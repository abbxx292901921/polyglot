import { APP_VERSION, DEFAULT_CONNECTION, DEFAULT_PROVIDER, DEFAULT_SAMPLERS, DEFAULT_PROMPTS, THEMES } from "./config.js";
import { applyRules, compileRule, cleanFlags } from "./regex-engine.js";
import { STAGE_KEYS, STAGE_META, normalizeToggles, defaultStageToggles, parseDirector, directorBlocks, parseDice, diceBlocks, defaultWorldState, normalizeWorld, applyWorldCommand, formatWorldSheet, worldBlocks, defaultChessState, normalizeChess, parseChessTriggers, chessBlocks, renderBoardText, startChessGame, playChessTurn, forfeitChess, buildStageBlocks } from "./stages.js";
import { SUPERVISOR_ACTIONS, parseSupervisorReply, validateAction, normalizeAction, describeAction, buildSupervisorPrompt, localDraftCharacter, localPolishCharacter } from "./supervisor.js";
import {
  openDB,
  listCharacters,
  saveCharacter,
  deleteCharacter,
  listPersonas,
  savePersona,
  setDefaultPersona,
  deletePersona,
  listChats,
  saveChat,
  touchChat,
  deleteChat,
  listMessages,
  saveMessage,
  deleteMessage,
  listLorebooks,
  saveLorebook,
  deleteLorebook,
  listPresets,
  savePreset,
  deletePreset,
  listProviders,
  saveProvider,
  deleteProvider,
  listAllRegexRules,
  saveRegexRule,
  deleteRegexRule,
  listStages,
  saveStage,
  getStageState,
  saveStageState,
  listStageStates,
  seedStagesIfEmpty,
  exportVaultToJSON,
  importVaultFromJSON,
  seedIfEmpty
} from "./db.js";
import { buildMessages, estimateTokens, activeChain, parentMap, childrenMap, treeLayout } from "./prompt-engine.js";
import { sendChat, fetchModels } from "./api-client.js";
import { parsePNGCard, parseCharacterJSON, normalizeCharacter, fileToAvatarDataURL } from "./png-parser.js";
import {
  err as logErr, warn as logWarn, info as logInfo,
  recent as diagRecent, clearLog, report as diagReport
} from "./diagnostics.js";

/* Polyglot Phase 4: Agnai-style centered views.
   Library + vault (P1), streaming presets (P2), cards/swipes/edit (P3), plus:
   top-tab router (Home/Characters/Chat/Presets/Books), Recent Conversations
   grid, Characters search/sort/favorites, character-detail with subordinate
   chats, preset cards + editor tabs (General/Prompt/Memory/Samplers/Toggles),
   Memory Books manager, theme presets + *action* and "dialogue" colors.
   Without a configured model, generation falls back to the offline echo so
   every path stays testable with no network. */

const $ = (sel) => document.querySelector(sel);
const ui = {
  characterId: Number(localStorage.getItem("polyglot.characterId")) || null,
  chatId: Number(localStorage.getItem("polyglot.chatId")) || null,
  personaId: Number(localStorage.getItem("polyglot.personaId")) || null,
  presetId: Number(localStorage.getItem("polyglot.presetId")) || null,
  providerId: Number(localStorage.getItem("polyglot.providerId")) || null
};
function persistUI() {
  for (const k of ["characterId", "chatId", "personaId", "presetId", "providerId"]) {
    if (ui[k] == null) localStorage.removeItem(`polyglot.${k}`);
    else localStorage.setItem(`polyglot.${k}`, String(ui[k]));
  }
}

let aborter = null;
const generating = () => !!aborter;

// Character editor draft state (modal). Null id = new character.
let edId = null;
let edAvatar = null;
let edLore = [];
let edAlts = [];
let edExtra = {};
// Persona editor draft state (modal). Null id = new persona.
let edPersonaId = null;
// Full-screen chat graph state. Null = modal closed.
let graphState = null;

