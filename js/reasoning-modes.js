/* Polyglot reasoning-modes — per-model thinking knobs, resolved not guessed.
   Nvidia NIM (and other strict gateways) reject unknown request keys
   (additionalProperties: false) and the reasoning knobs VARY per model:
   - reasoning_effort enums differ: kimi-k3 low|high|max, nemotron-3-super
     none|low|high, nemotron-3-ultra none|medium|high, gpt-oss low|medium|high.
   - nemotron family also takes reasoning_budget (-1..32768).
   - step-5/step-3.5 use chat_template_kwargs (enable_thinking, low_effort,
     medium_effort, preserve_thinking); step-5 reasoning CANNOT be disabled.
   Two sources, in order of trust:
   1. "fetched": fetchReasoningModes() (api-client) pulls the model's OpenAPI
      page from docs.api.nvidia.com and parseModesPage() extracts the knobs.
   2. "catalog": CATALOG below — the same schemas surveyed 2026-10, used when
      the docs fetch is offline/CORS-blocked or the model predates the page.
   Descriptors are plain JSON and are cached on the preset (reasoning_modes),
   so a fetch once keeps working offline. Pure module: no fetch, no DOM. */

// ---------- Built-in catalog (fallback; surveyed from docs.api.nvidia.com) ----------
const CATALOG = [
  {
    match: /nemotron-3-super/i,
    effort: { values: ["none", "low", "high"], default: "high" },
    budget: { min: -1, max: 32768, default: 16384 },
    kwargsModes: {
      off: { enable_thinking: false },
      low: { enable_thinking: true, low_effort: true },
      high: { enable_thinking: true }
    },
    strict_roles: true,
    hint: "reasoning_effort none|low|high + reasoning_budget (-1..32768)."
  },
  {
    match: /nemotron-3-ultra/i,
    effort: { values: ["none", "medium", "high"], default: "high" },
    budget: { min: -1, max: 32768, default: 16384 },
    kwargsModes: {
      off: { enable_thinking: false },
      medium: { enable_thinking: true, medium_effort: true },
      high: { enable_thinking: true }
    },
    strict_roles: true,
    hint: "reasoning_effort none|medium|high + reasoning_budget (-1..32768)."
  },
  {
    match: /nemotron-3\.5-lightning/i,
    budget: { min: -1, max: 32768, default: 16384 },
    kwargsModes: {
      off: { enable_thinking: false },
      on: { enable_thinking: true }
    },
    strict_roles: true,
    hint: "chat_template_kwargs enable_thinking + reasoning_budget (-1..32768)."
  },
  {
    match: /nemotron-3-nano/i,
    budget: { min: -1, max: 32768, default: 16384 },
    kwargsModes: {
      off: { enable_thinking: false },
      on: { enable_thinking: true }
    },
    strict_roles: false,
    hint: "chat_template_kwargs enable_thinking + reasoning_budget (-1..32768)."
  },
  {
    match: /kimi-k3/i,
    effort: { values: ["low", "high", "max"], default: "max" },
    strict_roles: false,
    hint: "reasoning_effort low|high|max (serve default max)."
  },
  {
    match: /kimi-k2-thinking/i,
    always_thinks: true,
    strict_roles: true,
    hint: "Always thinks; no API knob. Soften with the prompt-side softener and a high Max tokens."
  },
  {
    match: /qwen3-next-80b-a3b-thinking|qwq/i,
    always_thinks: true,
    strict_roles: true,
    hint: "Always thinks; no API knob. Soften with the prompt-side softener and a high Max tokens."
  },
  {
    match: /step-5-(preview|flash)|step-5-preview/i,
    kwargsModes: {
      on: { enable_thinking: true, preserve_thinking: true },
      lean: { enable_thinking: true, preserve_thinking: false }
    },
    always_thinks: true,
    reasoning_in_max_tokens: true,
    strict_roles: false,
    hint: "Reasoning cannot be disabled (enable_thinking is const true). lean = preserve_thinking:false. max_tokens INCLUDES reasoning — keep it high (16k+) or replies die mid-thought."
  },
  {
    match: /step-3\.5-flash|step-3-5-flash/i,
    always_thinks: true,
    strict_roles: true,
    hint: "Interleaved thinking, no API knob; strict alternating roles. Soften with the prompt-side softener and a high Max tokens."
  },
  {
    match: /gpt-oss/i,
    effort: { values: ["low", "medium", "high"], default: "medium" },
    strict_roles: true,
    hint: "reasoning_effort low|medium|high."
  },
  {
    match: /minimax-m2/i,
    strict_roles: true,
    hint: "No published reasoning knob; strict alternating roles."
  }
];

