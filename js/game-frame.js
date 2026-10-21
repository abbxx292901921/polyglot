// Polyglot game frame — hosts an agent-authored HTML minigame inside a
// sandboxed iframe and speaks the host/game protocol over postMessage.
//
// Security model:
//   · sandbox="allow-scripts" WITHOUT allow-same-origin puts the frame on an
//     opaque origin. It cannot reach the parent DOM, the app's IndexedDB
//     (where provider API keys live), localStorage, or cookies.
//   · A strict CSP meta is injected into every game document:
//     default-src 'none' kills every network path, so a game cannot phone
//     home or load a remote asset.
//   · Incoming messages are matched on event.source === frame.contentWindow,
//     because an opaque origin reports event.origin === "null" and origin
//     checks would therefore be meaningless.
//   · A game document is written by an agent, so it is treated as hostile:
//     `sanitizeGameHtml` strips URL-bearing markup on the export paths and
//     `buildExportDocument` wraps a shared game in the same sandbox, so an
//     exported file cannot become a tracker for whoever opens it.
//
// The bridge script is injected by the host, so a game never has to guess the
// protocol. It is a plain string on purpose: it is written into the srcdoc of
// the frame and must not contain a closing script tag.

import { sanitizeGameHtml, isLocalReference } from "./minigames.js";

const HOST_SOURCE = "polyglot";
const GAME_SOURCE = "polyglot-game";

// Strict policy: no network, no framing, no forms, no plugins. Inline style
// and script are allowed because a game is a single self-contained document.
const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join("; ");

// The bridge the game sees as the global `Polyglot`.
// Kept as a template-free string concatenation so it can be embedded in HTML.
const BRIDGE_SRC = [  "(function(){",
  "var state=null,ctx=null;",
  "function send(kind,extra){",
  "  var m={source:'polyglot-game',kind:kind};",
  "  if(extra){for(var k in extra){if(Object.prototype.hasOwnProperty.call(extra,k)){m[k]=extra[k];}}}",
  "  try{parent.postMessage(m,'*');}catch(e){}",
  "}",
  "function txt(v,max){var s=(v==null?'':String(v));return s.length>max?s.slice(0,max):s;}",
  "window.Polyglot={",
  "  get state(){return state;},",
  "  get ctx(){return ctx;},",
  "  report:function(summary,lines){",
  "    var out=[];",
  "    if(lines&&lines.length){for(var i=0;i<lines.length&&i<20;i++){",
  "      var l=lines[i];if(!l)continue;",
  "      if(typeof l==='string'){out.push({side:'sys',text:txt(l,300)});}",
  "      else{out.push({side:txt(l.side||'sys',8),text:txt(l.text||'',300)});}",
  "    }}",
  "    send('state',{state:state,summary:txt(summary||'',1200),log:out});",
  "  },",
  "  log:function(text){send('log',{line:txt(text||'',300)});},",
  "  setActions:function(list){",
  "    var out=[];",
  "    if(list&&list.length){for(var i=0;i<list.length&&i<12;i++){",
  "      var a=list[i];if(!a||!a.id)continue;",
  "      out.push({id:txt(a.id,40),label:txt(a.label||a.id,60)});",
  "    }}",
  "    send('actions',{actions:out});",
  "  },",
  "  finish:function(result){send('end',{result:txt(result||'',200)});},",
  "  move:function(action,label){send('move',{action:txt(action||'',40),label:txt(label||'',120)});}",
  "};",
  "window.addEventListener('message',function(e){",
  "  var d=e.data;if(!d||d.source!=='polyglot')return;",
  "  if(e.source&&parent&&e.source!==parent)return;",
  "  if(d.kind==='init'){",
  "    state=d.state||null;ctx=d.ctx||null;",
  "    try{if(typeof window.onPolyglotInit==='function'){window.onPolyglotInit(d);}}",
  "    catch(err){send('error',{message:String((err&&err.message)||err)});}",
  "  }else if(d.kind==='command'){",
  "    try{if(typeof window.onPolyglotCommand==='function'){window.onPolyglotCommand(String(d.text||''));}}",
  "    catch(err){send('error',{message:String((err&&err.message)||err)});}",
  "  }else if(d.kind==='state'){",
  "    state=(d.state==null)?state:d.state;",
  "  }",
  "});",
  "function announce(){send('ready',{});}",
  "if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',announce);}else{announce();}",
  "})();"
].join("\n");

// Exported so the protocol can be exercised without a browser.
export const GAME_BRIDGE_SOURCE = BRIDGE_SRC;

// Defensive: never let the injected bridge terminate its own script tag.
function safeScript(src) {
  return String(src || "").replace(/<\/(script)/gi, "<\\/$1");
}

