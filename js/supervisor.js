// Polyglot Forge agent — pure tool-call protocol, zero dependencies.
// No DOM, no IndexedDB, no imports: node-testable. Never throws; bad JSON
// lands in skipped. The LLM never writes anything directly: reads run live
// in the loop, writes become Approve/Reject proposals, app.js executes the
// approved ones via db.js helpers. API keys and avatar bytes never enter the
// prompt; vault export via the agent always strips keys.

export const STAGE_KEYS = ["director", "world", "dice", "chess"];

// Reads run immediately and their results feed back into the loop.
export const READ_ACTIONS = [
  "list_characters",
  "get_character",
  "list_chats",
  "read_chat",
  "list_lorebooks",
  "get_lorebook",
  "list_presets",
  "get_preset",
  "list_providers",
  "list_personas",
  "get_persona",
  "list_regex",
  "get_world",
  "list_stage_states"
];

// Writes are proposals only: nothing is applied until the user taps Approve.
export const WRITE_ACTIONS = [
  "create_character",
  "polish_character",
  "write_scenario",
  "delete_character",
  "create_chat",
  "delete_chat",
  "append_message",
  "delete_message",
  "create_lorebook",
  "add_lore_entry",
  "delete_lorebook",
  "save_persona",
  "delete_persona",
  "save_preset",
  "add_regex_rule",
  "delete_regex_rule",
  "add_stage",
  "set_world",
  "export_file"
];

// Loop control: done ends the run, answer ends it with a direct reply.
export const CONTROL_ACTIONS = ["done", "answer"];

export const SUPERVISOR_ACTIONS = [...READ_ACTIONS, ...WRITE_ACTIONS, ...CONTROL_ACTIONS];

export function isReadAction(a) {
  return !!a && READ_ACTIONS.includes(a.action || a);
}

export function isControlAction(a) {
  return !!a && CONTROL_ACTIONS.includes(a.action || a);
}

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

