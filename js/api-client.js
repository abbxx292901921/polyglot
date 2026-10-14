/* Polyglot api-client — OpenAI-Compatible payload sanitizer + streaming sender.
   Extra inputs are not permitted by strict gateways (400s), so every body is
   built from a tight allowlist plus exactly one reasoning strategy:
   - "none": strip all reasoning keys (Nemotron / Llama standard / base GLM).
   - "openai_effort": + reasoning_effort low|medium|high, no numeric budgets.
   - "anthropic_budget": + thinking {type:"enabled", budget_tokens>=1024}.
   - "tag_only": zero reasoning keys on the wire; <think> parsed client-side
     (DeepSeek R1-style on NIM). Same wire shape as "none".
   Keys are sent only in the Authorization header, never logged or put in URLs. */

import { streamSSE } from "./sse-streamer.js";

const EFFORTS = new Set(["low", "medium", "high"]);

export function sanitizePayload(preset, messages) {
  const conn = preset?.connection || {};
  const sam = preset?.samplers || {};
  const strategy = conn.reasoning_strategy || "none";

  const body = {
    model: conn.model,
    messages,
    temperature: Number(sam.temperature ?? 0.9),
    top_p: Number(sam.top_p ?? 1.0),
    max_tokens: Math.max(1, Number(sam.max_tokens ?? 800)),
    stream: true
  };
  const stops = Array.isArray(sam.stop) ? sam.stop.filter((s) => String(s).length) : [];
  if (stops.length) body.stop = stops;
  if (Number(sam.frequency_penalty)) body.frequency_penalty = Number(sam.frequency_penalty);
  if (Number(sam.presence_penalty)) body.presence_penalty = Number(sam.presence_penalty);

  if (strategy === "openai_effort") {
    const e = String(conn.reasoning_effort || "medium").toLowerCase();
    body.reasoning_effort = EFFORTS.has(e) ? e : "medium";
  } else if (strategy === "anthropic_budget") {
    const b = Math.max(1024, Number(conn.thinking_budget ?? 2048) || 2048);
    body.thinking = { type: "enabled", budget_tokens: b };
  }
  // "none" and "tag_only": no reasoning keys at all.
  return body;
}

export function resolveEndpoint(connection) {
  const base = String(connection?.base_url || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("E_NET_ENDPOINT: preset has no base URL.");
  if (/\/chat\/completions\/?$/.test(base)) return base;
  const proxy = connection?.use_proxy ? String(connection?.proxy_url || "").trim().replace(/\/+$/, "") : "";
  const root = proxy ? proxy + "/" + base.replace(/^https?:\/\//, "") : base;
  return root + "/chat/completions";
}

function errMsg(status, text) {
  let detail = "";
  try {
    const j = JSON.parse(text);
    detail = j?.error?.message || j?.message || "";
  } catch {
    detail = text.slice(0, 300);
  }
  return `E_API_FAIL: request failed (${status})${detail ? ": " + detail : ""}`;
}

// Streams one completion. Callbacks receive incremental text; resolves the
// accumulated {content, reasoning}. Throws on HTTP errors or abort.
export async function sendChat({ connection, samplers, messages, signal, onContent, onReasoning }) {
  if (!connection?.model) throw new Error("E_NET_MODEL: preset has no model name.");
  const url = resolveEndpoint(connection);
  const body = sanitizePayload({ connection, samplers }, messages);
  const headers = { "Content-Type": "application/json" };
  if (connection.api_key) headers.Authorization = "Bearer " + connection.api_key;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal
    });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new Error("E_NET_OFFLINE: network error — offline or CORS blocked. Try the reverse-proxy toggle.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(errMsg(res.status, text));
  }
  let content = "";
  let reasoning = "";
  await streamSSE(res, {
    signal,
    onContent: (t) => { content += t; if (onContent) onContent(t); },
    onReasoning: (t) => { reasoning += t; if (onReasoning) onReasoning(t); }
  });
  return { content, reasoning };
}
