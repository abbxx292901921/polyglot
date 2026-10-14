/* Polyglot prompt-engine — context pipeline, zero dependencies.
   Pure functions: macros, lorebook scan, token budget, depth inject, prefill.
   All card/lorebook text is treated as data; escaping happens at render time
   in app.js (renderRich), never here. */

const MACRO_DEPTH = 10;

function rollDice(spec) {
  const m = /^(\d+)d(\d+)$/i.exec(spec.trim());
  if (!m) return spec;
  const n = Math.min(100, parseInt(m[1], 10));
  const sides = Math.min(1000, parseInt(m[2], 10));
  if (!(n >= 1 && sides >= 1)) return spec;
  let total = 0;
  for (let i = 0; i < n; i++) total += 1 + Math.floor(Math.random() * sides);
  return String(total);
}

function pickRandom(spec) {
  const opts = spec.split(",").map((s) => s.trim()).filter((s) => s.length);
  if (!opts.length) return "";
  return opts[Math.floor(Math.random() * opts.length)];
}

// Recursively resolve {{char}} {{user}} {{persona}} {{time}} {{date}}
// {{random:a,b,c}} {{roll:XdY}}. Case-insensitive, max MACRO_DEPTH passes.
export function resolveMacros(text, ctx = {}) {
  let out = String(text ?? "");
  const now = new Date();
  const vars = {
    char: ctx.char ?? "",
    user: ctx.user ?? ctx.persona ?? "",
    persona: ctx.persona ?? ctx.user ?? ""
  };
  for (let d = 0; d < MACRO_DEPTH; d++) {
    let changed = false;
    out = out.replace(/\{\{\s*([a-zA-Z_]+)(?::([^{}]*))?\s*\}\}/g, (m, name, arg) => {
      changed = true;
      const key = name.toLowerCase();
      if (key === "char") return vars.char;
      if (key === "user") return vars.user;
      if (key === "persona") return vars.persona;
      if (key === "time") return now.toLocaleTimeString();
      if (key === "date") return now.toLocaleDateString();
      if (key === "random") return pickRandom(arg ?? "");
      if (key === "roll") return rollDice(arg ?? "");
      return m; // unknown macro: leave intact
    });
    if (!changed) break;
  }
  return out;
}

// Heuristic token estimate (~3.8 chars/token for English prose).
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).length / 3.8));
}

export function estimateMessages(messages) {
  let n = 0;
  for (const m of messages) n += estimateTokens(m.content) + 4;
  return n;
}

// Scan recent text (latest input + last 4 messages) for lorebook keyword hits.
// entries: [{keys:[...], content, enabled!==false, insertion_order}].
// Case-insensitive substring match. Sorted by insertion_order ascending.
export function scanLorebook(entries = [], recentText = "") {
  const hay = String(recentText ?? "").toLowerCase();
  if (!hay) return [];
  const hits = [];
  for (const e of entries) {
    if (!e || e.enabled === false) continue;
    const keys = Array.isArray(e.keys) ? e.keys : [];
    for (const k of keys) {
      const key = String(k ?? "").trim().toLowerCase();
      if (key && hay.includes(key)) {
        hits.push(e);
        break;
      }
    }
  }
  hits.sort((a, b) => (a.insertion_order ?? 0) - (b.insertion_order ?? 0));
  return hits;
}

// Insert authorsNote as a system message exactly `depth` turns above the
// latest message (depth=2 → 2 turns above). Clamped into range.
export function injectAtDepth(messages, noteContent, depth) {
  if (!noteContent) return messages;
  const out = [...messages];
  const d = Math.max(0, Math.min(out.length, Number(depth) || 0));
  out.splice(out.length - d, 0, { role: "system", content: noteContent });
  return out;
}

// Drop oldest non-system messages until the estimate fits
// (limit - maxTokens). System messages + the final message are never dropped.
export function applyTokenBudget(messages, { limit = 8192, maxTokens = 800 } = {}) {
  const budget = Math.max(512, limit - maxTokens);
  let msgs = [...messages];
  let dropped = 0;
  while (msgs.length > 1 && estimateMessages(msgs) > budget) {
    // Find oldest droppable index: not system, not the last message.
    const idx = msgs.findIndex((m, i) => i < msgs.length - 1 && m.role !== "system");
    if (idx === -1) break;
    msgs.splice(idx, 1);
    dropped++;
  }
  return { messages: msgs, estimated: estimateMessages(msgs), dropped };
}

// Full pipeline: macros → lorebook → depth inject → budget → prefill.
// history: [{role, content}] oldest→newest (already macro-safe raw text).
export function buildMessages({
  system = "",
  jailbreak = "",
  authorsNote = "",
  authorsNoteDepth = 2,
  loreEntries = [],
  activeLore = null,
  recentText = "",
  history = [],
  prefill = null,
  macroCtx = {},
  budget = {}
} = {}) {
  const sys = resolveMacros(system, macroCtx);
  const jb = jailbreak ? resolveMacros(jailbreak, macroCtx) : "";
  const note = authorsNote ? resolveMacros(authorsNote, macroCtx) : "";
  const lore = activeLore ?? scanLorebook(loreEntries, recentText);
  let msgs = [];
  if (sys) msgs.push({ role: "system", content: sys });
  for (const e of lore) {
    const c = resolveMacros(e.content || "", macroCtx);
    if (c) msgs.push({ role: "system", content: `[Lorebook: ${(e.keys || []).join(", ")}]\n${c}` });
  }
  if (jb) msgs.push({ role: "system", content: jb });
  for (const h of history) msgs.push({ role: h.role, content: h.content });
  if (note) msgs = injectAtDepth(msgs, note, authorsNoteDepth);
  const { messages, estimated, dropped } = applyTokenBudget(msgs, budget);
  if (prefill) messages.push({ role: "assistant", content: prefill });
  return { messages, estimated, dropped, loreHits: lore.length };
}