function themeCss(theme) {
  const t = theme && typeof theme === "object" ? theme : {};
  const v = (k, fb) => String(t[k] || fb);
  return [
    ":root{",
    "--pg-bg:" + v("bg", "#151c2e") + ";",
    "--pg-panel:" + v("panel", "#1a2338") + ";",
    "--pg-ink:" + v("ink", "#e8ecf4") + ";",
    "--pg-muted:" + v("muted", "#9aa6c2") + ";",
    "--pg-line:" + v("line", "#2a3654") + ";",
    "--pg-accent:" + v("accent", "#7c9bff") + ";",
    "--pg-dialogue:" + v("dialogue", "#ffa14d") + ";",
    "}",
    "html,body{margin:0;background:var(--pg-bg);color:var(--pg-ink);}",
    "body{padding:10px;box-sizing:border-box;}"
  ].join("");
}

// Elements that can pull the frame out of the game document: navigation
// helpers, subresource loaders and nested browsing contexts. The CSP already
// blocks the loads; removing them means a game cannot even attempt them.
const STRIP_TAGS = ["base", "link", "iframe", "object", "embed", "form", "portal", "frame", "frameset"];
// Attributes that can point somewhere. Stripped outright.
const STRIP_ATTRS = ["src", "href", "srcset", "action", "formaction", "poster", "data", "background", "xlink:href", "ping"];

// Split a game document into markup, styles and scripts without executing
// anything. DOMParser does not run scripts and does not fetch subresources
// for a detached document, so this is safe on untrusted HTML.
function parseGameDoc(html) {
  const src = String(html || "");
  const fallback = { body: src, styles: "", scripts: [] };
  if (typeof DOMParser === "undefined") return fallback;
  let doc = null;
  try {
    doc = new DOMParser().parseFromString(src, "text/html");
  } catch {
    return fallback;
  }
  if (!doc || !doc.body) return fallback;
  const styles = [];
  const scripts = [];
  for (const node of Array.from(doc.querySelectorAll("style"))) {
    styles.push(node.textContent || "");
    node.remove();
  }
  for (const node of Array.from(doc.querySelectorAll("script"))) {
    if (node.getAttribute("src")) {
      // External scripts are unreachable anyway (CSP), so drop them.
      node.remove();
      continue;
    }
    scripts.push({ text: node.textContent || "", type: node.getAttribute("type") || "" });
    node.remove();
  }
  // A meta refresh would navigate the frame away and take the CSP with it.
  for (const node of Array.from(doc.querySelectorAll("meta[http-equiv]"))) node.remove();
  for (const tag of STRIP_TAGS) {
    for (const node of Array.from(doc.querySelectorAll(tag))) node.remove();
  }
  for (const node of Array.from(doc.querySelectorAll("*"))) {
    if (!node.removeAttribute || !node.getAttribute) continue;
    for (const attr of STRIP_ATTRS) {
      const val = node.getAttribute(attr);
      if (val == null) continue;
      if (isLocalReference(val)) continue;
      node.removeAttribute(attr);
    }
  }
  return { body: doc.body.innerHTML, styles: styles.join("\n"), scripts };
}

export function buildGameDocument(html, theme) {
  const parsed = parseGameDoc(html);
  const head = [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"" + CSP + "\">",
    "<style>" + themeCss(theme) + "</style>"
  ];
  if (parsed.styles) head.push("<style>" + parsed.styles + "</style>");
  head.push("</head><body>");
  const body = ["<script>" + safeScript(BRIDGE_SRC) + "</script>", parsed.body];
  for (const s of parsed.scripts) {
    if (s.type && s.type !== "text/javascript" && s.type !== "module" && s.type !== "application/javascript") continue;
    body.push("<script>" + safeScript(s.text) + "</script>");
  }
  body.push("</body></html>");
  return head.join("") + body.join("");
}

// One global listener dispatches by source window, so N frames cost one
// listener instead of N.
const frames = new Set();
let listenerBound = false;

function ensureListener() {
  if (listenerBound) return;
  listenerBound = true;
  if (typeof window === "undefined" || !window.addEventListener) return;
  window.addEventListener("message", (e) => {
    const data = e.data;
    if (!data || typeof data !== "object") return;
    if (data.source !== GAME_SOURCE) return;
    for (const rec of frames) {
      const w = rec.frame.contentWindow;
      if (w && e.source === w) {
        rec.handle(data);
        return;
      }
    }
  });
}

