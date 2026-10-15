// Polyglot supervisor router — pure tool-call protocol, zero dependencies.
// No DOM, no IndexedDB, no imports: node-testable. Never throws; bad JSON
// lands in skipped. The LLM never writes files directly: it proposes actions,
// app.js validates, shows Approve/Reject, then executes via db.js helpers.
// Actions: create_character, polish_character, write_scenario, add_stage, set_world.

export const SUPERVISOR_ACTIONS = [
  "create_character",
  "polish_character",
  "write_scenario",
  "add_stage",
  "set_world"
];

export const STAGE_KEYS = ["director", "world", "dice", "chess"];

function safeStr(v, max) {
  if (typeof v !== "string") return "";
  const t = v.trim();
  if (!t) return "";
  return t.length > (max || 2000) ? t.slice(0, max || 2000) : t;
}

function toId(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

// Extract candidate JSON tool blocks from model text.
export function parseSupervisorReply(text) {
  const out = { actions: [], skipped: [], notes: [] };
  let src = String(text ?? "");
  if (!src.trim()) {
    out.skipped.push("empty reply");
    return out;
  }
  const candidates = [];
  const fenceRe = /```(?:json|tool)?\s*([\s\S]*?)```/gi;
  let m = null;
  while ((m = fenceRe.exec(src)) !== null) {
    if (m[1] && m[1].indexOf("action") !== -1) candidates.push(m[1]);
  }
  const commentRe = /<!--\s*tool\s*([\s\S]*?)\s*-->/gi;
  while ((m = commentRe.exec(src)) !== null) {
    if (m[1] && m[1].indexOf("action") !== -1) candidates.push(m[1]);
  }
  // Bare { "action": ... } object as last resort (first large brace span).
  if (!candidates.length) {
    const idx = src.indexOf('"action"');
    if (idx !== -1) {
      const open = src.lastIndexOf("{", idx);
      const close = src.indexOf("}", idx);
      if (open !== -1 && close !== -1 && close > open) candidates.push(src.slice(open, close + 1));
    }
  }
  for (const c of candidates) {
    const t = String(c).trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      const list = Array.isArray(obj) ? obj : [obj];
      for (const a of list) {
        if (a && typeof a === "object" && typeof a.action === "string") out.actions.push(a);
        else out.skipped.push("entry without action");
      }
    } catch {
      out.skipped.push("unparseable JSON block");
    }
  }
  if (!out.actions.length && !out.skipped.length) out.notes.push("no tool block found");
  return out;
}

// Validate one action object. Returns null when OK, else an E_SUPERVISOR string.
export function validateAction(a) {
  if (!a || typeof a !== "object") return "E_SUPERVISOR: action must be an object.";
  if (!SUPERVISOR_ACTIONS.includes(a.action)) {
    return "E_SUPERVISOR: unknown action " + String(a.action || "?").slice(0, 40) + ".";
  }
  if (a.action === "create_character") {
    if (!safeStr(a.name, 80)) return "E_SUPERVISOR: create_character needs a name.";
    return null;
  }
  if (a.action === "polish_character" || a.action === "write_scenario") {
    if (toId(a.character_id) == null && !safeStr(a.name, 80) && !safeStr(a.character_name, 80)) {
      return "E_SUPERVISOR: " + a.action + " needs character_id or name.";
    }
    if (a.action === "write_scenario" && !safeStr(a.scenario, 6000)) {
      return "E_SUPERVISOR: write_scenario needs a scenario.";
    }
    return null;
  }
  if (a.action === "add_stage") {
    if (!STAGE_KEYS.includes(a.stage_key)) return "E_SUPERVISOR: add_stage needs stage_key director|world|dice|chess.";
    return null;
  }
  if (a.action === "set_world") {
    if (!safeStr(a.location, 200) && !safeStr(a.time, 200) && !safeStr(a.notes, 4000)
      && !Array.isArray(a.party) && !Array.isArray(a.inventory) && !a.flags) {
      return "E_SUPERVISOR: set_world needs at least one world field.";
    }
    return null;
  }
  return "E_SUPERVISOR: rejected.";
}

export function normalizeAction(a, fallbackChatId) {
  const out = { ...(a || {}) };
  if (out.chat_id == null && fallbackChatId != null) out.chat_id = fallbackChatId;
  if (typeof out.enabled === "boolean") out.enabled = out.enabled ? 1 : 0;
  return out;
}

