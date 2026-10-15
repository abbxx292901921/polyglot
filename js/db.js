import { DB_NAME, DB_VERSION } from "./config.js";

// Polyglot storage — vanilla IndexedDB, zero dependencies.
// 10 stores: characters, personas, chats, messages (compound chat_time),
// lorebooks, presets, providers, regex_rules, stages (Phase 6 defs),
// chat_stage_state (Phase 6 per-chat state). All data stays on-device.

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
      if (!db.objectStoreNames.contains("providers")) {
        const s = db.createObjectStore("providers", { keyPath: "id", autoIncrement: true });
        s.createIndex("name", "name", { unique: false });
      }
      if (!db.objectStoreNames.contains("regex_rules")) {
        const s = db.createObjectStore("regex_rules", { keyPath: "id", autoIncrement: true });
        s.createIndex("character_id", "character_id", { unique: false });
      }
      if (!db.objectStoreNames.contains("stages")) {
        const s = db.createObjectStore("stages", { keyPath: "id", autoIncrement: true });
        s.createIndex("key", "key", { unique: true });
      }
      if (!db.objectStoreNames.contains("chat_stage_state")) {
        const s = db.createObjectStore("chat_stage_state", { keyPath: "id", autoIncrement: true });
        s.createIndex("chat_id", "chat_id", { unique: false });
        s.createIndex("chat_stage", ["chat_id", "stage_key"], { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Without this, a version upgrade blocked by another open tab stalls
    // every await forever and the app looks dead with no error. Reject loudly.
    req.onblocked = () => reject(new Error("E_DB_OPEN: database blocked — close other Polyglot tabs, then reload."));
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
    alternate_greetings: [],
    system_prompt: "",
    avatar: null,
    ...c,
    updated_at: now
  });
}

