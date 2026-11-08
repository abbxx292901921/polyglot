/* Non-streaming replies + streaming-refusal fallback.
   The bug being guarded: a gateway that ignores stream:true returns ordinary
   JSON, and the SSE decoder used to paint the whole JSON envelope as chat
   text. Also asserts the one-shot stream:false retry and its diagnostics.

   Run: node tools/nonstream.test.mjs */

import { sendChat, extractCompletion, buildPayload } from "../js/api-client.js";

let failures = 0;
function check(ok, label) {
  if (ok) {
    console.log("ok   " + label);
  } else {
    failures++;
    console.log("FAIL " + label);
  }
}

const conn = { base_url: "https://example.test/v1", api_key: "test-key" };
const preset = {
  model: "test/model",
  samplers: { temperature: 0.5, top_p: 1, max_tokens: 64 },
  reasoning_mode: "off",
  connection: conn
};
const messages = [{ role: "user", content: "hi" }];
const chat = (opts = {}) => sendChat({ preset, connection: conn, messages, ...opts });

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function sseResponse(chunks) {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// 1. A server that ignores stream:true and answers with JSON.
{
  let seen = null;
  globalThis.fetch = async (url, init) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) };
    return jsonResponse({
      choices: [{ message: { content: "Hello there.", reasoning_content: "brief thought" }, finish_reason: "stop" }]
    });
  };
  let content = "";
  let reasoning = "";
  const r = await chat({
    onContent: (t) => { content += t; },
    onReasoning: (t) => { reasoning += t; }
  });
  check(r.content === "Hello there.", "JSON reply parsed into content");
  check(content === "Hello there.", "JSON reply delivered through onContent");
  check(reasoning === "brief thought", "JSON reasoning delivered through onReasoning");
  check(seen.body.stream === true, "first attempt asks for streaming");
  check(seen.headers.Accept === "text/event-stream", "streaming attempt sends SSE Accept");
  check(!r.content.includes('"choices"'), "raw JSON envelope never painted as chat text");
}

// 2. A normal SSE reply still streams.
{
  globalThis.fetch = async () => sseResponse([
    { choices: [{ delta: { content: "Hel" } }] },
    { choices: [{ delta: { content: "lo" } }] }
  ]);
  const r = await chat();
  check(r.content === "Hello", "SSE reply still accumulates");
}

// 3. Streaming refused with 400 -> one non-stream retry succeeds.
{
  const seen = [];
  const notes = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ body, accept: init.headers.Accept, auth: init.headers.Authorization });
    if (body.stream) return jsonResponse({ detail: "streaming not supported" }, 400);
    return jsonResponse({ choices: [{ message: { content: "fallback ok" }, finish_reason: "stop" }] });
  };
  const r = await chat({ onNote: (n) => notes.push(n) });
  check(r.content === "fallback ok", "non-stream retry returns the reply");
  check(seen.length === 2, "exactly one retry is made");
  check(seen[1].body.stream === false, "retry flips stream to false");
  check(seen[1].accept === "application/json", "retry sends JSON Accept");
  check(seen[1].auth === "Bearer test-key", "retry keeps the key in the header");
  check(notes.some((n) => n.includes("E_STREAM_FALLBACK")), "retry is reported in diagnostics");
}

// 4. Both attempts fail -> both error bodies are surfaced.
{
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    return jsonResponse({ detail: body.stream ? "no sse here" : "messages are wrong" }, 400);
  };
  let message = "";
  try {
    await chat();
  } catch (e) {
    message = String(e?.message || e);
  }
  check(message.includes("messages are wrong"), "final error carries the non-stream body");
  check(message.includes("no sse here"), "final error still shows the streaming refusal");
  check(message.includes("streaming attempt"), "final error labels the streaming attempt");
}

