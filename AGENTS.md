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
- `index.html` — shell, viewport meta, top-tab `#tabs` + `#views`
  (`view-home/recent-grid, view-chars/chars-search/chars-sort/chars-fav-list/
  chars-list, view-detail/detail-avatar/detail-name/detail-chat-list,
  view-presets/preset-filter/preset-cards, view-books/books-char-filter/
  book-list, view-regex/regex-list/regex-form/rx-pattern/rx-test-in`), drawers,
  composer. Drawer IDs consumed by app.js:
  `ver, update-banner, reload-btn, chat, empty, input, send, stop, btn-left,
  btn-right, drawer-left, drawer-right, backdrop, persona-list, char-list,
  chat-list, btn-new-persona, btn-new-char, btn-new-chat, btn-export, chk-keys,
  file-import, vault-status, preset-list + editor tabs [data-ptab/ppane]
  (conn-*, sam-*, pr-*, tg-stream/tg-thought/tg-haptic), theme-preset,
  th-bg/panel/ink/accent/action/dialogue`.
- `style.css` — CSS vars (`--action` = `*asterisk*` color, `--dialogue` =
  `"quote"` color), 100dvh layout, safe-area, drawers, bubbles
  (`.action` muted italic, `.dialogue` bright), Phase 1 `.row/.list/.sec` UI,
  Phase 4 `#tabs/.wrap/.cards-grid/.card/.toolbar/.detail-head/.ptabs/.iconrow`.
- `manifest.json` — name Polyglot, relative `./` start_url/scope (Pages subpath!).
- `sw.js` — `CACHE` const + `ASSETS` list. Never cache API (cross-origin or
  `/chat|completions|messages|v1/`). Navigations network-first.
- `js/config.js` — `APP_VERSION`, `CACHE_NAME`, `DB_NAME/VERSION`,
  `DEFAULT_CONNECTION/SAMPLERS/PROMPTS`. Single source of truth for new presets.
- `js/db.js` — IndexedDB wrapper. Stores: characters, personas, chats, messages
  (compound `chat_time=[chat_id+timestamp]`), lorebooks, presets, regex_rules
  (index `character_id`, null = global).
  Exports: openDB, list*/save*/delete* per store, setDefaultPersona,
  touchChat, exportVaultToJSON({includeKeys}), importVaultFromJSON(data,{merge}),
  seedIfEmpty(defaults). DB v1→v2 upgrade only ADDS regex_rules; old vaults
  without that table still import (table optional).
- `js/app.js` — UI coordinator. Owns `ui={characterId,chatId,personaId,presetId}` in
  localStorage, drawer rendering, composer, streaming send path, swipe groups
  (`swipe_group_id`/`swipe_active`) + retry/continue/impersonate/edit/delete,
  character editor modal, card import + per-chat export/import, vault
  export/import, diagnostics panel, SW registration.
  BRANCH MODEL: a chat's `active_leaf_id` names the message the transcript,
  the model context and the graph all agree on. `setLeaf` advances it on
  EVERY append (send/retry/impersonate/continue/variant pick), `setActiveLeaf`
  jumps it (rewind = fork point), `branchSiblings` finds the nearest fork for
  the ◀ ▶ branch switcher, `deleteMessageAndFix` repairs a deleted leaf.
  Swipe variants and branches are the same tree shape (two rows, one parent):
  picking a variant re-roots the chain, `groupRows(chain, allRows, pathIds)`
  resolves groups against ALL rows so off-chain variants stay reachable.
- `js/prompt-engine.js` — pure context pipeline: resolveMacros, estimateTokens,
  scanLorebook, injectAtDepth, applyTokenBudget, buildMessages (+reasoningStyle
  softener), normalizeAgentic (strict user/assistant alternation, final user).
  Tree helpers: sortRows, parentMap, activeChain, childrenMap, tidyLayout
  (leaves take sequential lanes, parents sit at the mean of their children).
- `js/sse-streamer.js` — SSE decoder (TextDecoder stream) + createThinkSplitter
  for split `<think>` tags; routes reasoning_content + inline thinks to reasoning.
- `js/api-client.js` — buildPayload (allowlist + ONE validated thinking knob) +
  sanitizePayload wrapper, resolveEndpoint (proxy-aware), fetchReasoningModes
  (docs OpenAPI page, key never sent, catalog fallback), sendChat streaming via
  fetch + streamSSE with onNote surfacing.
- `js/reasoning-modes.js` — pure thinking-knob resolver: CATALOG (surveyed
  per-model effort/budget/kwargs shapes), parseModesPage (docs OpenAPI),
  mergeReasoning (new schema + legacy mapping), applyThinking (validated,
  exactly one knob), modeValues/describeMode for the preset UI.
- `js/png-parser.js` — card ingestion: walkChunks, tEXt/zTXt/iTXt, chara/ccv3
  (V3 wins), parsePNGCard/parseCharacterJSON/normalizeCharacter,
  fileToAvatarDataURL (512px webp→jpeg fallback).
