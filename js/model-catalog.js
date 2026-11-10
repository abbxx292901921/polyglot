/* Polyglot model-catalog — pure normalization + capability helpers for a
   provider's /models response. Provider payloads are untrusted: every field
   is reduced to plain strings/numbers here, and the UI escapes what it paints.
   No DOM, no fetch, no storage. OpenRouter's richer model objects are the
   primary target; plain id lists and other OpenAI-compatible shapes still
   normalize to the same record. */

const str = (v) => (typeof v === "string" ? v.trim() : "");
const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const list = (v) => {
  const rows = Array.isArray(v) ? v : [];
  return [...new Set(rows.map(str).filter(Boolean))];
};

export function normalizeModelCatalog(json) {
  const rows = [];
  if (Array.isArray(json)) rows.push(...json);
  else if (Array.isArray(json?.data)) rows.push(...json.data);
  else if (Array.isArray(json?.models)) rows.push(...json.models);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (typeof row === "string") {
      const id = row.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        name: id,
        context_length: null,
        max_completion_tokens: null,
        pricing: null,
        input_modalities: [],
        output_modalities: [],
        supported_parameters: [],
        reasoning: null
      });
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const id = str(row.id || row.name || row.model);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const pricing = row.pricing && typeof row.pricing === "object"
      ? { prompt: num(row.pricing.prompt), completion: num(row.pricing.completion) }
      : null;
    const reasoning = row.reasoning && typeof row.reasoning === "object"
      ? {
          default_effort: str(row.reasoning.default_effort) || null,
          default_enabled: row.reasoning.default_enabled === true,
          mandatory: row.reasoning.mandatory === true,
          supported_efforts: list(row.reasoning.supported_efforts)
        }
      : null;
    out.push({
      id,
      name: str(row.name) || id,
      context_length: num(row.context_length),
      max_completion_tokens: num(row.max_completion_tokens ?? row.top_provider?.max_completion_tokens),
      pricing,
      input_modalities: list(row.architecture?.input_modalities),
      output_modalities: list(row.architecture?.output_modalities),
      supported_parameters: list(row.supported_parameters),
      reasoning
    });
  }
  return out;
}

export function modelMetaFor(catalog, id) {
  const key = str(id).toLowerCase();
  if (!key) return null;
  return (catalog || []).find((m) => m && str(m.id).toLowerCase() === key) || null;
}

export function filterModels(catalog, query, limit = 0) {
  const q = str(query).toLowerCase();
  const rows = (catalog || []).filter((m) => {
    if (!m || !m.id) return false;
    if (!q) return true;
    return `${m.id} ${m.name || ""}`.toLowerCase().includes(q);
  });
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  if (limit > 0) return rows.slice(0, limit);
  return rows;
}

// OpenRouter's model objects advertise reasoning effort values. Translate
// them into the same descriptor shape the thinking UI already understands,
// so a model picked from the list pre-fills its own effort options.
export function reasoningDescriptor(meta) {
  const r = meta?.reasoning;
  const values = list(r?.supported_efforts);
  if (!values.length) return null;
  const def = values.includes(str(r.default_effort)) ? str(r.default_effort) : values[0];
  return {
    model: str(meta.id),
    source: "provider",
    effort: { values, default: def },
    ...(r.mandatory && !values.includes("none") ? { always_thinks: true } : {}),
    hint: `reasoning_effort ${values.join("|")}${r.mandatory ? " (mandatory)" : ""}.`
  };
}

export function capabilitySet(meta) {
  const caps = list(meta?.supported_parameters).map((s) => s.toLowerCase());
  return caps.length ? new Set(caps) : null;
}

// Unknown capabilities mean "send it" so presets made before the picker, or
// providers that return bare id lists, keep their old wire shape.
export function capabilityAllows(meta, name) {
  const caps = capabilitySet(meta);
  return !caps || caps.has(String(name).toLowerCase());
}

export function formatContext(n) {
  const v = num(n);
  if (v == null || v <= 0) return "";
  if (v >= 1e6) {
    const m = v / 1e6;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (v >= 1000) return `${Math.round(v / 1000)}k`;
  return String(Math.round(v));
}

export function formatPricePerMillion(v) {
  const n = num(v);
  if (n == null || n < 0) return "";
  if (n === 0) return "free";
  const perM = n * 1e6;
  if (perM >= 100) return `$${perM.toFixed(0)}`;
  if (perM >= 10) return `$${perM.toFixed(2).replace(/\.?0+$/, "")}`;
  if (perM >= 1) return `$${perM.toFixed(3).replace(/\.?0+$/, "")}`;
  return `$${perM.toFixed(4).replace(/\.?0+$/, "")}`;
}

export function formatPricePair(pricing) {
  if (!pricing || typeof pricing !== "object") return "";
  const p = num(pricing.prompt);
  const c = num(pricing.completion);
  if (p == null && c == null) return "";
  if (p === 0 && c === 0) return "free";
  const inText = p == null ? "?" : formatPricePerMillion(p) || "?";
  const outText = c == null ? "?" : formatPricePerMillion(c) || "?";
  const per = (text) => (text === "free" || text === "?" ? text : `${text}/M`);
  return `${per(inText)} in / ${per(outText)} out`;
}