export function catalogLookup(model) {
  const id = String(model || "");
  if (!id) return null;
  for (const c of CATALOG) {
    if (c.match.test(id)) {
      const { match, ...rest } = c;
      return { model: id, source: "catalog", ...rest };
    }
  }
  return null;
}

// ---------- OpenAPI page parser (docs.api.nvidia.com /nim/reference/<slug>-infer) ----------
// Extract the fenced ```json OpenAPI block, then walk request schemas for
// reasoning knobs + the messages-role rules. Returns null on any mismatch.
export function parseModesPage(html, model) {
  const text = String(html || "");
  const start = text.indexOf("```json");
  if (start < 0) return null;
  const jsonStart = text.indexOf("{", start);
  const end = text.indexOf("\n```", jsonStart);
  if (jsonStart < 0 || end < 0) return null;
  let spec;
  try {
    spec = JSON.parse(text.slice(jsonStart, end));
  } catch {
    return null;
  }
  const schemas = spec?.components?.schemas;
  if (!schemas || typeof schemas !== "object") return null;

  const d = { model: String(model || ""), source: "fetched", fetched_at: Date.now() };
  let effort = null;
  let budget = null;
  let ctk = null; // chat_template_kwargs property schema
  let maxTokens = null;
  let messagesDesc = "";
  let messagesRoles = null;

  for (const s of Object.values(schemas)) {
    if (!s || typeof s !== "object" || !s.properties) continue;
    const p = s.properties;
    if (p.reasoning_effort && !effort) {
      effort = {
        values: Array.isArray(p.reasoning_effort.enum) ? p.reasoning_effort.enum.map(String) : null,
        default: p.reasoning_effort.default != null ? String(p.reasoning_effort.default) : null
      };
    }
    if (p.reasoning_budget && !budget) {
      budget = {
        min: Number.isFinite(p.reasoning_budget.minimum) ? p.reasoning_budget.minimum : 0,
        max: Number.isFinite(p.reasoning_budget.maximum) ? p.reasoning_budget.maximum : 32768,
        default: Number.isFinite(p.reasoning_budget.default) ? p.reasoning_budget.default : 16384
      };
    }
    if (p.chat_template_kwargs && !ctk) ctk = p.chat_template_kwargs;
    if (p.max_tokens && !maxTokens) maxTokens = p.max_tokens;
    if (p.messages && typeof p.messages === "object") {
      if (typeof p.messages.description === "string") messagesDesc = p.messages.description;
      const items = p.messages.items;
      const role = items?.properties?.role;
      if (role && Array.isArray(role.enum)) messagesRoles = role.enum.map(String);
      else if (items?.anyOf) {
        for (const v of items.anyOf) {
          if (v?.properties?.role && Array.isArray(v.properties.role.enum)) {
            messagesRoles = v.properties.role.enum.map(String);
            break;
          }
        }
      }
    }
  }

  if (effort) d.effort = effort;
  if (budget) d.budget = budget;
  if (messagesDesc) {
    const low = messagesDesc.toLowerCase();
    d.strict_roles = low.includes("alternating");
  }
  if (Array.isArray(messagesRoles) && messagesRoles.includes("context")) d.accepts_context_role = true;

  // chat_template_kwargs: schema'd properties (step-5) and/or example bodies
  // (nemotron lightning/nano document kwargs only via examples).
  const kwargsExamples = [];
  const meta = spec?.paths && Object.values(spec.paths)[0]?.post?.["x-nvai-meta"];
  if (meta && Array.isArray(meta.examples)) {
    for (const ex of meta.examples) {
      try {
        const body = JSON.parse(ex.requestJson || "{}");
        if (body && typeof body.chat_template_kwargs === "object" && body.chat_template_kwargs) {
          kwargsExamples.push(body.chat_template_kwargs);
        }
      } catch { /* skip malformed example */ }
    }
  }
  const modes = {};
  const kwId = (obj) => {
    if (obj.enable_thinking === false) return "off";
    if (obj.low_effort) return "low";
    if (obj.medium_effort) return "medium";
    if (obj.preserve_thinking === false) return "lean";
    return "on";
  };
  for (const obj of kwargsExamples) {
    const id = kwId(obj);
    if (!modes[id] || JSON.stringify(obj).length > JSON.stringify(modes[id]).length) {
      modes[id] = obj;
    }
  }
  if (ctk?.properties) {
    d.kwargs_props = ctk.properties;
    const en = ctk.properties.enable_thinking;
    if (en && (en.const === true || (Array.isArray(en.enum) && en.enum.length === 1 && en.enum[0] === true))) {
      d.always_thinks = true;
    }
    if (!modes.on && en) {
      modes.on = { enable_thinking: true, ...(ctk.properties.preserve_thinking ? { preserve_thinking: true } : {}) };
      if (ctk.properties.preserve_thinking) modes.lean = { enable_thinking: true, preserve_thinking: false };
    }
  }
  if (Object.keys(modes).length) d.kwargsModes = modes;

  // Always-thinking heuristic: thinking-model name AND no way to switch it off.
  if (!d.always_thinks && /thinking|qwq|step-5/i.test(d.model) &&
      !d.effort?.values?.includes("none") && !d.kwargsModes?.off) {
    d.always_thinks = true;
  }
  if (maxTokens?.description && /reason/i.test(maxTokens.description)) {
    d.reasoning_in_max_tokens = true;
  }

  if (!d.effort && !d.budget && !d.kwargsModes && !d.always_thinks) return null;
  d.hint = describeDescriptor(d);
  return d;
}