// 5. Content-part arrays and choice.text are understood.
{
  const parts = extractCompletion({ choices: [{ message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }] });
  const text = extractCompletion({ choices: [{ text: "legacy" }] });
  check(parts.content === "ab", "content-part arrays are joined");
  check(text.content === "legacy", "choices[0].text is accepted");
}

// 6. A malformed 200 is a coded error, not silent empty output.
{
  globalThis.fetch = async () => new Response("<html>proxy error</html>", { status: 200, headers: { "content-type": "text/html" } });
  let message = "";
  try {
    await chat();
  } catch (e) {
    message = String(e?.message || e);
  }
  check(message.includes("E_API_FAIL"), "non-JSON 200 is reported as E_API_FAIL");
  check(message.includes("text/html"), "non-JSON 200 names the content type");
}

// 7. Empty/null messages never reach a strict chat template.
{
  const built = buildPayload(preset, [
    { role: "system", content: "" },
    { role: "assistant", content: "" },
    { role: "user", content: "hi" },
    { role: "assistant" },
    { role: "assistant", content: "   " },
    { role: "user", content: "there" }
  ]);
  check(built.body.messages.length === 2, "empty messages are dropped before send");
  check(built.body.messages[0].content === "hi", "surviving user message is kept");
  check(built.notes.some((n) => n.includes("E_EMPTY_MSG")), "dropped messages are reported");
}

// 8. Mistral Large 4's template wants one leading system and no system after
// an assistant. The handler moves the author's note to the front instead of
// letting the template raise "Unexpected role 'system' after role 'assistant'".
{
  const mistral = { ...preset, model: "mistralai/mistral-large-4-1t-a52b", samplers: { ...preset.samplers, max_tokens: 4096 } };
  const built = buildPayload(mistral, [
    { role: "system", content: "You are Mira." },
    { role: "user", content: "Hi." },
    { role: "assistant", content: "Hello." },
    { role: "system", content: "Keep replies short." },
    { role: "user", content: "Go on." }
  ]);
  check(built.body.messages[0].role === "system", "mistral: one leading system");
  check(built.body.messages.filter((m) => m.role === "system").length === 1, "mistral: no mid-history system");
  check(built.body.messages[0].content.includes("Keep replies short."), "mistral: note content preserved");
  check(built.notes.some((n) => n.includes("E_MISTRAL_SHAPE")), "mistral: merge reported");
}
{
  const mistral = { ...preset, model: "mistralai/mistral-large-4-1t-a52b", samplers: { ...preset.samplers, max_tokens: 4096 } };
  const built = buildPayload(mistral, [
    { role: "assistant", content: "Hello." },
    { role: "user", content: "Hi." }
  ]);
  check(built.body.messages[0].role === "system", "mistral: adds a leading system when missing");
  check(built.body.messages[1].role === "assistant", "mistral: greeting preserved after the system");
}

// 9. An all-empty conversation is rejected before any network call.
{
  let called = false;
  globalThis.fetch = async () => { called = true; return jsonResponse({}); };
  let message = "";
  try {
    await chat({ messages: [{ role: "user", content: "   " }] });
  } catch (e) {
    message = String(e?.message || e);
  }
  check(message.includes("E_EMPTY_CHAT"), "all-empty conversation is rejected before fetch");
  check(!called, "no request is made for an all-empty conversation");
}

// 10. A 200 with no reply text is an error, not an empty saved message.
{
  globalThis.fetch = async () => jsonResponse({
    choices: [{ message: { content: null, reasoning_content: "thinking..." }, finish_reason: "length" }]
  });
  let message = "";
  try {
    await chat();
  } catch (e) {
    message = String(e?.message || e);
  }
  check(message.includes("E_API_FAIL"), "empty completion is an error");
  check(message.includes("reasoning only"), "empty completion names the reasoning-only case");
  check(message.includes("length"), "empty completion names finish_reason");
}

console.log(failures ? `NONSTREAM_FAIL ${failures}` : "NONSTREAM_OK");
process.exitCode = failures ? 1 : 0;