export function triggerHaptic(ms = 10) {
  try {
    if (localStorage.getItem("polyglot.haptic") === "off") return;
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch {
    /* iOS Safari has no vibration API — silently ignore. */
  }
}

function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - Number(ts || Date.now())) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo} mo ago`;
  return `${Math.floor(mo / 12)} yr ago`;
}

function getToggles() {
  try {
    const t = JSON.parse(localStorage.getItem("polyglot.toggles") || "null");
    if (t && typeof t === "object") {
      return {
        stream: t.stream !== false,
        thought: t.thought !== false,
        haptic: t.haptic !== false
      };
    }
  } catch { /* fall through to defaults */ }
  return { stream: true, thought: true, haptic: true };
}

function saveToggles(tg) {
  localStorage.setItem("polyglot.toggles", JSON.stringify(tg));
  localStorage.setItem("polyglot.haptic", tg.haptic ? "on" : "off");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Escape first (XSS-safe even for hostile card text), then light markdown:
// **bold**, *action* (muted italic), "dialogue" (bright), `code`, [[choices]],
// [links](url), bare URLs, <font color="..."> passthrough. Paragraphs preserved.
export function renderRich(text) {
  const paras = escapeHtml(text).split(/\n{2,}/);
  return paras
    .map((p) => {
      const codes = [];
      let h = p.replace(/\n/g, "<br>");
      h = h.replace(/`([^`\n]+)`/g, (_, code) => {
        codes.push(code);
        return `\u0000${codes.length - 1}\u0000`;
      });
      h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      h = h.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em class="action">*$2*</em>');
      h = h.replace(/(^|[\s(])_([^_\n]+)_(?![a-zA-Z0-9_])/g, "$1<em>$2</em>");
      h = h.replace(/~~([^~]+)~~/g, "<del>$1</del>");
      h = h.replace(/\[\[([^\[\]]+)\]\]/g, '<span class="choice">[[$1]]</span>');
      h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      h = h.replace(/(^|[\s(])((?:https?:\/\/)[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
      h = h.replace(/&quot;([^&\n]+)&quot;/g, '<span class="dialogue">&quot;$1&quot;</span>');
      h = h.replace(/&lt;font\s+color=(?:&quot;([^&]*)&quot;|&#39;([^&]*)&#39;)&gt;/gi, (m, dq, sq) => {
        const c = dq !== undefined ? dq : sq;
        return `<font color="${c}">`;
      });
      h = h.replace(/&lt;\/font&gt;/gi, "</font>");
      h = h.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
      return `<p>${h}</p>`;
    })
    .join("");
}

function scrollBottom() {
  $("#chat").scrollTop = $("#chat").scrollHeight;
}

// ---------- Phase 5: regex scripts ----------
// Rules are cached in memory (refreshed at init + after every mutation).
// Prompt rules rewrite outgoing context only — stored history is untouched.
// Display rules rewrite raw text just before renderRich (which still escapes
// afterwards, so the XSS guarantee is unchanged). Live stream chunks stay raw;
// the final bubble is filtered.
let cachedRegex = null;

async function getRegexRules() {
  if (!cachedRegex) {
    try {
      cachedRegex = await listAllRegexRules();
    } catch {
      cachedRegex = [];
    }
  }
  return cachedRegex;
}

function bumpRegexCache() {
  cachedRegex = null;
}

function renderMsg(raw, characterId = ui.characterId) {
  try {
    const rules = cachedRegex || [];
    if (!rules.length) return renderRich(raw);
    return renderRich(applyRules(raw, rules, { place: "display", characterId }).text);
  } catch {
    return renderRich(raw);
  }
}

function applyPromptMessages(messages, rules, characterId) {
  if (!rules.length) return { messages, skipped: [] };
  let skipped = [];
  const out = messages.map((m) => {
    if (typeof m.content !== "string" || !m.content) return m;
    const r = applyRules(m.content, rules, { place: "prompt", characterId });
    if (r.skipped.length) skipped = [...new Set([...skipped, ...r.skipped])];
    return r.text === m.content ? m : { ...m, content: r.text };
  });
  return { messages: out, skipped };
}

function paintShell(role, who) {
  const empty = $("#empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const w = document.createElement("div");
  w.className = "who";
  w.textContent = who;
  const det = document.createElement("details");
  det.className = "thought";
  det.open = true;
  const sum = document.createElement("summary");
  sum.textContent = "💭 Thought Trace…";
  const tb = document.createElement("div");
  tb.className = "thought-body";
  det.append(sum, tb);
  det.style.display = "none";
  const body = document.createElement("div");
  body.innerHTML = renderRich("");
  div.append(w, det, body);
  $("#chat").append(div);
  scrollBottom();
  return { div, det, sum, tb, body };
}

function paintError(text) {
  const s = paintShell("assistant", "Polyglot");
  s.det.remove();
  s.body.innerHTML = renderRich(text);
  s.body.classList.add("err");
  return s.div;
}

function clearChatView(emptyText = "No messages yet. Say hello.") {
  $("#chat").innerHTML = `<div class="empty" id="empty">${escapeHtml(emptyText)}</div>`;
}

async function ensureSelection() {
  const [chars, personas, presets, providers, chats] = await Promise.all([
    listCharacters(),
    listPersonas(),
    listPresets(),
    listProviders().catch(() => []),
    ui.characterId != null ? listChats(ui.characterId) : listChats()
  ]);
  if (personas.length && !personas.some((p) => p.id === ui.personaId)) {
    ui.personaId = (personas.find((p) => p.is_default) || personas[0]).id;
  }
  if (chars.length && !chars.some((c) => c.id === ui.characterId)) {
    ui.characterId = chars[0].id;
  }
  if (presets.length && !presets.some((p) => p.id === ui.presetId)) {
    ui.presetId = presets[0].id;
  }
  if (providers.length && !providers.some((p) => p.id === ui.providerId)) {
    ui.providerId = providers[0].id;
  }
  if (ui.characterId != null) {
    const mine = chats.filter((c) => c.character_id === ui.characterId);
    if (mine.length && !mine.some((c) => c.id === ui.chatId)) {
      mine.sort((a, b) => b.updated_at - a.updated_at);
      ui.chatId = mine[0].id;
    }
    if (!mine.length) ui.chatId = null;
  } else {
    ui.chatId = null;
  }
  persistUI();
}

async function ensureChat() {
  if (ui.chatId != null) return ui.chatId;
  if (ui.characterId == null) {
    const id = await saveCharacter({
      name: "Notebook",
      description: "A private scratchpad. Chats here stay on this device.",
      first_mes: "*opens a fresh page* What are we writing today?"
    });
    ui.characterId = id;
  }
  const personas = await listPersonas();
  const persona = personas.find((p) => p.id === ui.personaId) || personas[0];
  const id = await saveChat({
    character_id: ui.characterId,
    persona_id: persona?.id ?? null,
    title: "Chat 1"
  });
  ui.chatId = id;
  persistUI();
  const chars = await listCharacters();
  const ch = chars.find((c) => c.id === ui.characterId);
  if (ch?.first_mes) {
    await saveMessage({ chat_id: id, role: "assistant", content: ch.first_mes, timestamp: Date.now() });
  }
  return id;
}

// All openers for a card (first_mes + alternate_greetings), non-empty.
function charStarters(ch) {
  const out = [];
  if (ch?.first_mes && String(ch.first_mes).trim()) out.push(String(ch.first_mes));
  for (const g of (ch?.alternate_greetings || [])) {
    if (g && String(g).trim()) out.push(String(g));
  }
  return out;
}

async function createChatWithStarter(charId, idx = 0) {
  const chars = await listCharacters();
  const starters = charStarters(chars.find((c) => c.id === charId));
  const id = await saveChat({
    character_id: charId,
    persona_id: ui.personaId,
    title: `Chat ${new Date().toLocaleString()}`
  });
  const pick = starters[idx] ?? starters[0];
  if (pick) {
    await saveMessage({ chat_id: id, role: "assistant", content: pick, parent_id: null, timestamp: Date.now() });
  }
  ui.characterId = charId;
  ui.chatId = id;
  persistUI();
  await refreshLibrary();
  await renderCurrentChat();
  return id;
}

let pendingStarterChar = null;

function openStarterPicker(charId, starters, chName) {
  pendingStarterChar = charId;
  $("#starter-title").textContent = `Openings — ${chName || "Character"}`;
  const list = $("#starter-list");
  list.innerHTML = "";
  starters.forEach((s, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "starter-opt";
    const lab = document.createElement("strong");
    lab.textContent = i === 0 ? "Main greeting" : `Alternate ${i}`;
    const prev = document.createElement("span");
    prev.className = "starter-prev";
    prev.textContent = s.length > 160 ? `${s.slice(0, 160)}…` : s;
    b.append(lab, prev);
    b.addEventListener("click", async () => {
      $("#starter-modal").hidden = true;
      await createChatWithStarter(pendingStarterChar, i);
      showView("chat");
      closeDrawers();
    });
    list.append(b);
  });
  $("#starter-modal").hidden = false;
}

async function getActivePreset() {
  const presets = await listPresets();
  return presets.find((p) => p.id === ui.presetId) || presets[0] || null;
}

async function getActiveProvider() {
  try {
    const providers = await listProviders();
    return providers.find((p) => p.id === ui.providerId) || providers[0] || null;
  } catch {
    return null;
  }
}

function presetModel(p) {
  if (!p) return "";
  if (typeof p.model === "string" && p.model.trim()) return p.model.trim();
  if (typeof p.connection?.model === "string") return p.connection.model.trim();
  return "";
}

function presetReasoning(p) {
  const c = p?.connection || {};
  return {
    strategy: p?.reasoning_strategy || c.reasoning_strategy || "none",
    effort: p?.reasoning_effort || c.reasoning_effort || "medium",
    budget: p?.thinking_budget ?? c.thinking_budget ?? 2048
  };
}

// v1.4 presets embedded connection.*. v1.5 splits providers out so any
// provider mixes with any model preset. Migrate once, idempotently.
async function migrateLegacyPresetsIfNeeded() {
  const [presets, providers] = await Promise.all([
    listPresets(),
    listProviders().catch(() => [])
  ]);
  const legacy = presets.filter((p) => p?.connection && (p.connection.base_url || p.connection.api_key || p.connection.proxy_url || p.connection.use_proxy));
  if (!legacy.length) return;
  const byKey = new Map(providers.map((p) => [`${p.base_url || ""}‖${p.proxy_url || ""}`, p]));
  let activeProviderId = ui.providerId;
  for (const p of legacy) {
    const c = p.connection;
    const key = `${c.base_url || ""}‖${c.proxy_url || ""}`;
    let prov = byKey.get(key);
    if (!prov) {
      const pid = await saveProvider({
        name: c.label || p.name || "Migrated provider",
        base_url: c.base_url || DEFAULT_PROVIDER.base_url,
        api_key: c.api_key || "",
        use_proxy: c.use_proxy ? 1 : 0,
        proxy_url: c.proxy_url || ""
      });
      const fresh = await listProviders();
      prov = fresh.find((x) => x.id === pid);
      byKey.set(key, prov);
    }
    if (p.id === ui.presetId && activeProviderId == null) activeProviderId = prov.id;
    await savePreset({
      ...p,
      id: p.id,
      model: typeof p.model === "string" && p.model ? p.model : (c.model || ""),
      reasoning_strategy: p.reasoning_strategy || c.reasoning_strategy || "none",
      reasoning_effort: p.reasoning_effort || c.reasoning_effort || "medium",
      thinking_budget: p.thinking_budget ?? c.thinking_budget ?? 2048,
      connection: undefined,
      updated_at: Date.now()
    });
  }
  if (activeProviderId == null) {
    const all = await listProviders();
    if (all.length) activeProviderId = all[0].id;
  }
  if (activeProviderId != null) {
    ui.providerId = activeProviderId;
    persistUI();
  }
}

// ---------- Message tree (branches + swipe groups) ----------
// The visible history is the active chain: walk parent_id links back from
// the chat's active leaf (latest message when no leaf is set, so legacy
// chats behave exactly as before). Swipes stay orthogonal: variants share
// a swipe_group; pathIds marks which variant the chain passes through so
// the display matches the context even on non-active variants.
function groupRows(rows, pathIds = null) {
  // Returns ordered items: {kind:'user',msg} | {kind:'group',msgs:[...],active}
  const items = [];
  const byGroup = new Map();
  for (const m of rows) {
    if (m.role !== "assistant" || m.swipe_group_id == null) {
      items.push({ kind: m.role === "user" ? "user" : "solo", msg: m });
    } else {
      if (!byGroup.has(m.swipe_group_id)) {
        const g = { kind: "group", groupId: m.swipe_group_id, msgs: [] };
        byGroup.set(m.swipe_group_id, g);
        items.push(g);
      }
      byGroup.get(m.swipe_group_id).msgs.push(m);
    }
  }
  for (const it of items) {
    if (it.kind === "group") {
      it.msgs.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
      it.active = (pathIds && it.msgs.find((m) => pathIds.has(m.id)))
        || it.msgs.find((m) => m.swipe_active === 1)
        || it.msgs[it.msgs.length - 1];
    }
  }
  return items;
}

// Load a chat's full rows plus its visible chain. Returns
// {rows, chain, pathIds, chat, leafId, latestId, hidden} where hidden is
// the number of newer messages on other branches.
async function getChatChain(chatId) {
  const [rows, chats] = await Promise.all([listMessages(chatId), listChats()]);
  const chat = chats.find((c) => c.id === chatId) || null;
  const sorted = [...rows].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
  const latestId = sorted.length ? sorted[sorted.length - 1].id : null;
  const leafId = chat?.active_leaf_id ?? null;
  const chain = activeChain(rows, leafId);
  const pathIds = new Set(chain.map((m) => m.id));
  const effLeaf = chain.length ? chain[chain.length - 1].id : null;
  return { rows, chain, pathIds, chat, leafId: effLeaf, latestId, hidden: rows.length - chain.length };
}

// Point a chat's view at a message (rewind/fast-forward). The next sent
// message parents onto the leaf, forking a new branch automatically.
async function setActiveLeaf(chatId, msgId) {
  const chats = await listChats();
  const chat = chats.find((c) => c.id === chatId);
  if (!chat) return;
  await saveChat({ ...chat, active_leaf_id: msgId });
  await renderCurrentChat();
}

function clearBranchbar() {
  const bar = $("#branchbar");
  if (!bar) return;
  bar.innerHTML = "";
  bar.hidden = true;
}

// Slim bar above the transcript: off-branch banner + graph entry button.
function renderBranchbar(rows, chain, pathIds, { leafId, latestId, hidden }) {
  const bar = $("#branchbar");
  if (!bar) return;
  bar.innerHTML = "";
  if (!rows.length) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const offBranch = leafId !== latestId;
  if (offBranch || hidden) {
    const banner = document.createElement("div");
    banner.className = "branch-banner";
    const info = document.createElement("span");
    info.textContent = offBranch
      ? `On a branch — ${hidden} later message${hidden === 1 ? "" : "s"} on other branches hidden.`
      : `${hidden} message${hidden === 1 ? "" : "s"} on other branches.`;
    banner.append(info);
    if (offBranch) {
      banner.append(actionButton("Latest ▶", "Jump to the newest message", () =>
        setActiveLeaf(ui.chatId, latestId)));
    }
    bar.append(banner);
  }
  const grow = document.createElement("div");
  grow.className = "graph-open-row";
  const gb = document.createElement("button");
  gb.type = "button";
  gb.textContent = `⑂ Graph (${rows.length})`;
  gb.title = "Open the full chat graph";
  gb.addEventListener("click", openGraph);
  grow.append(gb);
  bar.append(grow);
}

// Collapse straight message runs into pills so long linear chats stay
// readable: [{ids, role, count}]. Fork nodes always stand alone.
function collapseRuns(rows) {
  const kids = childrenMap(rows);
  const pmap = parentMap(rows);
  const orderedKids = (id) => [...(kids.get(id) || [])]
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || a.id - b.id);
  const roots = rows
    .filter((m) => pmap.get(m.id) == null)
    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0) || a.id - b.id);
  const runs = [];
  const consumed = new Set();
  const queue = [...(roots.length ? roots : [...rows].sort((a, b) => a.id - b.id).slice(0, 1))];
  const seen = new Set(queue.map((m) => m.id));
  while (queue.length) {
    const m = queue.shift();
    for (const k of orderedKids(m.id)) {
      if (!seen.has(k.id)) { seen.add(k.id); queue.push(k); }
    }
    if (consumed.has(m.id)) continue;
    const p = pmap.get(m.id);
    // A run starts at roots and at children of forks. Anything else was
    // already consumed by the run above it.
    if (p != null && orderedKids(p).length === 1) continue;
    const run = [m];
    consumed.add(m.id);
    let cur = m;
    for (;;) {
      const ck = orderedKids(cur.id);
      if (ck.length !== 1) break;
      const nxt = ck[0];
      run.push(nxt);
      consumed.add(nxt.id);
      cur = nxt;
      if ((kids.get(nxt.id) || []).length !== 1) break;
    }
    runs.push(run);
  }
  // Orphan rows unreachable from any root (should not happen — parentMap
  // falls back to time order) still get rendered rather than dropped.
  for (const m of rows) {
    if (!consumed.has(m.id)) runs.push([m]);
  }
  return runs.map((ids) => ({ ids: ids.map((m) => m.id), role: ids[0].role, count: ids.length }));
}

function openGraph() {
  if (ui.chatId == null) return;
  graphState = {
    collapsed: true, horizontal: false, selectedId: null,
    k: 1, px: 0, py: 0, bbox: null, items: [], needsFit: true
  };
  $("#graph-modal").hidden = false;
  renderGraph().catch((e) => logErr("E_UI_GRAPH", e.message));
}

function closeGraph() {
  $("#graph-modal").hidden = true;
  graphState = null;
}

function graphFit() {
  const st = graphState;
  const view = $("#graph-view");
  if (!st || !view) return;
  const w = view.clientWidth || 300;
  const h = view.clientHeight || 300;
  const b = st.bbox;
  if (!b || b.w <= 0 || b.h <= 0) {
    st.k = 1; st.px = w / 2; st.py = h / 2;
    return;
  }
  st.k = Math.max(0.2, Math.min(w / (b.w + 60), h / (b.h + 60), 1.6));
  st.px = (w - b.w * st.k) / 2 - b.x * st.k;
  st.py = (h - b.h * st.k) / 2 - b.y * st.k;
}

function graphApplyTransform() {
  const st = graphState;
  const g = $("#graph-g");
  if (!st || !g) return;
  g.setAttribute("transform", `translate(${st.px},${st.py}) scale(${st.k})`);
}

function graphShowPreview(msgId) {
  const st = graphState;
  const prev = $("#graph-preview");
  if (!st || !prev) return;
  const m = st.byId.get(msgId);
  if (!m) {
    prev.hidden = true;
    prev.innerHTML = "";
    return;
  }
  prev.hidden = false;
  prev.innerHTML = "";
  const who = document.createElement("div");
  who.className = "who";
  who.textContent = m.role === "user" ? "You" : (st.chName || "AI");
  prev.append(who);
  const body = document.createElement("div");
  body.textContent = String(m.content || "").replace(/\s+/g, " ").slice(0, 160);
  prev.append(body);
}

async function renderGraph() {
  const st = graphState;
  if (!st || ui.chatId == null) return;
  const { rows, chain, pathIds, leafId } = await getChatChain(ui.chatId);
  const chars = await listCharacters();
  const ch = chars.find((c) => c.id === ui.characterId);
  st.chName = ch?.name || "AI";
  st.byId = new Map(rows.map((m) => [m.id, m]));
  st.pathIds = pathIds;
  st.leafId = leafId;
  if (st.selectedId != null && !st.byId.has(st.selectedId)) st.selectedId = null;
  const { nodes } = treeLayout(rows);
  const pos = new Map(nodes.map((n) => [n.id, n]));
  const DX = 46;
  const DY = 42;
  const items = [];
  const runs = st.collapsed ? collapseRuns(rows) : rows.map((m) => ({ ids: [m.id], role: m.role, count: 1 }));
  for (const run of runs) {
    const first = pos.get(run.ids[0]);
    const last = pos.get(run.ids[run.ids.length - 1]);
    if (!first || !last) continue;
    // Pill sits at the run's midpoint so edges stay attached.
    const d = (first.depth + last.depth) / 2;
    const l = (first.lane + last.lane) / 2;
    items.push({
      ...run,
      x: st.horizontal ? d * DX : l * DX,
      y: st.horizontal ? l * DY : d * DY
    });
  }
  // Edges link run endpoints: parent run -> child run via the actual
  // parent pointer of the child's first message.
  const pmap = parentMap(rows);
  const runOf = new Map();
  for (const it of items) for (const id of it.ids) runOf.set(id, it);
  const edges = [];
  const seenEdge = new Set();
  for (const it of items) {
    const firstId = it.ids[0];
    const p = pmap.get(firstId);
    if (p == null) continue;
    const pit = runOf.get(p);
    if (!pit || pit === it) continue;
    const key = `${pit.ids[pit.ids.length - 1]}>${firstId}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    edges.push({ a: pit, b: it, on: pathIds.has(firstId) && pathIds.has(p) });
  }
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const it of items) {
    minx = Math.min(minx, it.x); miny = Math.min(miny, it.y);
    maxx = Math.max(maxx, it.x); maxy = Math.max(maxy, it.y);
  }
  if (!items.length) {
    st.bbox = null;
  } else {
    st.bbox = { x: minx, y: miny, w: Math.max(1, maxx - minx), h: Math.max(1, maxy - miny) };
  }
  st.items = items;
  if (st.bbox == null || st.needsFit) {
    st.needsFit = false;
    graphFit();
  }

  const NS = "http://www.w3.org/2000/svg";
  const view = $("#graph-view");
  view.innerHTML = "";
  const svg = document.createElementNS(NS, "svg");
  const g = document.createElementNS(NS, "g");
  g.id = "graph-g";
  for (const e of edges) {
    const ln = document.createElementNS(NS, "line");
    ln.setAttribute("x1", e.a.x); ln.setAttribute("y1", e.a.y);
    ln.setAttribute("x2", e.b.x); ln.setAttribute("y2", e.b.y);
    ln.setAttribute("class", "gn-edge" + (e.on ? " on" : ""));
    g.append(ln);
  }
  for (const it of items) {
    const lastId = it.ids[it.ids.length - 1];
    if (it.count > 1) {
      const grp = document.createElementNS(NS, "g");
      grp.setAttribute("class", "gn-run" + (it.ids.some((id) => pathIds.has(id)) ? " on" : ""));
      grp.dataset.mid = String(lastId);
      const r = document.createElementNS(NS, "rect");
      r.setAttribute("x", it.x - 19); r.setAttribute("y", it.y - 12);
      r.setAttribute("width", "38"); r.setAttribute("height", "24");
      r.setAttribute("rx", "12");
      const t = document.createElementNS(NS, "text");
      t.setAttribute("x", it.x); t.setAttribute("y", it.y + 4);
      t.textContent = `×${it.count}`;
      const tip = document.createElementNS(NS, "title");
      tip.textContent = `${it.count} messages — tap to load through here`;
      grp.append(r, t, tip);
      g.append(grp);
    } else {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("cx", it.x); c.setAttribute("cy", it.y);
      c.setAttribute("r", lastId === leafId ? "10" : "8");
      c.dataset.mid = String(lastId);
      const m = st.byId.get(lastId);
      c.setAttribute("class", "gn-dot gn-" + (it.role === "user" ? "user" : "asst")
        + (pathIds.has(lastId) ? "" : " dim")
        + (lastId === leafId ? " leaf" : "")
        + (lastId === st.selectedId ? " sel" : ""));
      const tip = document.createElementNS(NS, "title");
      tip.textContent = `${it.role === "user" ? "You" : st.chName}: ${String(m?.content || "").replace(/\s+/g, " ").slice(0, 80)}`;
      c.append(tip);
      g.append(c);
      // Fat transparent hit area for thumbs.
      const hit = document.createElementNS(NS, "circle");
      hit.setAttribute("cx", it.x); hit.setAttribute("cy", it.y);
      hit.setAttribute("r", "22");
      hit.setAttribute("fill", "transparent");
      hit.dataset.mid = String(lastId);
      g.append(hit);
    }
  }
  svg.append(g);
  view.append(svg);
  graphApplyTransform();
  graphShowPreview(st.selectedId ?? leafId);
  graphWireGestures(view);
  const cb = $("#btn-graph-collapse");
  if (cb) cb.textContent = st.collapsed ? "Expand" : "Collapse";
}

// Pan (drag), pinch-zoom, wheel-zoom, and tap-to-load on nodes. Wired once
// per modal element; always acts on the live graphState (the modal can be
// closed and reopened, which replaces the state object).
function graphWireGestures(view) {
  if (!graphState || view.dataset.wired === "1") return;
  view.dataset.wired = "1";
  const pts = new Map();
  let pinchD = 0;
  let moved = 0;
  const midOf = (e) => {
    const t = e.target;
    return t && t.dataset && t.dataset.mid ? Number(t.dataset.mid) : null;
  };
  view.addEventListener("pointerdown", (e) => {
    view.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = 0;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinchD = Math.hypot(a.x - b.x, a.y - b.y);
    }
  });
  view.addEventListener("pointermove", (e) => {
    const st = graphState;
    if (!st || !pts.has(e.pointerId)) return;
    const prev = pts.get(e.pointerId);
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    moved += Math.abs(dx) + Math.abs(dy);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchD > 0 && d > 0) {
        const rect = view.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - rect.left;
        const my = (a.y + b.y) / 2 - rect.top;
        const k2 = Math.max(0.2, Math.min(4, st.k * d / pinchD));
        st.px = mx - (mx - st.px) * (k2 / st.k);
        st.py = my - (my - st.py) * (k2 / st.k);
        st.k = k2;
        graphApplyTransform();
      }
      pinchD = d;
      return;
    }
    if (pts.size === 1) {
      st.px += dx;
      st.py += dy;
      graphApplyTransform();
    }
  });
  const up = async (e) => {
    const st = graphState;
    const wasTap = moved < 10 && pts.size <= 1;
    const mid = midOf(e);
    pts.delete(e.pointerId);
    if (pts.size < 2) pinchD = 0;
    if (st && wasTap && mid != null && ui.chatId != null) {
      st.selectedId = mid;
      try {
        await setActiveLeaf(ui.chatId, mid);
      } catch (err) {
        logErr("E_UI_GRAPH", err.message);
      }
      if (graphState === st) await renderGraph();
    }
  };
  view.addEventListener("pointerup", up);
  view.addEventListener("pointercancel", (e) => { pts.delete(e.pointerId); pinchD = 0; });
  view.addEventListener("wheel", (e) => {
    const st = graphState;
    if (!st) return;
    e.preventDefault();
    const rect = view.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const k2 = Math.max(0.2, Math.min(4, st.k * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    st.px = mx - (mx - st.px) * (k2 / st.k);
    st.py = my - (my - st.py) * (k2 / st.k);
    st.k = k2;
    graphApplyTransform();
  }, { passive: false });
}

// Fork the selected (or current) node into a brand-new chat carrying that
// path's history, then open it.
async function forkChatFromGraph() {
  const st = graphState;
  if (!st || ui.chatId == null) return;
  const target = st.selectedId ?? st.leafId;
  if (target == null) return;
  const { rows } = await getChatChain(ui.chatId);
  const path = activeChain(rows, target);
  if (!path.length) return;
  const id = await saveChat({
    character_id: ui.characterId,
    persona_id: ui.personaId,
    title: `Fork ${new Date().toLocaleString()}`
  });
  let parent = null;
  for (const m of path) {
    parent = await saveMessage({
      chat_id: id,
      role: m.role,
      content: m.content,
      reasoning_content: m.reasoning_content || "",
      swipe_group_id: m.swipe_group_id || null,
      swipe_active: m.swipe_active || null,
      parent_id: parent,
      timestamp: m.timestamp || Date.now()
    });
  }
  await saveChat({
    id,
    character_id: ui.characterId,
    persona_id: ui.personaId,
    active_leaf_id: parent,
    title: `Fork ${new Date().toLocaleString()}`
  });
  ui.chatId = id;
  persistUI();
  await refreshLibrary();
  closeGraph();
  await renderCurrentChat();
}

function actionButton(label, title, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    fn();
  });
  return b;
}

function attachSwipe(el, onPrev, onNext) {
  let x0 = 0;
  let y0 = 0;
  el.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    x0 = e.touches[0].clientX;
    y0 = e.touches[0].clientY;
  }, { passive: true });
  el.addEventListener("touchend", (e) => {
    if (e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - x0;
    const dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) onNext();
      else onPrev();
    }
  }, { passive: true });
}

async function setActiveSibling(chatId, groupId, msgId) {
  const rows = await listMessages(chatId);
  const sibs = rows.filter((m) => m.swipe_group_id === groupId);
  for (const s of sibs) {
    if ((s.id === msgId) !== (s.swipe_active === 1)) {
      await saveMessage({ ...s, swipe_active: s.id === msgId ? 1 : 0 });
    }
  }
  await renderCurrentChat();
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(String(text ?? ""));
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = String(text ?? "");
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  } catch (e) {
    logWarn("E_UI_SEND", `copy failed: ${e?.message || e}`);
  }
}

function openEditorBubble(div, msg, onSave) {
  const body = div.querySelector(".msgbody");
  const acts = div.querySelector(".acts");
  if (!body || div.querySelector(".editbox")) return;
  body.style.display = "none";
  if (acts) acts.style.display = "none";
  const ta = document.createElement("textarea");
  ta.className = "editbox";
  ta.rows = 4;
  ta.value = msg.content;
  const row = document.createElement("div");
  row.className = "acts";
  const save = actionButton("Save", "Save edit", async () => {
    await onSave(ta.value);
  });
  const cancel = actionButton("Cancel", "Cancel edit", () => renderCurrentChat());
  row.append(save, cancel);
  div.append(ta, row);
  ta.focus();
}

async function renderCurrentChat() {
  await ensureSelection();
  await getRegexRules();
  if (ui.chatId == null) {
    if (ui.characterId == null) {
      clearBranchbar();
      clearChatView("No characters yet. Tap ☰ to create or import one.");
      return;
    }
    const mine = await listChats(ui.characterId);
    if (!mine.length) {
      const chars = await listCharacters();
      const ch = chars.find((c) => c.id === ui.characterId);
      clearBranchbar();
      $("#chat").innerHTML = "";
      if (ch?.first_mes) {
        const s = paintShell("assistant", ch.name);
        s.det.remove();
        s.body.innerHTML = renderMsg(ch.first_mes);
        s.body.classList.add("msgbody");
      } else clearChatView("No messages yet. Say hello.");
      return;
    }
    mine.sort((a, b) => b.updated_at - a.updated_at);
    ui.chatId = mine[0].id;
    persistUI();
  }
  const { rows, chain, pathIds, leafId, latestId, hidden } = await getChatChain(ui.chatId);
  const [chars, personas] = await Promise.all([listCharacters(), listPersonas()]);
  const ch = chars.find((c) => c.id === ui.characterId);
  const me = personas.find((p) => p.id === ui.personaId);
  const chName = ch?.name || "Polyglot";
  const meName = me?.name || "You";
  renderBranchbar(rows, chain, pathIds, { leafId, latestId, hidden });
  $("#chat").innerHTML = "";
  if (!rows.length) {
    if (ch?.first_mes) {
      const s = paintShell("assistant", chName);
      s.det.remove();
      s.body.innerHTML = renderMsg(ch.first_mes);
    } else {
      const s = paintShell("assistant", "Polyglot");
      s.det.remove();
      s.body.innerHTML = renderRich("*ready* This chat is stored on-device.");
    }
    return;
  }
  const items = groupRows(chain, pathIds);
  items.forEach((it, ii) => {
    const isLast = ii === items.length - 1;
    if (it.kind === "user") {
      const div = document.createElement("div");
      div.className = "msg user";
      div.innerHTML = `<div class="who">${escapeHtml(meName)}</div>`;
      const body = document.createElement("div");
      body.className = "msgbody";
      body.innerHTML = renderMsg(it.msg.content);
      const acts = document.createElement("div");
      acts.className = "acts";
      acts.append(
        actionButton("↻ Retry", "Regenerate the reply after this message", () => handleRetryFromUser(it.msg)),
        actionButton("✎ Edit", "Edit message", () =>
          openEditorBubble(div, it.msg, async (v) => {
            await saveMessage({ ...it.msg, content: v });
            await renderCurrentChat();
          })),
        actionButton("⧉ Copy", "Copy message text", async () => {
          await copyText(it.msg.content);
        }),
        actionButton("⑂ Branch", "Rewind to here — your next message starts a new branch", () =>
          setActiveLeaf(ui.chatId, it.msg.id)),
        actionButton("🗑 Delete", "Delete message", async () => {
          if (!window.confirm("Delete this message?")) return;
          await deleteMessage(it.msg.id);
          await renderCurrentChat();
        })
      );
      div.append(body, acts);
      $("#chat").append(div);
      return;
    }
    // Assistant: solo or swipe group share one renderer.
    const sibs = it.kind === "group" ? it.msgs : [it.msg];
    const active = it.kind === "group" ? it.active : it.msg;
    const idx = sibs.indexOf(active);
    const div = document.createElement("div");
    div.className = "msg assistant";
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = chName;
    div.append(who);
    if (active.reasoning_content && getToggles().thought) {
      const det = document.createElement("details");
      det.className = "thought";
      const sum = document.createElement("summary");
      sum.textContent = `💭 Thought Trace (~${estimateTokens(active.reasoning_content)} tok)`;
      const tb = document.createElement("div");
      tb.className = "thought-body";
      tb.textContent = active.reasoning_content;
      det.append(sum, tb);
      div.append(det);
    }
    const body = document.createElement("div");
    body.className = "msgbody";
    body.innerHTML = renderMsg(active.content);
    div.append(body);
    const acts = document.createElement("div");
    acts.className = "acts";
    if (sibs.length > 1) {
      const prev = actionButton("◀", "Previous variant", async () => {
        const n = sibs[(idx - 1 + sibs.length) % sibs.length];
        triggerHaptic(10);
        await setActiveSibling(ui.chatId, it.groupId, n.id);
      });
      const pg = document.createElement("span");
      pg.className = "pg";
      pg.textContent = `${idx + 1}/${sibs.length}`;
      const next = actionButton("▶", "Next variant", async () => {
        const n = sibs[(idx + 1) % sibs.length];
        triggerHaptic(10);
        await setActiveSibling(ui.chatId, it.groupId, n.id);
      });
      acts.append(prev, pg, next);
      attachSwipe(div, () => prev.click(), () => next.click());
    }
    acts.append(
      actionButton("↻ Regenerate", "Regenerate (new variant)", () => handleRetry(it)),
      actionButton("✎ Edit", "Edit AI message", () =>
        openEditorBubble(div, active, async (v) => {
          await saveMessage({ ...active, content: v, updated_at: Date.now() });
          await renderCurrentChat();
        })),
      actionButton("⧉ Copy", "Copy message text", async () => {
        await copyText(active.content);
      }),
      actionButton("⑂ Branch", "Rewind to here — your next message starts a new branch", () =>
        setActiveLeaf(ui.chatId, active.id)),
      actionButton("🗑 Delete", "Delete message", async () => {
        if (!window.confirm("Delete this message?")) return;
        await deleteMessage(active.id);
        await renderCurrentChat();
      })
    );
    if (isLast) {
      acts.append(actionButton("▶| Continue", "Continue this reply", () => handleContinue()));
    }
    div.append(acts);
    $("#chat").append(div);
  });
  scrollBottom();
}

// ---------- Library ----------
async function refreshLibrary() {
  const [personas, chars, chats] = await Promise.all([
    listPersonas(),
    listCharacters(),
    ui.characterId != null ? listChats(ui.characterId) : Promise.resolve([])
  ]);

  const pl = $("#persona-list");
  pl.innerHTML = "";
  for (const p of personas) {
    const row = document.createElement("div");
    row.className = "row" + (p.id === ui.personaId ? " active" : "");
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = `${p.name}${p.is_default ? " ★" : ""}`;
    nm.title = p.description?.trim() ? p.description.trim() : "Tap to switch";
    nm.style.cursor = "pointer";
    nm.addEventListener("click", async () => {
      ui.personaId = p.id;
      await setDefaultPersona(p.id);
      persistUI();
      await refreshLibrary();
      await renderCurrentChat();
    });
    row.append(nm);
    const ed = document.createElement("button");
    ed.className = "x";
    ed.textContent = "✎";
    ed.setAttribute("aria-label", `Edit ${p.name}`);
    ed.addEventListener("click", () => openPersonaEditor(p.id));
    row.append(ed);
    if (personas.length > 1) {
      const x = document.createElement("button");
      x.className = "x";
      x.textContent = "×";
      x.setAttribute("aria-label", `Delete ${p.name}`);
      x.addEventListener("click", async () => {
        if (!window.confirm(`Delete persona "${p.name}"?`)) return;
        await deletePersona(p.id);
        if (ui.personaId === p.id) ui.personaId = null;
        persistUI();
        await ensureSelection();
        await refreshLibrary();
        await renderCurrentChat();
      });
      row.append(x);
    }
    pl.append(row);
  }

  const cl = $("#char-list");
  cl.innerHTML = "";
  for (const c of chars) {
    const row = document.createElement("div");
    row.className = "row" + (c.id === ui.characterId ? " active" : "");
    if (c.avatar) {
      const img = document.createElement("img");
      img.src = c.avatar;
      img.alt = "";
      img.style.cssText = "width:24px;height:24px;border-radius:50%;object-fit:cover;flex:0 0 auto;";
      row.append(img);
    }
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = c.name;
    nm.style.cursor = "pointer";
    nm.title = "Tap to open";
    nm.addEventListener("click", async () => {
      ui.characterId = c.id;
      ui.chatId = null;
      persistUI();
      await ensureSelection();
      await refreshLibrary();
      await renderCurrentChat();
      closeDrawers();
    });
    row.append(nm);
    const ed = document.createElement("button");
    ed.className = "x";
    ed.textContent = "✎";
    ed.setAttribute("aria-label", `Edit ${c.name}`);
    ed.addEventListener("click", () => openCharEditor(c.id));
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "×";
    x.setAttribute("aria-label", `Delete ${c.name}`);
    x.addEventListener("click", async () => {
      if (!window.confirm(`Delete "${c.name}" and all its chats?`)) return;
      await deleteCharacter(c.id);
      if (ui.characterId === c.id) {
        ui.characterId = null;
        ui.chatId = null;
      }
      persistUI();
      await ensureSelection();
      await refreshLibrary();
      await renderCurrentChat();
    });
    row.append(ed, x);
    cl.append(row);
  }

  const hl = $("#chat-list");
  hl.innerHTML = "";
  const sorted = [...chats].sort((a, b) => b.updated_at - a.updated_at);
  for (const h of sorted) {
    const row = document.createElement("div");
    row.className = "row" + (h.id === ui.chatId ? " active" : "");
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = h.title || `Chat ${h.id}`;
    nm.style.cursor = "pointer";
    nm.addEventListener("click", async () => {
      ui.chatId = h.id;
      persistUI();
      await refreshLibrary();
      await renderCurrentChat();
      closeDrawers();
    });
    row.append(nm);
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "×";
    x.setAttribute("aria-label", "Delete chat");
    x.addEventListener("click", async () => {
      if (!window.confirm("Delete this chat and its messages?")) return;
      await deleteChat(h.id);
      if (ui.chatId === h.id) ui.chatId = null;
      persistUI();
      await ensureSelection();
      await refreshLibrary();
      await renderCurrentChat();
    });
    row.append(x);
    hl.append(row);
  }
  refreshViews();
}

// ---------- Providers + model presets (v1.5 split, mix-and-match) ----------
function setPresetStatus(msg) {
  const el = $("#preset-status");
  if (el) el.textContent = msg;
}

function setProviderStatus(msg) {
  const el = $("#provider-status");
  if (el) el.textContent = msg;
}

function readPresetForm() {
  const stops = $("#sam-stop").value.split("\n").map((s) => s.trim()).filter((s) => s.length);
  return {
    name: $("#conn-label").value.trim() || "Preset",
    model: $("#conn-model").value.trim(),
    reasoning_strategy: $("#conn-strategy").value || "none",
    reasoning_effort: $("#conn-effort").value || "medium",
    thinking_budget: Number($("#conn-budget").value) || 2048,
    samplers: {
      temperature: Number($("#sam-temp").value),
      top_p: Number($("#sam-topp").value),
      top_k: Number($("#sam-topk").value),
      min_p: Number($("#sam-minp").value),
      max_tokens: Number($("#sam-max").value),
      context_window_limit: Number($("#sam-ctx").value) || 8192,
      frequency_penalty: Number($("#sam-freq").value) || 0,
      presence_penalty: Number($("#sam-pres").value) || 0,
      stop: stops
    },
    prompts: {
      system: $("#pr-system").value,
      jailbreak: $("#pr-jailbreak").value,
      authors_note: $("#pr-note").value,
      authors_note_depth: Number($("#pr-depth").value) || 0,
      prefill_enabled: $("#pr-prefill-use").checked,
      prefill_text: $("#pr-prefill-text").value
    }
  };
}

function fillPresetForm(preset) {
  if (!preset) return;
  const s = preset.samplers || {};
  const p = preset.prompts || {};
  const r = presetReasoning(preset);
  $("#conn-label").value = preset.name || "";
  $("#conn-model").value = presetModel(preset);
  $("#conn-strategy").value = r.strategy || "none";
  $("#conn-effort").value = r.effort || "medium";
  $("#conn-budget").value = r.budget ?? 2048;
  $("#sam-temp").value = s.temperature ?? 0.9;
  $("#sam-topp").value = s.top_p ?? 1.0;
  $("#sam-topk").value = s.top_k ?? 0;
  $("#sam-minp").value = s.min_p ?? 0;
  $("#sam-max").value = s.max_tokens ?? 800;
  $("#sam-ctx").value = s.context_window_limit ?? 8192;
  $("#sam-freq").value = s.frequency_penalty ?? 0;
  $("#sam-pres").value = s.presence_penalty ?? 0;
  $("#sam-stop").value = (s.stop || []).join("\n");
  $("#pr-system").value = p.system || "";
  $("#pr-jailbreak").value = p.jailbreak || "";
  $("#pr-note").value = p.authors_note || "";
  $("#pr-depth").value = p.authors_note_depth ?? 2;
  $("#pr-prefill-use").checked = !!p.prefill_enabled;
  $("#pr-prefill-text").value = p.prefill_text || "";
}

function readProviderForm() {
  return {
    name: $("#prov-name").value.trim() || "Provider",
    base_url: $("#prov-url").value.trim(),
    api_key: $("#prov-key").value,
    use_proxy: $("#prov-proxy-use").checked ? 1 : 0,
    proxy_url: $("#prov-proxy-url").value.trim()
  };
}

function fillProviderForm(prov) {
  if (!prov) return;
  $("#prov-name").value = prov.name || "";
  $("#prov-url").value = prov.base_url || "";
  $("#prov-key").value = prov.api_key || "";
  $("#prov-proxy-use").checked = !!prov.use_proxy;
  $("#prov-proxy-url").value = prov.proxy_url || "";
}

function refreshModelDatalist(models) {
  const dl = $("#model-choices");
  if (!dl) return;
  dl.innerHTML = "";
  for (const m of models || []) {
    const o = document.createElement("option");
    o.value = m;
    dl.append(o);
  }
  const sel = $("#prov-models");
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = "";
    const hint = document.createElement("option");
    hint.value = "";
    hint.textContent = (models && models.length) ? `${models.length} models — pick one, then Use in preset` : "Fetch models to list them here";
    sel.append(hint);
    for (const m of models || []) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      sel.append(o);
    }
    if (cur && models && models.includes(cur)) sel.value = cur;
  }
}

let cachedModels = [];

async function refreshPresets() {
  const presets = await listPresets();
  if (!presets.some((p) => p.id === ui.presetId) && presets.length) {
    ui.presetId = presets[0].id;
    persistUI();
  }
  const box = $("#preset-list");
  if (box) {
    box.innerHTML = "";
    for (const p of presets) {
      const row = document.createElement("div");
      row.className = "row" + (p.id === ui.presetId ? " active" : "");
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = `${p.name || "Preset"} — ${presetModel(p) || "no model"}`;
      nm.style.cursor = "pointer";
      nm.title = "Tap to select this model preset";
      nm.addEventListener("click", async () => {
        const cur = await getActivePreset();
        if (cur && cur.id === ui.presetId) await savePreset({ ...cur, ...readPresetForm(), id: cur.id });
        ui.presetId = p.id;
        persistUI();
        const fresh = await listPresets();
        fillPresetForm(fresh.find((x) => x.id === p.id) || p);
        await refreshPresets();
        updateComboLabels();
        setPresetStatus("");
      });
      row.append(nm);
      box.append(row);
    }
  }
  const active = presets.find((p) => p.id === ui.presetId) || presets[0];
  if (active) fillPresetForm(active);
  updateComboLabels();
}

async function refreshProviders() {
  let providers = [];
  try {
    providers = await listProviders();
  } catch {
    providers = [];
  }
  if (!providers.some((p) => p.id === ui.providerId) && providers.length) {
    ui.providerId = providers[0].id;
    persistUI();
  }
  const box = $("#provider-list");
  if (box) {
    box.innerHTML = "";
    for (const p of providers) {
      const row = document.createElement("div");
      row.className = "row" + (p.id === ui.providerId ? " active" : "");
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = p.name || "Provider";
      nm.style.cursor = "pointer";
      nm.title = (p.base_url || "") + " — tap to select this provider";
      nm.addEventListener("click", async () => {
        const cur = await getActiveProvider();
        if (cur && cur.id === ui.providerId) {
          try {
            await saveProvider({ ...cur, ...readProviderForm(), id: cur.id });
          } catch { /* keep selection moving */ }
        }
        ui.providerId = p.id;
        persistUI();
        const fresh = await listProviders();
        fillProviderForm(fresh.find((x) => x.id === p.id) || p);
        cachedModels = [];
        refreshModelDatalist([]);
        await refreshProviders();
        updateComboLabels();
        setProviderStatus("");
      });
      row.append(nm);
      box.append(row);
    }
  }
  const active = providers.find((p) => p.id === ui.providerId) || providers[0];
  if (active) fillProviderForm(active);
  updateComboLabels();
}

function updateComboLabels() {
  const label = async () => {
    const [prov, pre] = await Promise.all([getActiveProvider(), getActivePreset()]);
    const txt = `Using: ${prov?.name || "no provider"} → ${pre?.name || "no preset"} (${presetModel(pre) || "no model"})`;
    const a = $("#active-combo");
    if (a) a.textContent = txt;
    const b = $("#preset-combo");
    if (b) b.textContent = txt;
  };
  label();
}

async function handleFetchModels() {
  const form = readProviderForm();
  setProviderStatus("Fetching models…");
  try {
    const models = await fetchModels(form);
    cachedModels = models;
    refreshModelDatalist(models);
    setProviderStatus(models.length ? `Found ${models.length} models.` : "No models returned — check the base URL.");
    logInfo("E_PROVIDER", `models fetched (${models.length})`);
  } catch (e) {
    logErr("E_PROVIDER", e.message);
    setProviderStatus(`Fetch failed: ${e.message}`);
  }
  refreshDiag();
}

async function handleTestConnection() {
  const form = readProviderForm();
  setProviderStatus("Testing…");
  try {
    const models = await fetchModels(form);
    cachedModels = models;
    refreshModelDatalist(models);
    setProviderStatus(models.length ? `OK — ${models.length} models reachable.` : "OK — reachable, but /models was empty.");
    logInfo("E_PROVIDER", "connection test ok");
  } catch (e) {
    logErr("E_PROVIDER", e.message);
    setProviderStatus(`Test failed: ${e.message}`);
  }
  refreshDiag();
}

// ---------- Diagnostics panel ----------
function refreshDiag() {
  const box = $("#diag-log");
  if (!box) return;
  const rows = diagRecent(30);
  box.textContent = rows.length
    ? rows.map((e) => `${e.t.slice(11, 19)} [${e.level}] ${e.code}: ${e.msg}`).join("\n")
    : "No events yet.";
}

function diagNote(msg) {
  const d = $("#diag-status");
  if (d) d.textContent = msg;
}

// ---------- Context + generation core ----------
async function buildContext(pastRows, extraUserText = "") {
  const [chars, personas, preset, provider] = await Promise.all([
    listCharacters(),
    listPersonas(),
    getActivePreset(),
    getActiveProvider()
  ]);
  const ch = chars.find((c) => c.id === ui.characterId);
  const me = personas.find((p) => p.id === ui.personaId);
  const macroCtx = { char: ch?.name || "", user: me?.name || "You", persona: me?.name || "You" };
  const books = ui.characterId != null ? await listLorebooks(ui.characterId) : [];
  const flatLore = [];
  books.forEach((b, bi) => {
    (b.entries || []).forEach((e, ei) => {
      flatLore.push({
        keys: e.keys || e.keywords || [],
        content: e.content || "",
        enabled: e.enabled !== false,
        insertion_order: e.insertion_order ?? (bi * 1000 + ei)
      });
    });
  });
  const recent = [extraUserText, ...pastRows.slice(-4).map((m) => m.content)].join("\n");
  const history = pastRows.map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content
  }));
  const charSecs = [];
  if (ch?.description?.trim()) charSecs.push(ch.description.trim());
  if (ch?.personality?.trim()) charSecs.push(`Personality: ${ch.personality.trim()}`);
  if (ch?.scenario?.trim()) charSecs.push(`Scenario: ${ch.scenario.trim()}`);
  if (ch?.mes_example?.trim()) charSecs.push(`Example dialogue:\n${ch.mes_example.trim()}`);
  const charHead = charSecs.join("\n\n");
  const meHead = me?.description?.trim()
    ? `User persona (${(me.name || "You").trim()}): ${me.description.trim()}`
    : "";
  const sysBase = [preset?.prompts?.system || "", meHead, ch?.system_prompt?.trim() || "", charHead]
    .filter((s) => s && s.trim()).join("\n\n");
  // Phase 6: stage blocks (director/world/dice/chess) as system messages after lore.
  let stageBlocks = [];
  try {
    if (ui.chatId != null) {
      const [defs, states] = await Promise.all([listStages().catch(() => []), listStageStates(ui.chatId).catch(() => [])]);
      const toggles = defaultStageToggles();
      for (const d of (defs || [])) {
        if (d && d.key && toggles[d.key] !== undefined) toggles[d.key] = d.enabled ? 1 : 0;
      }
      try {
        const all = await listChats();
        const cur = all.find((c) => c.id === ui.chatId);
        if (cur && cur.stages && typeof cur.stages === "object") {
          const nt = normalizeToggles(cur.stages);
          for (const k of STAGE_KEYS) toggles[k] = nt[k];
        }
      } catch {
        // Per-chat override is optional; globals stand.
      }
      const stateMap = {};
      for (const s of (states || [])) {
        if (s && s.stage_key) stateMap[s.stage_key] = s.state || {};
      }
      stageBlocks = buildStageBlocks({ toggles, states: stateMap, lastUserText: extraUserText || recent || "" });
    }
  } catch (e) {
    try { logWarn("E_STAGE_STATE", "stage inject skipped: " + (e?.message || e)); } catch { /* noop */ }
    stageBlocks = [];
  }
  const built = buildMessages({
    system: sysBase,
    jailbreak: preset?.prompts?.jailbreak || "",
    authorsNote: preset?.prompts?.authors_note || "",
    authorsNoteDepth: preset?.prompts?.authors_note_depth ?? 2,
    loreEntries: flatLore,
    activeLore: null,
    stageBlocks,
    recentText: recent,
    history,
    prefill: preset?.prompts?.prefill_enabled ? preset.prompts.prefill_text || "*" : null,
    macroCtx,
    budget: {
      limit: preset?.samplers?.context_window_limit ?? 8192,
      maxTokens: preset?.samplers?.max_tokens ?? 800
    }
  });
  // Phase 5: prompt-scoped regex scripts rewrite outgoing context only.
  try {
    const rx = await getRegexRules();
    if (rx.length) {
      const r = applyPromptMessages(built.messages, rx, ui.characterId);
      built.messages = r.messages;
      if (r.skipped.length) logWarn("E_REGEX_RULE", `skipped invalid pattern: ${r.skipped.join(", ")}`);
    }
  } catch {
    /* regex must never break the send path */
  }
  return { preset, provider, ch, me, chName: ch?.name || "Polyglot", meName: me?.name || "You", built };
}

// Streams provider+preset messages into a live shell. Resolves {content, reasoning}.
async function runStream(preset, provider, messages, shell, signal) {
  const t0 = Date.now();
  const tg = getToggles();
  let acc = "";
  let accThink = "";
  const renderLive = () => {
    if (tg.stream) shell.body.innerHTML = renderRich(acc);
    if (accThink && tg.thought) {
      shell.det.style.display = "";
      shell.tb.textContent = accThink;
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      shell.sum.textContent = `💭 Thought Trace (${secs}s • ~${estimateTokens(accThink)} tok) [Tap to view]`;
    }
    scrollBottom();
  };
  const { content, reasoning } = await sendChat({
    provider: provider || undefined,
    preset,
    connection: preset?.connection,
    samplers: preset?.samplers,
    messages,
    signal,
    onContent: (t) => { acc += t; renderLive(); },
    onReasoning: (t) => { accThink += t; renderLive(); }
  });
  shell.body.innerHTML = renderMsg(content || acc);
  if ((reasoning || accThink) && tg.thought) {
    shell.det.style.display = "";
    shell.tb.textContent = reasoning || accThink;
  }
  shell.det.open = false;
  scrollBottom();
  return { content: content || acc, reasoning: reasoning || accThink };
}

function offlineEcho(text, who) {
  return `*considers your words* "Offline vault works — this reply is saved on-device." You said: ${text}`;
}

async function touchChatById(chatId, titleHint = "") {
  const chat = (await listChats()).find((c) => c.id === chatId);
  if (!chat) return;
  if (titleHint && (!chat.title || chat.title.startsWith("Chat "))) chat.title = titleHint.slice(0, 42);
  await touchChat(chat);
}

// Phase 6: deterministic stage pre-pass on the fresh user text. Never fatal.
async function runStagePrepass(chatId, userText) {
  try {
    const text = String(userText || "");
    if (!text.trim() || chatId == null) return;
    const [defs, states] = await Promise.all([listStages().catch(() => []), listStageStates(chatId).catch(() => [])]);
    const toggles = defaultStageToggles();
    for (const d of (defs || [])) {
      if (d && d.key && toggles[d.key] !== undefined) toggles[d.key] = d.enabled ? 1 : 0;
    }
    try {
      const all = await listChats();
      const cur = all.find((c) => c.id === chatId);
      if (cur && cur.stages && typeof cur.stages === "object") {
        const nt = normalizeToggles(cur.stages);
        for (const k of STAGE_KEYS) toggles[k] = nt[k];
      }
    } catch { /* optional override */ }
    const byKey = {};
    for (const s of (states || [])) {
      if (s && s.stage_key) byKey[s.stage_key] = s;
    }
    if (toggles.world) {
      const cur = normalizeWorld(byKey.world?.state);
      const upd = applyWorldCommand(cur, text);
      if (upd.changed) {
        await saveStageState(chatId, "world", upd.world, byKey.world?.settings || {});
        try { logInfo("E_STAGE_STATE", "world updated: " + upd.applied.slice(0, 3).join(", ")); } catch { /* noop */ }
      }
    }
    if (toggles.director) {
      const pd = parseDirector(text);
      if (pd.longterm.length) {
        const prev = (byKey.director?.state && typeof byKey.director.state.persistent === "string")
          ? byKey.director.state.persistent
          : "";
        const merged = (prev ? prev + "\n" : "") + pd.longterm.join("\n");
        await saveStageState(chatId, "director", { persistent: merged.slice(0, 2000) }, byKey.director?.settings || {});
      }
    }
    if (toggles.chess) {
      let cs = normalizeChess(byKey.chess?.state);
      const trig = parseChessTriggers(text, cs);
      if (trig.kind === "start") {
        cs = startChessGame(cs.difficulty);
        await saveStageState(chatId, "chess", cs, byKey.chess?.settings || {});
        try { logInfo("E_STAGE_STATE", "chess started"); } catch { /* noop */ }
      } else if (trig.kind === "move" && trig.moves && trig.moves.length) {
        for (const mv of trig.moves) {
          const r = playChessTurn(cs, mv.from, mv.to, mv.promo);
          if (r.ok) cs = r.state;
        }
        await saveStageState(chatId, "chess", cs, byKey.chess?.settings || {});
      } else if (trig.kind === "forfeit") {
        cs = forfeitChess(cs);
        await saveStageState(chatId, "chess", cs, byKey.chess?.settings || {});
      }
    }
  } catch (e) {
    try { logWarn("E_STAGE_STATE", "prepass skipped: " + (e?.message || e)); } catch { /* noop */ }
  }
}

// Persist [[persistent]] director notes found in an assistant reply. History untouched.
async function runStagePostpass(chatId, assistantText) {
  try {
    if (!assistantText || chatId == null) return;
    const pd = parseDirector(assistantText);
    if (!pd.longterm.length) return;
    const prev = await getStageState(chatId, "director").catch(() => null);
    const old = (prev && prev.state && typeof prev.state.persistent === "string") ? prev.state.persistent : "";
    const merged = (old ? old + "\n" : "") + pd.longterm.join("\n");
    await saveStageState(chatId, "director", { persistent: merged.slice(0, 2000) }, (prev && prev.settings) || {});
  } catch { /* never fatal */ }
}

// Fresh assistant reply for history rows (+ optional trailing user text already saved).
async function generateAssistant(chatId, pastRows, { groupId = null, titleHint = "" } = {}) {
  const { preset, provider, chName, built } = await buildContext(pastRows);
  if (!presetModel(preset)) {
    const lastUser = [...pastRows].reverse().find((m) => m.role === "user");
    const reply = offlineEcho(lastUser?.content || "", chName);
    const id = await saveMessage({
      chat_id: chatId, role: "assistant", content: reply,
      parent_id: pastRows.length ? pastRows[pastRows.length - 1].id : null,
      swipe_group_id: groupId || `g${Date.now()}`, swipe_active: 1, timestamp: Date.now()
    });
    if (groupId) await setActiveSibling(chatId, groupId, id);
    await touchChatById(chatId, titleHint);
    triggerHaptic(25);
    await refreshLibrary();
    await renderCurrentChat();
    return;
  }
  const shell = paintShell("assistant", chName);
  document.body.classList.add("generating");
  aborter = new AbortController();
  try {
    const { content, reasoning } = await runStream(preset, provider, built.messages, shell, aborter.signal);
    if (!content && !reasoning) throw new Error("E_UI_SEND: empty reply from provider.");
    const gid = groupId || `g${Date.now()}`;
    const id = await saveMessage({
      chat_id: chatId, role: "assistant",
      content: content || "(thinking only — see trace)",
      parent_id: pastRows.length ? pastRows[pastRows.length - 1].id : null,
      reasoning_content: reasoning, swipe_group_id: gid,
      swipe_active: 1, timestamp: Date.now()
    });
    if (groupId) await setActiveSibling(chatId, groupId, id);
    await runStagePostpass(chatId, content || "");
    await touchChatById(chatId, titleHint);
    triggerHaptic(25);
  } catch (e) {
    if (e?.name === "AbortError") {
      shell.div.remove();
      paintError("Stopped.");
    } else {
      logErr("E_UI_SEND", e.message);
      shell.div.remove();
      paintError(`Send failed: ${e.message}`);
    }
  } finally {
    aborter = null;
    document.body.classList.remove("generating");
    refreshDiag();
    if (ui.chatId === chatId) await renderCurrentChat();
    await refreshLibrary();
  }
}

async function handleSend() {
  if (generating()) return;
  const ta = $("#input");
  const text = ta.value.trim();
  if (!text) return;
  triggerHaptic(10);
  ta.value = "";
  autogrow();
  const chatId = await ensureChat();
  const { chain } = await getChatChain(chatId);
  const parent = chain.length ? chain[chain.length - 1].id : null;
  await saveMessage({ chat_id: chatId, role: "user", content: text, parent_id: parent, timestamp: Date.now() });
  await runStagePrepass(chatId, text);
  // Paint instantly (includes the new user message), then generate below it.
  await renderCurrentChat();
  const { chain: full } = await getChatChain(chatId);
  await generateAssistant(chatId, full, { titleHint: text });
}

async function handleRetry(item) {
  if (generating()) return;
  if (!item || (item.kind !== "group" && item.kind !== "solo")) return;
  triggerHaptic(10);
  const chatId = ui.chatId;
  const { chain } = await getChatChain(chatId);
  const sibs = item.kind === "group" ? item.msgs : [item.msg];
  const anchorId = (item.kind === "group" ? item.active?.id : item.msg.id) ?? sibs[0].id;
  const first = sibs[0];
  const pos = chain.findIndex((m) => m.id === anchorId);
  const history = pos === -1 ? chain : chain.slice(0, pos);
  const groupId = item.kind === "group" ? item.groupId : `g${Date.now()}`;
  if (item.kind === "solo") {
    await saveMessage({ ...first, swipe_group_id: groupId });
  }
  await generateAssistant(chatId, history, { groupId });
}

async function handleRetryFromUser(userMsg) {
  if (generating() || !userMsg) return;
  triggerHaptic(10);
  const chatId = ui.chatId;
  if (chatId == null) return;
  const { chain } = await getChatChain(chatId);
  const pos = chain.findIndex((m) => m.id === userMsg.id);
  const history = pos === -1 ? chain : chain.slice(0, pos + 1);
  await generateAssistant(chatId, history, {});
}

async function handleContinue() {
  if (generating()) return;
  const chatId = await ensureChat();
  const { chain } = await getChatChain(chatId);
  const rows = chain;
  if (!rows.length) return;
  const last = rows[rows.length - 1];
  triggerHaptic(10);
  if (last.role !== "assistant") {
    await generateAssistant(chatId, rows);
    return;
  }
  // Append to the last assistant message.
  const { preset, provider, chName } = await buildContext(rows.slice(0, -1));
  if (!presetModel(preset)) {
    const more = " *(nods along, offline echo continues.)*";
    await saveMessage({ ...last, content: last.content + more });
    await renderCurrentChat();
    return;
  }
  // History keeps the partial reply as the final assistant message (no prefill).
  const ctx = await buildContext(rows);
  const shell = paintShell("assistant", chName);
  // Seed the shell with the existing partial text.
  shell.body.innerHTML = renderMsg(last.content);
  document.body.classList.add("generating");
  aborter = new AbortController();
  try {
    const { content, reasoning } = await runStream(preset, provider, ctx.built.messages, shell, aborter.signal);
    await saveMessage({
      ...last,
      content: last.content + (content || ""),
      reasoning_content: (last.reasoning_content || "") + (reasoning || "")
    });
    await touchChatById(chatId);
    triggerHaptic(25);
  } catch (e) {
    if (e?.name === "AbortError") {
      shell.div.remove();
      await renderCurrentChat();
    } else {
      logErr("E_UI_SEND", e.message);
      shell.div.remove();
      paintError(`Send failed: ${e.message}`);
    }
  } finally {
    aborter = null;
    document.body.classList.remove("generating");
    refreshDiag();
    if (ui.chatId === chatId) await renderCurrentChat();
    await refreshLibrary();
  }
}

async function handleImpersonate() {
  if (generating()) return;
  const chatId = await ensureChat();
  const { chain } = await getChatChain(chatId);
  const rows = chain;
  const { preset, provider, meName } = await buildContext(rows);
  triggerHaptic(10);
  if (!presetModel(preset)) {
    const text = "*leans forward, offline echo as you.* \"No model set — open ⚙ and add a preset.\"";
    await saveMessage({
      chat_id: chatId, role: "user", content: text,
      parent_id: rows.length ? rows[rows.length - 1].id : null, timestamp: Date.now()
    });
    await touchChatById(chatId);
    await renderCurrentChat();
    await refreshLibrary();
    return;
  }
  const ctx = await buildContext(rows);
  // Steer the same pipeline into writing the user's next line.
  ctx.built.messages.push({
    role: "system",
    content: `Now write ${meName}'s next message in first person as ${meName}. Reply ONLY with that message, no narration about the task.`
  });
  const shell = paintShell("user", meName);
  document.body.classList.add("generating");
  aborter = new AbortController();
  try {
    const { content } = await runStream(preset, provider, ctx.built.messages, shell, aborter.signal);
    if (!content) throw new Error("E_UI_SEND: empty impersonation from provider.");
    await saveMessage({
      chat_id: chatId, role: "user", content,
      parent_id: rows.length ? rows[rows.length - 1].id : null, timestamp: Date.now()
    });
    await touchChatById(chatId);
    triggerHaptic(25);
  } catch (e) {
    if (e?.name === "AbortError") {
      shell.div.remove();
    } else {
      logErr("E_UI_SEND", e.message);
      shell.div.remove();
      paintError(`Send failed: ${e.message}`);
    }
  } finally {
    aborter = null;
    document.body.classList.remove("generating");
    refreshDiag();
    if (ui.chatId === chatId) await renderCurrentChat();
    await refreshLibrary();
  }
}

