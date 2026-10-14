import { APP_VERSION, DEFAULT_CONNECTION, DEFAULT_SAMPLERS, DEFAULT_PROMPTS } from "./config.js";
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
  listPresets,
  savePreset,
  deletePreset,
  exportVaultToJSON,
  importVaultFromJSON,
  seedIfEmpty
} from "./db.js";
import { buildMessages, estimateTokens } from "./prompt-engine.js";
import { sendChat } from "./api-client.js";
import { parsePNGCard, parseCharacterJSON, normalizeCharacter, fileToAvatarDataURL } from "./png-parser.js";
import {
  err as logErr, warn as logWarn, info as logInfo,
  recent as diagRecent, clearLog, report as diagReport
} from "./diagnostics.js";

/* Polyglot Phase 3: full SillyTavern-lite.
   Library + vault (P1), streaming presets (P2), plus: PNG/JSON card import
   with avatar shrink + lorebook auto-unpack, swipe sibling trees, retry,
   continue, impersonate, per-message edit/delete, character editor modal,
   per-chat export/import, and coded diagnostics (see js/diagnostics.js).
   Without a configured model, generation falls back to the offline echo so
   every path stays testable with no network. */

const $ = (sel) => document.querySelector(sel);
const ui = {
  characterId: Number(localStorage.getItem("polyglot.characterId")) || null,
  chatId: Number(localStorage.getItem("polyglot.chatId")) || null,
  personaId: Number(localStorage.getItem("polyglot.personaId")) || null,
  presetId: Number(localStorage.getItem("polyglot.presetId")) || null
};
function persistUI() {
  for (const k of ["characterId", "chatId", "personaId", "presetId"]) {
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

export function triggerHaptic(ms = 10) {
  try {
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch {
    /* iOS Safari has no vibration API — silently ignore. */
  }
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
// **bold**, *action* (muted italic), "dialogue" (bright). Paragraphs preserved.
export function renderRich(text) {
  const paras = escapeHtml(text).split(/\n{2,}/);
  return paras
    .map((p) => {
      let h = p.replace(/\n/g, "<br>");
      h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      h = h.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em class="action">*$2*</em>');
      h = h.replace(/&quot;([^&\n]+)&quot;/g, '<span class="dialogue">&quot;$1&quot;</span>');
      return `<p>${h}</p>`;
    })
    .join("");
}

function scrollBottom() {
  $("#chat").scrollTop = $("#chat").scrollHeight;
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
  const [chars, personas, presets, chats] = await Promise.all([
    listCharacters(),
    listPersonas(),
    listPresets(),
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

async function getActivePreset() {
  const presets = await listPresets();
  return presets.find((p) => p.id === ui.presetId) || presets[0] || null;
}

// ---------- Message tree (swipe groups) ----------
function groupRows(rows) {
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
      it.active = it.msgs.find((m) => m.swipe_active === 1) || it.msgs[it.msgs.length - 1];
    }
  }
  return items;
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
  if (ui.chatId == null) {
    if (ui.characterId == null) {
      clearChatView("No characters yet. Tap ☰ to create or import one.");
      return;
    }
    const mine = await listChats(ui.characterId);
    if (!mine.length) {
      const chars = await listCharacters();
      const ch = chars.find((c) => c.id === ui.characterId);
      $("#chat").innerHTML = "";
      if (ch?.first_mes) {
        const s = paintShell("assistant", ch.name);
        s.det.remove();
        s.body.innerHTML = renderRich(ch.first_mes);
        s.body.classList.add("msgbody");
      } else clearChatView("No messages yet. Say hello.");
      return;
    }
    mine.sort((a, b) => b.updated_at - a.updated_at);
    ui.chatId = mine[0].id;
    persistUI();
  }
  const rows = await listMessages(ui.chatId);
  const [chars, personas] = await Promise.all([listCharacters(), listPersonas()]);
  const ch = chars.find((c) => c.id === ui.characterId);
  const me = personas.find((p) => p.id === ui.personaId);
  const chName = ch?.name || "Polyglot";
  const meName = me?.name || "You";
  $("#chat").innerHTML = "";
  if (!rows.length) {
    if (ch?.first_mes) {
      const s = paintShell("assistant", chName);
      s.det.remove();
      s.body.innerHTML = renderRich(ch.first_mes);
    } else {
      const s = paintShell("assistant", "Polyglot");
      s.det.remove();
      s.body.innerHTML = renderRich("*ready* This chat is stored on-device.");
    }
    return;
  }
  const items = groupRows(rows);
  items.forEach((it, ii) => {
    const isLast = ii === items.length - 1;
    if (it.kind === "user") {
      const div = document.createElement("div");
      div.className = "msg user";
      div.innerHTML = `<div class="who">${escapeHtml(meName)}</div>`;
      const body = document.createElement("div");
      body.className = "msgbody";
      body.innerHTML = renderRich(it.msg.content);
      const acts = document.createElement("div");
      acts.className = "acts";
      acts.append(
        actionButton("✎ Edit", "Edit message", () =>
          openEditorBubble(div, it.msg, async (v) => {
            await saveMessage({ ...it.msg, content: v });
            await renderCurrentChat();
          })),
        actionButton("🗑", "Delete message", async () => {
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
    if (active.reasoning_content) {
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
    body.innerHTML = renderRich(active.content);
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
      actionButton("↻", "Regenerate (new variant)", () => handleRetry(it)),
      actionButton("✎ Edit", "Edit message", () =>
        openEditorBubble(div, active, async (v) => {
          await saveMessage({ ...active, content: v });
          await renderCurrentChat();
        })),
      actionButton("🗑", "Delete message", async () => {
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
    nm.title = "Tap to switch";
    nm.style.cursor = "pointer";
    nm.addEventListener("click", async () => {
      ui.personaId = p.id;
      await setDefaultPersona(p.id);
      persistUI();
      await refreshLibrary();
      await renderCurrentChat();
    });
    row.append(nm);
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
}

// ---------- Preset editor ----------
function setPresetStatus(msg) {
  $("#preset-status").textContent = msg;
}

function readPresetForm() {
  const stops = $("#sam-stop").value.split("\n").map((s) => s.trim()).filter((s) => s.length);
  return {
    name: $("#conn-label").value.trim() || "Preset",
    connection: {
      label: $("#conn-label").value.trim() || "Preset",
      base_url: $("#conn-url").value.trim(),
      api_key: $("#conn-key").value,
      model: $("#conn-model").value.trim(),
      reasoning_strategy: $("#conn-strategy").value,
      reasoning_effort: $("#conn-effort").value,
      thinking_budget: Number($("#conn-budget").value) || 2048,
      use_proxy: $("#conn-proxy-use").checked,
      proxy_url: $("#conn-proxy-url").value.trim()
    },
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
  const c = preset.connection || {};
  const s = preset.samplers || {};
  const p = preset.prompts || {};
  $("#conn-label").value = preset.name || c.label || "";
  $("#conn-url").value = c.base_url || "";
  $("#conn-key").value = c.api_key || "";
  $("#conn-model").value = c.model || "";
  $("#conn-strategy").value = c.reasoning_strategy || "none";
  $("#conn-effort").value = c.reasoning_effort || "medium";
  $("#conn-budget").value = c.thinking_budget ?? 2048;
  $("#conn-proxy-use").checked = !!c.use_proxy;
  $("#conn-proxy-url").value = c.proxy_url || "";
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

async function refreshPresets() {
  const presets = await listPresets();
  if (!presets.some((p) => p.id === ui.presetId) && presets.length) {
    ui.presetId = presets[0].id;
    persistUI();
  }
  const box = $("#preset-list");
  box.innerHTML = "";
  for (const p of presets) {
    const row = document.createElement("div");
    row.className = "row" + (p.id === ui.presetId ? " active" : "");
    const nm = document.createElement("span");
    nm.className = "nm";
    nm.textContent = p.name || "Preset";
    nm.style.cursor = "pointer";
    nm.addEventListener("click", async () => {
      const cur = await getActivePreset();
      if (cur && cur.id === ui.presetId) await savePreset({ ...cur, ...readPresetForm(), id: cur.id });
      ui.presetId = p.id;
      persistUI();
      const fresh = await listPresets();
      fillPresetForm(fresh.find((x) => x.id === p.id) || p);
      await refreshPresets();
      setPresetStatus("");
    });
    row.append(nm);
    box.append(row);
  }
  const active = presets.find((p) => p.id === ui.presetId) || presets[0];
  if (active) fillPresetForm(active);
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
  const [chars, personas, preset] = await Promise.all([
    listCharacters(),
    listPersonas(),
    getActivePreset()
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
  const charHead = [ch?.description, ch?.personality, ch?.scenario, ch?.mes_example]
    .filter((s) => s && String(s).trim()).join("\n\n");
  const sysBase = [preset?.prompts?.system || "", charHead].filter((s) => s.trim()).join("\n\n");
  const built = buildMessages({
    system: sysBase,
    jailbreak: preset?.prompts?.jailbreak || "",
    authorsNote: preset?.prompts?.authors_note || "",
    authorsNoteDepth: preset?.prompts?.authors_note_depth ?? 2,
    loreEntries: flatLore,
    recentText: recent,
    history,
    prefill: preset?.prompts?.prefill_enabled ? preset.prompts.prefill_text || "*" : null,
    macroCtx,
    budget: {
      limit: preset?.samplers?.context_window_limit ?? 8192,
      maxTokens: preset?.samplers?.max_tokens ?? 800
    }
  });
  return { preset, ch, me, chName: ch?.name || "Polyglot", meName: me?.name || "You", built };
}

// Streams preset.messages into a live shell. Resolves {content, reasoning}.
async function runStream(preset, messages, shell, signal) {
  const t0 = Date.now();
  let acc = "";
  let accThink = "";
  const renderLive = () => {
    shell.body.innerHTML = renderRich(acc);
    if (accThink) {
      shell.det.style.display = "";
      shell.tb.textContent = accThink;
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      shell.sum.textContent = `💭 Thought Trace (${secs}s • ~${estimateTokens(accThink)} tok) [Tap to view]`;
    }
    scrollBottom();
  };
  const { content, reasoning } = await sendChat({
    connection: preset.connection,
    samplers: preset.samplers,
    messages,
    signal,
    onContent: (t) => { acc += t; renderLive(); },
    onReasoning: (t) => { accThink += t; renderLive(); }
  });
  shell.det.open = false;
  renderLive();
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

// Fresh assistant reply for history rows (+ optional trailing user text already saved).
async function generateAssistant(chatId, pastRows, { groupId = null, titleHint = "" } = {}) {
  const { preset, chName, built } = await buildContext(pastRows);
  if (!preset?.connection?.model) {
    const lastUser = [...pastRows].reverse().find((m) => m.role === "user");
    const reply = offlineEcho(lastUser?.content || "", chName);
    const id = await saveMessage({
      chat_id: chatId, role: "assistant", content: reply,
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
    const { content, reasoning } = await runStream(preset, built.messages, shell, aborter.signal);
    if (!content && !reasoning) throw new Error("E_UI_SEND: empty reply from provider.");
    const gid = groupId || `g${Date.now()}`;
    const id = await saveMessage({
      chat_id: chatId, role: "assistant",
      content: content || "(thinking only — see trace)",
      reasoning_content: reasoning, swipe_group_id: gid,
      swipe_active: 1, timestamp: Date.now()
    });
    if (groupId) await setActiveSibling(chatId, groupId, id);
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
  await saveMessage({ chat_id: chatId, role: "user", content: text, timestamp: Date.now() });
  // Paint instantly (includes the new user message), then generate below it.
  await renderCurrentChat();
  const rows = await listMessages(chatId);
  await generateAssistant(chatId, rows, { titleHint: text });
}

async function handleRetry(item) {
  if (generating()) return;
  if (!item || (item.kind !== "group" && item.kind !== "solo")) return;
  triggerHaptic(10);
  const chatId = ui.chatId;
  const rows = await listMessages(chatId);
  const sibs = item.kind === "group" ? item.msgs : [item.msg];
  const first = sibs[0];
  const pos = rows.findIndex((m) => m.id === first.id);
  const history = pos === -1 ? rows : rows.slice(0, pos);
  const groupId = item.kind === "group" ? item.groupId : `g${Date.now()}`;
  if (item.kind === "solo") {
    await saveMessage({ ...first, swipe_group_id: groupId });
  }
  await generateAssistant(chatId, history, { groupId });
}

async function handleContinue() {
  if (generating()) return;
  const chatId = await ensureChat();
  const rows = await listMessages(chatId);
  if (!rows.length) return;
  const last = rows[rows.length - 1];
  triggerHaptic(10);
  if (last.role !== "assistant") {
    await generateAssistant(chatId, rows);
    return;
  }
  // Append to the last assistant message.
  const { preset, chName } = await buildContext(rows.slice(0, -1));
  if (!preset?.connection?.model) {
    const more = " *(nods along, offline echo continues.)*";
    await saveMessage({ ...last, content: last.content + more });
    await renderCurrentChat();
    return;
  }
  // History keeps the partial reply as the final assistant message (no prefill).
  const ctx = await buildContext(rows);
  const shell = paintShell("assistant", chName);
  // Seed the shell with the existing partial text.
  shell.body.innerHTML = renderRich(last.content);
  document.body.classList.add("generating");
  aborter = new AbortController();
  try {
    const { content, reasoning } = await runStream(preset, ctx.built.messages, shell, aborter.signal);
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
  const rows = await listMessages(chatId);
  const { preset, meName } = await buildContext(rows);
  triggerHaptic(10);
  if (!preset?.connection?.model) {
    const text = "*leans forward, offline echo as you.* \"No model set — open ⚙ and add a preset.\"";
    await saveMessage({ chat_id: chatId, role: "user", content: text, timestamp: Date.now() });
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
    const { content } = await runStream(preset, ctx.built.messages, shell, aborter.signal);
    if (!content) throw new Error("E_UI_SEND: empty impersonation from provider.");
    await saveMessage({ chat_id: chatId, role: "user", content, timestamp: Date.now() });
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
    persistUI();
    await ensureSelection();
    await refreshLibrary();
    await refreshPresets();
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
    for (const m of sorted) {
      await saveMessage({
        chat_id: chatId,
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content ?? ""),
        reasoning_content: m.reasoning_content || "",
        swipe_group_id: m.swipe_group_id || null,
        timestamp: Number(m.timestamp) || Date.now()
      });
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

// ---------- Character editor + card import ----------
function setCardStatus(msg) {
  $("#card-status").textContent = msg;
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

function openCharEditor(charId = null, prefill = null) {
  edId = charId;
  edAvatar = prefill?.avatar ?? null;
  edLore = (prefill?.loreEntries || []).map((e) => ({
    keys: Array.isArray(e.keys) ? e.keys : [],
    content: e.content || "",
    enabled: e.enabled !== false,
    insertion_order: e.insertion_order ?? 0
  }));
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

async function handleCardFile(file) {
  const name = file.name.toLowerCase();
  try {
    setCardStatus("Reading card…");
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
      setCardStatus(`Parsed ${kind}. Review below, then Save.`);
      openCharEditor(null, { ...norm, note: `Imported ${kind}. Review the text, then Save character.` });
      return;
    }
    if (name.endsWith(".webp") && file.type === "image/webp") {
      setCardStatus("WebP holds no embed — set fields manually or import its JSON.");
      openCharEditor(null, {
        character: { name: file.name.replace(/\.webp$/i, "") },
        loreEntries: [], avatar,
        note: "E_CARD_NONE: WebP image loaded as avatar only; paste fields or import JSON."
      });
      return;
    }
    const buf = await file.arrayBuffer();
    const { data, kind } = await parsePNGCard(buf);
    const norm = normalizeCharacter(data);
    norm.avatar = avatar;
    setCardStatus(`Parsed ${kind}. Review below, then Save.`);
    openCharEditor(null, { ...norm, note: `Imported ${kind}${norm.loreEntries.length ? ` + ${norm.loreEntries.length} lore entries` : ""}. Review the text, then Save character.` });
  } catch (e) {
    logErr("E_UI_IMPORT", e.message);
    setCardStatus(`Import failed: ${e.message}`);
  }
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

async function init() {
  $("#ver").textContent = APP_VERSION;
  window.__polyglot_version = APP_VERSION;
  try {
    await openDB();
  } catch (e) {
    document.getElementById("chat").innerHTML =
      `<div class="empty">E_DB_OPEN: storage failed — ${escapeHtml(e.message)}<small>Private mode or quota. Reload to retry.</small></div>`;
    logErr("E_DB_OPEN", e.message);
    return;
  }
  await seedIfEmpty({
    preset: {
      name: "Default",
      connection: { ...DEFAULT_CONNECTION },
      samplers: { ...DEFAULT_SAMPLERS },
      prompts: { ...DEFAULT_PROMPTS }
    }
  });
  await ensureSelection();
  await refreshLibrary();
  await refreshPresets();
  await renderCurrentChat();
  refreshDiag();
  logInfo("E_UI_SEND", `ready ${APP_VERSION}`);

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

  $("#btn-new-persona").addEventListener("click", async () => {
    const name = window.prompt("Persona name:", "You");
    if (!name) return;
    const id = await savePersona({ name: name.trim() });
    ui.personaId = id;
    persistUI();
    await refreshLibrary();
    await renderCurrentChat();
  });
  $("#btn-new-char").addEventListener("click", () => openCharEditor(null));
  $("#btn-new-chat").addEventListener("click", async () => {
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
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) await handleCardFile(f);
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

  $("#btn-new-preset").addEventListener("click", async () => {
    const name = window.prompt("Preset name:", "Preset 2");
    if (!name) return;
    const id = await savePreset({
      name: name.trim(),
      connection: { ...DEFAULT_CONNECTION, label: name.trim() },
      samplers: { ...DEFAULT_SAMPLERS },
      prompts: { ...DEFAULT_PROMPTS }
    });
    ui.presetId = id;
    persistUI();
    await refreshPresets();
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
    setPresetStatus("Deleted.");
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
}

init();