export async function deleteCharacter(id) {
  // Cascade: chats + their messages, lorebooks, per-character regex rules.
  const chats = await getByIndex("chats", "character_id", id);
  for (const ch of chats) await deleteChat(ch.id);
  const books = await getByIndex("lorebooks", "character_id", id);
  for (const b of books) await delRec("lorebooks", b.id);
  const rules = await getByIndex("regex_rules", "character_id", id);
  for (const r of rules) await delRec("regex_rules", r.id);
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
  try {
    const states = await getByIndex("chat_stage_state", "chat_id", id);
    for (const s of states) await delRec("chat_stage_state", s.id);
  } catch {
    // Pre-v4 DBs have no stage state table yet.
  }
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
    parent_id: null,
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

// ---------- Presets (model presets: model + reasoning + samplers + prompts) ----------
export const listPresets = () => getAll("presets");

export function savePreset(p) {
  return putRec("presets", { updated_at: Date.now(), ...p });
}

export const deletePreset = (id) => delRec("presets", id);

// ---------- Providers (connections: base_url + key + proxy, no sampling) ----------
// Shape: {name, base_url, api_key, use_proxy:0|1|bool, proxy_url, updated_at}.
export const listProviders = () => getAll("providers");

export function saveProvider(p) {
  return putRec("providers", { updated_at: Date.now(), ...p });
}

export const deleteProvider = (id) => delRec("providers", id);

// ---------- Regex scripts (Phase 5) ----------
// Rule shape: {name, pattern, replacement, flags, place:"prompt"|"display"|"both",
//   character_id:null|id (null = global), enabled:0|1, updated_at}.
export async function listRegexRules(characterId = null) {
  if (characterId == null) return getAll("regex_rules");
  const [global, scoped] = await Promise.all([
    getByIndex("regex_rules", "character_id", null),
    getByIndex("regex_rules", "character_id", characterId)
  ]);
  return [...global, ...scoped];
}

export const listAllRegexRules = () => getAll("regex_rules");

export function saveRegexRule(r) {
  return putRec("regex_rules", {
    name: "",
    pattern: "",
    replacement: "",
    flags: "g",
    place: "both",
    character_id: null,
    enabled: 1,
    updated_at: Date.now(),
    ...r,
    updated_at: Date.now()
  });
}

export const deleteRegexRule = (id) => delRec("regex_rules", id);

// ---------- Stages (Phase 6) ----------
// stages: global defs {key, name, enabled:0|1, config:{...}}.
// chat_stage_state: per-chat {chat_id, stage_key, state:{...}, settings:{...}}.
export async function listStages() {
  try {
    return await getAll("stages");
  } catch {
    return [];
  }
}

export function saveStage(s) {
  return putRec("stages", {
    key: "",
    name: "",
    enabled: 1,
    config: {},
    updated_at: Date.now(),
    ...s,
    updated_at: Date.now()
  });
}

export const deleteStage = (id) => delRec("stages", id);

export async function getStageState(chatId, stageKey) {
  try {
    const db = await openDB();
    const tx = db.transaction("chat_stage_state", "readonly");
    const idx = tx.objectStore("chat_stage_state").index("chat_stage");
    const row = await reqToPromise(idx.get([chatId, stageKey]));
    return row || null;
  } catch {
    return null;
  }
}

export async function saveStageState(chatId, stageKey, state, settings) {
  const prev = await getStageState(chatId, stageKey);
  const rec = {
    chat_id: chatId,
    stage_key: stageKey,
    state: state ?? {},
    settings: settings ?? (prev?.settings || {}),
    updated_at: Date.now()
  };
  if (prev?.id != null) rec.id = prev.id;
  return putRec("chat_stage_state", rec);
}

export async function listStageStates(chatId) {
  try {
    if (chatId == null) return await getAll("chat_stage_state");
    return await getByIndex("chat_stage_state", "chat_id", chatId);
  } catch {
    return [];
  }
}

export async function seedStagesIfEmpty() {
  let rows = [];
  try {
    rows = await getAll("stages");
  } catch {
    return;
  }
  if (rows.length) return;
  const defs = [
    { key: "director", name: "Director", enabled: 1, config: {} },
    { key: "world", name: "World State", enabled: 1, config: {} },
    { key: "dice", name: "Dice", enabled: 1, config: {} },
    { key: "chess", name: "Chess", enabled: 0, config: { difficulty: 2, board_scale: "M" } }
  ];
  for (const d of defs) {
    try {
      await putRec("stages", { ...d, updated_at: Date.now() });
    } catch {
      // Ignore per-row failures so boot never bricks on stages.
    }
  }
}

// ---------- Vault backup ----------
export async function exportVaultToJSON({ includeKeys = false } = {}) {
  const [characters, personas, chats, messages, lorebooks, presets, providers, regex_rules, stages, chat_stage_state] = await Promise.all([
    getAll("characters"),
    getAll("personas"),
    getAll("chats"),
    getAll("messages"),
    getAll("lorebooks"),
    getAll("presets"),
    getAll("providers").catch(() => []),
    getAll("regex_rules").catch(() => []),
    getAll("stages").catch(() => []),
    getAll("chat_stage_state").catch(() => [])
  ]);
  const safePresets = presets.map((p) => {
    if (includeKeys || !p.connection) return p;
    return { ...p, connection: { ...p.connection, api_key: "" } };
  });
  const safeProviders = providers.map((p) => {
    if (includeKeys) return p;
    return { ...p, api_key: "" };
  });
  return {
    app: "Polyglot",
    version: 3,
    exported_at: new Date().toISOString(),
    tables: { characters, personas, chats, messages, lorebooks, presets: safePresets, providers: safeProviders, regex_rules, stages, chat_stage_state }
  };
}

export async function importVaultFromJSON(data, { merge = false } = {}) {
  if (!data || typeof data !== "object" || !data.tables) {
    throw new Error("E_VAULT_SHAPE: not a Polyglot vault file (missing tables).");
  }
  // regex_rules + providers + stages are optional so older vaults still import.
  const names = ["characters", "personas", "chats", "messages", "lorebooks", "presets", "providers", "regex_rules", "stages", "chat_stage_state"];
  for (const n of names) {
    if (data.tables[n] !== undefined && !Array.isArray(data.tables[n])) {
      throw new Error(`E_VAULT_TABLE: vault table "${n}" is corrupt (expected array).`);
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
  const [personas, presets, providers, characters] = await Promise.all([
    getAll("personas"),
    getAll("presets"),
    getAll("providers").catch(() => []),
    getAll("characters")
  ]);
  if (!personas.length) {
    await savePersona({ name: "You", description: "", is_default: 1 });
  }
  if (!providers.length && defaults?.provider) {
    await saveProvider(defaults.provider);
  }
  if (!presets.length && defaults?.preset) {
    await savePreset(defaults.preset);
  }
  if (!characters.length && defaults?.character) {
    await saveCharacter(defaults.character);
  }
}
