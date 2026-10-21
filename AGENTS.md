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
  REVISION COUNTER: every write (putRec/delRec/clearStore/setDefaultPersona/
  deleteChat) bumps `rev`; `getRev()` is the single source of truth for "has
  the data changed since I last painted?". The UI uses it to cache the
  character table and to skip redundant view rebuilds. Add a bump to any NEW
  write path — a missed one shows stale UI.
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
  RENDER RULES (battery): `renderRich` = escapeHtml → split(/\n{2,}/) → one
  `renderParagraphInner` per paragraph. `createLiveRenderer` streams a reply
  incrementally: finished paragraphs are committed to the DOM once, only the
  trailing partial paragraph is re-rendered, and all painting is coalesced to
  one `requestAnimationFrame` (`frameOnce`). Output is byte-identical to
  `renderRich` — `tools/stream-equiv.test.mjs` proves it over 96k cases.
  NEVER re-render a whole bubble per token. `getRev()` + `viewSignature`
  decide whether a view needs rebuilding at all.
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
- `js/minigames.js` — PURE minigame contract + built-in engines. Session
  shape `{active,phase,name,data,summary,actions[],log[],pending[],result}`;
  `normalizeSession`, `addLog`, `addPending`, `sessionBlock`,
  `buildMinigameBlocks`, `fenceGameText` (game text is DATA, never
  instruction), `slugKey`, `validateMinigameHtml` (self-contained, offline,
  no navigation, must use the Polyglot bridge), `parseGameCommand`
  (`/duel …`, `/fortune …`, `/game <key> …`), and the native engines: `duel`
  (HP/guard/focus, deterministic rolls) + `fortune` (21-card draw, 2 rerolls).
  `GAME_AUTHORING_GUIDE` + `GAME_SKELETON_HTML` are what the Forge agent is
  shown, so the guide and the validator must never disagree.
- `js/game-frame.js` — hosts an agent-authored HTML minigame in a sandboxed
  iframe. `sandbox="allow-scripts"` WITHOUT `allow-same-origin` → opaque
  origin → the game cannot reach the parent DOM, the app's IndexedDB (where
  provider keys live), localStorage or cookies. A strict CSP meta
  (`default-src 'none'`) kills every subresource. `buildGameDocument` strips
  navigation-capable elements/attributes; the bridge (`GAME_BRIDGE_SOURCE`)
  is injected and speaks postMessage with the host. The host matches incoming
  messages on `event.source === frame.contentWindow` (an opaque origin reports
  `origin === "null"`), and a `load` watchdog puts the game back if it
  navigates itself away. `runGameCommand` drives a throwaway frame for chat
  commands when the Games tab is closed.
- `js/stages.js` — pure deterministic roleplay engine (chess/dice/world/director).
- `js/supervisor.js` — the Forge agent protocol (may import other PURE modules
  only — never db.js/app.js).

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
11. Minigames are UNTRUSTED CODE. A game document is written by an agent (or
    imported from disk). It runs in an opaque-origin sandboxed iframe, but
    never let game-authored text act as an instruction: fence it
    (`fenceGameText`) before it reaches a system message, and strip
    navigation in `validateMinigameHtml` + `buildGameDocument` — the CSP does
    not stop a frame navigating itself away.
12. Anything that LEAVES the device is a leak surface. A game document is
    agent-authored, so a shared one can carry a tracker aimed at whoever
    opens it. Exports must be sanitized: `sanitizeGameHtml` on the vault and
    on any exported markup, `buildExportDocument` for a shared game file
    (same sandbox + navigation watchdog as the app), and
    `validateMinigameHtml` on the vault import so a hand-crafted vault cannot
    install a game that phones home. Never commit a vault or an export to
    the public repo — `.gitignore` covers `*.vault.json` and `polyglot-*`.

## Test checklist (run before calling a phase done)
- Module-goal parse of `sw.js` + every `js/*.js` clean (see rule 9/10).
- `node tools/boot.test.mjs` → INIT_OK / NO_REJECTIONS / BOOT_CLEAN.
- `node tools/minigame.test.mjs`, `node tools/frame.test.mjs`,
  `node tools/forge-game.test.mjs` → all OK.
- `node tools/stream-equiv.test.mjs` → 0 failures.
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
- v1.7.1 DONE: iOS battery pass — no feature cuts, no DB migration. STREAMING
  (the big one): the live path used to run `renderRich(acc)` + a full
  `innerHTML` re-parse of the whole bubble on EVERY token, which is O(n²) in
  both markdown regexes and DOM parse. Now `createLiveRenderer` commits each
  finished paragraph to the DOM exactly once and re-renders only the trailing
  partial paragraph, coalesced to one `requestAnimationFrame` per frame
  (`frameOnce`); the thought trace moved to 10Hz so `estimateTokens()` (O(len))
  left the per-token path. Output is byte-identical — proven by
  `tools/stream-equiv.test.mjs` (96k comparisons, 0 failures) and measured at
  ~6.4x faster JS-side by `tools/stream-bench.mjs`. INPUT: `trackKeyboard`
  batches `visualViewport` resize/scroll to one write per frame (each
  `--kb-offset` write invalidated style for the whole document); the composer
  uses CSS `field-sizing: content` where supported (zero JS layout per
  keystroke) with the measured fallback kept for older engines; character and
  preset search are debounced. GRAPH: `pointermove` is frame-coalesced with a
  cached rect, the animated dash-flow tail dropped 18 → 6 strokes, and a new
  Animations toggle (`motion`, defaults to the OS `prefers-reduced-motion`)
  stops the infinite SVG repaints. RENDERING: `db.js` now exports `getRev()`
  (bumped by every write) so views re-render only when their data actually
  changed, and the character table is cached against it. Also: real 180/192/512
  PNG app icons (iOS cannot use SVG for `apple-touch-icon` and was screenshotting
  the page), SW navigation timeout so an offline cold start does not keep the
  radio awake, `overscroll-behavior: contain` on inner scrollers.
  `tools/boot.test.mjs` runs the real `init()` against DOM/IDB stubs.
- v1.8.0 DONE: minigames + the Forge can now build them. NEW `js/minigames.js`
  (pure): the session contract, the `fenceGameText` data fence, the HTML
  validator, the chat-command parser, and two native engines (`duel` — HP /
  guard / focus against the character; `fortune` — a 21-card spread with two
  rerolls). NEW `js/game-frame.js`: an agent-authored HTML game runs in an
  opaque-origin sandboxed iframe under a strict CSP, talks to the host over
  postMessage through an injected bridge, and a `load` watchdog restores it if
  it navigates itself away. NEW `minigames` store (DB v4→v5) holds the HTML
  documents; sessions reuse `chat_stage_state` under `minigame:<key>` so no
  second session store and no session migration. NEW Games tab: per-game
  board, tap actions, event log, and a separate **Narrate** button that asks
  the character to react to the queued events (the model is told the
  authoritative state as a fenced system block). Chat commands work too
  (`/duel strike`, `/fortune focus <question>`, `/game <key> <cmd>`).
  FORGE: the agent gained `list_minigames`, `get_minigame`, `create_minigame`
  and   `delete_minigame`, and its system prompt now embeds the authoring guide
  plus a working skeleton, so it can build a game from scratch (writes still
  need Approve). HTML games can also be imported/exported as files — the
  export is a SANDBOXED WRAPPER (`buildExportDocument`), never the raw
  agent-authored document, so a shared game file cannot report the reader's
  address to whoever wrote it. No existing chat, message or stage behaviour
  changed.
