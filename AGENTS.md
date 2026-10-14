# AGENTS.md — Polyglot contributor guide (for AI agents + future patches)

## What this is
Polyglot: private, offline-first, zero-backend mobile PWA. SillyTavern-lite for
smartphones (iOS Safari + Android Chrome). Local-first: chats/characters stay in
IndexedDB on-device. Only AI generation hits the network (OpenAI-Compatible APIs).
Deployed as static files to GitHub Pages. No build step, no bundler.

## Stack (locked — do not reintroduce frameworks)
- Vanilla ES modules (`<script type="module">`), hand-written `style.css`, no CDN.
- Zero runtime dependencies. No Vue, Tailwind, Dexie, Marked, Lucide, DOMPurify.
- Markdown is a tiny escape-first renderer in `js/app.js` (`renderRich`).
- Storage is raw IndexedDB in `js/db.js` (6 stores, see below).
- PWA: `manifest.json` + `sw.js` (versioned cache, network-first navigations).

## File map
- `index.html` — shell, viewport meta, drawers, composer. IDs consumed by app.js:
  `ver, update-banner, reload-btn, chat, empty, input, send, stop, btn-left,
  btn-right, drawer-left, drawer-right, backdrop, persona-list, char-list,
  chat-list, btn-new-persona, btn-new-char, btn-new-chat, btn-export, chk-keys,
  file-import, vault-status`.
- `style.css` — CSS vars, 100dvh layout, safe-area, drawers, bubbles
  (`.action` muted italic, `.dialogue` bright), Phase 1 `.row/.list/.sec` UI.
- `manifest.json` — name Polyglot, relative `./` start_url/scope (Pages subpath!).
- `sw.js` — `CACHE` const + `ASSETS` list. Never cache API (cross-origin or
  `/chat|completions|messages|v1/`). Navigations network-first.
- `js/config.js` — `APP_VERSION`, `CACHE_NAME`, `DB_NAME/VERSION`,
  `DEFAULT_CONNECTION/SAMPLERS/PROMPTS`. Single source of truth for new presets.
- `js/db.js` — IndexedDB wrapper. Stores: characters, personas, chats, messages
  (compound `chat_time=[chat_id+timestamp]`), lorebooks, presets.
  Exports: openDB, list*/save*/delete* per store, setDefaultPersona,
  touchChat, exportVaultToJSON({includeKeys}), importVaultFromJSON(data,{merge}),
  seedIfEmpty(defaults).
- `js/app.js` — UI coordinator. Owns `ui={characterId,chatId,personaId}` in
  localStorage, drawer rendering, composer, vault export/import, SW registration.
- (Planned) `js/prompt-engine.js`, `js/sse-streamer.js`, `js/api-client.js`,
  `js/png-parser.js` — Phase 2/3. Keep them dependency-free modules.

## Rules for every patch
1. No placeholders. Never `TODO`, stub functions, or omitted logic. Complete code only.
2. XSS: always `escapeHtml` BEFORE markdown regex. Card/lorebook text is hostile
   until escaped. Never assign raw card text to innerHTML.
3. Relative paths only (`./`). Absolute `/sw.js` breaks Pages project sites.
4. Version bumps touch THREE places together: `config.js APP_VERSION` +
   `CACHE_NAME`, `sw.js CACHE`, `index.html #ver` fallback text.
5. SW: never cache POST or API. Same-origin GET assets only.
6. Keys: never log, never put in URLs, never commit. Vault export strips
   `connection.api_key` unless `includeKeys:true`. Respect `.gitignore`.
7. Mobile: keep `100dvh` + `env(safe-area-inset-*)` + `visualViewport` keyboard
   offset. `navigator.vibrate` is Android-only — always try/catch.
8. Keep it light: no new dependencies without explicit user approval. Prefer
   ~50 lines of vanilla over a library.
9. Verify: `node --check` every touched JS file. Serve with
   `python3 -m http.server 8000`, reload + send + reload to prove persistence.

## Test checklist (run before calling a phase done)
- `node --check js/*.js sw.js` clean.
- Fresh load → send → reload → message persists; new chat/persona/character CRUD works.
- Export vault with keys OFF → JSON has `"api_key": ""`. Import replaces data.
- Airplane mode (after first load): shell + history open, send works locally.
- No console errors on iOS-sized viewport (360×740) and desktop.

## Roadmap
- Phase 0 DONE: shell + SW + offline echo.
- Phase 1 DONE: IndexedDB + library + vault.
- Phase 2 NEXT: prompt-engine + sse-streamer + api-client (OpenAI-Compatible).
- Phase 3: png-parser (tEXt/zTXt/iTXt + webp→jpeg fallback) + swipes/retry/
  continue/impersonate/edit + right-drawer presets UI.
