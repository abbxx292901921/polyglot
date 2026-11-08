#!/usr/bin/env node
/* Mistral Large 4 wire probe.
   Answers one question: which part of the request does NIM actually refuse?
   It sends the real Polyglot body (built by buildPayload) plus the documented
   minimum shape, varying exactly one thing at a time: streaming, max_tokens,
   and the message sequence (leading assistant / mid-history system / double
   user). Both the direct NIM endpoint and the relay are tested.

   The key is read from NVIDIA_API_KEY (or NIM_API_KEY) and is only ever put
   in the Authorization header. It is never printed, logged or written.

   Run:
     $env:NVIDIA_API_KEY="nvapi-..."
     node tools/mistral-probe.mjs

   Options:
     --direct-only / --relay-only
     --model=<id>
     --relay=<url>
     --case=<substring>          only run matching case names
     --max-cases=<n>             stop after n cases (debug)
*/

import { buildPayload, resolveEndpoint } from "../js/api-client.js";

const MODEL = (process.argv.find((a) => a.startsWith("--model=")) || "").slice(8) || process.env.PROBE_MODEL || "mistralai/mistral-large-4-1t-a52b";
const RELAY = (process.argv.find((a) => a.startsWith("--relay=")) || "").slice(8) || process.env.POLYGLOT_RELAY || "https://polyglot-relay.spoogboog5599.workers.dev/";
const KEY = process.env.NVIDIA_API_KEY || process.env.NIM_API_KEY || "";
const onlyCase = (process.argv.find((a) => a.startsWith("--case=")) || "").slice(7).toLowerCase();
const maxCases = Number((process.argv.find((a) => a.startsWith("--max-cases=")) || "").slice(12)) || 0;
const routes = process.argv.includes("--direct-only")
  ? ["direct"]
  : process.argv.includes("--relay-only")
    ? ["relay"]
    : ["direct", "relay"];

if (!KEY) {
  console.error("No key. Set NVIDIA_API_KEY (or NIM_API_KEY) in this shell, then rerun.");
  process.exit(2);
}

const BASE = "https://integrate.api.nvidia.com/v1";
const URLS = {
  direct: resolveEndpoint({ base_url: BASE, api_key: KEY }),
  relay: resolveEndpoint({ base_url: BASE, api_key: KEY, use_proxy: true, proxy_url: RELAY })
};

const SYS = "You are Mira, a concise roleplay partner. Reply in one short sentence.";
const GREETING = "*Mira looks up from her book.* \"Oh — hello. I wasn't expecting anyone.\"";
const USER = "Hi Mira. What are you reading?";

const history = [
  { role: "system", content: SYS },
  { role: "assistant", content: GREETING },
  { role: "user", content: USER }
];

// The exact wire body Polyglot builds for this preset, with one override.
function polyglot({ stream, max_tokens = 8000, messages = history }) {
  const preset = {
    model: MODEL,
    samplers: {
      temperature: 0.9,
      top_p: 1.0,
      max_tokens,
      stop: [],
      frequency_penalty: 0,
      presence_penalty: 0,
      context_window_limit: 200000
    },
    reasoning_mode: "off",
    connection: { base_url: BASE, api_key: KEY }
  };
  const body = buildPayload(preset, messages).body;
  body.stream = stream;
  return body;
}