// ---------- Vault ----------
function setVaultStatus(msg) {
  $("#vault-status").textContent = msg;
}

async function handleExport() {
  try {
    setVaultStatus("Preparing backup…");
    const includeKeys = $("#chk-keys").checked;
    const vault = await exportVaultToJSON({ includeKeys });
    const blob = new Blob([JSON.stringify(vault, null, 2)], { type: "application/json" });
    const day = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `polyglot-vault-${day}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setVaultStatus(includeKeys ? "Exported with keys — keep this file private." : "Exported without keys.");
    logInfo("E_UI_EXPORT", includeKeys ? "vault exported with keys" : "vault exported without keys");
  } catch (e) {
    logErr("E_UI_EXPORT", e.message);
    setVaultStatus(`Export failed: ${e.message}`);
  }
  refreshDiag();
}

async function handleImportFile(file) {
  try {
    setVaultStatus("Reading backup…");
    const text = await file.text();
    const data = JSON.parse(text);
    await importVaultFromJSON(data, { merge: false });
    ui.characterId = null;
    ui.chatId = null;
    ui.personaId = null;
    ui.presetId = null;
    ui.providerId = null;
    persistUI();
    bumpRegexCache();
    await ensureSelection();
    await refreshLibrary();
    await refreshPresets();
    await refreshProviders();
    updateComboLabels();
    await renderCurrentChat();
    setVaultStatus("Import complete.");
    logInfo("E_UI_IMPORT", "vault import complete");
  } catch (e) {
    logErr("E_UI_IMPORT", e.message);
    setVaultStatus(`Import failed: ${e.message}`);
  }
  refreshDiag();
}

// ---------- Per-chat export/import ----------
async function handleExportChat() {
  try {
    if (ui.chatId == null) throw new Error("E_UI_EXPORT: no chat selected.");
    const [chars, chats, rows] = await Promise.all([
      listCharacters(), listChats(), listMessages(ui.chatId)
    ]);
    const chat = chats.find((c) => c.id === ui.chatId);
    const ch = chars.find((c) => c.id === chat.character_id);
    const data = {
      app: "Polyglot", kind: "chat", version: 1,
      exported_at: new Date().toISOString(),
      character: ch, chat, messages: rows
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `polyglot-chat-${(chat.title || chat.id).toString().replace(/[^\w-]+/g, "_")}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    logErr("E_UI_EXPORT", e.message);
    window.alert(`Chat export failed: ${e.message}`);
  }
  refreshDiag();
}