- `js/diagnostics.js` — coded ring logger (200). Only app.js imports it.
- `js/regex-engine.js` — pure find/replace scripts: cleanFlags, compileRule,
  applyRules(text, rules, {place, characterId}) → {text, applied, skipped}.
  Never throws; invalid patterns land in `skipped`.

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
9. Verify: module-goal parse of every touched JS file — bare
   `node --check file.js` in a dir WITHOUT `"type":"module"` does NOT reliably
   parse ES modules (v1.3.0 shipped a fatal `*/`-inside-block-comment SyntaxError
   that bare --check passed; every button dead, static shell). Stage copies with
   a `{"type":"module"}` package.json and `--check` them, or execute the real
   `init()` in node with DOM/IDB stubs. Serve with
   `python3 -m http.server 8000`, reload + send + reload to prove persistence.
10. Never put the two-character sequence `*/` inside a `/* */` block comment
    (e.g. writing `*action*/"dialogue"` in prose) — it ends the comment early
    and the rest parses as code, bricking the whole module. Reword or use `//`.

## Test checklist (run before calling a phase done)
- Module-goal parse of `sw.js` + every `js/*.js` clean (see rule 9/10).
- Fresh load → send → reload → message persists; new chat/persona/character CRUD works.
- Export vault with keys OFF → JSON has `"api_key": ""`. Import replaces data.
- Airplane mode (after first load): shell + history open, send works locally.
- No console errors on iOS-sized viewport (360×740) and desktop.

## Roadmap
- Phase 0 DONE: shell + SW + offline echo.
- Phase 1 DONE: IndexedDB + library + vault.
- Phase 2 DONE: prompt-engine + sse-streamer + api-client (OpenAI-Compatible).
- Phase 3 DONE: png-parser (tEXt/zTXt/iTXt + webp→jpeg fallback) + swipes/retry/
  continue/impersonate/edit + character edit UI.
- Phase 4 DONE: top-tab router (Home/Characters/Chat/Presets/Books) + Recent grid
  + Characters search/sort/favorites + character-detail subordinate chats +
  preset cards + editor tabs + Memory Books manager + THEMES
  (polyglot/agnai/amoled/light) + *action*/"dialogue" color settings + stream/
  thought/haptic toggles. Default tab Home; detail highlights Characters tab.
- Phase 5 DONE: regex scripts — `regex_rules` store (DB v2, global/per-char,
  prompt/display/both), pure `regex-engine.js`, prompt rewrite in buildContext
  (history untouched), display rewrite pre-renderRich (XSS order kept), Regex
  tab with add/edit/test-drive/import/export, `E_REGEX_RULE` diagnostics.
  Existing data survives: v1→v2 upgrade only adds the store; SW swap never
   touches IndexedDB/localStorage.
- v1.4.1 HOTFIX: v1.3.0/1.4.0 never ran — header `/* */` comment in `app.js`
  contained a literal `*/` (`*action*/`), a module-killing SyntaxError bare
  `node --check` passed. Static shell, all buttons dead. Fixed the comment,
  wrapped init data-load in try/catch (wiring always runs, failure surfaces in
  #chat + diag log), global error/unhandledrejection reporter, `onblocked`
   rejection in `openDB`. Verified by executing `init()` in node with DOM/IDB
   stubs (INIT_OK, 0 rejections).
- v1.6.1 DONE: per-model thinking knobs — `reasoning-modes.js` (CATALOG +
  docs-OpenAPI parse + merge/apply, exactly one validated knob), `buildPayload`
  + `fetchReasoningModes` (key never sent, catalog fallback) in api-client,
  `normalizeAgentic` + `reasoningStyle` softener in prompt-engine, Thinking
  mode/Level/Budget/JSON/Agentic UI + Fetch thinking modes button, `E_MODES_
  FETCH/E_REASONING/E_AGENCY` diagnostics. Legacy reasoning_strategy presets
  still send via mergeReasoning mapping; no DB migration (preset fields only).
- v1.6.2 DONE: Forge agent loop — `supervisor.js` protocol extended to 14 reads
  (list/get across characters, chats, lorebooks, presets, personas, providers,
  regex, world, stage states) + 19 writes + done/answer controls; `handleForgeRun`
  runs up to 6 steps (reads live, writes become approval proposals, transcript in
  `#forge-results`, Stop button aborts in-flight call); `executeSupervisorAction`
  applies deletes/upserts/exports (vault/chat/character/preset/lorebook/regex
  downloads, keys always stripped, avatars never enter the prompt). No DB
  migration; all writes still need Approve.
- v1.7.0 DONE: branching repaired + graph makeover. Branching: every append
  advances `active_leaf_id` (`setLeaf`), so pressing ⑂ Branch and typing
  continues from that point instead of parking on the fork (before, the new
  message was invisible AND the model answered without it). Swipe variants and
  branches are one tree shape — picking a variant re-roots the chain
  (`applyActiveSibling`), `groupRows` resolves groups against all rows so
  off-chain variants stay swipeable, retry reuses the reply's swipe group, and
  deleting the leaf repairs the pointer. Branch bar gained a ◀ ▶ branch
  switcher over the nearest fork (`branchSiblings`). Graph: `tidyLayout` in
  prompt-engine (leaves get lanes, parents sit at the mean of their children —
  a straight chain is ONE column), cubic glowing edges with a dash flow on the
  live tail, radar halo on the current leaf, fork diamonds, zoom-in labels,
  dot-grid backdrop, and hit-testing in graph space (no per-node hit circles).
  No DB migration; existing chats keep working (null leaf = linear chain).
