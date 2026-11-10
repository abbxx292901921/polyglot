/* Polyglot api-client — OpenAI-Compatible payload builder + streaming sender.
   Strict gateways (Nvidia NIM: additionalProperties false) reject unknown
   request keys, so every body is built from a tight allowlist plus exactly
   ONE validated thinking knob shape, resolved from the model's own schema:
   - "off": no reasoning keys (client-side think parsing still runs).
   - "effort": reasoning_effort, validated against the model's enum (kimi-k3
     low|high|max, nemotron-3-super none|low|high, gpt-oss low|medium|high).
   - "budget": reasoning_budget (Nemotron -1..32768), clamped per model.
   - "kwargs": chat_template_kwargs (step-5/nemotron enable_thinking,
     low_effort, medium_effort, preserve_thinking) from fetched/catalog modes.
   - "anthropic": thinking {type:"enabled", budget_tokens>=1024}.
   - "custom": user JSON merged at the body root (their responsibility).
   Modes come from fetchReasoningModes() (the model's OpenAPI page on
   docs.api.nvidia.com, proxy-aware, key never sent) or the built-in catalog
   in reasoning-modes.js — never guessed per-request.
   Agentic-format endpoints additionally get normalizeAgentic() messages:
   one leading system, strict user/assistant alternation, final user turn.
   Keys are sent only in the Authorization header, never logged or put in
   URLs. Providers (base_url + key + proxy) and model presets (model +
   samplers + prompts) are distinct and mixed at send time. Legacy presets
   that still embed connection.* keep working via mergeReasoning's mapping. */

import { streamSSE } from "./sse-streamer.js";
import { normalizeAgentic } from "./prompt-engine.js";
import { mergeReasoning, agenticWanted, applyThinking, catalogLookup, parseModesPage } from "./reasoning-modes.js";
import { normalizeModelCatalog, capabilitySet } from "./model-catalog.js";

function pickModel(preset) {
  if (typeof preset?.model === "string" && preset.model.trim()) return preset.model.trim();
  const legacy = preset?.connection?.model;
  if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
  return "";
}

function proxified({ use_proxy, proxy_url }, host, path) {
  const proxy = use_proxy ? String(proxy_url || "").trim().replace(/\/+$/, "") : "";
  const target = `https://${host}${path}`;
  return proxy ? proxy + "/" + target.replace(/^https?:\/\//, "") : target;
}

// Builds the wire body + human-readable notes (invalid mode values, budget
// bumps, agentic merges). sanitizePayload() returns just the body for
// back-compat; sendChat uses this and surfaces notes via onNote.
export function buildPayload(preset, messages) {
  const sam = preset?.samplers || {};
  const model = pickModel(preset);
  const r = mergeReasoning(preset || {}, preset?.connection || {}, model);
  const notes = [];

  const body = {
    model,
    temperature: Number(sam.temperature ?? 0.9),
    top_p: Number(sam.top_p ?? 1.0),
    max_tokens: Math.max(1, Number(sam.max_tokens ?? 800)),
    stream: true
  };
  const stops = Array.isArray(sam.stop) ? sam.stop.filter((s) => String(s).length) : [];
  if (stops.length) body.stop = stops;
  if (Number(sam.frequency_penalty)) body.frequency_penalty = Number(sam.frequency_penalty);
  if (Number(sam.presence_penalty)) body.presence_penalty = Number(sam.presence_penalty);

  // The provider's own model list is the only reliable statement of which
  // sampler keys a model accepts. Filtering only happens when the preset
  // carries a non-empty supported_parameters list, so older presets and
  // bare-id providers keep their exact previous wire shape.
  const caps = capabilitySet(preset?.model_meta);
  if (caps) {
    const skipped = [];
    for (const key of ["temperature", "top_p", "max_tokens", "stop", "frequency_penalty", "presence_penalty"]) {
      if (Object.prototype.hasOwnProperty.call(body, key) && !caps.has(key)) {
        delete body[key];
        skipped.push(key);
      }
    }
    if (skipped.length) {
      notes.push(`E_CAP_SKIP: ${model || "this model"} does not list ${skipped.join(", ")} — omitted from the request.`);
    }
  }

  let msgs = Array.isArray(messages) ? messages : [];
  // Empty messages are poison on strict chat templates: Mistral Large 4's
  // template raises "must have non-empty content" for a null/undefined
  // message, and an empty assistant greeting (a card with no first_mes) is
  // exactly that. Drop them before any model sees them.
  const beforeFilter = msgs.length;
  msgs = msgs.filter((m) => {
    if (!m || typeof m !== "object") return false;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) return true;
    if (typeof m.content === "string") return m.content.trim().length > 0;
    if (Array.isArray(m.content)) return m.content.length > 0;
    return false;
  });
  if (msgs.length !== beforeFilter) {
    notes.push(`E_EMPTY_MSG: dropped ${beforeFilter - msgs.length} empty message${beforeFilter - msgs.length === 1 ? "" : "s"} before send.`);
  }
  if (agenticWanted(r)) {
    const n = normalizeAgentic(msgs);
    msgs = n.messages;
    const bits = [];
    if (n.merged) bits.push(`merged ${n.merged} same-role message${n.merged === 1 ? "" : "s"}`);
    if (n.nudged) bits.push("appended final user turn");
    if (bits.length) notes.push(`E_AGENCY: agentic format — ${bits.join(", ")}.`);
  }
  if (r.descriptor?.system_must_lead) {
    const systems = msgs.filter((m) => m.role === "system");
    const rest = msgs.filter((m) => m.role !== "system");
    const systemText = systems.map((m) => m.content).filter((c) => typeof c === "string" && c.trim()).join("\n\n");
    const wasLeading = msgs[0]?.role === "system";
    if (systemText) {
      msgs = [{ role: "system", content: systemText }, ...rest];
      if (systems.length > 1) {
        notes.push(`E_MISTRAL_SHAPE: merged ${systems.length} system messages into one leading system prompt.`);
      } else if (!wasLeading) {
        notes.push("E_MISTRAL_SHAPE: moved the system prompt to the front of the conversation.");
      }
    } else {
      msgs = rest;
    }
    if (msgs.length && msgs[0].role !== "user" && msgs[0].role !== "system") {
      msgs = [{ role: "system", content: "Continue the conversation in character." }, ...msgs];
      notes.push("E_MISTRAL_SHAPE: added a leading system message (this model must start with user or system).");
    }
  }
  body.messages = msgs;

  notes.push(...applyThinking(body, r));
  return { body, notes };
}