async function handleImportChatFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || data.kind !== "chat" || !Array.isArray(data.messages)) {
      throw new Error("E_UI_IMPORT: not a Polyglot chat file.");
    }
    let charId = null;
    if (data.character?.name) {
      const chars = await listCharacters();
      const hit = chars.find((c) => c.name === data.character.name);
      if (hit) charId = hit.id;
      else {
        charId = await saveCharacter({
          name: data.character.name,
          description: data.character.description || "",
          personality: data.character.personality || "",
          scenario: data.character.scenario || "",
          first_mes: data.character.first_mes || "",
          mes_example: data.character.mes_example || "",
          alternate_greetings: data.character.alternate_greetings || [],
          system_prompt: data.character.system_prompt || "",
          avatar: data.character.avatar || null
        });
      }
    } else {
      await ensureChat();
      charId = ui.characterId;
    }
    const chatId = await saveChat({
      character_id: charId,
      persona_id: ui.personaId,
      title: (data.chat?.title || "Imported chat") + ""
    });
    const sorted = [...data.messages].sort((a, b) =>
      (a.timestamp - b.timestamp) || ((a.id || 0) - (b.id || 0)));
    // Import mints fresh IDs, so remap old parent links (branch structure
    // survives; unknown parents fall back to linear order on render).
    const idMap = new Map();
    const saved = [];
    for (const m of sorted) {
      const rec = {
        chat_id: chatId,
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content ?? ""),
        reasoning_content: m.reasoning_content || "",
        swipe_group_id: m.swipe_group_id || null,
        swipe_active: m.swipe_active === 1 ? 1 : 0,
        parent_id: null,
        timestamp: Number(m.timestamp) || Date.now()
      };
      const nid = await saveMessage(rec);
      if (m.id != null) idMap.set(m.id, nid);
      saved.push({ ...rec, id: nid, oldParent: m.parent_id ?? null });
    }
    for (const s of saved) {
      if (s.oldParent != null && idMap.has(s.oldParent)) {
        const { oldParent, ...rest } = s;
        void oldParent;
        await saveMessage({ ...rest, parent_id: idMap.get(s.oldParent) });
      }
    }
    if (data.chat?.active_leaf_id != null && idMap.has(data.chat.active_leaf_id)) {
      const chats = await listChats();
      const chat = chats.find((c) => c.id === chatId);
      if (chat) await saveChat({ ...chat, active_leaf_id: idMap.get(data.chat.active_leaf_id) });
    }
    ui.characterId = charId;
    ui.chatId = chatId;
    persistUI();
    await ensureSelection();
    await refreshLibrary();
    await renderCurrentChat();
    closeDrawers();
    logInfo("E_UI_IMPORT", `chat imported (${sorted.length} messages)`);
  } catch (e) {
    logErr("E_UI_IMPORT", e.message);
    window.alert(`Chat import failed: ${e.message}`);
  }
  refreshDiag();
}

async function handlePresetImportFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const rows = Array.isArray(data) ? data : [data];
    let lastId = null;
    for (const p of rows) {
      if (!p || typeof p !== "object") continue;
      const { id, ...rest } = p;
      void id;
      // Accept v1.5 model presets and legacy v1.4 presets with connection.*.
      const legacy = rest.connection || {};
      lastId = await savePreset({
        name: String(rest.name || legacy.label || "Imported preset"),
        model: String(rest.model ?? legacy.model ?? ""),
        reasoning_strategy: rest.reasoning_strategy || legacy.reasoning_strategy || "none",
        reasoning_effort: rest.reasoning_effort || legacy.reasoning_effort || "medium",
        thinking_budget: rest.thinking_budget ?? legacy.thinking_budget ?? 2048,
        samplers: { ...DEFAULT_SAMPLERS, ...(rest.samplers || {}) },
        prompts: { ...DEFAULT_PROMPTS, ...(rest.prompts || {}) }
      });
      // If the file still carries a provider, import it too (once per base_url).
      if (legacy.base_url) {
        const existing = await listProviders();
        const hit = existing.some((x) => (x.base_url || "") === legacy.base_url && (x.proxy_url || "") === (legacy.proxy_url || ""));
        if (!hit) {
          await saveProvider({
            name: String(legacy.label || rest.name || "Imported provider"),
            base_url: legacy.base_url,
            api_key: legacy.api_key || "",
            use_proxy: legacy.use_proxy ? 1 : 0,
            proxy_url: legacy.proxy_url || ""
          });
        }
      }
    }
    if (lastId != null) {
      ui.presetId = lastId;
      persistUI();
    }
    await refreshPresets();
    await refreshProviders();
    updateComboLabels();
    logInfo("E_UI_IMPORT", `preset imported (${rows.length})`);
  } catch (e) {
    logErr("E_UI_IMPORT", e.message);
    window.alert(`Preset import failed: ${e.message}`);
  }
  refreshDiag();
}

