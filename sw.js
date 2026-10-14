/* Polyglot service worker — offline-first shell, network-first updates.
   - Navigations: network first (instant OTA from GitHub Pages), cache fallback offline.
   - Same-origin static assets: cache first, then network, then cache-put.
   - API calls (cross-origin or /chat/completions, /v1/, /messages): never cached.
*/

const CACHE = "polyglot-v1.3.0";
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
  "./js/png-parser.js",
  "./js/diagnostics.js",
  "./icons/icon.svg"
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

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never cache cross-origin API traffic or any AI endpoint.
  if (url.origin !== self.location.origin || isApiRequest(url)) return;

  // Navigations: network first for instant updates, cache fallback offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./")))
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