const CASES = [
  {
    name: "docs-exact",
    stream: false,
    body: () => ({
      model: MODEL,
      messages: [{ role: "user", content: "What is 37 + 58? Reply with only the number." }],
      max_tokens: 128,
      stream: false,
      temperature: 0.5,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      reasoning_effort: "high"
    })
  },
  {
    name: "minimum-stream",
    stream: true,
    body: () => ({ model: MODEL, messages: [{ role: "user", content: "Say hi." }], max_tokens: 64, stream: true })
  },
  {
    name: "minimum-nostream",
    stream: false,
    body: () => ({ model: MODEL, messages: [{ role: "user", content: "Say hi." }], max_tokens: 64, stream: false })
  },
  {
    name: "empty-assistant-stream",
    stream: true,
    body: () => ({
      model: MODEL,
      messages: [
        { role: "system", content: SYS },
        { role: "assistant", content: "" },
        { role: "user", content: USER }
      ],
      max_tokens: 64,
      stream: true
    })
  },
  {
    name: "missing-content-stream",
    stream: true,
    body: () => ({
      model: MODEL,
      messages: [
        { role: "system", content: SYS },
        { role: "assistant" },
        { role: "user", content: USER }
      ],
      max_tokens: 64,
      stream: true
    })
  },
  {
    name: "system-after-assistant",
    stream: true,
    body: () => ({
      model: MODEL,
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: USER },
        { role: "assistant", content: "*Mira closes the book.* \"Just a travelogue.\"" },
        { role: "system", content: "Author's note: keep replies under 30 words." },
        { role: "user", content: "Any good?" }
      ],
      max_tokens: 64,
      stream: true
    })
  },
  {
    name: "leading-assistant-stream",
    stream: true,
    body: () => ({
      model: MODEL,
      messages: [
        { role: "assistant", content: GREETING },
        { role: "user", content: USER }
      ],
      max_tokens: 64,
      stream: true
    })
  },
  {
    name: "polyglot-stream-8000",
    stream: true,
    body: () => polyglot({ stream: true, max_tokens: 8000 })
  },
  {
    name: "polyglot-nostream-8000",
    stream: false,
    body: () => polyglot({ stream: false, max_tokens: 8000 })
  },
  {
    name: "polyglot-stream-4096",
    stream: true,
    body: () => polyglot({ stream: true, max_tokens: 4096 })
  },
  {
    name: "polyglot-nostream-4096",
    stream: false,
    body: () => polyglot({ stream: false, max_tokens: 4096 })
  },
  {
    name: "leading-user-stream",
    stream: true,
    body: () => polyglot({ stream: true, max_tokens: 128, messages: [{ role: "system", content: SYS }, { role: "user", content: USER }] })
  },
  {
    name: "leading-user-nostream",
    stream: false,
    body: () => polyglot({ stream: false, max_tokens: 128, messages: [{ role: "system", content: SYS }, { role: "user", content: USER }] })
  },
  {
    name: "no-greeting-stream",
    stream: true,
    body: () => polyglot({
      stream: true,
      max_tokens: 128,
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: USER },
        { role: "assistant", content: "*Mira closes the book.* \"Just a travelogue.\"" },
        { role: "user", content: "Any good?" }
      ]
    })
  },
  {
    name: "system-mid-stream",
    stream: true,
    body: () => polyglot({
      stream: true,
      max_tokens: 128,
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: USER },
        { role: "assistant", content: "*Mira closes the book.* \"Just a travelogue.\"" },
        { role: "system", content: "Author's note: keep replies under 30 words." },
        { role: "user", content: "Any good?" }
      ]
    })
  },
  {
    name: "double-user-stream",
    stream: true,
    body: () => polyglot({
      stream: true,
      max_tokens: 128,
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: USER },
        { role: "user", content: "I said hello." }
      ]
    })
  },
  {
    name: "leading-user-nudge-stream",
    stream: true,
    body: () => polyglot({
      stream: true,
      max_tokens: 128,
      messages: [
        { role: "system", content: SYS },
        { role: "user", content: "(Begin.)" },
        { role: "assistant", content: GREETING },
        { role: "user", content: USER }
      ]
    })
  }
];

function shortBody(text, limit = 260) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > limit ? s.slice(0, limit) + "…" : s;
}

async function firstStreamText(response) {
  if (!response.body) return "(no body)";
  const reader = response.body.getReader();
  try {
    const { value } = await reader.read();
    return value ? new TextDecoder().decode(value).replace(/\s+/g, " ").slice(0, 220) : "(empty stream)";
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

async function runCase(caseDef, route) {
  const url = URLS[route];
  const body = caseDef.body();
  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: caseDef.stream ? "text/event-stream" : "application/json",
        Authorization: "Bearer " + KEY
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return { route, status: "ERR", detail: String(e?.message || e), ms: Date.now() - started };
  }
  const ct = String(res.headers.get("content-type") || "").toLowerCase();
  const ms = Date.now() - started;
  if (!res.ok) {
    return { route, status: res.status, ct, detail: shortBody(await res.text().catch(() => "")), ms };
  }
  if (caseDef.stream && ct.includes("text/event-stream")) {
    return { route, status: res.status, ct, detail: "SSE: " + await firstStreamText(res), ms };
  }
  const text = await res.text().catch(() => "");
  try {
    const json = JSON.parse(text);
    const choice = json?.choices?.[0] || {};
    const msg = choice.message || {};
    const preview = typeof msg.content === "string" ? msg.content : "";
    const reasoned = typeof msg.reasoning_content === "string" && msg.reasoning_content.length;
    return {
      route,
      status: res.status,
      ct,
      detail: shortBody(`content=${JSON.stringify(preview.slice(0, 120))} finish=${choice.finish_reason || "?"} reasoning=${reasoned ? "yes" : "no"}`),
      ms
    };
  } catch {
    return { route, status: res.status, ct, detail: "non-JSON: " + shortBody(text), ms };
  }
}

const selected = (onlyCase ? CASES.filter((c) => c.name.includes(onlyCase)) : CASES).slice(0, maxCases || undefined);
if (!selected.length) {
  console.error("No cases matched " + JSON.stringify(onlyCase));
  process.exit(2);
}

console.log(`Mistral probe — model ${MODEL}`);
console.log(`routes: ${routes.join(", ")} | cases: ${selected.length} | key: present (not printed)\n`);

const results = [];
for (const caseDef of selected) {
  for (const route of routes) {
    const r = await runCase(caseDef, route);
    results.push({ case: caseDef.name, stream: caseDef.stream, ...r });
    console.log(
      `${caseDef.name.padEnd(28)} ${caseDef.stream ? "sse " : "json"} ${route.padEnd(6)} ` +
      `${String(r.status).padEnd(4)} ${r.detail}`
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

console.log("\nSUMMARY");
for (const caseDef of selected) {
  const row = results.filter((r) => r.case === caseDef.name);
  const statuses = row.map((r) => `${r.route}=${r.status}`).join(" ");
  console.log(`${caseDef.name.padEnd(28)} ${statuses}`);
}

const failures = results.filter((r) => r.status !== 200);
if (failures.length) {
  console.log("\nFAILURE BODIES");
  for (const f of failures) console.log(`[${f.route}] ${f.case} (${f.status}): ${f.detail}`);
}