async function handleBookImportFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const rows = Array.isArray(data) ? data : (data.entries ? [data] : (data.books || []));
    if (!rows.length) throw new Error("E_UI_IMPORT: not a Polyglot lorebook file.");
    for (const b of rows) {
      const selVal = $("#books-char-filter")?.value;
      await saveLorebook({
        character_id: (selVal && selVal !== "all" ? Number(selVal) : null) ?? (b.character_id ?? null),
        name: String(b.name || "Imported book"),
        entries: Array.isArray(b.entries) ? b.entries : []
      });
    }
    await renderBooksView();
    logInfo("E_UI_IMPORT", `book imported (${rows.length})`);
  } catch (e) {
    logErr("E_UI_IMPORT", e.message);
    window.alert(`Book import failed: ${e.message}`);
  }
  refreshDiag();
}

// ---------- Character editor + card import ----------
function openPersonaEditor(id = null) {
  edPersonaId = id;
  $("#persona-title").textContent = id == null ? "New persona" : "Edit persona";
  $("#pe-name").value = "";
  $("#pe-desc").value = "";
  $("#persona-status").textContent = "";
  if (id != null) {
    listPersonas().then((all) => {
      const p = all.find((x) => x.id === id);
      if (!p || edPersonaId !== id) return;
      $("#pe-name").value = p.name || "";
      $("#pe-desc").value = p.description || "";
    });
  }
  $("#persona-modal").hidden = false;
}

function closePersonaEditor() {
  $("#persona-modal").hidden = true;
  edPersonaId = null;
}

async function savePersonaEditor() {
  const name = $("#pe-name").value.trim();
  const description = $("#pe-desc").value.trim();
  if (!name) {
    $("#persona-status").textContent = "Name is required.";
    return;
  }
  try {
    let id = edPersonaId;
    if (id == null) {
      id = await savePersona({ name, description });
    } else {
      const all = await listPersonas();
      const prev = all.find((x) => x.id === id) || {};
      await savePersona({ ...prev, name, description, id });
    }
    ui.personaId = id;
    persistUI();
    await ensureSelection();
    await refreshLibrary();
    await renderCurrentChat();
    closePersonaEditor();
    logInfo("E_UI_PERSONA", `persona saved (${name})`);
  } catch (e) {
    logErr("E_UI_PERSONA", e.message);
    $("#persona-status").textContent = `Save failed: ${e.message}`;
  }
  refreshDiag();
}
function setCardStatus(msg) {
  $("#card-status").textContent = msg;
  // The drawer status is invisible when importing from the Characters tab or
  // the character editor modal, so mirror it there too.
  const cs = $("#char-status");
  if (cs) cs.textContent = msg;
}

function setCharStatus(msg) {
  $("#char-status").textContent = msg;
}

function renderEditorLore() {
  const box = $("#ch-lore-list");
  box.innerHTML = "";
  if (!edLore.length) {
    box.innerHTML = '<div class="status">No lorebook entries.</div>';
    return;
  }
  edLore.forEach((e, i) => {
    const row = document.createElement("div");
    row.className = "row";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = `${(e.keys || []).join(", ")} — ${String(e.content).slice(0, 60)}`;
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "×";
    x.setAttribute("aria-label", "Delete entry");
    x.addEventListener("click", () => {
      edLore.splice(i, 1);
      renderEditorLore();
    });
    row.append(nm, x);
    box.append(row);
  });
}

function renderEditorAlts() {
  const box = $("#ch-alts-list");
  if (!box) return;
  box.innerHTML = "";
  if (!edAlts.length) {
    box.innerHTML = '<div class="status">No alternate openings — new chats start with the first message.</div>';
    return;
  }
  edAlts.forEach((s, i) => {
    const wrap = document.createElement("div");
    wrap.className = "altrow";
    const lab = document.createElement("span");
    lab.className = "nm";
    lab.textContent = `Alternate ${i + 1}`;
    const ta = document.createElement("textarea");
    ta.rows = 2;
    ta.value = s;
    ta.setAttribute("aria-label", `Alternate opening ${i + 1}`);
    ta.addEventListener("input", () => { edAlts[i] = ta.value; });
    const x = document.createElement("button");
    x.className = "x";
    x.type = "button";
    x.textContent = "×";
    x.setAttribute("aria-label", "Delete alternate");
    x.addEventListener("click", () => {
      edAlts.splice(i, 1);
      renderEditorAlts();
    });
    wrap.append(lab, ta, x);
    box.append(wrap);
  });
}

function openCharEditor(charId = null, prefill = null) {
  edId = charId;
  edAvatar = prefill?.avatar ?? null;
  edLore = (prefill?.loreEntries || []).map((e) => ({
    keys: Array.isArray(e.keys) ? e.keys : [],
    content: e.content || "",
    enabled: e.enabled !== false,
    insertion_order: e.insertion_order ?? 0
  }));
  // Alternate starters + extra card metadata ride the same draft so an
  // import survives review → Save (edits merge over the stored record).
  edAlts = [...(prefill?.character?.alternate_greetings || [])];
  edExtra = {
    creator_notes: prefill?.character?.creator_notes || "",
    tags: prefill?.character?.tags || [],
    character_version: prefill?.character?.character_version || ""
  };
  $("#ch-title").textContent = charId == null ? "New character" : "Edit character";
  const fill = async () => {
    if (prefill?.character) {
      const c = prefill.character;
      $("#ch-name").value = c.name || "";
      $("#ch-desc").value = c.description || "";
      $("#ch-pers").value = c.personality || "";
      $("#ch-scen").value = c.scenario || "";
      $("#ch-first").value = c.first_mes || "";
      $("#ch-example").value = c.mes_example || "";
      $("#ch-sys").value = c.system_prompt || "";
    } else if (charId != null) {
      const chars = await listCharacters();
      const c = chars.find((x) => x.id === charId);
      if (!c) return;
      edAvatar = c.avatar || null;
      $("#ch-name").value = c.name || "";
      $("#ch-desc").value = c.description || "";
      $("#ch-pers").value = c.personality || "";
      $("#ch-scen").value = c.scenario || "";
      $("#ch-first").value = c.first_mes || "";
      $("#ch-example").value = c.mes_example || "";
      $("#ch-sys").value = c.system_prompt || "";
      edAlts = [...(c.alternate_greetings || [])];
      edExtra = {
        creator_notes: c.creator_notes || "",
        tags: c.tags || [],
        character_version: c.character_version || ""
      };
      const books = await listLorebooks(charId);
      edLore = [];
      books.forEach((b) => {
        (b.entries || []).forEach((e) => edLore.push({
          keys: e.keys || [], content: e.content || "",
          enabled: e.enabled !== false, insertion_order: e.insertion_order ?? edLore.length
        }));
      });
    } else {
      $("#ch-name").value = "";
      $("#ch-desc").value = "";
      $("#ch-pers").value = "";
      $("#ch-scen").value = "";
      $("#ch-first").value = "";
      $("#ch-example").value = "";
      $("#ch-sys").value = "";
    }
    const img = $("#ch-avatar");
    if (edAvatar) {
      img.src = edAvatar;
      img.style.display = "";
    } else {
      img.removeAttribute("src");
      img.style.display = "none";
    }
    renderEditorLore();
    renderEditorAlts();
    setCharStatus(prefill?.note || "");
  };
  fill();
  $("#char-modal").hidden = false;
}

function closeCharEditor() {
  $("#char-modal").hidden = true;
}

async function saveCharEditor() {
  try {
    const rec = {
      name: $("#ch-name").value.trim() || "Untitled",
      description: $("#ch-desc").value,
      personality: $("#ch-pers").value,
      scenario: $("#ch-scen").value,
      first_mes: $("#ch-first").value,
      mes_example: $("#ch-example").value,
      system_prompt: $("#ch-sys").value,
      alternate_greetings: edAlts.map((s) => String(s)).filter((s) => s.trim()),
      ...edExtra,
      avatar: edAvatar
    };
    let id = edId;
    if (id == null) id = await saveCharacter(rec);
    else {
      const chars = await listCharacters();
      const prev = chars.find((x) => x.id === id) || {};
      await saveCharacter({ ...prev, ...rec, id });
    }
    if (edLore.length) {
      await saveLorebook({ character_id: id, name: "Character book", entries: edLore });
    }
    ui.characterId = id;
    ui.chatId = null;
    persistUI();
    await ensureSelection();
    await refreshLibrary();
    await renderCurrentChat();
    closeCharEditor();
    closeDrawers();
    logInfo("E_UI_IMPORT", `character saved (${rec.name})`);
  } catch (e) {
    logErr("E_UI_IMPORT", e.message);
    setCharStatus(`Save failed: ${e.message}`);
  }
  refreshDiag();
}

// One-line import receipt: which core fields landed, so a bad scrape is
// visible immediately instead of surfacing mid-chat.
function importReport(kind, norm) {
  const c = norm.character || {};
  const core = ["name", "description", "personality", "scenario", "first_mes", "mes_example"];
  const filled = core.filter((k) => c[k] && String(c[k]).trim()).length;
  const bits = [`${filled}/${core.length} sections`];
  if ((c.alternate_greetings || []).length) bits.push(`${c.alternate_greetings.length} alternate opening${c.alternate_greetings.length === 1 ? "" : "s"}`);
  if ((norm.loreEntries || []).length) bits.push(`${norm.loreEntries.length} lore entries`);
  if (c.system_prompt && String(c.system_prompt).trim()) bits.push("system prompt");
  return `Imported ${kind} (${bits.join(" · ")}).`;
}

// Shared card-file reader: returns {norm, kind} or throws. WebP-only files
// carry no embed, so they come back as a name + avatar shell.
async function parseCardFile(file) {
  const name = file.name.toLowerCase();
  let avatar = null;
  try {
    if (file.type.startsWith("image/")) avatar = await fileToAvatarDataURL(file);
  } catch (e) {
    logWarn("E_IMG_AVATAR", e.message);
  }
  if (name.endsWith(".json")) {
    const { data, kind } = parseCharacterJSON(await file.text());
    const norm = normalizeCharacter(data);
    norm.avatar = avatar;
    return { norm, kind };
  }
  if (name.endsWith(".webp") && file.type === "image/webp") {
    return {
      norm: {
        character: { name: file.name.replace(/\.webp$/i, "") },
        loreEntries: [],
        avatar
      },
      kind: "webp-avatar"
    };
  }
  const buf = await file.arrayBuffer();
  const { data, kind } = await parsePNGCard(buf);
  const norm = normalizeCharacter(data);
  norm.avatar = avatar;
  return { norm, kind };
}

async function handleCardFile(file) {
  try {
    setCardStatus("Reading card…");
    const { norm, kind } = await parseCardFile(file);
    if (kind === "webp-avatar") {
      setCardStatus("WebP holds no embed — set fields manually or import its JSON.");
      openCharEditor(null, {
        ...norm,
        note: "E_CARD_NONE: WebP image loaded as avatar only; paste fields or import JSON."
      });
      return;
    }
    const rep = importReport(kind, norm);
    setCardStatus(`${rep} Review below, then Save.`);
    openCharEditor(null, { ...norm, note: `${rep} Review the text, then Save character.` });
  } catch (e) {
    logErr("E_UI_IMPORT", e.message);
    setCardStatus(`Import failed: ${e.message}`);
  }
  refreshDiag();
}

// Bulk import: two or more files are saved directly (no per-card review),
// with progress in the import status and a saved/failed summary at the end.
// Nameless cards fall back to their filename so nothing is silently skipped.
async function handleCardFiles(files) {
  if (!files.length) return;
  if (files.length === 1) {
    await handleCardFile(files[0]);
    return;
  }
  let ok = 0;
  const failed = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    setCardStatus(`Importing ${i + 1}/${files.length}: ${f.name}…`);
    try {
      const { norm } = await parseCardFile(f);
      const c = { ...(norm.character || {}) };
      if (!c.name || !String(c.name).trim()) c.name = f.name.replace(/\.(png|json|webp)$/i, "");
      const id = await saveCharacter({ ...c, avatar: norm.avatar ?? null });
      if ((norm.loreEntries || []).length) {
        await saveLorebook({ character_id: id, name: "Character book", entries: norm.loreEntries });
      }
      ok++;
    } catch (e) {
      logErr("E_UI_IMPORT", `${f.name}: ${e.message}`);
      failed.push(`${f.name} (${e.message})`);
    }
  }
  await refreshLibrary();
  showView("chars");
  const summary = failed.length
    ? `Bulk import: ${ok} saved, ${failed.length} failed: ${failed.join("; ")}`
    : `Bulk import: ${ok} character${ok === 1 ? "" : "s"} saved.`;
  setCardStatus(summary);
  logInfo("E_UI_IMPORT", summary);
  refreshDiag();
}

// ---------- Shell plumbing ----------
function autogrow() {
  const ta = $("#input");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.38) + "px";
}

function openDrawer(id) {
  if (id === "drawer-right") refreshDiag();
  $(`#${id}`).classList.add("open");
  $("#backdrop").classList.add("show");
}
function closeDrawers() {
  document.querySelectorAll(".drawer.open").forEach((d) => d.classList.remove("open"));
  $("#backdrop").classList.remove("show");
}

function trackKeyboard() {
  if (!window.visualViewport) return;
  const set = () => {
    const gap = Math.max(0, window.innerHeight - window.visualViewport.height);
    document.documentElement.style.setProperty("--kb-offset", `${gap}px`);
  };
  window.visualViewport.addEventListener("resize", set);
  window.visualViewport.addEventListener("scroll", set);
  set();
}

function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", async () => {
    try {
      const reg = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      const showBanner = () => $("#update-banner").classList.add("show");
      if (reg.waiting && navigator.serviceWorker.controller) showBanner();
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) showBanner();
        });
      });
      $("#reload-btn").addEventListener("click", () => window.location.reload());
    } catch {
      /* Offline file:// preview or private mode — app still works, no updates. */
    }
  });
}

async function copyDiagReport() {
  try {
    const text = diagReport(APP_VERSION);
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    diagNote("Report copied — paste it to your assistant for patch help.");
  } catch (e) {
    logErr("E_UI_EXPORT", e.message);
    diagNote(`Copy failed: ${e.message}`);
  }
  refreshDiag();
}

// ---------- Phase 4: top-tab router + centered views ----------
let view = localStorage.getItem("polyglot.view") || "home";
let detailCharId = Number(localStorage.getItem("polyglot.detailChar")) || null;

function showView(name) {
  view = name;
  localStorage.setItem("polyglot.view", name);
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name || (name === "detail" && b.dataset.view === "chars")));
  const inChat = name === "chat";
  $("#chat").style.display = inChat ? "" : "none";
  $("#composer").style.display = inChat ? "" : "none";
  const bb = $("#branchbar");
  if (bb && !inChat) bb.hidden = true;
  $("#views").style.display = inChat ? "none" : "";
  for (const v of ["home", "chars", "detail", "presets", "books", "regex", "stages", "forge"]) {
    const el = $(`#view-${v}`);
    if (el) el.hidden = name !== v;
  }
  if (name === "home") refreshHome();
  if (name === "chars") renderCharsView();
  if (name === "detail") renderDetailView();
  if (name === "presets") { renderPresetCards(); renderProviderCards(); }
  if (name === "books") renderBooksView();
  if (name === "regex") renderRegexView();
  if (name === "stages") renderStagesView();
  if (name === "forge") renderForgeView();
  if (name === "chat") {
    renderCurrentChat();
    window.setTimeout(autogrow, 0);
  }
}

async function openChat(chatId, characterId) {
  ui.characterId = characterId;
  ui.chatId = chatId;
  persistUI();
  await ensureSelection();
  await refreshLibrary();
  await renderCurrentChat();
  showView("chat");
  closeDrawers();
}

async function openDetail(charId) {
  detailCharId = charId;
  localStorage.setItem("polyglot.detailChar", String(charId));
  ui.characterId = charId;
  persistUI();
  showView("detail");
}

function avatarImg(src, cls = "av") {
  const img = document.createElement("img");
  img.className = cls;
  img.alt = "";
  if (src) img.src = src;
  else img.style.visibility = "hidden";
  return img;
}

async function refreshHome() {
  const grid = $("#recent-grid");
  if (!grid) return;
  grid.innerHTML = "";
  const [chats, chars] = await Promise.all([listChats(), listCharacters()]);
  const byChar = new Map(chars.map((c) => [c.id, c]));
  const sorted = [...chats].sort((a, b) => b.updated_at - a.updated_at).slice(0, 8);
  if (!sorted.length) {
    grid.innerHTML = `<div class="card wide">No conversations yet. Create a character, then start chatting — everything stays on-device.</div>`;
    return;
  }
  for (const h of sorted) {
    const ch = byChar.get(h.character_id);
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    const row = document.createElement("div");
    row.className = "crow";
    row.append(avatarImg(ch?.avatar));
    const tx = document.createElement("div");
    tx.style.minWidth = "0";
    const t = document.createElement("div");
    t.className = "ctitle";
    t.textContent = h.title || ch?.name || `Chat ${h.id}`;
    const s = document.createElement("div");
    s.className = "csub";
    s.textContent = `${ch?.name || "Chat"} • ${timeAgo(h.updated_at)}`;
    tx.append(t, s);
    const go = document.createElement("span");
    go.className = "go";
    go.textContent = "→";
    row.append(tx, go);
    card.append(row);
    const go2 = () => openChat(h.id, h.character_id);
    card.addEventListener("click", go2);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        go2();
      }
    });
    grid.append(card);
  }
}

