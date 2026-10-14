import { DB_NAME, DB_VERSION } from "./config.js";

/* Polyglot storage — vanilla IndexedDB, zero dependencies.
   6 stores mirroring the SillyTavern-lite model:
   characters, personas, chats, messages (compound chat_time index),
   lorebooks, presets. All data stays on-device. */

let dbp = null;

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("characters")) {
        const s = db.createObjectStore("characters", { keyPath: "id", autoIncrement: true });
        s.createIndex("name", "name", { unique: false });
        s.createIndex("created_at", "created_at", { unique: false });
      }
      if (!db.objectStoreNames.contains("personas")) {
        const s = db.createObjectStore("personas", { keyPath: "id", autoIncrement: true });
        s.createIndex("name", "name", { unique: false });
        s.createIndex("is_default", "is_default", { unique: false });
      }
      if (!db.objectStoreNames.contains("chats")) {
        const s = db.createObjectStore("chats", { keyPath: "id", autoIncrement: true });
        s.createIndex("character_id", "character_id", { unique: false });
        s.createIndex("updated_at", "updated_at", { unique: false });
      }
      if (!db.objectStoreNames.contains("messages")) {
        const s = db.createObjectStore("messages", { keyPath: "id", autoIncrement: true });
        s.createIndex("chat_id", "chat_id", { unique: false });
        s.createIndex("chat_time", ["chat_id", "timestamp"], { unique: false });
        s.createIndex("swipe_group_id", "swipe_group_id", { unique: false });
      }
      if (!db.objectStoreNames.contains("lorebooks")) {
        const s = db.createObjectStore("lorebooks", { keyPath: "id", autoIncrement: true });
        s.createIndex("character_id", "character_id", { unique: false });
      }
      if (!db.objectStoreNames.contains("presets")) {
        const s = db.createObjectStore("presets", { keyPath: "id", autoIncrement: true });
        s.createIndex("name", "name", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function storeRO(name) {
  const db = await openDB();
  return db.transaction(name, "readonly").objectStore(name);
}

async function getAll(name) {
  const st = await storeRO(name);
  return reqToPromise(st.getAll());
}

async function getById(name, id) {
  const st = await storeRO(name);
  return reqToPromise(st.get(id));
}

async function putRec(name, rec) {
  const db = await openDB();
  const tx = db.transaction(name, "readwrite");
  const req = tx.objectStore(name).put(rec);
  const id = await reqToPromise(req);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return id;
}

async function delRec(name, id) {
  const db = await openDB();
  const tx = db.transaction(name, "readwrite");
  tx.objectStore(name).delete(id);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function clearStore(name) {
  const db = await openDB();
  const tx = db.transaction(name, "readwrite");
  tx.objectStore(name).clear();
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function getByIndex(name, index, value) {
  const st = await storeRO(name);
  return reqToPromise(st.index(index).getAll(value));
}

// ---------- Characters ----------
export const listCharacters = () => getAll("characters");

export function saveCharacter(c) {
  const now = Date.now();
  return putRec("characters", {
    created_at: now,
    description: "",
    personality: "",
    scenario: "",
    first_mes: "",
    mes_example: "",
    avatar: null,
    ...c,
    updated_at: now
  });
}

export async function deleteCharacter(id) {
  // Cascade: chats + their messages, lorebooks.
  const chats = await getByIndex("chats", "character_id", id);
  for (const ch of chats) await deleteChat(ch.id);
  const books = await getByIndex("lorebooks", "character_id", id);
  for (const b of books) await delRec("lorebooks", b.id);
  await delRec("characters", id);
}

// ---------- Personas ----------
export const listPersonas = () => getAll("personas");

export function savePersona(p) {
  return putRec("personas", { created_at: Date.now(), description: "", is_default: 0, ...p });
}

export async function setDefaultPersona(id) {
  const all = await getAll("personas");
  const db = await openDB();
  const tx = db.transaction("personas", "readwrite");
  const st = tx.objectStore("personas");
  for (const p of all) {
    p.is_default = p.id === id ? 1 : 0;
    st.put(p);
  }
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const deletePersona = (id) => delRec("personas", id);

// ---------- Chats ----------
export async function listChats(characterId = null) {
  if (characterId == null) return getAll("chats");
  return getByIndex("chats", "character_id", characterId);
}

export function saveChat(c) {
  const now = Date.now();
  return putRec("chats", { created_at: now, ...c, updated_at: now });
}

export function touchChat(chat) {
  chat.updated_at = Date.now();
  return putRec("chats", chat);
}

export async function deleteChat(id) {
  const msgs = await getByIndex("messages", "chat_id", id);
  const db = await openDB();
  const tx = db.transaction("messages", "readwrite");
  const st = tx.objectStore("messages");
  for (const m of msgs) st.delete(m.id);
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  await delRec("chats", id);
}

// ---------- Messages ----------
export async function listMessages(chatId) {
  const db = await openDB();
  const tx = db.transaction("messages", "readonly");
  const idx = tx.objectStore("messages").index("chat_time");
  const range = IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER]);
  const rows = await reqToPromise(idx.getAll(range));
  rows.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
  return rows;
}

export function saveMessage(m) {
  return putRec("messages", {
    timestamp: Date.now(),
    reasoning_content: "",
    swipe_group_id: null,
    ...m
  });
}

export const deleteMessage = (id) => delRec("messages", id);

// ---------- Lorebooks ----------
export async function listLorebooks(characterId = null) {
  if (characterId == null) return getAll("lorebooks");
  return getByIndex("lorebooks", "character_id", characterId);
}

export function saveLorebook(b) {
  return putRec("lorebooks", { updated_at: Date.now(), entries: [], ...b });
}

export const deleteLorebook = (id) => delRec("lorebooks", id);

// ---------- Presets ----------
export const listPresets = () => getAll("presets");

export function savePreset(p) {
  return putRec("presets", { updated_at: Date.now(), ...p });
}

export const deletePreset = (id) => delRec("presets", id);

// ---------- Vault backup ----------
export async function exportVaultToJSON({ includeKeys = false } = {}) {
  const [characters, personas, chats, messages, lorebooks, presets] = await Promise.all([
    getAll("characters"),
    getAll("personas"),
    getAll("chats"),
    getAll("messages"),
    getAll("lorebooks"),
    getAll("presets")
  ]);
  const safePresets = presets.map((p) => {
    if (includeKeys || !p.connection) return p;
    return { ...p, connection: { ...p.connection, api_key: "" } };
  });
  return {
    app: "Polyglot",
    version: 1,
    exported_at: new Date().toISOString(),
    tables: { characters, personas, chats, messages, lorebooks, presets: safePresets }
  };
}

export async function importVaultFromJSON(data, { merge = false } = {}) {
  if (!data || typeof data !== "object" || !data.tables) {
    throw new Error("Not a Polyglot vault file (missing tables).");
  }
  const names = ["characters", "personas", "chats", "messages", "lorebooks", "presets"];
  for (const n of names) {
    if (data.tables[n] !== undefined && !Array.isArray(data.tables[n])) {
      throw new Error(`Vault table "${n}" is corrupt (expected array).`);
    }
  }
  if (!merge) {
    for (const n of names) await clearStore(n);
  }
  for (const n of names) {
    const rows = data.tables[n] || [];
    for (const r of rows) await putRec(n, r);
  }
  return true;
}

export async function seedIfEmpty(defaults) {
  const [personas, presets, characters] = await Promise.all([
    getAll("personas"),
    getAll("presets"),
    getAll("characters")
  ]);
  if (!personas.length) {
    await savePersona({ name: "You", description: "", is_default: 1 });
  }
  if (!presets.length && defaults?.preset) {
    await savePreset(defaults.preset);
  }
  if (!characters.length && defaults?.character) {
    await saveCharacter(defaults.character);
  }
}
