/* Boot smoke test: runs the REAL init() from js/app.js against DOM + IndexedDB
   stubs and asserts the app wires up without throwing. Catches the class of
   bug where a module parses fine but dies at runtime (see AGENTS.md rule 9).
   Run with:  node tools/boot.test.mjs */

const created = [];
let rejections = 0;

function mkEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: "",
    innerHTML: "",
    textContent: "",
    value: "",
    checked: false,
    hidden: false,
    disabled: false,
    className: "",
    dataset: {},
    options: [],
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { if (f === undefined) f = !this._s.has(c); f ? this._s.add(c) : this._s.delete(c); return f; },
      contains(c) { return this._s.has(c); }
    },
    children: [],
    files: [],
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    append(...c) { c.forEach((x) => this.children.push(x)); },
    remove() {},
    replaceWith() {},
    contains() { return false; },
    focus() {},
    click() {},
    select() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, right: 360, bottom: 640, width: 360, height: 640, x: 0, y: 0 }; },
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    get scrollHeight() { return 1000; },
    set scrollTop(v) { this._scrollTop = v; },
    get scrollTop() { return this._scrollTop || 0; },
    get clientHeight() { return 640; },
    get clientWidth() { return 360; }
  };
  created.push(el);
  return el;
}

const store = new Map();

globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); }
};

globalThis.document = {
  documentElement: mkEl("html"),
  body: mkEl("body"),
  createElement: (t) => mkEl(t),
  createElementNS: (ns, t) => mkEl(t),
  createTextNode: (t) => ({ textContent: t }),
  getElementById: (id) => mkEl("div"),
  querySelector: () => mkEl("div"),
  querySelectorAll: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  execCommand: () => true,
  hidden: false
};

globalThis.window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: () => 0,
  clearInterval: () => {},
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
  innerHeight: 800,
  innerWidth: 360,
  scrollTo: () => {},
  location: { reload() {}, href: "http://localhost/" },
  getComputedStyle: () => ({ getPropertyValue: () => "" }),
  visualViewport: null,
  navigator: { vibrate: null }
};

try {
  Object.defineProperty(globalThis, "navigator", {
    value: {
      vibrate: null,
      onLine: true,
      serviceWorker: null,
      clipboard: null,
      userAgent: "node-test"
    },
    configurable: true,
    writable: true
  });
} catch { /* node already provides a navigator */ }

globalThis.CSS = { supports: () => false };
globalThis.IDBKeyRange = { bound: (a, b) => ({ a, b }) };

// --- Minimal IndexedDB -------------------------------------------------
function req(result) {
  const r = { result, onsuccess: null, onerror: null };
  setTimeout(() => r.onsuccess && r.onsuccess(), 0);
  return r;
}
function makeStore(name) {
  const m = new Map();
  const self = {
    _m: m,
    createIndex() {},
    index() { return { getAll: () => req([]), get: () => req(undefined) }; },
    getAll: () => req([...m.values()]),
    get: (k) => req(m.get(k)),
    put(v) {
      if (v.id == null) v.id = ++makeStore._n;
      m.set(v.id, v);
      return req(v.id);
    },
    delete: (k) => { m.delete(k); return req(undefined); },
    clear: () => { m.clear(); return req(undefined); },
    count: () => req(m.size)
  };
  return self;
}
makeStore._n = 0;

const objectStoreNames = ["characters", "personas", "chats", "messages", "lorebooks",
  "presets", "providers", "regex_rules", "stages", "chat_stage_state", "minigames"];

// Exposed so the test can prove the boot really wrote to the database
// instead of hanging on a transaction that never completed.
const dbStores = {};

globalThis.indexedDB = {
  open() {
    const r = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: null };
    setTimeout(() => {
      const stores = {};
      for (const n of objectStoreNames) {
        stores[n] = makeStore(n);
        dbStores[n] = stores[n]._m;
      }
      r.result = {
        objectStoreNames: { contains: (n) => !!stores[n] },
        createObjectStore: (n) => makeStore(n),
        // A transaction has to fire oncomplete. db.js awaits it after every
        // write, so a transaction that never completes leaves every write
        // hanging in silence and the boot test would pass without having
        // exercised a single write.
        transaction: () => {
          const tx = { oncomplete: null, onerror: null, onabort: null, _pending: 0, _done: false };
          const settle = () => {
            if (tx._pending > 0 || tx._done) return;
            tx._done = true;
            setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
          };
          tx.objectStore = (n) => {
            const st = stores[n] || makeStore(n);
            for (const op of ["put", "delete", "clear"]) {
              const orig = st[op].bind(st);
              st[op] = (...args) => {
                tx._pending++;
                const req = orig(...args);
                setTimeout(() => { tx._pending--; settle(); }, 0);
                return req;
              };
            }
            return st;
          };
          return tx;
        },
        close() {}
      };
      if (r.onupgradeneeded) r.onupgradeneeded();
      if (r.onsuccess) r.onsuccess();
    }, 0);
    return r;
  }
};

process.on("unhandledRejection", (e) => {
  rejections++;
  console.log("UNHANDLED REJECTION:", e && e.message ? e.message : e);
});

const mod = await import("../js/app.js");
console.log("module loaded, exports:", Object.keys(mod).sort().join(", "));

// app.js calls init() on import. Wait for it to start (it stamps the version
// on window) and then for the async data load to settle.
const errors = [];
const realErr = console.error;
console.error = (...a) => { errors.push(a.map(String).join(" ")); realErr(...a); };

let started = false;
for (let i = 0; i < 100; i++) {
  if (globalThis.window.__polyglot_version) { started = true; break; }
  await new Promise((r) => setTimeout(r, 10));
}
console.log(started ? `INIT_STARTED ${globalThis.window.__polyglot_version}` : "INIT_NEVER_STARTED");
await new Promise((r) => setTimeout(r, 400));

// Exercise the pure helpers the UI leans on.
if (typeof mod.renderRich === "function") {
  const sample = "Hello **world**\n\n*action* and \"dialogue\"\n\n`code`";
  const html = mod.renderRich(sample);
  if (!html.includes("<strong>world</strong>")) throw new Error("renderRich broken");
  console.log("RENDER_OK");
}

// Exercise the minigames panel against the stub DOM: the library, the
// session list, the card builder and the log all have to survive a build.
if (typeof mod.renderGamesView === "function") {
  await mod.renderGamesView();
  console.log("GAMES_OK");
}

// The boot seeds a default persona, preset, provider and the stage defs. If
// the stub transaction never completed, those writes would have hung in
// silence and the boot would still look clean, so assert they actually
// landed. (Characters are not seeded here: they come from the starter
// modal, not seedIfEmpty.)
await new Promise((r) => setTimeout(r, 150));
const mustBeSeeded = ["personas", "presets", "providers", "stages"];
const seeded = mustBeSeeded.filter((n) => dbStores[n] && dbStores[n].size > 0);
const missing = mustBeSeeded.filter((n) => !(dbStores[n] && dbStores[n].size > 0));
if (missing.length) {
  console.log("SEED_MISSING " + missing.join(","));
  process.exitCode = 1;
} else {
  console.log("SEED_OK " + seeded.join(","));
}

await new Promise((r) => setTimeout(r, 250));
const bootErrors = errors.filter((e) => !/E_UI_SEND\] boot/.test(e));
console.log(rejections ? `REJECTIONS=${rejections}` : "NO_REJECTIONS");
console.log(bootErrors.length ? `BOOT_ERRORS=${bootErrors.length}\n` + bootErrors.join("\n") : "BOOT_CLEAN");
process.exit(rejections || bootErrors.length || !started ? 1 : 0);