async function renderCharsView() {
  const q = ($("#chars-search")?.value || "").trim().toLowerCase();
  const sort = $("#chars-sort")?.value || "modified";
  const chars = await listCharacters();
  let list = chars.filter((c) =>
    !q || (c.name || "").toLowerCase().includes(q) ||
    (c.description || "").toLowerCase().includes(q));
  const byMod = (a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0);
  if (sort === "name") list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  else if (sort === "favorites") list.sort((a, b) => (b.favorite || 0) - (a.favorite || 0) || byMod(a, b));
  else list.sort(byMod);
  const favs = list.filter((c) => c.favorite);
  const rest = list;
  const paint = (box, rows, showFavState) => {
    box.innerHTML = "";
    if (!rows.length) {
      box.innerHTML = `<div class="status">None.</div>`;
      return;
    }
    for (const c of rows) {
      const row = document.createElement("div");
      row.className = "row" + (c.id === ui.characterId ? " active" : "");
      row.append(avatarImg(c.avatar));
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.style.cursor = "pointer";
      nm.textContent = c.name + (showFavState && c.favorite ? " ★" : "");
      nm.title = c.description ? c.description.slice(0, 120) : "Open";
      nm.addEventListener("click", () => openDetail(c.id));
      row.append(nm);
      const icons = document.createElement("span");
      icons.className = "iconrow";
      const fav = document.createElement("button");
      fav.textContent = c.favorite ? "★" : "☆";
      fav.title = "Toggle favorite";
      fav.setAttribute("aria-label", "Toggle favorite");
      fav.addEventListener("click", async (e) => {
        e.stopPropagation();
        await saveCharacter({ ...c, favorite: c.favorite ? 0 : 1, id: c.id });
        await refreshLibrary();
        await renderCharsView();
        await refreshHome();
      });
      const ed = document.createElement("button");
      ed.textContent = "⋯";
      ed.title = "Edit character";
      ed.setAttribute("aria-label", "Edit character");
      ed.addEventListener("click", (e) => {
        e.stopPropagation();
        openCharEditor(c.id);
      });
      icons.append(fav, ed);
      row.append(icons);
      box.append(row);
    }
  };
  paint($("#chars-fav-list"), favs, false);
  paint($("#chars-list"), rest, true);
}

async function renderDetailView() {
  const chars = await listCharacters();
  const c = chars.find((x) => x.id === detailCharId) || chars.find((x) => x.id === ui.characterId);
  if (!c) {
    $("#detail-name").textContent = "No character yet";
    $("#detail-sub").textContent = "Create one to start.";
    $("#detail-chat-list").innerHTML = "";
    return;
  }
  detailCharId = c.id;
  localStorage.setItem("polyglot.detailChar", String(c.id));
  const av = $("#detail-avatar");
  if (c.avatar) {
    av.src = c.avatar;
    av.style.visibility = "";
  } else {
    av.removeAttribute("src");
    av.style.visibility = "hidden";
  }
  $("#detail-name").textContent = c.name;
  $("#detail-sub").textContent = (c.description || "").slice(0, 140);
  const chats = await listChats(c.id);
  const box = $("#detail-chat-list");
  box.innerHTML = "";
  const sorted = [...chats].sort((a, b) => b.updated_at - a.updated_at);
  if (!sorted.length) box.innerHTML = `<div class="status">No chats yet — start one above.</div>`;
  for (const h of sorted) {
    const row = document.createElement("div");
    row.className = "row" + (h.id === ui.chatId ? " active" : "");
    row.append(avatarImg(c.avatar));
    const tx = document.createElement("span");
    tx.className = "nm";
    tx.style.cursor = "pointer";
    const t = document.createElement("div");
    t.textContent = h.title || `Chat ${h.id}`;
    const s = document.createElement("div");
    s.className = "csub";
    s.textContent = timeAgo(h.updated_at);
    tx.append(t, s);
    tx.addEventListener("click", () => openChat(h.id, c.id));
    const del = document.createElement("button");
    del.className = "x";
    del.textContent = "🗑";
    del.setAttribute("aria-label", "Delete chat");
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!window.confirm("Delete this chat and its messages?")) return;
      await deleteChat(h.id);
      if (ui.chatId === h.id) ui.chatId = null;
      persistUI();
      await ensureSelection();
      await refreshLibrary();
      await renderDetailView();
      await refreshHome();
    });
    row.append(tx, del);
    box.append(row);
  }
}

async function renderPresetCards() {
  const box = $("#preset-cards");
  if (box) {
    const f = ($("#preset-filter")?.value || "").trim().toLowerCase();
    const presets = await listPresets();
    box.innerHTML = "";
    const rows = presets.filter((p) =>
      !f || (p.name || "").toLowerCase().includes(f) ||
      presetModel(p).toLowerCase().includes(f));
    if (!rows.length) {
      box.innerHTML = `<div class="status">No presets match.</div>`;
    } else {
      for (const p of rows) {
        const row = document.createElement("div");
        row.className = "row" + (p.id === ui.presetId ? " active" : "");
        const tx = document.createElement("span");
        tx.className = "nm";
        tx.style.cursor = "pointer";
        const t = document.createElement("div");
        t.textContent = p.name || "Preset";
        const s = document.createElement("div");
        s.className = "csub";
        const r = presetReasoning(p);
        s.textContent = `${r.strategy || "none"} | ${presetModel(p) || "no model"}`;
        tx.append(t, s);
        tx.addEventListener("click", async () => {
          ui.presetId = p.id;
          persistUI();
          const fresh = await listPresets();
          fillPresetForm(fresh.find((x) => x.id === p.id) || p);
          await refreshPresets();
          await renderPresetCards();
          openDrawer("drawer-right");
        });
        const icons = document.createElement("span");
        icons.className = "iconrow";
        const exp = document.createElement("button");
        exp.textContent = "⤓";
        exp.title = "Export preset JSON";
        exp.addEventListener("click", async (e) => {
          e.stopPropagation();
          const blob = new Blob([JSON.stringify(p, null, 2)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `polyglot-preset-${(p.name || p.id).toString().replace(/[^\w-]+/g, "_")}.json`;
          document.body.append(a);
          a.click();
          a.remove();
          window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        });
        const dup = document.createElement("button");
        dup.textContent = "⧉";
        dup.title = "Duplicate preset";
        dup.addEventListener("click", async (e) => {
          e.stopPropagation();
          const { id, ...rest } = p;
          void id;
          const nid = await savePreset({ ...rest, name: `${p.name || "Preset"} copy` });
          ui.presetId = nid;
          persistUI();
          await refreshPresets();
          await renderPresetCards();
        });
        const del = document.createElement("button");
        del.textContent = "🗑";
        del.title = "Delete preset";
        del.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (presets.length <= 1) {
            window.alert("Keep at least one preset.");
            return;
          }
          if (!window.confirm(`Delete preset "${p.name}"?`)) return;
          await deletePreset(p.id);
          if (ui.presetId === p.id) ui.presetId = null;
          persistUI();
          await ensureSelection();
          await refreshPresets();
          await renderPresetCards();
        });
        icons.append(exp, dup, del);
        row.append(tx, icons);
        box.append(row);
      }
    }
  }
  updateComboLabels();
}

async function renderProviderCards() {
  const box = $("#provider-cards");
  if (!box) return;
  let providers = [];
  try {
    providers = await listProviders();
  } catch {
    providers = [];
  }
  box.innerHTML = "";
  if (!providers.length) {
    box.innerHTML = `<div class="status">No providers yet — add your Nvidia NIM endpoint above.</div>`;
    return;
  }
  for (const p of providers) {
    const row = document.createElement("div");
    row.className = "row" + (p.id === ui.providerId ? " active" : "");
    const tx = document.createElement("span");
    tx.className = "nm";
    tx.style.cursor = "pointer";
    const t = document.createElement("div");
    t.textContent = p.name || "Provider";
    const s = document.createElement("div");
    s.className = "csub";
    s.textContent = p.base_url || "no URL";
    tx.append(t, s);
    tx.addEventListener("click", async () => {
      ui.providerId = p.id;
      persistUI();
      const fresh = await listProviders();
      fillProviderForm(fresh.find((x) => x.id === p.id) || p);
      cachedModels = [];
      refreshModelDatalist([]);
      await refreshProviders();
      await renderProviderCards();
      openDrawer("drawer-right");
    });
    const icons = document.createElement("span");
    icons.className = "iconrow";
    const del = document.createElement("button");
    del.textContent = "🗑";
    del.title = "Delete provider";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (providers.length <= 1) {
        window.alert("Keep at least one provider.");
        return;
      }
      if (!window.confirm(`Delete provider "${p.name}"?`)) return;
      await deleteProvider(p.id);
      if (ui.providerId === p.id) ui.providerId = null;
      persistUI();
      await ensureSelection();
      await refreshProviders();
      await renderProviderCards();
    });
    icons.append(del);
    row.append(tx, icons);
    box.append(row);
  }
  updateComboLabels();
}