export function createGameFrame({ html, theme, ctx, onEvent } = {}) {
  ensureListener();
  const frame = document.createElement("iframe");
  frame.className = "gameframe";
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("title", "minigame");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.setAttribute("loading", "eager");

  const rec = {
    frame,
    ready: false,
    destroyed: false,
    onEvent: typeof onEvent === "function" ? onEvent : () => {},
    readyResolve: null,
    post(kind, payload) {
      const w = frame.contentWindow;
      if (!w) return false;
      const msg = { source: HOST_SOURCE, kind };
      if (payload && typeof payload === "object") {
        for (const k in payload) {
          if (Object.prototype.hasOwnProperty.call(payload, k)) msg[k] = payload[k];
        }
      }
      try { w.postMessage(msg, "*"); } catch { /* frame may be gone */ }
      return true;
    },
    destroy() {
      rec.destroyed = true;
      frames.delete(rec);
      try { frame.remove(); } catch { /* noop */ }
    }
  };

  rec.readyPromise = new Promise((resolve) => { rec.readyResolve = resolve; });
  rec.handle = (data) => {
    if (rec.destroyed) return;
    if (data.kind === "ready") {
      rec.ready = true;
      try { rec.readyResolve(true); } catch { /* noop */ }
      rec.post("init", { state: (ctx && ctx.state) || null, ctx: ctx || {} });
    }
    try { rec.onEvent(data); } catch { /* a bad game must never break the host */ }
  };

  // A frame can navigate itself, and the new document would run without the
  // game's CSP. The first load is the game; any later load means it left, so
  // the game is put back.
  let loads = 0;
  let restoring = false;
  frame.addEventListener("load", () => {
    loads++;
    if (restoring) {
      restoring = false;
      return;
    }
    if (loads > 1) {
      restoring = true;
      rec.ready = false;
      try { frame.srcdoc = buildGameDocument(html, theme); } catch { /* noop */ }
    }
  });

  frames.add(rec);
  frame.srcdoc = buildGameDocument(html, theme);
  return rec;
}

// A standalone file for a game. The game is embedded in a sandboxed iframe
// with the same CSP and the same navigation watchdog the app uses, so a
// shared game file cannot beacon the reader's address to whoever wrote the
// document, and cannot navigate the page away either.
//
// Without this, an exported file would be raw agent-authored HTML running
// with full page privileges: one <img src="http://tracker/pixel"> would hand
// the reader's IP to the author of the game.
export function buildExportDocument(html, theme) {
  const inner = buildGameDocument(sanitizeGameHtml(html), theme);
  // The inner document is embedded as a JSON string, so a closing script tag
  // inside it cannot break out of the wrapper.
  const payload = JSON.stringify(inner).replace(/<\//g, "<\\/");
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>Polyglot minigame</title>",
    "<style>html,body{margin:0;height:100%;background:#151c2e;overflow:hidden}",
    "iframe{display:block;width:100%;height:100vh;border:0}</style>",
    "</head><body>",
    "<iframe id=\"pg\" sandbox=\"allow-scripts\" referrerpolicy=\"no-referrer\"></iframe>",
    "<script>",
    "var doc=" + payload + ";",
    "var f=document.getElementById('pg');",
    "var loads=0,restoring=false;",
    "f.addEventListener('load',function(){",
    "  loads++;",
    "  if(restoring){restoring=false;return;}",
    "  if(loads>1){restoring=true;f.srcdoc=doc;}",
    "});",
    "f.srcdoc=doc;",
    "</script>",
    "</body></html>"
  ].join("");
}

// Run a chat command against a game that has no live frame (the Games tab is
// closed). Builds a throwaway frame, hands it the persisted state, sends the
// command, waits for the game to report back, then tears the frame down.
// Every message the game sends is also handed to onEvent, so the caller's
// normal handler persists the state instead of it being thrown away.
export async function runGameCommand({ html, theme, ctx, text, timeoutMs = 5000, onEvent } = {}) {
  const rec = createGameFrame({ html, theme, ctx, onEvent: () => {} });
  const holder = document.createElement("div");
  holder.className = "gameframe-holder";
  holder.appendChild(rec.frame);
  document.body.appendChild(holder);
  let settle = null;
  const answered = new Promise((resolve) => { settle = resolve; });
  let grace = null;
  rec.onEvent = (data) => {
    if (typeof onEvent === "function") {
      try { onEvent(data); } catch { /* a bad game must never break the host */ }
    }
    if (data.kind === "state" || data.kind === "end") {
      if (grace) { clearTimeout(grace); grace = null; }
      settle(data);
      return;
    }
    // A game that only logs or re-offers buttons has still answered, but a
    // state report may still be on its way, so give it a short grace.
    if ((data.kind === "log" || data.kind === "actions") && !grace) {
      grace = setTimeout(() => settle(data), 500);
    }
  };
  try {
    const ready = await Promise.race([
      rec.readyPromise,
      new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
    ]);
    if (!ready) return { ok: false, error: "E_GAME_FRAME: the game did not start in time." };
    rec.post("command", { text: String(text || "") });
    const reply = await Promise.race([
      answered,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
    ]);
    if (!reply) return { ok: false, error: "E_GAME_FRAME: the game did not answer the command." };
    return { ok: true, message: reply };
  } catch (e) {
    return { ok: false, error: "E_GAME_FRAME: " + (e?.message || String(e)) };
  } finally {
    rec.destroy();
    try { holder.remove(); } catch { /* noop */ }
  }
}