// Human-readable one-liner for the approval card. Never includes HTML.
export function describeAction(a, characters) {
  const list = Array.isArray(characters) ? characters : [];
  const findName = (id) => {
    const c = list.find((x) => x && x.id === Number(id));
    return c ? c.name || ("#" + id) : ("#" + id);
  };
  const nm = a.character_id != null ? findName(a.character_id) : (a.name || a.character_name || "?");
  if (a.action === "create_character") return "Create character " + (a.name || "?");
  if (a.action === "polish_character") return "Polish " + nm;
  if (a.action === "write_scenario") return "Write scenario for " + nm;
  if (a.action === "add_stage") {
    const scope = a.chat_id != null ? ("chat #" + a.chat_id) : (a.character_id != null ? findName(a.character_id) : "current chat");
    return "Attach stage " + (a.stage_key || "?") + " to " + scope;
  }
  if (a.action === "set_world") {
    const bits = [];
    if (a.location) bits.push("location=" + String(a.location).slice(0, 40));
    if (a.time) bits.push("time=" + String(a.time).slice(0, 40));
    return "Set world (" + (bits.join(", ") || "fields") + ")";
  }
  return String(a.action || "action");
}

// System prompt for the supervisor LLM call. Lists schemas + current library.
export function buildSupervisorPrompt({ characters, chats, stageStates }) {
  const chars = (Array.isArray(characters) ? characters : []).slice(0, 60).map((c) => ({
    id: c.id,
    name: c.name || "",
    has_scenario: !!(c.scenario && String(c.scenario).trim())
  }));
  const hint = Array.isArray(chats) ? chats.length : 0;
  return [
    "You are the Polyglot Forge supervisor. Propose library edits as tool JSON only.",
    "Rules: output ONE fenced ```tool block with a single JSON object (or array). No prose outside the fence.",
    "Keep fields short: description 1-3 sentences, scenario 2-6 sentences, first_mes one greeting line.",
    "Never invent character_id values outside this library list. Prefer name matching when unsure.",
    "Actions:",
    "- {\"action\":\"create_character\",\"name\":\"...\",\"description\":\"...\",\"personality\":\"...\",\"scenario\":\"...\",\"first_mes\":\"...\",\"mes_example\":\"...\",\"system_prompt\":\"...\"}",
    "- {\"action\":\"polish_character\",\"character_id\":1,\"description\":\"...\",\"personality\":\"...\",\"scenario\":\"...\",\"first_mes\":\"...\"} (or use \"name\" instead of character_id)",
    "- {\"action\":\"write_scenario\",\"character_id\":1,\"scenario\":\"...\",\"first_mes\":\"...\"}",
    "- {\"action\":\"add_stage\",\"stage_key\":\"world|director|dice|chess\",\"chat_id\":123,\"enabled\":1}",
    "- {\"action\":\"set_world\",\"chat_id\":123,\"location\":\"...\",\"time\":\"...\",\"weather\":\"...\",\"party\":[],\"inventory\":[],\"notes\":\"...\"}",
    "Library characters: " + JSON.stringify(chars).slice(0, 3000),
    "Open chats: " + hint + ". Stage keys: director, world, dice, chess."
  ].join("\n");
}

// Offline fallback: draft a character skeleton from a one-line brief. Pure + total.
export function localDraftCharacter(brief) {
  const raw = safeStr(brief, 500) || "Unnamed Wanderer";
  const nameGuess = raw.split(/[,.\n]/)[0].trim().slice(0, 40) || "Unnamed Wanderer";
  const cap = nameGuess.charAt(0).toUpperCase() + nameGuess.slice(1);
  return {
    name: cap,
    description: cap + " — " + raw.slice(0, 220),
    personality: "Warm, curious, and direct. Speaks plainly and stays in the moment.",
    scenario: "You meet " + cap + " on the road, mid-journey, with an unfinished errand and time to talk.",
    first_mes: "*" + "looks up as you approach" + "* \"Hey — mind if I walk with you a while?\"",
    mes_example: "{{user}}: Hello.\n{{char}}: \"Hey. Glad you showed up.\"",
    system_prompt: "",
    avatar: null
  };
}

// Offline polish: deterministic cleanup (trim, collapse blanks, fix greeting).
export function localPolishCharacter(char) {
  const c = { ...(char || {}) };
  for (const k of ["description", "personality", "scenario", "first_mes", "mes_example", "system_prompt"]) {
    if (typeof c[k] === "string") c[k] = c[k].replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  if (c.first_mes && !/[.!?"*]$/.test(c.first_mes.trim())) c.first_mes = c.first_mes.trim() + ".";
  c.updated_at = Date.now();
  return c;
}