export function sanitizePayload(preset, messages) {
  return buildPayload(preset, messages).body;
}

// Pulls the reply out of a non-streaming OpenAI-style completion. Some
// gateways ignore stream:true and answer with plain JSON; without this the
// SSE decoder would paint the raw JSON envelope into the bubble.
export function extractCompletion(json) {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
  const msg = choice?.message || {};
  let content = typeof msg.content === "string" ? msg.content : "";
  if (!content && Array.isArray(msg.content)) {
    content = msg.content
      .map((p) => (typeof p === "string" ? p : (typeof p?.text === "string" ? p.text : "")))
      .join("");
  }
  if (!content && typeof choice?.text === "string") content = choice.text;
  let reasoning = typeof msg.reasoning_content === "string" ? msg.reasoning_content : "";
  if (!reasoning && typeof msg.reasoning === "string") reasoning = msg.reasoning;
  if (!reasoning && typeof choice?.reasoning_content === "string") reasoning = choice.reasoning_content;
  return { content, reasoning };
}

export function resolveEndpoint(connection) {
  const base = String(connection?.base_url || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("E_NET_ENDPOINT: preset has no base URL.");
  if (/\/chat\/completions\/?$/.test(base)) return base;
  const proxy = connection?.use_proxy ? String(connection?.proxy_url || "").trim().replace(/\/+$/, "") : "";
  const root = proxy ? proxy + "/" + base.replace(/^https?:\/\//, "") : base;
  return root + "/chat/completions";
}

export function resolveModelsEndpoint(connection) {
  const raw = String(connection?.base_url || "").trim().replace(/\/+$/, "");
  if (!raw) throw new Error("E_NET_ENDPOINT: provider has no base URL.");
  let base = raw;
  base = base.replace(/\/chat\/completions\/?$/, "");
  const proxy = connection?.use_proxy ? String(connection?.proxy_url || "").trim().replace(/\/+$/, "") : "";
  const root = proxy ? proxy + "/" + base.replace(/^https?:\/\//, "") : base;
  return root + "/models";
}

export function normalizeModelList(json) {
  const out = [];
  const push = (v) => {
    const id = typeof v === "string" ? v : (v?.id || v?.name || v?.model);
    if (typeof id === "string" && id.trim() && !out.includes(id.trim())) out.push(id.trim());
  };
  if (Array.isArray(json)) json.forEach(push);
  else if (Array.isArray(json?.data)) json.data.forEach(push);
  else if (Array.isArray(json?.models)) json.models.forEach(push);
  return out;
}

function offlineHint(host) {
  const h = String(host || "").toLowerCase();
  if (h.includes("integrate.api.nvidia.com") || h.includes("nvidia")) {
    return "E_NET_OFFLINE: network error reaching Nvidia NIM — browsers block this host via CORS. Enable Use reverse proxy with your proxy URL, or host a CORS relay, then Test connection.";
  }
  return "E_NET_OFFLINE: network error — offline or CORS blocked. Try the reverse-proxy toggle, then Test connection.";
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// GET {base}/models with the provider key. Returns normalized model records
// (id, name, context, pricing, modalities, supported_parameters, reasoning).
// The body is untrusted provider data; normalizeModelCatalog reduces every
// field to plain strings/numbers and drops unknown shapes.
// Throws coded errors; never logs the key.
export async function fetchModelCatalog({ base_url, api_key, use_proxy, proxy_url, signal } = {}) {
  const conn = { base_url, api_key, use_proxy, proxy_url };
  const url = resolveModelsEndpoint(conn);
  const headers = {};
  if (api_key) headers.Authorization = "Bearer " + api_key;
  let res;
  try {
    res = await fetch(url, { method: "GET", headers, signal });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new Error(offlineHint(hostOf(url)) + ` (${e?.message || "fetch failed"})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(errMsg(res.status, text));
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error("E_API_FAIL: /models did not return JSON (proxy may have rewritten it).");
  }
  return normalizeModelCatalog(json);
}

// Back-compat: callers that only need the id list keep their old return shape.
export async function fetchModels(opts) {
  return (await fetchModelCatalog(opts)).map((m) => m.id);
}

// Resolves a model's thinking knobs from its own OpenAPI page on
// docs.api.nvidia.com (public docs; the provider key is NEVER sent here).
// Model ids like "stepfun-ai/step-5-preview" map to slugs like
// "stepfun-ai-step-5-preview-infer". Never throws: docs fetch is
// CORS-blocked from browsers without a proxy, so any failure falls back to
// the surveyed catalog in reasoning-modes.js. Resolves
// { descriptor, source: "fetched"|"catalog"|"none", note }.
export async function fetchReasoningModes({ model, use_proxy, proxy_url, signal } = {}) {
  const id = String(model || "").trim();
  if (!id) throw new Error("E_MODES_FETCH: no model name — pick a model first.");
  const slug = id.toLowerCase().replace(/[\/. _]+/g, "-").replace(/[^a-z0-9-]/g, "") + "-infer";
  const url = proxified({ use_proxy, proxy_url }, "docs.api.nvidia.com", "/nim/reference/" + slug);
  try {
    const res = await fetch(url, { method: "GET", signal });
    if (!res.ok) throw new Error(`docs page ${res.status}`);
    const html = await res.text();
    const parsed = parseModesPage(html, id);
    if (parsed) {
      return { descriptor: parsed, source: "fetched", note: `Fetched live schema for ${id} (${parsed.hint || "no knobs"}).` };
    }
    const cat = catalogLookup(id);
    if (cat) {
      return { descriptor: cat, source: "catalog", note: `Docs page for ${id} had no reasoning schema; using surveyed catalog (${cat.hint || "no knobs"}).` };
    }
    return { descriptor: null, source: "none", note: `No reasoning schema found for ${id} — mode "off" sends no reasoning keys.` };
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    const cat = catalogLookup(id);
    if (cat) {
      return { descriptor: cat, source: "catalog", note: `Docs fetch blocked (${e?.message || "offline/CORS"}) — using surveyed catalog for ${id} (${cat.hint || "no knobs"}). Enable the reverse proxy and retry for the live schema.` };
    }
    return { descriptor: null, source: "none", note: `Docs fetch blocked (${e?.message || "offline/CORS"}) and ${id} is not in the catalog — mode "off" sends no reasoning keys.` };
  }
}

function errMsg(status, text) {
  let detail = "";
  const pick = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
  try {
    const j = JSON.parse(text);
    if (j && typeof j === "object") {
      // FastAPI validation shape: detail is an array of {loc, msg}.
      if (Array.isArray(j.detail)) {
        detail = j.detail
          .map((d) => {
            if (typeof d === "string") return d;
            const loc = Array.isArray(d?.loc) ? d.loc.filter((p) => p !== "body").join(".") : "";
            const msg = pick(d?.msg) || pick(d?.message) || "invalid";
            return loc ? `${loc}: ${msg}` : msg;
          })
          .filter(Boolean)
          .join("; ");
      } else {
        detail =
          pick(j?.error?.message) ||
          pick(j?.message) ||
          pick(j?.detail) ||
          (typeof j?.error === "string" ? pick(j.error) : "") ||
          pick(j?.code);
      }
    } else {
      detail = pick(String(j));
    }
  } catch {
    detail = String(text || "").slice(0, 300);
  }
  detail = detail.slice(0, 300);
  return `E_API_FAIL: request failed (${status})${detail ? ": " + detail : ""}`;
}

function headersFor(stream, apiKey) {
  const headers = { "Content-Type": "application/json" };
  // NVIDIA's official clients send Accept based on stream. SSE dispatch in
  // third-party inference fronts (and some relays) keys on it.
  headers.Accept = stream ? "text/event-stream" : "application/json";
  if (apiKey) headers.Authorization = "Bearer " + apiKey;
  return headers;
}

// Streams one completion. Callbacks receive incremental text; resolves the
// accumulated {content, reasoning}. Throws on HTTP errors or abort.
// Accepts split shapes: {provider, preset} (v1.5+) or legacy {connection}.
// Legacy {connection:{...model}} still works: it is merged as the fallback.
export async function sendChat({ provider, preset, connection, samplers, messages, signal, onContent, onReasoning, onNote }) {
  const effConn = { ...(provider || {}), ...(connection || {}) };
  const effSamplers = samplers ?? preset?.samplers ?? {};
  const effPreset = {
    ...(preset || {}),
    samplers: effSamplers,
    connection: effConn,
    model: preset?.model ?? connection?.model ?? provider?.model ?? "",
    reasoning_strategy: preset?.reasoning_strategy ?? connection?.reasoning_strategy ?? "none",
    reasoning_effort: preset?.reasoning_effort ?? connection?.reasoning_effort ?? "medium",
    thinking_budget: preset?.thinking_budget ?? connection?.thinking_budget ?? 2048
  };
  if (!pickModel(effPreset)) throw new Error("E_NET_MODEL: preset has no model name.");
  const url = resolveEndpoint(effConn);
  const { body, notes } = buildPayload(effPreset, messages);
  if (onNote) for (const n of notes) { try { onNote(n); } catch { /* notes never break send */ } }
  if (!Array.isArray(body.messages) || !body.messages.length) {
    throw new Error("E_EMPTY_CHAT: nothing to send — the conversation has no non-empty messages.");
  }

  const post = (wire) => fetch(url, {
    method: "POST",
    headers: headersFor(wire.stream, effConn.api_key),
    body: JSON.stringify(wire),
    signal
  });

  let res;
  try {
    res = await post(body);
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new Error(offlineHint(hostOf(url)) + ` (${e?.message || "fetch failed"})`);
  }

  // Some models/relays refuse SSE outright. A 400/422 on a streaming send is
  // retried once without streaming: if the model can answer at all, it
  // answers in JSON, and if it cannot, the JSON error body is the more
  // useful one to surface.
  let streamFailure = "";
  if (!res.ok && body.stream && (res.status === 400 || res.status === 422)) {
    streamFailure = errMsg(res.status, await res.text().catch(() => ""));
    if (onNote) { try { onNote(`E_STREAM_FALLBACK: streaming send was refused (${res.status}) — retrying once with stream:false.`); } catch { /* notes never break send */ } }
    try {
      res = await post({ ...body, stream: false });
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      throw new Error(offlineHint(hostOf(url)) + ` (${e?.message || "fetch failed"})`);
    }
    if (!res.ok) {
      const retryFailure = errMsg(res.status, await res.text().catch(() => ""));
      throw new Error(retryFailure + " | streaming attempt: " + streamFailure.replace(/^E_API_FAIL: /, ""));
    }
    body.stream = false;
    if (onNote) { try { onNote("E_STREAM_FALLBACK: non-streaming retry succeeded."); } catch { /* notes never break send */ } }
  } else if (!res.ok) {
    throw new Error(errMsg(res.status, await res.text().catch(() => "")));
  }

  let content = "";
  let reasoning = "";
  const ct = String(res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("text/event-stream")) {
    await streamSSE(res, {
      signal,
      onContent: (t) => { content += t; if (onContent) onContent(t); },
      onReasoning: (t) => { reasoning += t; if (onReasoning) onReasoning(t); }
    });
  } else {
    // Every other content type is read once and sniffed. Normal JSON is the
    // non-streaming path; an SSE body mislabeled by a proxy is replayed
    // through the SSE decoder; anything else is a real error, never chat text.
    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch { /* not JSON */ }
    if (json) {
      const got = extractCompletion(json);
      content = got.content;
      reasoning = got.reasoning;
      if (!content) {
        const finish = json?.choices?.[0]?.finish_reason;
        throw new Error(
          `E_API_FAIL: completion had no reply text${reasoning ? " (reasoning only)" : ""}${finish ? ` (finish_reason: ${finish})` : ""}.`
        );
      }
      if (onContent) onContent(content);
      if (reasoning && onReasoning) onReasoning(reasoning);
    } else if (/(^|\n)\s*data:/.test(text)) {
      const replay = new Response(text, { status: res.status, headers: res.headers });
      await streamSSE(replay, {
        signal,
        onContent: (t) => { content += t; if (onContent) onContent(t); },
        onReasoning: (t) => { reasoning += t; if (onReasoning) onReasoning(t); }
      });
    } else {
      throw new Error(`E_API_FAIL: expected JSON or SSE (got ${ct || "unknown content-type"}): ${text.slice(0, 200)}`);
    }
  }
  return { content, reasoning };
}