function describeDescriptor(d) {
  const bits = [];
  if (d.effort?.values) bits.push(`reasoning_effort ${d.effort.values.join("|")}`);
  if (d.budget) bits.push(`reasoning_budget ${d.budget.min}..${d.budget.max}`);
  if (d.kwargsModes) bits.push(`chat_template_kwargs ${Object.keys(d.kwargsModes).join("|")}`);
  if (d.always_thinks) bits.push("always thinks (cannot disable)");
  if (d.reasoning_in_max_tokens) bits.push("reasoning counts toward max_tokens");
  if (d.strict_roles) bits.push("strict user/assistant alternation");
  return bits.join("; ") || "no reasoning knobs documented";
}

// ---------- Preset field merge (new schema + v1.6 legacy strategies) ----------
export function validDescriptor(desc, model) {
  if (!desc || typeof desc !== "object") return null;
  if (model && desc.model && desc.model !== model) return null;
  if (desc.source !== "fetched" && desc.source !== "catalog") return null;
  if (!desc.effort && !desc.budget && !desc.kwargsModes && !desc.always_thinks && !desc.strict_roles) return null;
  return desc;
}

export function mergeReasoning(preset = {}, connection = {}, model = "") {
  const c = connection || {};
  const legacyStrategy = preset.reasoning_strategy || c.reasoning_strategy || "";
  let mode = preset.reasoning_mode || "";
  let value = preset.reasoning_value ?? "";
  if (!mode) {
    if (legacyStrategy === "openai_effort") {
      mode = "effort";
      value = preset.reasoning_effort || c.reasoning_effort || "medium";
    } else if (legacyStrategy === "anthropic_budget") {
      mode = "anthropic";
    } else {
      mode = "off"; // "none" | "tag_only" | unset
    }
  }
  const budget = preset.reasoning_budget ?? preset.thinking_budget ?? c.thinking_budget ?? 2048;
  return {
    mode,
    value: String(value ?? ""),
    budget: Number(budget) || 2048,
    kwargs: String(preset.reasoning_kwargs || ""),
    agentic: preset.agentic_format || "auto",
    soften: String(preset?.prompts?.reasoning_style || ""),
    descriptor: validDescriptor(preset.reasoning_modes, model)
  };
}

