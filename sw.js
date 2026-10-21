/* Polyglot service worker — offline-first shell, network-first updates.
   - Navigations: network first (instant OTA from GitHub Pages), cache fallback offline.
   - Same-origin static assets: cache first, then network, then cache-put.
   - API calls (cross-origin or /chat/completions, /v1/, /messages): never cached.
*/

const CACHE = "polyglot-v1.8.1";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.json",
  "./js/app.js",
  "./js/config.js",
  "./js/db.js",
  "./js/prompt-engine.js",
  "./js/sse-streamer.js",
  "./js/api-client.js",
  "./js/reasoning-modes.js",
  "./js/png-parser.js",
  "./js/diagnostics.js",
  "./js/regex-engine.js",
  "./js/stages.js",
  "./js/supervisor.js",
  "./js/minigames.js",
  "./js/game-frame.js",
  "./icons/icon.svg",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

function isApiRequest(url) {
  return (
    url.pathname.includes("/chat/completions") ||
    url.pathname.includes("/completions") ||
    url.pathname.includes("/messages") ||
    url.pathname.includes("/v1/")
  );
}

// Caps how long a navigation waits on the network. Offline (or a captive
// portal) a fetch can hang for many seconds while the radio stays awake —
// fall back to the cached shell instead.
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("E_SW_TIMEOUT: network timeout")), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never cache cross-origin API traffic or any AI endpoint.
  if (url.origin !== self.location.origin || isApiRequest(url)) return;

  // Navigations: network first for instant updates, cache fallback offline.
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const res = await withTimeout(fetch(req), 2500);
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put("./index.html", copy)).catch(() => {});
          return res;
        } catch {
          const hit = await caches.match("./index.html");
          return hit || caches.match("./");
        }
      })()
    );
    return;
  }

  // Static assets: cache first for offline + speed.
  event.respondWith(
    caches.match(req, { ignoreSearch: false }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
