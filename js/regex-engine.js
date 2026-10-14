/* Polyglot regex-engine — pure SillyTavern-style find/replace scripts.
   No DOM, no IndexedDB, no imports: node-testable.
   Rule shape: {name, pattern, replacement, flags, place, character_id, enabled}.
   - place: "prompt" (outgoing context only) | "display" (render only) | "both".
   - character_id: null = global, else applies only to that character's chats.
   - flags: subset of gim suy d (anything else is dropped, never throws).
   Invalid patterns never throw: the rule is skipped and reported in `skipped`.
   Replacements support $1..$99 groups; a literal $ is written $$. */

const ALLOWED_FLAGS = new Set(["g", "i", "m", "s", "u", "y", "d"]);

export function cleanFlags(flags) {
  return [...new Set(String(flags ?? "g").split(""))]
    .filter((f) => ALLOWED_FLAGS.has(f))
    .join("");
}

export function compileRule(rule) {
  if (!rule || rule.enabled === 0 || rule.enabled === false) return null;
  const src = String(rule.pattern ?? "");
  if (!src) return null;
  try {
    return new RegExp(src, cleanFlags(rule.flags));
  } catch {
    return null;
  }
}

// Applies ordered prompt/display-scoped rules to text. Pure + total: never throws.
export function applyRules(text, rules, { place = "prompt", characterId = null } = {}) {
  let out = String(text ?? "");
  const applied = [];
  const skipped = [];
  const rows = Array.isArray(rules) ? rowsSorted(rules) : [];
  for (const r of rows) {
    if (!r || r.enabled === 0 || r.enabled === false) continue;
    const scope = r.place || "both";
    if (scope !== "both" && scope !== place) continue;
    if (r.character_id != null && characterId != null && r.character_id !== characterId) continue;
    const re = compileRule(r);
    if (!re) {
      skipped.push(r.name || `#${r.id ?? "?"}`);
      continue;
    }
    const before = out;
    try {
      out = out.replace(re, String(r.replacement ?? ""));
    } catch {
      skipped.push(r.name || `#${r.id ?? "?"}`);
      continue;
    }
    if (out !== before) applied.push(r.name || `#${r.id ?? "?"}`);
  }
  return { text: out, applied, skipped };
}

function rowsSorted(rules) {
  return [...rules].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
}

// Convenience wrappers used by app.js.
export const applyPromptRules = (text, rules, characterId) =>
  applyRules(text, rules, { place: "prompt", characterId });

export const applyDisplayRules = (text, rules, characterId) =>
  applyRules(text, rules, { place: "display", characterId });