function hasTarget(a, keys) {
  for (const k of keys) {
    if (k === "id" && toId(a.id) != null) return true;
    if (/(_id|_name)$/.test(k) && (toId(a[k]) != null || safeStr(a[k], 120))) return true;
    if (safeStr(a[k], 120)) return true;
  }
  return false;
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
  if (a.action === "done") return null;
  if (a.action === "answer") {
    if (!safeStr(a.text, 4000)) return "E_SUPERVISOR: answer needs text.";
    return null;
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
  if (a.action === "delete_character") {
    if (!hasTarget(a, ["character_id", "name", "character_name"])) {
      return "E_SUPERVISOR: delete_character needs character_id or name.";
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
  if (a.action === "get_character" || a.action === "get_persona") {
    if (toId(a.character_id) == null && toId(a.persona_id) == null && !safeStr(a.name, 120)) {
      return "E_SUPERVISOR: " + a.action + " needs an id or name.";
    }
    return null;
  }
  if (a.action === "get_lorebook") {
    if (toId(a.lorebook_id) == null && !safeStr(a.name, 120)) {
      return "E_SUPERVISOR: get_lorebook needs lorebook_id or name.";
    }
    return null;
  }
  if (a.action === "get_preset") {
    if (toId(a.preset_id) == null && !safeStr(a.name, 120)) {
      return "E_SUPERVISOR: get_preset needs preset_id or name.";
    }
    return null;
  }
  if (a.action === "list_characters" || a.action === "list_chats" || a.action === "list_lorebooks"
    || a.action === "list_presets" || a.action === "list_providers" || a.action === "list_personas"
    || a.action === "list_regex" || a.action === "list_stage_states" || a.action === "get_world") {
    return null;
  }
  if (a.action === "read_chat") {
    if (toId(a.chat_id) == null) return "E_SUPERVISOR: read_chat needs chat_id.";
    return null;
  }
  if (a.action === "create_chat") {
    if (!hasTarget(a, ["character_id", "name", "character_name"])) {
      return "E_SUPERVISOR: create_chat needs character_id or name.";
    }
    return null;
  }
  if (a.action === "delete_chat") {
    if (toId(a.chat_id) == null) return "E_SUPERVISOR: delete_chat needs chat_id.";
    return null;
  }
  if (a.action === "append_message") {
    if (toId(a.chat_id) == null) return "E_SUPERVISOR: append_message needs chat_id.";
    if (a.role !== "user" && a.role !== "assistant") return "E_SUPERVISOR: append_message role must be user|assistant.";
    if (!safeStr(a.content, 6000)) return "E_SUPERVISOR: append_message needs content.";
    return null;
  }
  if (a.action === "delete_message") {
    if (toId(a.message_id) == null) return "E_SUPERVISOR: delete_message needs message_id.";
    return null;
  }
  if (a.action === "create_lorebook") {
    if (!safeStr(a.name, 120)) return "E_SUPERVISOR: create_lorebook needs a name.";
    return null;
  }
  if (a.action === "add_lore_entry") {
    if (toId(a.lorebook_id) == null && !safeStr(a.name, 120) && !safeStr(a.lorebook_name, 120)) {
      return "E_SUPERVISOR: add_lore_entry needs lorebook_id or name.";
    }
    if (!safeStr(a.content, 4000)) return "E_SUPERVISOR: add_lore_entry needs content.";
    return null;
  }
  if (a.action === "delete_lorebook") {
    if (toId(a.lorebook_id) == null && !safeStr(a.name, 120) && !safeStr(a.lorebook_name, 120)) {
      return "E_SUPERVISOR: delete_lorebook needs lorebook_id or name.";
    }
    return null;
  }
  if (a.action === "save_persona") {
    if (toId(a.persona_id) == null && !safeStr(a.name, 120)) {
      return "E_SUPERVISOR: save_persona needs persona_id or name.";
    }
    return null;
  }
  if (a.action === "delete_persona") {
    if (toId(a.persona_id) == null && !safeStr(a.name, 120)) {
      return "E_SUPERVISOR: delete_persona needs persona_id or name.";
    }
    return null;
  }
  if (a.action === "save_preset") {
    if (toId(a.preset_id) == null && !safeStr(a.name, 120)) {
      return "E_SUPERVISOR: save_preset needs preset_id or name.";
    }
    if (a.model == null && a.reasoning_mode == null && a.reasoning_value == null
      && a.reasoning_budget == null && a.agentic_format == null) {
      return "E_SUPERVISOR: save_preset needs at least one field: model, reasoning_mode, reasoning_value, reasoning_budget, agentic_format.";
    }
    if (a.reasoning_mode != null && !["off", "effort", "budget", "kwargs", "anthropic", "custom"].includes(a.reasoning_mode)) {
      return "E_SUPERVISOR: save_preset reasoning_mode must be off|effort|budget|kwargs|anthropic|custom.";
    }
    if (a.agentic_format != null && !["auto", "on", "off"].includes(a.agentic_format)) {
      return "E_SUPERVISOR: save_preset agentic_format must be auto|on|off.";
    }
    return null;
  }
  if (a.action === "add_regex_rule") {
    if (!safeStr(a.pattern, 2000)) return "E_SUPERVISOR: add_regex_rule needs a pattern.";
    if (a.flags != null && (typeof a.flags !== "string" || !/^[a-z]{0,6}$/i.test(a.flags))) {
      return "E_SUPERVISOR: add_regex_rule flags must be letters only.";
    }
    if (a.place != null && !["prompt", "display", "both"].includes(a.place)) {
      return "E_SUPERVISOR: add_regex_rule place must be prompt|display|both.";
    }
    return null;
  }
  if (a.action === "delete_regex_rule") {
    if (toId(a.rule_id) == null) return "E_SUPERVISOR: delete_regex_rule needs rule_id.";
    return null;
  }
  if (a.action === "export_file") {
    if (!["vault", "chat", "character", "preset", "lorebook", "regex"].includes(a.kind)) {
      return "E_SUPERVISOR: export_file kind must be vault|chat|character|preset|lorebook|regex.";
    }
    if (a.include_keys) return "E_SUPERVISOR: export_file never includes keys.";
    if (a.kind !== "vault" && a.kind !== "regex" && toId(a.chat_id) == null && toId(a.character_id) == null
      && toId(a.preset_id) == null && toId(a.lorebook_id) == null && !safeStr(a.name, 120)) {
      return "E_SUPERVISOR: export_file needs a target id or name for kind " + a.kind + ".";
    }
    return null;
  }
  return "E_SUPERVISOR: rejected.";
}

export function normalizeAction(a, fallbackChatId) {
  const out = { ...(a || {}) };
  if (out.chat_id == null && fallbackChatId != null
    && ["add_stage", "set_world", "get_world", "list_stage_states"].includes(out.action)) {
    out.chat_id = fallbackChatId;
  }
  if (typeof out.enabled === "boolean") out.enabled = out.enabled ? 1 : 0;
  if (out.action === "read_chat") {
    const n = Number(out.limit);
    out.limit = Number.isFinite(n) ? Math.min(20, Math.max(1, Math.floor(n))) : 10;
  }
  if (out.action === "append_message" && typeof out.role === "string") {
    out.role = out.role.trim().toLowerCase();
  }
  if ((out.action === "add_lore_entry") && out.keys != null && !Array.isArray(out.keys)) {
    out.keys = String(out.keys).split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20);
  }
  delete out.include_keys;
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
  if (a.action === "done") return "Finish run" + (a.summary ? ": " + String(a.summary).slice(0, 80) : "");
  if (a.action === "answer") return "Answer user";
  if (a.action === "list_characters") return "Look up characters" + (a.query ? " matching " + a.query : "");
  if (a.action === "get_character") return "Inspect character " + nm;
  if (a.action === "list_chats") return "Look up chats";
  if (a.action === "read_chat") return "Read chat #" + (a.chat_id ?? "?");
  if (a.action === "list_lorebooks") return "Look up lorebooks";
  if (a.action === "get_lorebook") return "Inspect lorebook " + (a.name || a.lorebook_name || ("#" + (a.lorebook_id ?? "?")));
  if (a.action === "list_presets") return "Look up presets";
  if (a.action === "get_preset") return "Inspect preset " + (a.name || ("#" + (a.preset_id ?? "?")));
  if (a.action === "list_providers") return "Look up providers (no keys shown)";
  if (a.action === "list_personas") return "Look up personas";
  if (a.action === "get_persona") return "Inspect persona " + (a.name || ("#" + (a.persona_id ?? "?")));
  if (a.action === "list_regex") return "Look up regex rules";
  if (a.action === "get_world") return "Inspect world state" + (a.chat_id != null ? " for chat #" + a.chat_id : "");
  if (a.action === "list_stage_states") return "Inspect stage states" + (a.chat_id != null ? " for chat #" + a.chat_id : "");
  if (a.action === "create_character") return "Create character " + (a.name || "?");
  if (a.action === "polish_character") return "Polish " + nm;
  if (a.action === "write_scenario") return "Write scenario for " + nm;
  if (a.action === "delete_character") return "DELETE character " + nm;
  if (a.action === "create_chat") return "Start new chat with " + nm;
  if (a.action === "delete_chat") return "DELETE chat #" + (a.chat_id ?? "?");
  if (a.action === "append_message") return "Append " + (a.role || "?") + " message to chat #" + (a.chat_id ?? "?");
  if (a.action === "delete_message") return "DELETE message #" + (a.message_id ?? "?");
  if (a.action === "create_lorebook") return "Create lorebook " + (a.name || "?");
  if (a.action === "add_lore_entry") {
    return "Add lore entry to " + (a.name || a.lorebook_name || ("#" + (a.lorebook_id ?? "?")));
  }
  if (a.action === "delete_lorebook") return "DELETE lorebook " + (a.name || a.lorebook_name || ("#" + (a.lorebook_id ?? "?")));
  if (a.action === "save_persona") return "Save persona " + (a.name || ("#" + (a.persona_id ?? "?")));
  if (a.action === "delete_persona") return "DELETE persona " + (a.name || ("#" + (a.persona_id ?? "?")));
  if (a.action === "save_preset") return "Update preset " + (a.name || ("#" + (a.preset_id ?? "?")));
  if (a.action === "add_regex_rule") return "Add regex rule" + (a.name ? " " + a.name : "");
  if (a.action === "delete_regex_rule") return "DELETE regex rule #" + (a.rule_id ?? "?");
  if (a.action === "export_file") return "Export " + (a.kind || "?") + " file (keys stripped)";
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

// System prompt for the Forge agent loop. Lists the protocol, schemas, and a
// compact snapshot of the library. Keys and avatar bytes are never included.
export function buildSupervisorPrompt({ characters, chats, personas, presets, providers, lorebooks }) {
  const chars = (Array.isArray(characters) ? characters : []).slice(0, 60).map((c) => ({
    id: c.id,
    name: c.name || "",
    has_scenario: !!(c.scenario && String(c.scenario).trim())
  }));
  const chatList = (Array.isArray(chats) ? chats : []).slice(-15).map((c) => ({
    id: c.id,
    character_id: c.character_id ?? null,
    title: String(c.title || "").slice(0, 40)
  }));
  const presetList = (Array.isArray(presets) ? presets : []).slice(0, 20).map((p) => ({
    id: p.id,
    name: p.name || "",
    model: String(p.model || (p.connection && p.connection.model) || "").slice(0, 80)
  }));
  const personaList = (Array.isArray(personas) ? personas : []).slice(0, 20).map((p) => ({
    id: p.id,
    name: p.name || ""
  }));
  return [
    "You are the Polyglot Forge agent. You work in steps: reply with exactly ONE fenced ```tool JSON object per step.",
    "Reads run immediately and you get an Observation back. Writes are PROPOSALS ONLY: they are recorded for user approval, never applied during the run. Never assume a write was applied; refer to new things by name, not by guessed ids.",
    "Prefer reading before writing. Keep text fields short. Finish with done {\"summary\"} or, for questions, answer {\"text\"}.",
    "Control: {\"action\":\"done\",\"summary\":\"...\"} | {\"action\":\"answer\",\"text\":\"...\"}",
    "Reads: list_characters {query?} | get_character {character_id|name} | list_chats {character_id?,query?} | read_chat {chat_id,limit?<=20} | list_lorebooks {character_id?} | get_lorebook {lorebook_id|name} | list_presets | get_preset {preset_id|name} | list_providers | list_personas | get_persona {persona_id|name} | list_regex {character_id?} | get_world {chat_id?} | list_stage_states {chat_id?}",
    "Character writes: {\"action\":\"create_character\",\"name\",\"description\",\"personality\",\"scenario\",\"first_mes\",\"mes_example\",\"system_prompt\"} | polish_character {character_id|name + fields} | write_scenario {character_id|name,\"scenario\",\"first_mes\"?} | delete_character {character_id|name}",
    "Chat writes: create_chat {character_id|name,title?} | delete_chat {chat_id} | append_message {chat_id,role:user|assistant,name?,content} | delete_message {message_id}",
    "Library writes: create_lorebook {name,character_id|name?,description?} | add_lore_entry {lorebook_id|name,keys?[],content,enabled?} | delete_lorebook {lorebook_id|name} | save_persona {persona_id|name,description?} | delete_persona {persona_id|name}",
    "Config writes: save_preset {preset_id|name + any of model,reasoning_mode off|effort|budget|kwargs|anthropic|custom,reasoning_value,reasoning_budget,agentic_format auto|on|off} (existing preset only; keys untouched) | add_regex_rule {name?,pattern,replacement?,flags?,place? prompt|display|both,character_id? omit=global} | delete_regex_rule {rule_id} | add_stage {stage_key director|world|dice|chess,chat_id?,enabled?} | set_world {chat_id?,location?,time?,weather?,party?[],inventory?[],notes?} | export_file {kind vault|chat|character|preset|lorebook|regex + target id/name; keys always stripped}",
    "Characters: " + JSON.stringify(chars).slice(0, 3000),
    "Recent chats: " + JSON.stringify(chatList).slice(0, 1500),
    "Presets: " + JSON.stringify(presetList).slice(0, 1200),
    "Personas: " + JSON.stringify(personaList).slice(0, 800),
    "Providers: " + (Array.isArray(providers) ? providers.length : 0)
    + ". Lorebooks: " + (Array.isArray(lorebooks) ? lorebooks.length : 0)
    + ". Stage keys: director, world, dice, chess."
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
