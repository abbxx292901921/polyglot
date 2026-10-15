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

// ---------- Message tree (chat branching) ----------
// Rows are flat {id, chat_id, timestamp, role, content, parent_id?...}.
// parent_id links a message to its parent; rows without one (all pre-
// branch chats) form a linear chain in time order. All helpers are pure.

// Oldest-first sort shared by every tree walk.
export function sortRows(rows) {
  return [...(rows || [])].sort((a, b) =>
    (a.timestamp - b.timestamp) || (a.id - b.id));
}

// Map id -> effective parent id (null = root). An explicit parent_id wins
// when it points at another row of the same chat (deleted parents and
// cross-chat junk fall back to linear order).
export function parentMap(rows) {
  const sorted = sortRows(rows);
  const ids = new Set(sorted.map((m) => m.id));
  const map = new Map();
  sorted.forEach((m, i) => {
    const p = m.parent_id;
    map.set(m.id, (p != null && ids.has(p) && p !== m.id) ? p : (i > 0 ? sorted[i - 1].id : null));
  });
  return map;
}

// Walk from leafId back to the root, oldest-first. Guards cycles.
// leafId null/unknown -> latest message (classic linear behavior).
export function activeChain(rows, leafId = null) {
  const sorted = sortRows(rows);
  if (!sorted.length) return [];
  const byId = new Map(sorted.map((m) => [m.id, m]));
  const pmap = parentMap(sorted);
  let leaf = (leafId != null && byId.has(leafId)) ? byId.get(leafId) : sorted[sorted.length - 1];
  const chain = [];
  const seen = new Set();
  let cur = leaf;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    const p = pmap.get(cur.id);
    cur = p == null ? null : byId.get(p);
  }
  return chain;
}

// Map parent id (null = roots) -> child rows in time order, for the graph.
export function childrenMap(rows) {
  const sorted = sortRows(rows);
  const pmap = parentMap(sorted);
  const kids = new Map();
  for (const m of sorted) {
    const p = pmap.get(m.id);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(m);
  }
  return kids;
}

// Compact tree layout: depth (root = 0) + lane (DFS pre-order row) per id.
// Pure geometry for the SVG branch graph in app.js.
export function treeLayout(rows) {
  const sorted = sortRows(rows);
  const byId = new Map(sorted.map((m) => [m.id, m]));
  const pmap = parentMap(sorted);
  const kids = childrenMap(sorted);
  const depth = new Map();
  const getDepth = (id) => {
    if (depth.has(id)) return depth.get(id);
    const seen = new Set();
    let d = 0;
    let cur = id;
    while (pmap.get(cur) != null && !seen.has(cur)) {
      seen.add(cur);
      cur = pmap.get(cur);
      d++;
      if (!byId.has(cur)) break;
    }
    depth.set(id, d);
    return d;
  };
  const nodes = [];
  let lane = 0;
  const visit = (id) => {
    const m = byId.get(id);
    if (!m) return;
    nodes.push({ id, role: m.role, depth: getDepth(id), lane: lane++ });
    for (const k of (kids.get(id) || [])) visit(k.id);
  };
  for (const r of (kids.get(null) || kids.get(undefined) || [])) visit(r.id);
  if (!nodes.length) sorted.forEach((m) => nodes.push({ id: m.id, role: m.role, depth: 0, lane: lane++ }));
  return { nodes, maxDepth: nodes.reduce((a, n) => Math.max(a, n.depth), 0) };
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
