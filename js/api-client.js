/* Polyglot api-client — OpenAI-Compatible payload sanitizer + streaming sender.
   Extra inputs are not permitted by strict gateways (400s), so every body is
   built from a tight allowlist plus exactly one reasoning strategy:
   - "none": strip all reasoning keys (Nemotron / Llama standard / base GLM).
   - "openai_effort": + reasoning_effort low|medium|high, no numeric budgets.
   - "anthropic_budget": + thinking {type:"enabled", budget_tokens>=1024}.
   - "tag_only": zero reasoning keys on the wire; <think> parsed client-side
     (DeepSeek R1-style on NIM). Same wire shape as "none".
   Keys are sent only in the Authorization header, never logged or put in URLs.
   Providers (base_url + key + proxy) and model presets (model + samplers +
   prompts) are distinct and mixed at send time. Legacy presets that still
   embed connection.* keep working via the merge below. */

import { streamSSE } from "./sse-streamer.js";

const EFFORTS = new Set(["low", "medium", "high"]);

function pickModel(preset) {
  if (typeof preset?.model === "string" && preset.model.trim()) return preset.model.trim();
  const legacy = preset?.connection?.model;
  if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
  return "";
}

function pickReasoning(preset) {
  const c = preset?.connection || {};
  return {
    strategy: preset?.reasoning_strategy || c.reasoning_strategy || "none",
    effort: preset?.reasoning_effort || c.reasoning_effort || "medium",
    budget: preset?.thinking_budget ?? c.thinking_budget ?? 2048
  };
}

export function sanitizePayload(preset, messages) {
  const sam = preset?.samplers || {};
  const strategy = pickReasoning(preset).strategy;
  const model = pickModel(preset);

  const body = {
    model,
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
    const raw = pickReasoning(preset).effort;
    const e = String(raw || "medium").toLowerCase();
    body.reasoning_effort = EFFORTS.has(e) ? e : "medium";
  } else if (strategy === "anthropic_budget") {
    const raw = pickReasoning(preset).budget;
    const b = Math.max(1024, Number(raw ?? 2048) || 2048);
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

// GET {base}/models with the provider key. Returns string[] of model ids.
// Throws coded errors; never logs the key.
export async function fetchModels({ base_url, api_key, use_proxy, proxy_url, signal } = {}) {
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
  return normalizeModelList(json);
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
// Accepts split shapes: {provider, preset} (v1.5+) or legacy {connection}.
// Legacy {connection:{...model}} still works: it is merged as the fallback.
export async function sendChat({ provider, preset, connection, samplers, messages, signal, onContent, onReasoning }) {
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
  const body = sanitizePayload(effPreset, messages);
  const headers = { "Content-Type": "application/json" };
  if (effConn.api_key) headers.Authorization = "Bearer " + effConn.api_key;

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
    throw new Error(offlineHint(hostOf(url)) + ` (${e?.message || "fetch failed"})`);
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
