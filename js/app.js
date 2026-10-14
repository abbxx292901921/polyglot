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
  listPresets,
  savePreset,
  exportVaultToJSON,
  importVaultFromJSON,
  seedIfEmpty
} from "./db.js";

/* Polyglot Phase 1: persistent shell.
   Characters / personas / chats / messages live in IndexedDB (db.js).
   Left drawer is fully functional. Right drawer (presets/API) lands in Phase 2.
   Send path persists to DB; the assistant echo is still local until Phase 2
   swaps it for streaming generation. */

const $ = (sel) => document.querySelector(sel);
const ui = {
  characterId: Number(localStorage.getItem("polyglot.characterId")) || null,
  chatId: Number(localStorage.getItem("polyglot.chatId")) || null,
  personaId: Number(localStorage.getItem("polyglot.personaId")) || null
};
function persistUI() {
  for (const k of ["characterId", "chatId", "personaId"]) {
    if (ui[k] == null) localStorage.removeItem(`polyglot.${k}`);
    else localStorage.setItem(`polyglot.${k}`, String(ui[k]));
  }
}

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

function paintMessage(role, text, who) {
  const empty = $("#empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  const w = document.createElement("div");
  w.className = "who";
  w.textContent = who || (role === "user" ? "You" : "Polyglot");
  const body = document.createElement("div");
  body.innerHTML = renderRich(text);
  div.append(w, body);
  $("#chat").append(div);
  $("#chat").scrollTop = $("#chat").scrollHeight;
}

function clearChatView(emptyText = "No messages yet. Say hello.") {
  $("#chat").innerHTML = `<div class="empty" id="empty">${escapeHtml(emptyText)}</div>`;
}

async function ensureSelection() {
  const [chars, personas, chats] = await Promise.all([
    listCharacters(),
    listPersonas(),
    ui.characterId != null ? listChats(ui.characterId) : listChats()
  ]);
  if (personas.length && !personas.some((p) => p.id === ui.personaId)) {
    ui.personaId = (personas.find((p) => p.is_default) || personas[0]).id;
  }
  if (chars.length && !chars.some((c) => c.id === ui.characterId)) {
    ui.characterId = chars[0].id;
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

async function renderCurrentChat() {
  await ensureSelection();
  if (ui.chatId == null) {
    if (ui.characterId == null) {
      clearChatView("No characters yet. Tap ☰ to create one.");
      return;
    }
    const mine = await listChats(ui.characterId);
    if (!mine.length) {
      const chars = await listCharacters();
      const ch = chars.find((c) => c.id === ui.characterId);
      clearChatView(ch?.first_mes ? "" : "No messages yet. Say hello.");
      $("#chat").innerHTML = "";
      if (ch?.first_mes) paintMessage("assistant", ch.first_mes, ch.name);
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
  $("#chat").innerHTML = "";
  if (!rows.length) {
    if (ch?.first_mes) paintMessage("assistant", ch.first_mes, ch.name);
    else paintMessage("assistant", "*ready* This chat is stored on-device.", "Polyglot");
    return;
  }
  for (const m of rows) {
    const who = m.role === "user" ? me?.name || "You" : ch?.name || "Polyglot";
    paintMessage(m.role === "user" ? "user" : "assistant", m.content, who);
  }
}

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
    row.append(x);
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

async function handleSend() {
  const ta = $("#input");
  const text = ta.value.trim();
  if (!text) return;
  triggerHaptic(10);
  ta.value = "";
  autogrow();
  const chatId = await ensureChat();
  const [chars, personas] = await Promise.all([listCharacters(), listPersonas()]);
  const ch = chars.find((c) => c.id === ui.characterId);
  const me = personas.find((p) => p.id === ui.personaId);
  await saveMessage({ chat_id: chatId, role: "user", content: text, timestamp: Date.now() });
  paintMessage("user", text, me?.name || "You");
  const chat = (await listChats()).find((c) => c.id === chatId);
  if (chat) {
    if (!chat.title || chat.title.startsWith("Chat ")) {
      chat.title = text.slice(0, 42);
    }
    await touchChat(chat);
  }
  // Local echo until Phase 2 replaces this block with streaming generation.
  window.setTimeout(async () => {
    const reply = `*considers your words* "Offline vault works — this reply is saved on-device." You said: ${text}`;
    await saveMessage({ chat_id: chatId, role: "assistant", content: reply, timestamp: Date.now() });
    const cur = await listChats().then((all) => all.find((c) => c.id === chatId));
    if (cur) await touchChat(cur);
    if (ui.chatId === chatId) {
      paintMessage("assistant", reply, ch?.name || "Polyglot");
      triggerHaptic(25);
    }
    await refreshLibrary();
  }, 250);
  await refreshLibrary();
}

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
  } catch (e) {
    setVaultStatus(`Export failed: ${e.message}`);
  }
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
    persistUI();
    await ensureSelection();
    await refreshLibrary();
    await renderCurrentChat();
    setVaultStatus("Import complete.");
  } catch (e) {
    setVaultStatus(`Import failed: ${e.message}`);
  }
}

function autogrow() {
  const ta = $("#input");
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, window.innerHeight * 0.38) + "px";
}

function openDrawer(id) {
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

async function init() {
  $("#ver").textContent = APP_VERSION;
  window.__polyglot_version = APP_VERSION;
  await openDB();
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
  await renderCurrentChat();

  $("#btn-left").addEventListener("click", () => openDrawer("drawer-left"));
  $("#btn-right").addEventListener("click", () => openDrawer("drawer-right"));
  document.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", closeDrawers)
  );
  $("#backdrop").addEventListener("click", closeDrawers);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawers();
  });
  $("#send").addEventListener("click", handleSend);
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
  $("#btn-new-char").addEventListener("click", async () => {
    const name = window.prompt("Character name:", "New character");
    if (!name) return;
    const id = await saveCharacter({ name: name.trim(), first_mes: "*appears* Hello." });
    ui.characterId = id;
    ui.chatId = null;
    persistUI();
    await ensureSelection();
    await refreshLibrary();
    await renderCurrentChat();
  });
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

  autogrow();
  trackKeyboard();
  registerSW();
}

init();
