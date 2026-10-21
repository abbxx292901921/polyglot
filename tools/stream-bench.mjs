/* Benchmark: the OLD live-stream path (full renderRich + innerHTML per token)
   vs the NEW incremental path, over a realistic reply.
   Run with:  node tools/stream-bench.mjs  */

function mkEl(tag = "div") {
  return {
    tagName: String(tag).toUpperCase(),
    innerHTML: "",
    textContent: "",
    children: [],
    style: { setProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    get scrollHeight() { return this.children.length * 40; }
  };
}

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
  documentElement: mkEl("html"),
  body: mkEl("body"),
  createElement: (t) => mkEl(t),
  createElementNS: (ns, t) => mkEl(t),
  getElementById: () => mkEl("div"),
  querySelector: () => mkEl("div"),
  querySelectorAll: () => [],
  addEventListener: () => {}
};
globalThis.window = {
  addEventListener: () => {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  setTimeout, clearTimeout,
  matchMedia: () => ({ matches: false }),
  innerHeight: 800, visualViewport: null
};
globalThis.CSS = { supports: () => false };
// init() awaits openDB(); never settling it keeps the boot quiet and lets the
// benchmark run on its own.
globalThis.indexedDB = { open: () => ({ onsuccess: null, onerror: null, onupgradeneeded: null }) };

const { renderRich, createLiveRenderer } = await import("../js/app.js");

// A realistic roleplay reply: 6 paragraphs, mixed markdown.
const REPLY = [
  "*The door creaks open as you step inside, rain dripping from your coat onto the warped floorboards.*",
  "\"You came back. I wasn't sure you would,\" she says, a faint smile crossing her face as she turns from the window. The lamplight catches the silver chain at her throat.",
  "The room is warm, lit by a single lamp on the desk. **Papers** are scattered everywhere — maps, photographs, a half-finished letter covered in cramped handwriting.",
  "She reaches for the letter, then hesitates. \"There's something I need to tell you. About the night the lighthouse went dark, and why I never left this island.\"",
  "`If you tell them, they will come for you too.` The words hang in the air, and outside, thunder rolls over the water like something moving in the dark.",
  "She looks at you then, waiting — [[Stay]] / [[Leave]] / [[Ask about the letter]]",
  "*She turns back to the window, arms folded, the reflection of the lamp glassy and unreadable in the rain-streaked pane.*",
  "\"There were three of us on the rock that night. Only two came back. The official report says the third drowned.\"",
  "The [harbour records](https://example.com/records/1874) for that week are missing from the archive, and the keeper's logbook was never found.",
  "She finally looks at you again. \"You can ask me anything. But once you know, you can't unknow it — and this island has a way of keeping secrets.\"",
  "*Her hand drifts to the silver chain at her throat, touching it, then dropping.* \"Well? What do you want to ask me first?\"",
  "The lamp gutters. Somewhere below, a door slams, and the floorboards answer with a low groan that runs the length of the house.",
  "\"Choose carefully,\" she says, and for the first time her voice carries the edge of something older than fear. \"The island remembers what people say on this rock.\""
].join("\n\n");

// ~3 character tokens, like a real SSE stream.
const tokens = [];
for (let i = 0; i < REPLY.length; i += 3) tokens.push(REPLY.slice(i, i + 3));

// --- OLD path ---------------------------------------------------------
function oldPath() {
  const shell = { body: mkEl("div"), det: {}, tb: mkEl("div"), sum: mkEl("div") };
  let acc = "";
  const t0 = process.hrtime.bigint();
  for (const t of tokens) {
    acc += t;
    shell.body.innerHTML = renderRich(acc);
    shell.body.scrollTop = shell.body.scrollHeight;
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// --- NEW path ---------------------------------------------------------
function newPath() {
  const shell = { body: mkEl("div"), det: {}, tb: mkEl("div"), sum: mkEl("div") };
  const live = createLiveRenderer(shell.body);
  live.reset();
  live.draw();
  const t0 = process.hrtime.bigint();
  for (const t of tokens) {
    live.push(t);
    live.draw();
    shell.body.scrollTop = shell.body.scrollHeight;
  }
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

// Warm up, then measure.
oldPath(); newPath();
let oldMs = Infinity, newMs = Infinity;
for (let i = 0; i < 5; i++) {
  oldMs = Math.min(oldMs, oldPath());
  newMs = Math.min(newMs, newPath());
}

const chars = REPLY.length;
const toks = tokens.length;
console.log(`reply: ${chars} chars, ${toks} tokens`);
console.log(`OLD (renderRich per token): ${oldMs.toFixed(1)} ms`);
console.log(`NEW (incremental)          : ${newMs.toFixed(1)} ms`);
console.log(`speedup                    : ${(oldMs / newMs).toFixed(1)}x`);
console.log(`saved per 1000 tokens      : ${(((oldMs - newMs) / toks) * 1000).toFixed(0)} ms`);