export function agenticWanted(r) {
  return !!r && (r.agentic === "on" || (r.agentic === "auto" && !!r.descriptor?.strict_roles));
}

// ---------- Payload application: exactly one knob shape, validated ----------
export function applyThinking(body, r) {
  const notes = [];
  const d = r?.descriptor;
  if (!r || r.mode === "off") return notes;

  if (r.mode === "effort") {
    let v = String(r.value || d?.effort?.default || "medium").toLowerCase();
    if (d?.effort?.values) {
      if (!d.effort.values.includes(v)) {
        const fallback = d.effort.default || d.effort.values[0];
        notes.push(`E_MODE_INVALID: effort "${v}" is not offered by ${d.model} (has ${d.effort.values.join("|")}) — using "${fallback}".`);
        v = fallback;
      }
    }
    body.reasoning_effort = v;
  } else if (r.mode === "budget") {
    let b = Number(r.budget);
    if (!Number.isFinite(b)) b = d?.budget?.default ?? 2048;
    if (d?.budget) {
      const clamped = Math.min(d.budget.max, Math.max(d.budget.min, b));
      if (clamped !== b) {
        notes.push(`E_MODE_INVALID: reasoning_budget ${b} clamped to ${clamped} (${d.model} allows ${d.budget.min}..${d.budget.max}).`);
        b = clamped;
      }
    }
    body.reasoning_budget = b;
  } else if (r.mode === "kwargs") {
    const modes = d?.kwargsModes;
    const v = String(r.value || "on");
    if (modes && modes[v]) {
      body.chat_template_kwargs = { ...modes[v] };
    } else {
      const obj = parseKwargsJson(r.kwargs, notes);
      if (obj) body.chat_template_kwargs = obj;
      else if (modes) notes.push(`E_MODE_INVALID: kwargs mode "${v}" unknown for ${d.model} (has ${Object.keys(modes).join("|")}).`);
    }
  } else if (r.mode === "anthropic") {
    const b = Math.max(1024, Number(r.budget) || 2048);
    body.thinking = { type: "enabled", budget_tokens: b };
  } else if (r.mode === "custom") {
    const obj = parseKwargsJson(r.kwargs, notes);
    if (obj) Object.assign(body, obj);
  }

  // Always-thinking checkpoints where max_tokens COVERS reasoning: a small
  // budget means the reply dies mid-thought with null content.
  if (d?.reasoning_in_max_tokens && Number(body.max_tokens) < 4096) {
    notes.push(`E_BUDGET_BUMP: max_tokens ${body.max_tokens} raised to 16384 — ${d.model} counts reasoning toward max_tokens.`);
    body.max_tokens = 16384;
  }
  return notes;
}

function parseKwargsJson(raw, notes) {
  const s = String(raw || "").trim();
  if (!s) return null;
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch { /* fall through */ }
  notes.push("E_MODE_INVALID: custom reasoning JSON is not an object — skipped.");
  return null;
}

// ---------- UI helpers ----------
export function modeValues(r) {
  if (!r) return [];
  if (r.mode === "effort") {
    return r.descriptor?.effort?.values || ["low", "medium", "high"];
  }
  if (r.mode === "kwargs") {
    const modes = r.descriptor?.kwargsModes;
    return modes ? Object.keys(modes) : ["on", "off"];
  }
  return [];
}

export function describeMode(r) {
  if (!r) return "off";
  if (r.mode === "off") return "off";
  if (r.mode === "effort") return `effort:${r.value || "auto"}`;
  if (r.mode === "budget") return `budget:${r.budget}`;
  if (r.mode === "kwargs") return `kwargs:${r.value || "on"}`;
  if (r.mode === "anthropic") return `anthropic:${r.budget}`;
  return "custom";
}
