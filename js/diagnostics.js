/* Polyglot diagnostics — tiny coded logger for troubleshooting + patches.
   Convention: every user-visible failure carries a stable code E_AREA_NNN.
   Pure modules (db/api-client/png-parser) THROW coded messages but never
   import this file (keeps them dependency-free and node-testable).
   Only app.js imports here: log() in catch paths, report() for copy-paste
   patch requests. Ring buffer, 200 entries, memory-only (no PII persisted). */

const CAP = 200;
const entries = [];

export const CODES = {
  E_DB_OPEN: "IndexedDB open/upgrade failed (private mode, quota, or blocked version).",
  E_VAULT_SHAPE: "Import file is not a Polyglot vault (missing tables object).",
  E_VAULT_TABLE: "A vault table is corrupt (expected array). Re-export from source.",
  E_NET_ENDPOINT: "Provider has no base URL. Fill Base URL in the provider editor.",
  E_NET_MODEL: "Model preset has no model name. Fetch models from the provider, then pick one.",
  E_NET_OFFLINE: "Fetch failed: offline, DNS, or mobile Safari CORS preflight. Try proxy toggle + Test connection.",
  E_PROVIDER: "Provider save/test failure; reason follows the code.",
  E_API_FAIL: "Provider returned HTTP error; status + provider message follow the code.",
  E_SSE_PARTIAL: "Skipped a malformed SSE line (common via proxies); stream continues.",
  E_PNG_SIG: "File is not a PNG (bad signature). Use PNG card or JSON export.",
  E_PNG_TRUNC: "PNG truncated mid-chunk. Re-download the card.",
  E_PNG_MANY: "PNG rejected: too many chunks (likely not a card).",
  E_ZLIB_UNSUPPORTED: "Compressed card (zTXt/iTXt) on a browser without DecompressionStream.",
  E_ZLIB_METHOD: "Card uses an unsupported compression method (only deflate/0).",
  E_ITXT_MALFORMED: "iTXt chunk malformed. Re-export the card from source.",
  E_CARD_EMPTY: "Card chunk present but empty.",
  E_CARD_NONE: "No chara/ccv3 chunk in PNG. Image-only file; import its JSON instead.",
  E_CARD_JSON: "Embedded card text is not valid JSON/base64. Re-export the card.",
  E_IMG_AVATAR: "Avatar resize failed; continuing without avatar image.",
  E_UI_SEND: "Send-path failure; the message before the code names the cause.",
  E_UI_IMPORT: "File import failed; reason follows the code.",
  E_UI_EXPORT: "Backup export failed; reason follows the code.",
  E_REGEX_RULE: "Regex script saved/applied/skipped; invalid patterns are rejected or skipped, never fatal.",
  E_STAGE_STATE: "Stage state load/save/dice/chess/world event; never fatal to send.",
  E_STAGE_RULE: "Stage def saved/applied/skipped; invalid config rejected, never fatal.",
  E_SUPERVISOR: "Supervisor router action proposed/applied/rejected; schema errors are rejected, never fatal.",
  E_MODES_FETCH: "Thinking-modes fetch for a model: live docs schema, surveyed catalog fallback, or none.",
  E_REASONING: "Thinking knob applied/skipped at send time; invalid values fall back, never fatal.",
  E_AGENCY: "Agentic message normalization at send time (strict user/assistant alternation).",
  E_GAME_CONTRACT: "Minigame HTML validation: self-contained, offline, uses the Polyglot bridge.",
  E_GAME_FRAME: "Sandboxed minigame frame: start, command round trip, or a game-side error.",
  E_GAME_STATE: "Minigame session load/save/move; never fatal to the send path."
};

export function log(level, code, msg) {
  entries.push({ t: new Date().toISOString(), level, code, msg: String(msg ?? "") });
  if (entries.length > CAP) entries.splice(0, entries.length - CAP);
  if (level === "error") {
    try { console.error(`[Polyglot ${code}]`, msg); } catch { /* noop */ }
  }
}

export const info = (code, msg) => log("info", code, msg);
export const warn = (code, msg) => log("warn", code, msg);
export const err = (code, msg) => log("error", code, msg);

export function recent(n = 50) {
  return entries.slice(-n);
}

export function clearLog() {
  entries.length = 0;
}

export function report(appVersion) {
  const head = [
    `Polyglot diagnostics ${new Date().toISOString()}`,
    `version: ${appVersion}`,
    `ua: ${navigator.userAgent}`,
    `online: ${navigator.onLine}`,
    `entries: ${entries.length} (showing ${Math.min(entries.length, CAP)})`,
    "---"
  ];
  const lines = recent(CAP).map((e) => `${e.t} [${e.level}] ${e.code}: ${e.msg}`);
  return head.concat(lines).join("\n");
}
