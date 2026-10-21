/* Equivalence test: the incremental live renderer must produce exactly the
   same HTML as renderRich() for the same text, at every intermediate step.
   Run with:  node --experimental-vm-modules tools/stream-equiv.test.mjs   */

function mkEl(tag) {
  const el = {
    tagName: tag,
    innerHTML: "",
    textContent: "",
    children: [],
    style: { setProperty() {} },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {},
    getAttribute() { return null; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    remove() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() {},
    click() {}
  };
  return el;
}

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};
globalThis.document = {
  documentElement: mkEl("html"),
  body: mkEl("body"),
  createElement: (t) => mkEl(t),
  createElementNS: (ns, t) => mkEl(t),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {}
};
globalThis.window = {
  addEventListener: () => {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: (id) => clearTimeout(id),
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  matchMedia: () => ({ matches: false }),
  innerHeight: 800,
  visualViewport: null,
  location: { reload() {} }
};
try {
  Object.defineProperty(globalThis, "navigator", {
    value: { vibrate: null, onLine: true },
    configurable: true,
    writable: true
  });
} catch { /* node already provides a navigator */ }
globalThis.indexedDB = undefined;

const { renderRich, createLiveRenderer } = await import("../js/app.js");

// Deterministic PRNG so failures are reproducible.
let seed = 0x2f6e2b1;
function rnd() {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0xffffffff;
}
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }

const FRAGMENTS = [
  "Hello there.", "**bold text**", "*an action*", "_under_", "~~struck~~",
  "`inline code`", "[[a choice]]", "[link](https://example.com/x)",
  "https://bare.example.com/path", "\"quoted dialogue\"",
  "<font color=\"#ff0000\">coloured</font>", "plain & text <tag>",
  "line one", "line two", "a", "the", "  ", "\t", "100% & <5",
  "**unclosed", "`open code", "[[open", "quote \"unclosed"
];

function randomText(maxParas) {
  const paras = [];
  const n = 1 + Math.floor(rnd() * maxParas);
  for (let p = 0; p < n; p++) {
    const lines = 1 + Math.floor(rnd() * 4);
    const parts = [];
    for (let l = 0; l < lines; l++) parts.push(pick(FRAGMENTS));
    paras.push(parts.join(rnd() < 0.5 ? " " : "\n"));
  }
  return paras.join(rnd() < 0.5 ? "\n\n" : "\n\n\n");
}

function liveHtml(target) {
  return target.children.map((c) => `<p>${c.innerHTML}</p>`).join("");
}

let checked = 0;
let fails = 0;

for (let iter = 0; iter < 4000; iter++) {
  const text = randomText(6);
  const target = mkEl("div");
  const live = createLiveRenderer(target);
  live.reset();
  live.draw();

  // Feed the text in random chunk sizes and compare after every chunk.
  let pos = 0;
  let guard = 0;
  while (pos < text.length && guard++ < 500) {
    const size = 1 + Math.floor(rnd() * 9);
    live.push(text.slice(pos, pos + size));
    pos += size;
    live.draw();
    const want = renderRich(text.slice(0, pos));
    const got = liveHtml(target);
    checked++;
    if (want !== got) {
      fails++;
      if (fails <= 3) {
        console.log("--- MISMATCH at pos", pos, "---");
        console.log("TEXT :", JSON.stringify(text.slice(0, pos)));
        console.log("WANT :", want);
        console.log("GOT  :", got);
      }
      break;
    }
  }
}

// Also compare the final full-document result for a few long inputs.
for (let iter = 0; iter < 200; iter++) {
  const text = randomText(20).repeat(3);
  const target = mkEl("div");
  const live = createLiveRenderer(target);
  live.reset();
  live.draw();
  live.push(text);
  live.draw();
  checked++;
  if (renderRich(text) !== liveHtml(target)) {
    fails++;
    console.log("--- FINAL MISMATCH ---", JSON.stringify(text.slice(0, 120)));
  }
}

console.log(`stream-equivalence: ${checked} comparisons, ${fails} failures`);
process.exit(fails ? 1 : 0);
