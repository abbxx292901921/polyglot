/* Game frame protocol test: runs the injected bridge script in a fake window
   and checks the host/game message contract without a browser.
   Run with:  node tools/frame.test.mjs */

import { GAME_BRIDGE_SOURCE, buildGameDocument, buildExportDocument } from "../js/game-frame.js";
import { sanitizeGameHtml } from "../js/minigames.js";

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

// ---------- the bridge script ----------

function makeFakeWindow() {
  const sent = [];
  const handlers = [];
  const win = {
    sent,
    handlers,
    addEventListener(type, fn) {
      if (type === "message") handlers.push(fn);
    },
    document: {
      readyState: "complete",
      addEventListener() {}
    }
  };
  win.parent = {
    postMessage(msg) { sent.push(msg); }
  };
  return win;
}

function runBridge(win) {
  // The bridge is a classic script: run it with window/parent/document bound.
  const fn = new Function("window", "parent", "document", GAME_BRIDGE_SOURCE);
  fn(win, win.parent, win.document);
  return win;
}

const win = runBridge(makeFakeWindow());

ok("bridge defines Polyglot", !!win.Polyglot);
ok("bridge announces ready", win.sent.some((m) => m.source === "polyglot-game" && m.kind === "ready"),
  JSON.stringify(win.sent));

const last = () => win.sent[win.sent.length - 1];

// report
win.sent.length = 0;
win.Polyglot.report("The player scored 3 points.", [{ side: "you", text: "You score a point." }, "plain line"]);
eq("report kind", last().kind, "state");
eq("report summary", last().summary, "The player scored 3 points.");
eq("report log count", last().log.length, 2);
eq("report log side", last().log[0].side, "you");
eq("report log text", last().log[0].text, "You score a point.");
eq("report string log becomes a sys line", last().log[1].side, "sys");
eq("report string log text", last().log[1].text, "plain line");
eq("report carries the source tag", last().source, "polyglot-game");

// report must not let a huge summary through
win.sent.length = 0;
win.Polyglot.report("x".repeat(5000));
ok("summary is capped", last().summary.length <= 1200, "len " + last().summary.length);

// log
win.sent.length = 0;
win.Polyglot.log("a line");
eq("log kind", last().kind, "log");
eq("log text", last().line, "a line");

// setActions
win.sent.length = 0;
win.Polyglot.setActions([{ id: "go", label: "Go" }, { id: "x" }, { nope: 1 }, null]);
eq("actions kind", last().kind, "actions");
eq("actions are filtered", last().actions.length, 2);
eq("action id", last().actions[0].id, "go");
eq("action label", last().actions[0].label, "Go");
eq("action label defaults to the id", last().actions[1].label, "x");

// finish
win.sent.length = 0;
win.Polyglot.finish("You win.");
eq("finish kind", last().kind, "end");
eq("finish result", last().result, "You win.");

// move
win.sent.length = 0;
win.Polyglot.move("strike", "You strike");
eq("move kind", last().kind, "move");
eq("move action", last().action, "strike");
eq("move label", last().label, "You strike");

// incoming init and command
let initCtx = null;
let commandText = null;
win.onPolyglotInit = (d) => { initCtx = d; };
win.onPolyglotCommand = (t) => { commandText = t; };
const fire = (data, src) => {
  for (const h of win.handlers) h({ data, source: src === undefined ? win.parent : src });
};

fire({ source: "polyglot", kind: "init", state: { score: 7 }, ctx: { key: "k" } });
ok("init reaches the game", initCtx !== null);
eq("init carries the state", win.Polyglot.state.score, 7);
eq("init carries the ctx", initCtx.ctx.key, "k");

fire({ source: "polyglot", kind: "command", text: "go" });
eq("command reaches the game", commandText, "go");

// a message from another origin must be ignored
initCtx = null;
commandText = null;
fire({ source: "somebody-else", kind: "init", state: { score: 99 } });
fire({ kind: "init", state: { score: 98 } });
ok("foreign messages are ignored", initCtx === null);

// a message from a window that is not the host must be ignored, even if it
// carries the right tag
initCtx = null;
fire({ source: "polyglot", kind: "init", state: { score: 97 } }, { source: "a-stranger" });
ok("a message from another window is ignored", initCtx === null);

// a throwing game callback must not take the frame down
win.onPolyglotInit = () => { throw new Error("boom"); };
win.sent.length = 0;
fire({ source: "polyglot", kind: "init", state: {} });
ok("a throwing callback is reported, not fatal", win.sent.some((m) => m.kind === "error"), JSON.stringify(win.sent));
ok("the error carries a message", win.sent.some((m) => m.kind === "error" && m.message.includes("boom")));

// ---------- the document builder ----------

const html = "<style>.a{color:red}</style><p>hi</p><script>var x=1;Polyglot.report('x');</script>";
const doc = buildGameDocument(html, { bg: "#101010", ink: "#f0f0f0", accent: "#00ff00" });