async function renderBooksView() {
  const sel = $("#books-char-filter");
  const box = $("#book-list");
  if (!sel || !box) return;
  const chars = await listCharacters();
  const cur = sel.value || "all";
  sel.innerHTML = "";
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All characters";
  sel.append(all);
  for (const c of chars) {
    const o = document.createElement("option");
    o.value = String(c.id);
    o.textContent = c.name;
    sel.append(o);
  }
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "all";
  const filter = sel.value;
  const books = filter === "all"
    ? await listLorebooks()
    : await listLorebooks(Number(filter));
  const byChar = new Map(chars.map((c) => [c.id, c.name]));
  box.innerHTML = "";
  if (!books.length) {
    box.innerHTML = `<div class="status">No memory books yet. Character card imports auto-create them.</div>`;
    return;
  }
  for (const b of books) {
    const row = document.createElement("div");
    row.className = "row";
    const tx = document.createElement("span");
    tx.className = "nm";
    const t = document.createElement("div");
    t.textContent = b.name || "Book";
    const s = document.createElement("div");
    s.className = "csub";
    s.textContent = `${byChar.get(b.character_id) || "Shared"} • ${(b.entries || []).length} entries`;
    tx.append(t, s);
    const icons = document.createElement("span");
    icons.className = "iconrow";
    const exp = document.createElement("button");
    exp.textContent = "⤓";
    exp.title = "Export book JSON";
    exp.addEventListener("click", (e) => {
      e.stopPropagation();
      const blob = new Blob([JSON.stringify(b, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `polyglot-book-${(b.name || b.id).toString().replace(/[^\w-]+/g, "_")}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
    const del = document.createElement("button");
    del.textContent = "🗑";
    del.title = "Delete book";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!window.confirm(`Delete book "${b.name || b.id}"?`)) return;
      await deleteLorebook(b.id);
      await renderBooksView();
    });
    const ed = document.createElement("button");
    ed.textContent = "⋯";
    ed.title = "Edit book (rename, entries)";
    ed.setAttribute("aria-label", "Edit book");
    ed.addEventListener("click", (e) => {
      e.stopPropagation();
      openBookEditor(b.id);
    });
    tx.style.cursor = "pointer";
    tx.title = "Tap to edit";
    tx.addEventListener("click", () => openBookEditor(b.id));
    icons.append(ed, exp, del);
    row.append(tx, icons);
    box.append(row);
  }
}

// ---------- Memory book editor (rename + entries CRUD) ----------
let edBookId = null;
let edBookEntries = [];

function setBookStatus(msg) {
  const el = $("#book-status");
  if (el) el.textContent = msg;
}

async function fillBookCharSelect(selected = "shared") {
  const sel = $("#bk-char");
  if (!sel) return;
  const chars = await listCharacters();
  sel.innerHTML = "";
  const g = document.createElement("option");
  g.value = "shared";
  g.textContent = "Shared (all chats)";
  sel.append(g);
  for (const c of chars) {
    const o = document.createElement("option");
    o.value = String(c.id);
    o.textContent = c.name;
    sel.append(o);
  }
  sel.value = [...sel.options].some((o) => o.value === String(selected)) ? String(selected) : "shared";
}

function renderBookEntries() {
  const box = $("#bk-entry-list");
  if (!box) return;
  box.innerHTML = "";
  if (!edBookEntries.length) {
    box.innerHTML = `<div class="status">No entries yet — add keys + content below.</div>`;
    return;
  }
  edBookEntries.forEach((e, i) => {
    const row = document.createElement("div");
    row.className = "row";
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = `${(e.keys || []).join(", ")} — ${String(e.content || "").slice(0, 70)}${e.enabled === false ? " (off)" : ""}`;
    const icons = document.createElement("span");
    icons.className = "iconrow";
    const tg = document.createElement("button");
    tg.textContent = e.enabled === false ? "▶" : "⏸";
    tg.title = "Toggle entry";
    tg.addEventListener("click", () => {
      edBookEntries[i] = { ...e, enabled: e.enabled === false ? true : false };
      renderBookEntries();
    });
    const ed = document.createElement("button");
    ed.textContent = "⋯";
    ed.title = "Load into editor below";
    ed.addEventListener("click", () => {
      $("#bk-keys").value = (e.keys || []).join(", ");
      $("#bk-content").value = e.content || "";
      edBookEntries.splice(i, 1);
      renderBookEntries();
    });
    const x = document.createElement("button");
    x.textContent = "×";
    x.setAttribute("aria-label", "Delete entry");
    x.addEventListener("click", () => {
      edBookEntries.splice(i, 1);
      renderBookEntries();
    });
    icons.append(tg, ed, x);
    row.append(nm, icons);
    box.append(row);
  });
}

async function openBookEditor(bookId = null) {
  edBookId = bookId;
  edBookEntries = [];
  const modal = $("#book-modal");
  if (!modal) return;
  if (bookId == null) {
    $("#bk-title").textContent = "New memory book";
    $("#bk-name").value = "";
    await fillBookCharSelect("shared");
    $("#bk-keys").value = "";
    $("#bk-content").value = "";
    setBookStatus("");
  } else {
    const books = await listLorebooks();
    const b = books.find((x) => x.id === bookId);
    if (!b) return;
    $("#bk-title").textContent = "Edit memory book";
    $("#bk-name").value = b.name || "";
    await fillBookCharSelect(b.character_id == null ? "shared" : b.character_id);
    edBookEntries = (b.entries || []).map((e, i) => ({
      keys: Array.isArray(e.keys) ? e.keys : (Array.isArray(e.keywords) ? e.keywords : []),
      content: e.content || "",
      enabled: e.enabled !== false,
      insertion_order: e.insertion_order ?? i
    }));
    $("#bk-keys").value = "";
    $("#bk-content").value = "";
    setBookStatus(`${edBookEntries.length} entries loaded.`);
  }
  renderBookEntries();
  modal.hidden = false;
}

function closeBookEditor() {
  const modal = $("#book-modal");
  if (modal) modal.hidden = true;
  edBookId = null;
  setBookStatus("");
}

async function saveBookEditor() {
  try {
    const name = $("#bk-name").value.trim() || "Untitled book";
    const charSel = $("#bk-char")?.value || "shared";
    const rec = {
      name,
      character_id: charSel === "shared" ? null : Number(charSel),
      entries: edBookEntries.map((e, i) => ({
        keys: Array.isArray(e.keys) ? e.keys : [],
        content: String(e.content || ""),
        enabled: e.enabled !== false,
        insertion_order: e.insertion_order ?? i
      }))
    };
    if (edBookId == null) {
      await saveLorebook(rec);
    } else {
      const books = await listLorebooks();
      const prev = books.find((x) => x.id === edBookId) || {};
      await saveLorebook({ ...prev, ...rec, id: edBookId });
    }
    closeBookEditor();
    await renderBooksView();
    logInfo("E_UI_IMPORT", `book saved (${name})`);
  } catch (e) {
    logErr("E_UI_IMPORT", e.message);
    setBookStatus(`Save failed: ${e.message}`);
  }
  refreshDiag();
}

// ---------- Phase 5: regex scripts view ----------
let edRxId = null;

function setRxStatus(msg) {
  const el = $("#rx-status");
  if (el) el.textContent = msg;
}

async function fillRxCharSelect(selected = "global") {
  const sel = $("#rx-char");
  if (!sel) return;
  const chars = await listCharacters();
  sel.innerHTML = "";
  const g = document.createElement("option");
  g.value = "global";
  g.textContent = "Global (all chats)";
  sel.append(g);
  for (const c of chars) {
    const o = document.createElement("option");
    o.value = String(c.id);
    o.textContent = c.name;
    sel.append(o);
  }
  sel.value = [...sel.options].some((o) => o.value === String(selected)) ? String(selected) : "global";
}

function openRegexForm(id = null, prefill = null) {
  edRxId = id;
  $("#regex-form").hidden = false;
  if (prefill) {
    $("#rx-name").value = prefill.name || "";
    $("#rx-pattern").value = prefill.pattern || "";
    $("#rx-replacement").value = prefill.replacement || "";
    $("#rx-flags").value = prefill.flags || "g";
    $("#rx-place").value = prefill.place || "both";
    $("#rx-enabled").checked = prefill.enabled !== 0 && prefill.enabled !== false;
    fillRxCharSelect(prefill.character_id == null ? "global" : prefill.character_id);
  } else {
    $("#rx-name").value = "";
    $("#rx-pattern").value = "";
    $("#rx-replacement").value = "";
    $("#rx-flags").value = "g";
    $("#rx-place").value = "both";
    $("#rx-enabled").checked = true;
    fillRxCharSelect("global");
  }
  setRxStatus("");
  $("#rx-pattern").focus();
}

function closeRegexForm() {
  $("#regex-form").hidden = true;
  edRxId = null;
  setRxStatus("");
}

async function saveRegexForm() {
  const pattern = $("#rx-pattern").value;
  const flags = cleanFlags($("#rx-flags").value || "g");
  $("#rx-flags").value = flags;
  if (!pattern.trim()) {
    setRxStatus("Find pattern is empty — nothing to match.");
    return;
  }
  if (!compileRule({ pattern, flags, enabled: 1 })) {
    setRxStatus("Invalid regex — check brackets and escapes. Rule not saved.");
    logWarn("E_REGEX_RULE", `rejected invalid pattern: ${pattern.slice(0, 80)}`);
    refreshDiag();
    return;
  }
  const charSel = $("#rx-char")?.value || "global";
  const rec = {
    name: $("#rx-name").value.trim() || "Untitled rule",
    pattern,
    replacement: $("#rx-replacement").value,
    flags: flags || "g",
    place: $("#rx-place").value || "both",
    character_id: charSel === "global" ? null : Number(charSel),
    enabled: $("#rx-enabled").checked ? 1 : 0
  };
  try {
    if (edRxId == null) await saveRegexRule(rec);
    else {
      const all = await listAllRegexRules();
      const prev = all.find((r) => r.id === edRxId) || {};
      await saveRegexRule({ ...prev, ...rec, id: edRxId });
    }
    bumpRegexCache();
    closeRegexForm();
    await renderRegexView();
    logInfo("E_REGEX_RULE", `rule saved (${rec.name})`);
  } catch (e) {
    logErr("E_REGEX_RULE", e.message);
    setRxStatus(`Save failed: ${e.message}`);
  }
  refreshDiag();
}

async function renderRegexView() {
  const box = $("#regex-list");
  if (!box) return;
  const [rules, chars] = await Promise.all([listAllRegexRules(), listCharacters()]);
  const byChar = new Map(chars.map((c) => [c.id, c.name]));
  box.innerHTML = "";
  const sorted = [...rules].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  if (!sorted.length) {
    box.innerHTML = `<div class="status">No rules yet. Example: find <b>Jon\\b</b> → replace <b>John</b>, both, global.</div>`;
    return;
  }
  for (const r of sorted) {
    const row = document.createElement("div");
    row.className = "row" + (r.enabled ? "" : " disabled");
    if (!r.enabled) row.style.opacity = "0.55";
    const tx = document.createElement("span");
    tx.className = "nm";
    const t = document.createElement("div");
    t.textContent = `${r.enabled ? "" : "⏸ "}${r.name || "Rule"}  /${r.pattern}/${r.flags}`;
    const s = document.createElement("div");
    s.className = "csub";
    const scope = r.character_id == null ? "global" : (byChar.get(r.character_id) || "deleted char");
    s.textContent = `→ ${String(r.replacement).slice(0, 40) || "(delete match)"} • ${r.place} • ${scope}`;
    tx.append(t, s);
    const icons = document.createElement("span");
    icons.className = "iconrow";
    const tg = document.createElement("button");
    tg.textContent = r.enabled ? "⏸" : "▶";
    tg.title = r.enabled ? "Disable rule" : "Enable rule";
    tg.setAttribute("aria-label", "Toggle rule");
    tg.addEventListener("click", async (e) => {
      e.stopPropagation();
      await saveRegexRule({ ...r, enabled: r.enabled ? 0 : 1, id: r.id });
      bumpRegexCache();
      await renderRegexView();
    });
    const ed = document.createElement("button");
    ed.textContent = "⋯";
    ed.title = "Edit rule";
    ed.setAttribute("aria-label", "Edit rule");
    ed.addEventListener("click", (e) => {
      e.stopPropagation();
      openRegexForm(r.id, r);
    });
    const del = document.createElement("button");
    del.textContent = "🗑";
    del.title = "Delete rule";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!window.confirm(`Delete rule "${r.name || r.pattern}"?`)) return;
      await deleteRegexRule(r.id);
      bumpRegexCache();
      await renderRegexView();
    });
    icons.append(tg, ed, del);
    row.append(tx, icons);
    box.append(row);
  }
}

async function runRegexTest() {
  const src = $("#rx-test-in")?.value || "";
  const place = $("#rx-test-place")?.value || "prompt";
  const out = $("#rx-test-out");
  if (!out) return;
  if (!src.trim()) {
    out.textContent = "Type something above first.";
    return;
  }
  const rules = await getRegexRules();
  const r = applyRules(src, rules, { place, characterId: ui.characterId });
  const bits = [];
  if (r.applied.length) bits.push(`Applied: ${r.applied.join(", ")}`);
  else bits.push("No rule matched.");
  if (r.skipped.length) bits.push(`Skipped invalid: ${r.skipped.join(", ")}`);
  out.innerHTML = "";
  const pre = document.createElement("div");
  pre.textContent = r.text;
  pre.style.cssText = "color:var(--ink);white-space:pre-wrap;margin-top:6px;";
  const meta = document.createElement("div");
  meta.textContent = bits.join(" ");
  out.append(meta, pre);
}

async function handleRegexImportFile(file) {
  try {
    const data = JSON.parse(await file.text());
    const rows = Array.isArray(data) ? data : [data];
    let n = 0;
    for (const r of rows) {
      if (!r || typeof r !== "object" || !String(r.pattern || "").trim()) continue;
      if (!compileRule({ pattern: r.pattern, flags: r.flags, enabled: 1 })) continue;
      const { id, ...rest } = r;
      void id;
      const place = ["prompt", "display", "both"].includes(rest.place) ? rest.place : "both";
      await saveRegexRule({
        name: String(rest.name || "Imported rule"),
        pattern: String(r.pattern),
        replacement: String(rest.replacement ?? ""),
        flags: cleanFlags(rest.flags) || "g",
        place,
        character_id: rest.character_id ?? null,
        enabled: rest.enabled === 0 ? 0 : 1
      });
      n++;
    }
    bumpRegexCache();
    await renderRegexView();
    logInfo("E_REGEX_RULE", `rules imported (${n})`);
  } catch (e) {
    logErr("E_REGEX_RULE", e.message);
    window.alert(`Regex import failed: ${e.message}`);
  }
  refreshDiag();
}

// ---------- Phase 6: Stages manager + Forge supervisor ----------
function stageToggleRow(key, enabled, onFlip) {
  const row = document.createElement("div");
  row.className = "row";
  const tx = document.createElement("span");
  tx.className = "nm";
  const t = document.createElement("div");
  t.textContent = (enabled ? "" : "⏸ ") + (STAGE_META[key]?.name || key);
  const s = document.createElement("div");
  s.className = "csub";
  s.textContent = STAGE_META[key]?.desc || key;
  tx.append(t, s);
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = enabled ? "⏸" : "▶";
  b.title = enabled ? "Disable stage" : "Enable stage";
  b.addEventListener("click", onFlip);
  row.append(tx, b);
  return row;
}

async function currentChatToggles() {
  const t = defaultStageToggles();
  try {
    const defs = await listStages().catch(() => []);
    for (const d of (defs || [])) {
      if (d && d.key && t[d.key] !== undefined) t[d.key] = d.enabled ? 1 : 0;
    }
    if (ui.chatId != null) {
      const all = await listChats();
      const cur = all.find((c) => c.id === ui.chatId);
      if (cur && cur.stages && typeof cur.stages === "object") {
        const nt = normalizeToggles(cur.stages);
        for (const k of STAGE_KEYS) t[k] = nt[k];
      }
    }
  } catch { /* defaults stand */ }
  return t;
}

async function renderStagesView() {
  const box = $("#stage-list");
  if (!box) return;
  box.innerHTML = "";
  const toggles = await currentChatToggles();
  const chatLabel = $("#stage-chat-label");
  if (chatLabel) {
    try {
      const all = await listChats();
      const cur = all.find((c) => c.id === ui.chatId);
      chatLabel.textContent = cur ? ("Chat: " + (cur.title || ("#" + cur.id))) : "No chat selected — toggles edit global defaults.";
    } catch {
      chatLabel.textContent = "";
    }
  }
  for (const k of STAGE_KEYS) {
    const row = stageToggleRow(k, !!toggles[k], async () => {
      const next = toggles[k] ? 0 : 1;
      try {
        if (ui.chatId != null) {
          const all = await listChats();
          const cur = all.find((c) => c.id === ui.chatId);
          if (cur) {
            const nt = normalizeToggles(cur.stages);
            nt[k] = next;
            await saveChat({ ...cur, stages: nt });
          }
        } else {
          const defs = await listStages().catch(() => []);
          const found = (defs || []).find((d) => d && d.key === k);
          await saveStage({ ...(found || { key: k, name: STAGE_META[k]?.name || k }), enabled: next, id: found?.id });
        }
        logInfo("E_STAGE_RULE", "stage " + k + " " + (next ? "enabled" : "disabled"));
      } catch (e) {
        logErr("E_STAGE_RULE", e?.message || String(e));
      }
      refreshDiag();
      await renderStagesView();
    });
    box.append(row);
  }
  // World sheet + chess board preview for the current chat.
  const prev = $("#stage-preview");
  if (prev) {
    prev.innerHTML = "";
    if (ui.chatId == null) {
      prev.textContent = "Open a chat to preview world + board.";
    } else {
      try {
        const states = await listStageStates(ui.chatId).catch(() => []);
        const byKey = {};
        for (const s of (states || [])) {
          if (s && s.stage_key) byKey[s.stage_key] = s.state || {};
        }
        const w = normalizeWorld(byKey.world);
        const sheet = document.createElement("div");
        sheet.className = "card wide";
        const h = document.createElement("strong");
        h.textContent = "World — " + (w.location || "unknown place");
        const p = document.createElement("div");
        p.className = "status";
        p.textContent = formatWorldSheet(w);
        sheet.append(h, p);
        prev.append(sheet);
        const cs = normalizeChess(byKey.chess);
        if (cs.active) {
          const b = document.createElement("pre");
          b.className = "board-pre";
          b.textContent = renderBoardText(cs) + "\nFEN: " + cs.fen;
          prev.append(b);
        }
      } catch { /* preview optional */ }
    }
  }
}

let forgeProposals = [];

async function executeSupervisorAction(a) {
  const errV = validateAction(a);
  if (errV) throw new Error(errV);
  const act = normalizeAction(a, ui.chatId);
  const chars = await listCharacters();
  const byId = (id) => chars.find((c) => c && c.id === Number(id));
  const byName = (n) => {
    const t = String(n || "").trim().toLowerCase();
    return chars.find((c) => String(c.name || "").trim().toLowerCase() === t);
  };
  if (act.action === "create_character") {
    const id = await saveCharacter({
      name: String(act.name).slice(0, 80),
      description: String(act.description || ""),
      personality: String(act.personality || ""),
      scenario: String(act.scenario || ""),
      first_mes: String(act.first_mes || ""),
      mes_example: String(act.mes_example || ""),
      system_prompt: String(act.system_prompt || ""),
      avatar: null
    });
    await refreshLibrary();
    return "created character #" + id;
  }
  if (act.action === "polish_character" || act.action === "write_scenario") {
    const target = act.character_id != null ? byId(act.character_id) : byName(act.name || act.character_name);
    if (!target) throw new Error("E_SUPERVISOR: character not found.");
    const patch = { ...target };
    for (const k of ["description", "personality", "scenario", "first_mes", "mes_example", "system_prompt"]) {
      if (typeof act[k] === "string" && act[k].trim()) patch[k] = act[k];
    }
    if (act.action === "write_scenario" && act.scenario) patch.scenario = act.scenario;
    await saveCharacter(patch);
    await refreshLibrary();
    return "updated " + (target.name || ("#" + target.id));
  }
  if (act.action === "add_stage") {
    const chatId = act.chat_id != null ? Number(act.chat_id) : ui.chatId;
    if (chatId == null) throw new Error("E_SUPERVISOR: no chat selected for add_stage.");
    const all = await listChats();
    const cur = all.find((c) => c.id === chatId);
    if (!cur) throw new Error("E_SUPERVISOR: chat not found.");
    const nt = normalizeToggles(cur.stages);
    nt[act.stage_key] = act.enabled === 0 ? 0 : 1;
    await saveChat({ ...cur, stages: nt });
    return "stage " + act.stage_key + " " + (nt[act.stage_key] ? "on" : "off") + " for chat #" + chatId;
  }
  if (act.action === "set_world") {
    const chatId = act.chat_id != null ? Number(act.chat_id) : ui.chatId;
    if (chatId == null) throw new Error("E_SUPERVISOR: no chat selected for set_world.");
    const prev = await getStageState(chatId, "world").catch(() => null);
    const cur = normalizeWorld(prev?.state);
    const next = normalizeWorld({
      ...cur,
      location: act.location ?? cur.location,
      time: act.time ?? cur.time,
      weather: act.weather ?? cur.weather,
      notes: act.notes ?? cur.notes,
      party: Array.isArray(act.party) ? act.party : cur.party,
      inventory: Array.isArray(act.inventory) ? act.inventory : cur.inventory,
      flags: (act.flags && typeof act.flags === "object") ? act.flags : cur.flags
    });
    await saveStageState(chatId, "world", next, prev?.settings || {});
    return "world set for chat #" + chatId;
  }
  throw new Error("E_SUPERVISOR: rejected.");
}

async function renderForgeView() {
  const box = $("#forge-results");
  if (!box) return;
  box.innerHTML = "";
  if (!forgeProposals.length) {
    box.innerHTML = `<div class="status">No proposals yet. Describe a character or say "polish Rin" / "write a tavern scenario" / "add chess to this chat". Proposals appear here for approval — nothing is applied until you tap Approve.</div>`;
    return;
  }
  const chars = await listCharacters().catch(() => []);
  for (let i = 0; i < forgeProposals.length; i++) {
    const a = forgeProposals[i];
    const card = document.createElement("div");
    card.className = "card wide";
    const h = document.createElement("strong");
    h.textContent = describeAction(a, chars);
    const pre = document.createElement("pre");
    pre.className = "status";
    pre.style.whiteSpace = "pre-wrap";
    pre.textContent = JSON.stringify(a, null, 1).slice(0, 1500);
    const row = document.createElement("div");
    row.className = "vaultbtns";
    const ok = document.createElement("button");
    ok.className = "btn";
    ok.type = "button";
    ok.textContent = "Approve";
    ok.addEventListener("click", async () => {
      try {
        const msg = await executeSupervisorAction(a);
        forgeProposals.splice(i, 1);
        logInfo("E_SUPERVISOR", "applied: " + msg);
        window.alert(msg);
      } catch (e) {
        logErr("E_SUPERVISOR", e?.message || String(e));
        window.alert("Supervisor action failed: " + (e?.message || e));
      }
      refreshDiag();
      await renderForgeView();
      await renderStagesView().catch(() => {});
    });
    const no = document.createElement("button");
    no.className = "btn secondary";
    no.type = "button";
    no.textContent = "Reject";
    no.addEventListener("click", async () => {
      forgeProposals.splice(i, 1);
      logInfo("E_SUPERVISOR", "proposal rejected");
      await renderForgeView();
    });
    row.append(ok, no);
    card.append(h, pre, row);
    box.append(card);
  }
}

async function handleForgeRun() {
  const ta = $("#forge-input");
  const req = (ta?.value || "").trim();
  if (!req) return;
  const btn = $("#btn-forge-run");
  if (btn) btn.disabled = true;
  try {
    const [chars, chats] = await Promise.all([listCharacters().catch(() => []), listChats().catch(() => [])]);
    const lower = req.toLowerCase();
    // Fast offline paths: no model needed for skeleton drafts and stage toggles.
    if (/^(make|create|new)\b/.test(lower) && !presetModel(await getActivePreset().catch(() => null))) {
      forgeProposals = [{ action: "create_character", ...localDraftCharacter(req) }];
      await renderForgeView();
      return;
    }
    const mStage = lower.match(/add\s+(director|world|dice|chess)(?:\s+to\s+(?:this\s+|current\s+)?chat)?/);
    if (mStage && !presetModel(await getActivePreset().catch(() => null))) {
      forgeProposals = [{ action: "add_stage", stage_key: mStage[1], chat_id: ui.chatId, enabled: 1 }];
      await renderForgeView();
      return;
    }
    const preset = await getActivePreset().catch(() => null);
    if (!presetModel(preset)) {
      // Offline default: draft a character skeleton for approval.
      forgeProposals = [{ action: "create_character", ...localDraftCharacter(req) }];
      logInfo("E_SUPERVISOR", "offline draft proposed (no model set)");
      await renderForgeView();
      return;
    }
    const provider = await getActiveProvider().catch(() => null);
    const sys = buildSupervisorPrompt({ characters: chars, chats, stageStates: [] });
    const { content } = await sendChat({
      provider: provider || undefined,
      preset,
      connection: preset?.connection,
      samplers: { ...(preset?.samplers || {}), max_tokens: 900, temperature: 0.4 },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: req + "\nCurrent chat id: " + (ui.chatId ?? "none") + ". Reply with ONE ```tool fenced JSON action." }
      ],
      signal: null
    });
    const parsed = parseSupervisorReply(content || "");
    const valid = [];
    for (const a of parsed.actions) {
      const e = validateAction(a);
      if (!e) valid.push(normalizeAction(a, ui.chatId));
      else logErr("E_SUPERVISOR", e);
    }
    if (parsed.skipped.length) logErr("E_SUPERVISOR", "skipped: " + parsed.skipped.join("; "));
    if (!valid.length) {
      window.alert("Supervisor returned no valid action. Try: 'Create a gruff dwarven barkeep' or 'Add chess to this chat'.");
      return;
    }
    forgeProposals = valid.slice(0, 5);
    logInfo("E_SUPERVISOR", "proposed " + forgeProposals.length + " action(s)");
    await renderForgeView();
  } catch (e) {
    logErr("E_SUPERVISOR", e?.message || String(e));
    window.alert("Supervisor failed: " + (e?.message || e));
  } finally {
    if (btn) btn.disabled = false;
    refreshDiag();
  }
}

function refreshViews() {
  if (view === "home") refreshHome();
  else if (view === "chars") renderCharsView();
  else if (view === "detail") renderDetailView();
  else if (view === "presets") { renderPresetCards(); renderProviderCards(); }
  else if (view === "books") renderBooksView();
  else if (view === "regex") renderRegexView();
  else if (view === "stages") renderStagesView();
  else if (view === "forge") renderForgeView();
}

// ---------- Phase 4: theme presets + *action* and "dialogue" colors ----------
function currentThemeVars() {
  try {
    return JSON.parse(localStorage.getItem("polyglot.themeVars") || "null") || null;
  } catch {
    return null;
  }
}

function applyTheme(name, vars = null) {
  const base = THEMES[name] || (name === "custom" ? THEMES.polyglot : THEMES.polyglot);
  const v = vars || base;
  const root = document.documentElement;
  root.style.setProperty("--bg", v.bg);
  root.style.setProperty("--bg2", v.bg2);
  root.style.setProperty("--panel", v.panel);
  root.style.setProperty("--ink", v.ink);
  root.style.setProperty("--muted", v.muted);
  root.style.setProperty("--line", v.line);
  root.style.setProperty("--accent", v.accent);
  root.style.setProperty("--action", v.action);
  root.style.setProperty("--dialogue", v.dialogue);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", v.bg);
  localStorage.setItem("polyglot.theme", name);
  localStorage.setItem("polyglot.themeVars", JSON.stringify(v));
  const sel = $("#theme-preset");
  if (sel && sel.value !== name) sel.value = name;
  const map = {
    "#th-bg": v.bg, "#th-panel": v.panel, "#th-ink": v.ink,
    "#th-accent": v.accent, "#th-action": v.action, "#th-dialogue": v.dialogue
  };
  for (const [id, val] of Object.entries(map)) {
    const el = $(id);
    if (el && /^#[0-9a-fA-F]{6}$/.test(val || "")) el.value = val;
  }
}

function initTheme() {
  const name = localStorage.getItem("polyglot.theme") || "polyglot";
  const vars = currentThemeVars();
  if (name === "custom" && vars) applyTheme("custom", vars);
  else applyTheme(THEMES[name] ? name : "polyglot", vars);
}

function readThemeInputs() {
  const pick = (id, fb) => {
    const el = $(id);
    return el && /^#[0-9a-fA-F]{6}$/.test(el.value) ? el.value : fb;
  };
  const cur = currentThemeVars() || THEMES.polyglot;
  return {
    ...cur,
    bg: pick("#th-bg", cur.bg),
    panel: pick("#th-panel", cur.panel),
    ink: pick("#th-ink", cur.ink),
    accent: pick("#th-accent", cur.accent),
    action: pick("#th-action", cur.action),
    dialogue: pick("#th-dialogue", cur.dialogue),
    bg2: cur.bg2, muted: cur.muted, line: cur.line
  };
}

// Boot errors must never brick the shell: report them to the diagnostics log
// instead of aborting init before the UI is wired. (A module-level SyntaxError
// once bricked v1.3.0 completely — see header comment rule: no "*/" inside
// block comments. This reporter is the second line of defense.)
function surfaceBootErrors() {
  const show = (msg) => {
    try {
      logErr("E_UI_SEND", `boot: ${msg}`);
      refreshDiag();
    } catch { /* the reporter itself must never throw */ }
  };
  window.addEventListener("error", (e) => show((e && e.message) || "unknown error"));
  window.addEventListener("unhandledrejection", (e) =>
    show((e && e.reason && e.reason.message) || String((e && e.reason) || "unknown rejection")));
}

async function init() {
  $("#ver").textContent = APP_VERSION;
  window.__polyglot_version = APP_VERSION;
  surfaceBootErrors();
  try {
    await openDB();
  } catch (e) {
    document.getElementById("chat").innerHTML =
      `<div class="empty">E_DB_OPEN: storage failed — ${escapeHtml(e.message)}<small>Private mode or quota. Reload to retry.</small></div>`;
    logErr("E_DB_OPEN", e.message);
    return;
  }
  let bootError = null;
  try {
  await seedIfEmpty({
    preset: {
      name: "Default",
      model: "nvidia/llama-3.1-nemotron-70b-instruct",
      reasoning_strategy: "none",
      reasoning_effort: "medium",
      thinking_budget: 2048,
      samplers: { ...DEFAULT_SAMPLERS },
      prompts: { ...DEFAULT_PROMPTS }
    },
    provider: { ...DEFAULT_PROVIDER }
  });
  await migrateLegacyPresetsIfNeeded();
  try {
    await seedStagesIfEmpty();
  } catch { /* stages seed must never brick boot */ }
  await ensureSelection();
  await refreshLibrary();
  await refreshPresets();
  await refreshProviders();
  await renderCurrentChat();
  refreshDiag();
  logInfo("E_UI_SEND", `ready ${APP_VERSION}`);
  } catch (e) {
    // Data load failed, but the shell must stay usable: fall through to the
    // wiring below so every button works, then surface the failure visibly.
    bootError = e;
    logErr("E_UI_SEND", `boot: ${e && e.message ? e.message : e}`);
  }

  $("#btn-left").addEventListener("click", () => openDrawer("drawer-left"));
  $("#btn-right").addEventListener("click", () => openDrawer("drawer-right"));
  document.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", closeDrawers)
  );
  $("#backdrop").addEventListener("click", closeDrawers);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDrawers();
      closeCharEditor();
      closeBookEditor();
      closePersonaEditor();
      closeGraph();
      const sm = $("#starter-modal");
      if (sm) sm.hidden = true;
    }
  });
  $("#send").addEventListener("click", handleSend);
  $("#stop").addEventListener("click", () => {
    if (aborter) aborter.abort();
  });
  $("#btn-imp").addEventListener("click", handleImpersonate);
  $("#input").addEventListener("input", autogrow);
  $("#input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      handleSend();
    }
  });

  $("#btn-new-persona").addEventListener("click", () => openPersonaEditor(null));
  $("#btn-persona-close")?.addEventListener("click", closePersonaEditor);
  $("#btn-persona-save")?.addEventListener("click", savePersonaEditor);
  $("#btn-new-char").addEventListener("click", () => openCharEditor(null));
  $("#btn-new-chat").addEventListener("click", async () => {
    const chars = await listCharacters();
    const ch = chars.find((c) => c.id === ui.characterId);
    const starters = charStarters(ch);
    if (starters.length > 1) {
      openStarterPicker(ui.characterId, starters, ch?.name);
      return;
    }
    await ensureChat();
    const id = await saveChat({
      character_id: ui.characterId,
      persona_id: ui.personaId,
      title: `Chat ${new Date().toLocaleString()}`
    });
    ui.chatId = id;
    persistUI();
    await refreshLibrary();
    await renderCurrentChat();
    closeDrawers();
  });
  $("#btn-export").addEventListener("click", handleExport);
  $("#file-import").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (!window.confirm("Replace ALL current data with this backup?")) return;
    await handleImportFile(f);
  });
  $("#file-card").addEventListener("change", async (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = "";
    if (files.length) await handleCardFiles(files);
  });
  $("#btn-export-chat").addEventListener("click", handleExportChat);
  $("#file-chat-import").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) await handleImportChatFile(f);
  });

  $("#btn-ch-close").addEventListener("click", closeCharEditor);
  $("#btn-ch-save").addEventListener("click", saveCharEditor);
  $("#ch-avatar-file").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      edAvatar = await fileToAvatarDataURL(f);
      const img = $("#ch-avatar");
      img.src = edAvatar;
      img.style.display = "";
      setCharStatus("");
    } catch (err2) {
      logErr("E_IMG_AVATAR", err2.message);
      setCharStatus(`Image failed: ${err2.message}`);
    }
    refreshDiag();
  });
  $("#btn-ch-lore-add").addEventListener("click", () => {
    const keys = $("#ch-lore-keys").value.split(",").map((s) => s.trim()).filter((s) => s.length);
    const content = $("#ch-lore-content").value.trim();
    if (!keys.length || !content) {
      setCharStatus("Lore entry needs keys + content.");
      return;
    }
    edLore.push({ keys, content, enabled: true, insertion_order: edLore.length });
    $("#ch-lore-keys").value = "";
    $("#ch-lore-content").value = "";
    renderEditorLore();
  });
  $("#btn-ch-alt-add").addEventListener("click", () => {
    edAlts.push("");
    renderEditorAlts();
  });

  $("#btn-new-preset").addEventListener("click", async () => {
    const name = window.prompt("Preset name:", "Preset 2");
    if (!name) return;
    const id = await savePreset({
      name: name.trim(),
      model: "nvidia/llama-3.1-nemotron-70b-instruct",
      reasoning_strategy: "none",
      reasoning_effort: "medium",
      thinking_budget: 2048,
      samplers: { ...DEFAULT_SAMPLERS },
      prompts: { ...DEFAULT_PROMPTS }
    });
    ui.presetId = id;
    persistUI();
    await refreshPresets();
    await renderPresetCards();
  });
  $("#btn-save-preset").addEventListener("click", async () => {
    try {
      const active = await getActivePreset();
      const form = readPresetForm();
      if (active) await savePreset({ ...active, ...form, id: active.id, updated_at: Date.now() });
      else {
        const id = await savePreset(form);
        ui.presetId = id;
        persistUI();
      }
      await refreshPresets();
      await renderPresetCards();
      setPresetStatus("Saved.");
    } catch (e) {
      logErr("E_UI_SEND", e.message);
      setPresetStatus(`Save failed: ${e.message}`);
    }
    refreshDiag();
  });
  $("#btn-del-preset").addEventListener("click", async () => {
    const presets = await listPresets();
    if (presets.length <= 1) {
      setPresetStatus("Keep at least one preset.");
      return;
    }
    const active = await getActivePreset();
    if (!active) return;
    if (!window.confirm(`Delete preset "${active.name}"?`)) return;
    await deletePreset(active.id);
    ui.presetId = null;
    persistUI();
    await ensureSelection();
    await refreshPresets();
    await renderPresetCards();
    setPresetStatus("Deleted.");
  });

  // ---------- v1.5 wiring: providers (connection) + model presets ----------
  $("#btn-provider-new")?.addEventListener("click", async () => {
    const name = window.prompt("Provider name:", "Nvidia NIM");
    if (!name) return;
    const id = await saveProvider({ ...DEFAULT_PROVIDER, name: name.trim() });
    ui.providerId = id;
    persistUI();
    await refreshProviders();
    await renderProviderCards();
  });
  $("#btn-new-provider")?.addEventListener("click", async () => {
    const name = window.prompt("Provider name:", "Nvidia NIM");
    if (!name) return;
    const id = await saveProvider({ ...DEFAULT_PROVIDER, name: name.trim() });
    ui.providerId = id;
    persistUI();
    await refreshProviders();
    await renderProviderCards();
  });
  $("#btn-fetch-models")?.addEventListener("click", handleFetchModels);
  $("#btn-test-conn")?.addEventListener("click", handleTestConnection);
  $("#btn-use-model")?.addEventListener("click", async () => {
    const pick = $("#prov-models")?.value || "";
    if (!pick) {
      setProviderStatus("Fetch models first, then pick one.");
      return;
    }
    const box = $("#conn-model");
    if (box) box.value = pick;
    try {
      const active = await getActivePreset();
      if (active) {
        await savePreset({ ...active, model: pick, id: active.id, updated_at: Date.now() });
        await refreshPresets();
      }
    } catch (e) {
      logErr("E_PROVIDER", e.message);
    }
    updateComboLabels();
    setProviderStatus(`Model set: ${pick}`);
    refreshDiag();
  });
  $("#prov-models")?.addEventListener("change", (e) => {
    const v = e.target.value || "";
    if (v && $("#conn-model")) $("#conn-model").value = v;
  });
  $("#btn-save-provider")?.addEventListener("click", async () => {
    try {
      const active = await getActiveProvider();
      const form = readProviderForm();
      if (active) await saveProvider({ ...active, ...form, id: active.id, updated_at: Date.now() });
      else {
        const id = await saveProvider(form);
        ui.providerId = id;
        persistUI();
      }
      await refreshProviders();
      await renderProviderCards();
      setProviderStatus("Saved.");
    } catch (e) {
      logErr("E_PROVIDER", e.message);
      setProviderStatus(`Save failed: ${e.message}`);
    }
    refreshDiag();
  });
  $("#btn-del-provider")?.addEventListener("click", async () => {
    const providers = await listProviders();
    if (providers.length <= 1) {
      setProviderStatus("Keep at least one provider.");
      return;
    }
    const active = await getActiveProvider();
    if (!active) return;
    if (!window.confirm(`Delete provider "${active.name}"?`)) return;
    await deleteProvider(active.id);
    ui.providerId = null;
    persistUI();
    await ensureSelection();
    await refreshProviders();
    await renderProviderCards();
    cachedModels = [];
    refreshModelDatalist([]);
    setProviderStatus("Deleted.");
  });

  // ---------- v1.5 wiring: memory book editor ----------
  // ---------- v1.5 wiring: memory book editor ----------
  $("#btn-book-new")?.addEventListener("click", () => openBookEditor(null));
  $("#btn-graph-close")?.addEventListener("click", closeGraph);
  $("#btn-graph-reset")?.addEventListener("click", async () => {
    if (!graphState) return;
    graphState.needsFit = true;
    await renderGraph();
  });
  $("#btn-graph-rotate")?.addEventListener("click", async () => {
    if (!graphState) return;
    graphState.horizontal = !graphState.horizontal;
    graphState.needsFit = true;
    await renderGraph();
  });
  $("#btn-graph-collapse")?.addEventListener("click", async () => {
    if (!graphState) return;
    graphState.collapsed = !graphState.collapsed;
    graphState.needsFit = true;
    await renderGraph();
  });
  $("#btn-graph-fork")?.addEventListener("click", () => {
    forkChatFromGraph().catch((e) => logErr("E_UI_GRAPH", e.message));
  });
  $("#btn-starter-close")?.addEventListener("click", () => { $("#starter-modal").hidden = true; });
  $("#btn-bk-close")?.addEventListener("click", closeBookEditor);
  $("#btn-bk-save")?.addEventListener("click", saveBookEditor);
  $("#btn-bk-entry-add")?.addEventListener("click", () => {
    const keys = $("#bk-keys").value.split(",").map((s) => s.trim()).filter((s) => s.length);
    const content = $("#bk-content").value.trim();
    if (!keys.length || !content) {
      setBookStatus("Entry needs keys + content.");
      return;
    }
    edBookEntries.push({ keys, content, enabled: true, insertion_order: edBookEntries.length });
    $("#bk-keys").value = "";
    $("#bk-content").value = "";
    renderBookEntries();
    setBookStatus(`${edBookEntries.length} entries.`);
  });
  $("#book-modal")?.addEventListener("click", (e) => {
    if (e.target && e.target.id === "book-modal") closeBookEditor();
  });

  // ---------- Phase 4 wiring: tabs, views, ptabs, toggles, theme ----------
  initTheme();
  const tg0 = getToggles();
  if ($("#tg-stream")) $("#tg-stream").checked = tg0.stream;
  if ($("#tg-thought")) $("#tg-thought").checked = tg0.thought;
  if ($("#tg-haptic")) $("#tg-haptic").checked = tg0.haptic;
  localStorage.setItem("polyglot.haptic", tg0.haptic ? "on" : "off");

  document.querySelectorAll("#tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      triggerHaptic(10);
      showView(b.dataset.view);
    })
  );
  document.querySelectorAll("[data-ptab]").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("[data-ptab]").forEach((x) =>
        x.classList.toggle("active", x === b));
      document.querySelectorAll("[data-ppane]").forEach((p) => {
        p.hidden = p.dataset.ppane !== b.dataset.ptab;
      });
    })
  );

  const newChatFor = async (charId) => {
    const chars = await listCharacters();
    const ch = chars.find((c) => c.id === charId);
    const starters = charStarters(ch);
    if (starters.length > 1) {
      ui.characterId = charId;
      persistUI();
      await ensureSelection();
      openStarterPicker(charId, starters, ch?.name);
      return;
    }
    ui.characterId = charId;
    persistUI();
    await ensureSelection();
    const id = await saveChat({
      character_id: charId,
      persona_id: ui.personaId,
      title: `Chat ${new Date().toLocaleString()}`
    });
    ui.chatId = id;
    persistUI();
    await refreshLibrary();
    await renderCurrentChat();
    showView("chat");
  };

  $("#btn-chars-new")?.addEventListener("click", () => openCharEditor(null));
  $("#btn-guide-char")?.addEventListener("click", () => openCharEditor(null));
  $("#btn-guide-preset")?.addEventListener("click", () => showView("presets"));
  $("#btn-guide-book")?.addEventListener("click", () => showView("books"));
  $("#btn-preset-new")?.addEventListener("click", async () => {
    const name = window.prompt("Preset name:", "Preset 2");
    if (!name) return;
    const id = await savePreset({
      name: name.trim(),
      model: "nvidia/llama-3.1-nemotron-70b-instruct",
      reasoning_strategy: "none",
      reasoning_effort: "medium",
      thinking_budget: 2048,
      samplers: { ...DEFAULT_SAMPLERS },
      prompts: { ...DEFAULT_PROMPTS }
    });
    ui.presetId = id;
    persistUI();
    await refreshPresets();
    await renderPresetCards();
  });
  $("#chars-search")?.addEventListener("input", () => renderCharsView());
  $("#chars-sort")?.addEventListener("change", () => renderCharsView());
  $("#preset-filter")?.addEventListener("input", () => renderPresetCards());
  $("#books-char-filter")?.addEventListener("change", () => renderBooksView());
  $("#file-preset-import")?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) await handlePresetImportFile(f);
  });
  $("#file-book-import")?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) await handleBookImportFile(f);
  });
  $("#detail-back")?.addEventListener("click", () => showView("chars"));
  $("#btn-detail-new-chat")?.addEventListener("click", async () => {
    if (detailCharId != null) await newChatFor(detailCharId);
  });
  $("#btn-detail-edit")?.addEventListener("click", () => {
    if (detailCharId != null) openCharEditor(detailCharId);
  });
  for (const [id, key] of [["#tg-stream", "stream"], ["#tg-thought", "thought"], ["#tg-haptic", "haptic"]]) {
    $(id)?.addEventListener("change", async (e) => {
      const tg = { ...getToggles(), [key]: e.target.checked };
      saveToggles(tg);
      if (key === "thought") await renderCurrentChat();
    });
  }
  $("#theme-preset")?.addEventListener("change", (e) => {
    const name = e.target.value;
    if (name === "custom") {
      applyTheme("custom", readThemeInputs());
      return;
    }
    applyTheme(name);
  });
  for (const id of ["#th-bg", "#th-panel", "#th-ink", "#th-accent", "#th-action", "#th-dialogue"]) {
    $(id)?.addEventListener("input", () => applyTheme("custom", readThemeInputs()));
  }

  $("#btn-regex-new")?.addEventListener("click", () => openRegexForm(null));
  $("#btn-rx-cancel")?.addEventListener("click", closeRegexForm);
  $("#btn-rx-save")?.addEventListener("click", saveRegexForm);
  $("#btn-rx-test")?.addEventListener("click", runRegexTest);
  $("#btn-regex-export")?.addEventListener("click", async () => {
    try {
      const rules = await listAllRegexRules();
      const blob = new Blob([JSON.stringify(rules, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `polyglot-regex-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      logErr("E_REGEX_RULE", e.message);
    }
    refreshDiag();
  });
  $("#file-regex-import")?.addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) await handleRegexImportFile(f);
  });
  $("#btn-forge-run")?.addEventListener("click", handleForgeRun);
  $("#btn-forge-draft")?.addEventListener("click", async () => {
    const ta = $("#forge-input");
    const brief = (ta?.value || "").trim() || "A curious traveler with a secret";
    forgeProposals = [{ action: "create_character", ...localDraftCharacter(brief) }];
    logInfo("E_SUPERVISOR", "offline draft proposed");
    refreshDiag();
    await renderForgeView();
  });
  $("#btn-forge-polish")?.addEventListener("click", async () => {
    try {
      const chars = await listCharacters();
      const ch = chars.find((c) => c.id === ui.characterId) || chars[0];
      if (!ch) {
        window.alert("No character to polish yet.");
        return;
      }
      forgeProposals = [{ action: "polish_character", character_id: ch.id, ...localPolishCharacter(ch) }];
      logInfo("E_SUPERVISOR", "polish draft proposed for " + (ch.name || ch.id));
      refreshDiag();
      await renderForgeView();
    } catch (e) {
      logErr("E_SUPERVISOR", e?.message || String(e));
    }
  });
  $("#btn-stage-export")?.addEventListener("click", async () => {
    try {
      const [defs, states] = await Promise.all([listStages().catch(() => []), listStageStates(ui.chatId).catch(() => [])]);
      const blob = new Blob([JSON.stringify({ defs, states }, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `polyglot-stages-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      logErr("E_STAGE_RULE", e?.message || String(e));
    }
    refreshDiag();
  });

  $("#btn-diag-copy").addEventListener("click", copyDiagReport);
  $("#btn-diag-export").addEventListener("click", () => {
    try {
      const blob = new Blob([diagReport(APP_VERSION)], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `polyglot-diag-${new Date().toISOString().slice(0, 10)}.txt`;
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      diagNote("Log exported.");
    } catch (e) {
      logErr("E_UI_EXPORT", e.message);
      diagNote(`Export failed: ${e.message}`);
    }
    refreshDiag();
  });
  $("#btn-diag-clear").addEventListener("click", () => {
    clearLog();
    refreshDiag();
    diagNote("Cleared.");
  });

  autogrow();
  trackKeyboard();
  registerSW();
  await getRegexRules();
  showView(["home", "chars", "chat", "presets", "books", "detail", "regex", "stages", "forge"].includes(view) ? view : "home");
  if (bootError) {
    const msg = bootError && bootError.message ? bootError.message : String(bootError);
    const ch = document.getElementById("chat");
    if (ch) ch.innerHTML = `<div class="empty">Boot incomplete — ${escapeHtml(msg)}<small>Buttons still work. Check settings → Diagnostics, or reload.</small></div>`;
    refreshDiag();
  }
}

init();