ok("document has a doctype", doc.startsWith("<!doctype html>"));
ok("document has the CSP", doc.includes("Content-Security-Policy"));
ok("CSP denies network", doc.includes("default-src 'none'"));
ok("CSP denies connections", doc.includes("connect-src 'none'"));
ok("CSP denies framing", doc.includes("frame-src 'none'"));
ok("CSP allows inline script", doc.includes("script-src 'unsafe-inline'"));
ok("document has the bridge", doc.includes("polyglot-game"));
ok("document injects theme vars", doc.includes("--pg-bg:#101010"));
ok("document injects the accent", doc.includes("--pg-accent:#00ff00"));
ok("document keeps the game markup", doc.includes("hi"));
ok("document keeps the game script", doc.includes("Polyglot.report('x')"));
ok("bridge runs before the game script", doc.indexOf("polyglot-game") < doc.indexOf("Polyglot.report('x')"));

// The bridge must be emitted as one complete script tag, and game content
// must land strictly after it so nothing a game contains can break it open.
const doc3 = buildGameDocument("<script>Polyglot.report('a');</script>", {});
const bridgeStart = doc3.indexOf("<script>(function(){");
const bridgeEnd = doc3.indexOf("</script>", bridgeStart);
ok("the bridge is one complete script tag", bridgeStart >= 0 && bridgeEnd > bridgeStart);
ok("game content comes after the bridge", doc3.indexOf("Polyglot.report('a')") > bridgeEnd);
ok("game content is not inside the bridge", doc3.indexOf("Polyglot.report('a')") >= bridgeEnd);

// ---------- the sandbox itself ----------
// The security boundary is the iframe sandbox, so pin it: allow-scripts yes,
// allow-same-origin never (that would hand the game the app's origin, and
// with it the API keys in IndexedDB).

const attrs = {};
const frameHandlers = {};
const fakeEl = {
  attrs,
  className: "",
  srcdoc: "",
  setAttribute(k, v) { attrs[k] = v; },
  getAttribute(k) { return attrs[k] ?? null; },
  addEventListener(type, fn) { frameHandlers[type] = fn; },
  appendChild() {},
  remove() {},
  contentWindow: { postMessage() {} }
};
globalThis.document = { createElement: () => fakeEl };
globalThis.window = { addEventListener() {} };

const { createGameFrame } = await import("../js/game-frame.js");
const rec = createGameFrame({ html: "<p>x</p>", theme: {}, ctx: { key: "k" } });
eq("frame is sandboxed", attrs.sandbox, "allow-scripts");
ok("frame never gets allow-same-origin", !String(attrs.sandbox).includes("allow-same-origin"));
eq("frame has a referrer policy", attrs.referrerpolicy, "no-referrer");
ok("frame has a title", !!attrs.title);

// A frame that navigates itself would run the new document without the
// game's CSP, so a second load puts the game back.
const firstDoc = rec.frame.srcdoc;
ok("the frame starts with the game document", firstDoc.includes("<p>x</p>"));
if (frameHandlers.load) frameHandlers.load();
eq("the first load does not restore", rec.frame.srcdoc, firstDoc);
if (frameHandlers.load) frameHandlers.load();
ok("a navigation restores the game document", rec.frame.srcdoc === firstDoc);
rec.destroy();

// ---------- the export path ----------
// A shared game file must not be able to report the reader's address to
// whoever wrote the document, and must not be able to navigate the page.

const tracker = "<img src=\"http://tracker.invalid/pixel.gif\"><script>Polyglot.report('x')</script>";
const clean = sanitizeGameHtml(tracker);
ok("the tracker image is stripped", !clean.includes("tracker.invalid"), clean);
ok("the game script survives", clean.includes("Polyglot.report"));

const css = sanitizeGameHtml("<style>@import url(http://tracker.invalid/x.css);b{background:url(http://tracker.invalid/p.gif)}</style>");
ok("css imports are stripped", !css.includes("tracker.invalid"), css);

const nav = sanitizeGameHtml("<meta http-equiv=\"refresh\" content=\"0;url=http://tracker.invalid/\"><base href=\"http://tracker.invalid/\"><a href=\"http://tracker.invalid/\">x</a>");
ok("meta refresh is stripped", !nav.toLowerCase().includes("http-equiv"), nav);
ok("base is stripped", !nav.toLowerCase().includes("<base"), nav);
ok("links are stripped", !nav.includes("tracker.invalid"), nav);

const extScript = sanitizeGameHtml("<script src=\"http://tracker.invalid/a.js\"></script><script>Polyglot</script>");
ok("external scripts are stripped", !extScript.includes("tracker.invalid"), extScript);
ok("inline scripts survive", extScript.includes("Polyglot"));

const exportDoc = buildExportDocument(tracker, {});
ok("the export has no tracker", !exportDoc.includes("tracker.invalid"), exportDoc.slice(0, 200));
ok("the export sandboxes the game", exportDoc.includes('sandbox="allow-scripts"'));
ok("the export never gets allow-same-origin", !exportDoc.includes("allow-same-origin"));
ok("the export carries a CSP", exportDoc.includes("Content-Security-Policy"));
ok("the export restores a navigated game", exportDoc.includes("loads>1") && exportDoc.includes("f.srcdoc=doc"));
ok("the export embeds the game", exportDoc.includes("Polyglot.report"));

// ---------- report ----------

console.log("PASS " + pass);
if (fail) {
  console.log("FAIL " + fail);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("FRAME_TESTS_OK");
