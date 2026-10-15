// Polyglot stages - pure deterministic roleplay tools, zero dependencies.
// No DOM, no IndexedDB, no imports: node-testable.
// Four built-ins: director (Boss-Mode brackets), world-state holder,
// dice roller, chess-lite engine. All functions are total and never throw.
// Custom user stages are JSON templates consumed by app.js, never evaled here.

export const STAGE_KEYS = ["director", "world", "dice", "chess"];

export const STAGE_META = {
  director: { name: "Director", desc: "Boss-Mode: [immediate] and [[persistent]] stage directions." },
  world: { name: "World State", desc: "Location, party, inventory, flags holder + slash commands." },
  dice: { name: "Dice", desc: "Deterministic /roll handling so the LLM cannot fudge." },
  chess: { name: "Chess", desc: "Play chess vs a vanilla engine. Say play chess, move A2 to A4." }
};

export function defaultStageToggles() {
  return { director: 1, world: 1, dice: 1, chess: 0 };
}

export function normalizeToggles(raw) {
  const d = defaultStageToggles();
  if (!raw || typeof raw !== "object") return d;
  const out = { ...d };
  for (const k of STAGE_KEYS) {
    if (raw[k] === 1 || raw[k] === true || raw[k] === "1") out[k] = 1;
    else if (raw[k] === 0 || raw[k] === false || raw[k] === "0" || raw[k] == null) out[k] = 0;
    else out[k] = d[k];
  }
  return out;
}

// ---------- Director (Boss-Mode) ----------
// Double brackets are long-term (persist until replaced).
// Single brackets are immediate (this reply only).
// Extraction runs on raw stored text; history itself is never rewritten.
export function parseDirector(text) {
  let src = String(text ?? "");
  const longterm = [];
  const immediate = [];
  if (!src) return { cleaned: src, immediate, longterm, hasDirector: false };
  // Pull double-bracketed first so inner singles are not double-counted.
  src = src.replace(/\[\[([\s\S]*?)\]\]/g, (m, inner) => {
    const t = String(inner ?? "").trim();
    if (t) longterm.push(t);
    return "";
  });
  src = src.replace(/\[([\s\S]*?)\]/g, (m, inner) => {
    const t = String(inner ?? "").trim();
    if (!t) return "";
    // Guard against empty leftovers from the double pass.
    immediate.push(t);
    return "";
  });
  // Collapse 3+ blank lines left by stripping, trim trailing space.
  const cleaned = src.replace(/\n{3,}/g, "\n\n").trim();
  return { cleaned, immediate, longterm, hasDirector: (immediate.length + longterm.length) > 0 };
}

export function directorBlocks(immediateList, persistentText) {
  const out = [];
  const imm = (Array.isArray(immediateList) ? immediateList : []).map((s) => String(s || "").trim()).filter(Boolean);
  const per = String(persistentText || "").trim();
  if (imm.length) out.push({ role: "system", content: "[Stage Direction - immediate, apply to this reply only]\n" + imm.map((s) => "- " + s).join("\n") });
  if (per) out.push({ role: "system", content: "[Stage Direction - persistent, applies until replaced]\n" + per });
  return out;
}

// ---------- Dice ----------
// Supports: /roll 2d6, /roll d20+3, /roll 4d6-2, /roll 1d100
// Returns every roll in the message so the prompt can list them.
const DICE_RE = /(?:^|\s)\/roll\s+(\d{0,3})d(\d{1,4})(\s*[+-]\s*\d{1,4})?/gi;

export function parseDice(text) {
  const src = String(text ?? "");
  const rolls = [];
  if (!src) return rolls;
  DICE_RE.lastIndex = 0;
  let m;
  while ((m = DICE_RE.exec(src)) !== null) {
    try {
      const n = Math.min(100, Math.max(1, parseInt(m[1] || "1", 10) || 1));
      const sides = Math.min(1000, Math.max(2, parseInt(m[2], 10) || 6));
      const modRaw = (m[3] || "").replace(/\s+/g, "");
      const mod = modRaw ? parseInt(modRaw, 10) || 0 : 0;
      const parts = [];
      let total = 0;
      for (let i = 0; i < n; i++) {
        const r = 1 + Math.floor(Math.random() * sides);
        parts.push(r);
        total += r;
      }
      total += mod;
      const spec = `${n}d${sides}${modRaw || ""}`;
      rolls.push({ spec, num: n, sides, mod, parts, total });
      if (rolls.length >= 10) break;
    } catch {
      continue;
    }
  }
  DICE_RE.lastIndex = 0;
  return rolls;
}

export function diceBlocks(rolls, who) {
  if (!rolls || !rolls.length) return [];
  const name = String(who || "You").trim() || "You";
  const lines = rolls.map((r) => `- ${name} rolled ${r.spec} => [${r.parts.join(", ")}]${r.mod ? ` ${r.mod > 0 ? "+" : ""}${r.mod}` : ""} = ${r.total}`);
  return [{ role: "system", content: "[Dice - deterministic, authoritative, do not reroll or contradict]\n" + lines.join("\n") }];
}

// ---------- World state ----------
export function defaultWorldState() {
  return { location: "", time: "", weather: "", party: [], inventory: [], flags: {}, notes: "" };
}

export function normalizeWorld(raw) {
  const d = defaultWorldState();
  if (!raw || typeof raw !== "object") return d;
  return {
    location: String(raw.location || ""),
    time: String(raw.time || ""),
    weather: String(raw.weather || ""),
    party: Array.isArray(raw.party) ? raw.party.map((s) => String(s)).filter(Boolean).slice(0, 24) : [],
    inventory: Array.isArray(raw.inventory) ? raw.inventory.map((s) => String(s)).filter(Boolean).slice(0, 48) : [],
    flags: (raw.flags && typeof raw.flags === "object") ? { ...raw.flags } : {},
    notes: String(raw.notes || "")
  };
}

// Slash commands handled deterministically before the LLM call.
// Returns {changed, reply} where reply is shown to the user as a system chip.
export function applyWorldCommand(text, state) {
  const st = normalizeWorld(state);
  const src = String(text ?? "").trim();
  if (!src.startsWith("/")) return { state: st, changed: false, reply: "" };
  const line = src.replace(/\s+/g, " ").trim();
  let m;
  m = /^\/set\s+(location|time|place|where|weather)\s+(.+)$/i.exec(line);
  if (m) {
    const val = m[2].trim().slice(0, 160);
    if (/^time/i.test(m[1])) st.time = val;
    else if (/^weather/i.test(m[1])) st.weather = val;
    else st.location = val;
    return { state: st, changed: true, reply: `World updated: ${m[1].toLowerCase()} = ${val}` };
  }
  m = /^\/party\s+(add|join)\s+(.+)$/i.exec(line);
  if (m) {
    const name = m[2].trim().slice(0, 80);
    if (name && !st.party.includes(name)) st.party.push(name);
    return { state: st, changed: true, reply: `Party: ${st.party.length ? st.party.join(", ") : "(empty)"}` };
  }
  m = /^\/party\s+(remove|leave|drop)\s+(.+)$/i.exec(line);
  if (m) {
    const name = m[2].trim().toLowerCase();
    st.party = st.party.filter((p) => p.toLowerCase() !== name);
    return { state: st, changed: true, reply: `Party: ${st.party.length ? st.party.join(", ") : "(empty)"}` };
  }
  if (/^\/party\s*(list|show)?$/i.test(line)) {
    return { state: st, changed: false, reply: `Party: ${st.party.length ? st.party.join(", ") : "(empty)"}` };
  }
  m = /^\/(give|add|get|take)\s+(.+)$/i.exec(line);
  if (m) {
    const item = m[2].trim().slice(0, 80);
    if (item && !st.inventory.includes(item)) st.inventory.push(item);
    return { state: st, changed: true, reply: `Inventory: ${st.inventory.length ? st.inventory.join(", ") : "(empty)"}` };
  }
  m = /^\/(drop|remove|lose)\s+(.+)$/i.exec(line);
  if (m) {
    const item = m[2].trim().toLowerCase();
    st.inventory = st.inventory.filter((x) => x.toLowerCase() !== item);
    return { state: st, changed: true, reply: `Inventory: ${st.inventory.length ? st.inventory.join(", ") : "(empty)"}` };
  }
  m = /^\/flag\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/i.exec(line);
  if (m) {
    st.flags[m[1].slice(0, 40)] = m[2].trim().slice(0, 160);
    return { state: st, changed: true, reply: `Flag ${m[1]} = ${st.flags[m[1]]}` };
  }
  m = /^\/flag\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(line);
  if (m) {
    st.flags[m[1].slice(0, 40)] = "true";
    return { state: st, changed: true, reply: `Flag ${m[1]} set.` };
  }
  m = /^\/unflag\s+([A-Za-z_][A-Za-z0-9_]*)$/i.exec(line);
  if (m) {
    delete st.flags[m[1]];
    return { state: st, changed: true, reply: `Flag ${m[1]} cleared.` };
  }
  m = /^\/note\s+(.+)$/i.exec(line);
  if (m) {
    st.notes = (st.notes ? st.notes + "\n" : "") + m[1].trim().slice(0, 500);
    return { state: st, changed: true, reply: "Note recorded." };
  }
  if (/^\/(world|sheet|status)\s*$/.test(line)) {
    return { state: st, changed: false, reply: formatWorldSheet(st) };
  }
  if (/^\/(inv|inventory|bag)\s*$/.test(line)) {
    return { state: st, changed: false, reply: `Inventory: ${st.inventory.length ? st.inventory.join(", ") : "(empty)"}` };
  }
  return { state: st, changed: false, reply: "" };
}

export function formatWorldSheet(st) {
  const s = normalizeWorld(st);
  const flagKeys = Object.keys(s.flags || {});
  const lines = [
    `Location: ${s.location || "-"}`,
    `Time: ${s.time || "-"}`,
    `Weather: ${s.weather || "-"}`,
    `Party: ${s.party.length ? s.party.join(", ") : "-"}`,
    `Inventory: ${s.inventory.length ? s.inventory.join(", ") : "-"}`,
    `Flags: ${flagKeys.length ? flagKeys.map((k) => `${k}=${s.flags[k]}`).join(", ") : "-"}`
  ];
  if (s.notes) lines.push(`Notes: ${s.notes.slice(0, 300)}`);
  return lines.join("\n");
}

export function worldBlocks(st) {
  const s = normalizeWorld(st);
  const empty = !s.location && !s.time && !s.weather && !s.party.length && !s.inventory.length && !Object.keys(s.flags || {}).length && !s.notes;
  if (empty) return [];
  return [{ role: "system", content: "[World State - authoritative, do not contradict]\n" + formatWorldSheet(s) }];
}

// ---------- Chess-lite ----------
// Vanilla legal-move engine. Board index 0=a8 .. 63=h1.
// Pieces: KQRBNP white, kqrbnp black, "" empty.
// User is White, engine is Black. State is JSON-safe for IndexedDB.

const PIECE_VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0, "": 0 };

const GLYPH = {
  K: "♚", Q: "♛", R: "♜", B: "♝", N: "♞", P: "♟",
  k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟", "": "·"
};

export function defaultChessState(difficulty) {
  const back = ["r", "n", "b", "q", "k", "b", "n", "r"];
  const board = new Array(64).fill("");
  for (let f = 0; f < 8; f++) {
    board[f] = back[f];
    board[8 + f] = "p";
    board[48 + f] = "P";
    board[56 + f] = back[f].toUpperCase();
  }
  return {
    board, turn: "w",
    castling: { K: true, Q: true, k: true, q: true },
    ep: -1, halfmove: 0, fullmove: 1,
    active: false, winner: "", reason: "",
    moves: [], difficulty: clampDifficulty(difficulty)
  };
}

export function normalizeChess(raw) {
  const d = defaultChessState(raw && raw.difficulty);
  if (!raw || typeof raw !== "object") return d;
  const board = Array.isArray(raw.board) && raw.board.length === 64
    ? raw.board.map((p) => (typeof p === "string" && /^[KQRBNPkqrbnp]?$/.test(p) ? p : ""))
    : d.board;
  return {
    board,
    turn: raw.turn === "b" ? "b" : "w",
    castling: { K: !!raw.castling?.K, Q: !!raw.castling?.Q, k: !!raw.castling?.k, q: !!raw.castling?.q },
    ep: Number.isInteger(raw.ep) && raw.ep >= -1 && raw.ep < 64 ? raw.ep : -1,
    halfmove: Number(raw.halfmove) || 0,
    fullmove: Number(raw.fullmove) || 1,
    active: !!raw.active,
    winner: raw.winner === "w" || raw.winner === "b" || raw.winner === "draw" ? raw.winner : "",
    reason: String(raw.reason || ""),
    moves: Array.isArray(raw.moves) ? raw.moves.slice(-300) : [],
    difficulty: clampDifficulty(raw.difficulty)
  };
}

export function clampDifficulty(v) {
  const n = Number(v);
  if (n === 1 || n === 2 || n === 3) return n;
  return 2;
}

export function coordToIndex(coord) {
  const c = String(coord || "").trim().toLowerCase();
  const m = /^([a-h])([1-8])$/.exec(c);
  if (!m) return -1;
  const file = m[1].charCodeAt(0) - 97;
  const rank = parseInt(m[2], 10);
  const row = 8 - rank;
  return row * 8 + file;
}

export function indexToCoord(i) {
  const row = Math.floor(i / 8);
  const file = i % 8;
  return String.fromCharCode(97 + file) + String(8 - row);
}

function pieceColor(p) {
  if (!p) return "";
  return p === p.toUpperCase() ? "w" : "b";
}

function rowOf(i) { return Math.floor(i / 8); }
function fileOf(i) { return i % 8; }
function onBoard(r, f) { return r >= 0 && r < 8 && f >= 0 && f < 8; }

function findKing(board, color) {
  const want = color === "w" ? "K" : "k";
  for (let i = 0; i < 64; i++) if (board[i] === want) return i;
  return -1;
}

function attackedBy(board, sq, by) {
  const r = rowOf(sq);
  const f = fileOf(sq);
  // Pawns
  const dir = by === "w" ? 1 : -1;
  for (const df of [-1, 1]) {
    const rr = r + dir;
    const ff = f + df;
    if (!onBoard(rr, ff)) continue;
    const p = board[rr * 8 + ff];
    if (p === (by === "w" ? "P" : "p")) return true;
  }
  // Knights
  const knight = by === "w" ? "N" : "n";
  for (const [dr, df] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) {
    const rr = r + dr;
    const ff = f + df;
    if (!onBoard(rr, ff)) continue;
    if (board[rr * 8 + ff] === knight) return true;
  }
  // King
  const king = by === "w" ? "K" : "k";
  for (let dr = -1; dr <= 1; dr++) {
    for (let df = -1; df <= 1; df++) {
      if (!dr && !df) continue;
      const rr = r + dr;
      const ff = f + df;
      if (!onBoard(rr, ff)) continue;
      if (board[rr * 8 + ff] === king) return true;
    }
  }
  // Sliders
  const rook = by === "w" ? "R" : "r";
  const bishop = by === "w" ? "B" : "b";
  const queen = by === "w" ? "Q" : "q";
  for (const [dr, df] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    let rr = r + dr;
    let ff = f + df;
    while (onBoard(rr, ff)) {
      const p = board[rr * 8 + ff];
      if (p) {
        if (p === rook || p === queen) return true;
        break;
      }
      rr += dr;
      ff += df;
    }
  }
  for (const [dr, df] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    let rr = r + dr;
    let ff = f + df;
    while (onBoard(rr, ff)) {
      const p = board[rr * 8 + ff];
      if (p) {
        if (p === bishop || p === queen) return true;
        break;
      }
      rr += dr;
      ff += df;
    }
  }
  return false;
}

function pseudoMovesFor(board, i, castling, ep) {
  const p = board[i];
  if (!p) return [];
  const color = pieceColor(p);
  const kind = p.toLowerCase();
  const r = rowOf(i);
  const f = fileOf(i);
  const out = [];
  const push = (to, promo, special) => {
    if (to < 0 || to > 63) return;
    const t = board[to];
    if (t && pieceColor(t) === color) return;
    out.push({ from: i, to, promo: promo || "", special: special || "", captured: t || "" });
  };
  if (kind === "p") {
    const dir = color === "w" ? -1 : 1;
    const startRow = color === "w" ? 6 : 1;
    const promoRow = color === "w" ? 0 : 7;
    const one = (r + dir) * 8 + f;
    if (onBoard(r + dir, f) && !board[one]) {
      if (rowOf(one) === promoRow) {
        for (const pr of ["q", "r", "b", "n"]) push(one, pr);
      } else {
        push(one);
        const two = (r + dir * 2) * 8 + f;
        if (r === startRow && !board[two]) push(two, "", "double");
      }
    }
    for (const df of [-1, 1]) {
      if (!onBoard(r + dir, f + df)) continue;
      const to = (r + dir) * 8 + (f + df);
      const t = board[to];
      const isPromo = rowOf(to) === promoRow;
      if (t && pieceColor(t) !== color) {
        if (isPromo) { for (const pr of ["q", "r", "b", "n"]) push(to, pr); }
        else push(to);
      } else if (!t && to === ep) {
        push(to, "", "ep");
      }
    }
    return out;
  }
  if (kind === "n") {
    for (const [dr, df] of [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]]) {
      if (!onBoard(r + dr, f + df)) continue;
      push((r + dr) * 8 + (f + df));
    }
    return out;
  }
  if (kind === "k") {
    for (let dr = -1; dr <= 1; dr++) {
      for (let df = -1; df <= 1; df++) {
        if (!dr && !df) continue;
        if (!onBoard(r + dr, f + df)) continue;
        push((r + dr) * 8 + (f + df));
      }
    }
    // Castling: king on home square, squares empty and unattacked.
    const enemy = color === "w" ? "b" : "w";
    if (color === "w" && i === 60) {
      if (castling.K && !board[61] && !board[62] && board[63] === "R") {
        if (!attackedBy(board, 60, enemy) && !attackedBy(board, 61, enemy) && !attackedBy(board, 62, enemy)) {
          out.push({ from: i, to: 62, promo: "", special: "castleK", captured: "" });
        }
      }
      if (castling.Q && !board[59] && !board[58] && !board[57] && board[56] === "R") {
        if (!attackedBy(board, 60, enemy) && !attackedBy(board, 59, enemy) && !attackedBy(board, 58, enemy)) {
          out.push({ from: i, to: 58, promo: "", special: "castleQ", captured: "" });
        }
      }
    }
    if (color === "b" && i === 4) {
      if (castling.k && !board[5] && !board[6] && board[7] === "r") {
        if (!attackedBy(board, 4, enemy) && !attackedBy(board, 5, enemy) && !attackedBy(board, 6, enemy)) {
          out.push({ from: i, to: 6, promo: "", special: "castleK", captured: "" });
        }
      }
      if (castling.q && !board[3] && !board[2] && !board[1] && board[0] === "r") {
        if (!attackedBy(board, 4, enemy) && !attackedBy(board, 3, enemy) && !attackedBy(board, 2, enemy)) {
          out.push({ from: i, to: 2, promo: "", special: "castleQ", captured: "" });
        }
      }
    }
    return out;
  }
  const dirs = [];
  if (kind === "b" || kind === "q") dirs.push([-1, -1], [-1, 1], [1, -1], [1, 1]);
  if (kind === "r" || kind === "q") dirs.push([-1, 0], [1, 0], [0, -1], [0, 1]);
  for (const [dr, df] of dirs) {
    let rr = r + dr;
    let ff = f + df;
    while (onBoard(rr, ff)) {
      const to = rr * 8 + ff;
      const t = board[to];
      if (!t) push(to);
      else {
        if (pieceColor(t) !== color) push(to);
        break;
      }
      rr += dr;
      ff += df;
    }
  }
  return out;
}

function applyOnBoard(board, castling, epInfo, mv, color) {
  // Returns {board, castling, ep, captured} without legality filtering.
  const nb = board.slice();
  const nc = { ...castling };
  const piece = nb[mv.from];
  let captured = nb[mv.to] || "";
  let newEp = -1;
  // En passant capture removes the pawn behind the target.
  if (mv.special === "ep") {
    const capSq = mv.to + (color === "w" ? 8 : -8);
    captured = nb[capSq] || "";
    nb[capSq] = "";
  }
  nb[mv.from] = "";
  let placed = piece;
  if (mv.promo) {
    placed = color === "w" ? mv.promo.toUpperCase() : mv.promo.toLowerCase();
  }
  nb[mv.to] = placed;
  if (mv.special === "castleK") {
    if (color === "w") { nb[63] = ""; nb[61] = "R"; }
    else { nb[7] = ""; nb[5] = "r"; }
  }
  if (mv.special === "castleQ") {
    if (color === "w") { nb[56] = ""; nb[59] = "R"; }
    else { nb[0] = ""; nb[3] = "r"; }
  }
  if (mv.special === "double") {
    newEp = mv.from + (color === "w" ? -8 : 8);
  }
  // Castling rights decay.
  if (piece === "K") { nc.K = false; nc.Q = false; }
  if (piece === "k") { nc.k = false; nc.q = false; }
  if ((mv.from === 63 || mv.to === 63) && board[63] === "R") nc.K = false;
  if ((mv.from === 56 || mv.to === 56) && board[56] === "R") nc.Q = false;
  if ((mv.from === 7 || mv.to === 7) && board[7] === "r") nc.k = false;
  if ((mv.from === 0 || mv.to === 0) && board[0] === "r") nc.q = false;
  void epInfo;
  return { board: nb, castling: nc, ep: newEp, captured };
}

export function legalMoves(state, color) {
  const st = normalizeChess(state);
  const turn = color || st.turn;
  const out = [];
  for (let i = 0; i < 64; i++) {
    const p = st.board[i];
    if (!p || pieceColor(p) !== turn) continue;
    const pseudos = pseudoMovesFor(st.board, i, st.castling, st.ep);
    for (const mv of pseudos) {
      const applied = applyOnBoard(st.board, st.castling, st.ep, mv, turn);
      const kingSq = findKing(applied.board, turn);
      if (kingSq === -1) continue;
      const enemy = turn === "w" ? "b" : "w";
      if (attackedBy(applied.board, kingSq, enemy)) continue;
      out.push(mv);
    }
  }
  return out;
}

export function gameStatus(state) {
  const st = normalizeChess(state);
  const moves = legalMoves(st, st.turn);
  const kingSq = findKing(st.board, st.turn);
  const enemy = st.turn === "w" ? "b" : "w";
  const inCheck = kingSq !== -1 && attackedBy(st.board, kingSq, enemy);
  if (moves.length === 0) {
    if (inCheck) return { over: true, winner: enemy, reason: "checkmate", inCheck };
    return { over: true, winner: "draw", reason: "stalemate", inCheck };
  }
  if (st.halfmove >= 100) return { over: true, winner: "draw", reason: "fifty-move rule", inCheck };
  return { over: false, winner: "", reason: "", inCheck };
}

function evaluateBoard(board) {
  // White-relative centipawns. Material + tiny center bonus.
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = board[i];
    if (!p) continue;
    const v = PIECE_VAL[p.toLowerCase()] || 0;
    const r = rowOf(i);
    const f = fileOf(i);
    const center = (3.5 - Math.abs(3.5 - (f + 0.5)) + 3.5 - Math.abs(3.5 - (r + 0.5))) * 4;
    const bonus = (p.toLowerCase() === "p" || p.toLowerCase() === "n") ? center : center * 0.3;
    if (pieceColor(p) === "w") score += v + bonus;
    else score -= v + bonus;
  }
  return score;
}

function pickAiMove(st, legal) {
  if (!legal.length) return null;
  const diff = clampDifficulty(st.difficulty);
  if (diff === 1) {
    return legal[Math.floor(Math.random() * legal.length)];
  }
  // Greedy 1-ply for black (minimize white-relative score).
  let best = null;
  let bestScore = Infinity;
  const scored = [];
  for (const mv of legal) {
    const applied = applyOnBoard(st.board, st.castling, st.ep, mv, "b");
    const s = evaluateBoard(applied.board) + Math.random() * (diff === 2 ? 60 : 12);
    scored.push({ mv, s });
    if (s < bestScore) { bestScore = s; best = mv; }
  }
  if (diff === 2 && Math.random() < 0.3) {
    return scored[Math.floor(Math.random() * scored.length)].mv;
  }
  return best;
}

function commitMove(st, mv, color) {
  const applied = applyOnBoard(st.board, st.castling, st.ep, mv, color);
  const piece = st.board[mv.from];
  const isPawn = piece.toLowerCase() === "p";
  const isCapture = !!(applied.captured || mv.special === "ep");
  st.board = applied.board;
  st.castling = applied.castling;
  st.ep = applied.ep;
  st.halfmove = (isPawn || isCapture) ? 0 : st.halfmove + 1;
  if (color === "b") st.fullmove += 1;
  st.turn = color === "w" ? "b" : "w";
  st.moves.push({ from: indexToCoord(mv.from), to: indexToCoord(mv.to), by: color, promo: mv.promo || "", special: mv.special || "", captured: applied.captured || "" });
  const status = gameStatus(st);
  if (status.over) {
    st.active = false;
    st.winner = status.winner;
    st.reason = status.reason;
  }
  return { captured: applied.captured || "", status };
}

export function startChessGame(difficulty) {
  const st = defaultChessState(difficulty);
  st.active = true;
  return st;
}

// User move + automatic engine reply. Returns a result object for the UI chip.
export function playChessTurn(state, fromCoord, toCoord) {
  const st = normalizeChess(state);
  if (!st.active) return { state: st, ok: false, error: "No active game. Say play chess to start." };
  if (st.turn !== "w") return { state: st, ok: false, error: "Not your turn yet." };
  const from = coordToIndex(fromCoord);
  const to = coordToIndex(toCoord);
  if (from < 0 || to < 0) return { state: st, ok: false, error: `Bad squares: ${fromCoord} to ${toCoord}. Use A2 to A4.` };
  const piece = st.board[from];
  if (!piece || pieceColor(piece) !== "w") return { state: st, ok: false, error: `No white piece on ${String(fromCoord).toUpperCase()}.` };
  const legal = legalMoves(st, "w");
  const want = legal.filter((m) => m.from === from && m.to === to);
  if (!want.length) return { state: st, ok: false, error: `Illegal move: ${String(fromCoord).toUpperCase()} to ${String(toCoord).toUpperCase()}.` };
  // Prefer queen promotion when several promo options match the same squares.
  want.sort((a, b) => (b.promo === "q" ? 1 : 0) - (a.promo === "q" ? 1 : 0));
  const userRes = commitMove(st, want[0], "w");
  const out = {
    state: st, ok: true, error: "",
    user: { from: indexToCoord(from), to: indexToCoord(to), captured: userRes.captured },
    ai: null, status: userRes.status
  };
  if (userRes.status.over) return out;
  // Engine reply as Black.
  const blackLegal = legalMoves(st, "b");
  if (!blackLegal.length) {
    const s = gameStatus(st);
    st.active = false;
    st.winner = s.winner;
    st.reason = s.reason;
    out.status = s;
    return out;
  }
  const aiMv = pickAiMove(st, blackLegal);
  if (aiMv) {
    const aiFrom = indexToCoord(aiMv.from);
    const aiTo = indexToCoord(aiMv.to);
    const aiRes = commitMove(st, aiMv, "b");
    out.ai = { from: aiFrom, to: aiTo, captured: aiRes.captured };
    out.status = aiRes.status;
  }
  return out;
}

export function forfeitChess(state) {
  const st = normalizeChess(state);
  st.active = false;
  st.winner = "b";
  st.reason = "forfeit - board knocked over";
  return st;
}

export function toFEN(state) {
  const st = normalizeChess(state);
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    let row = "";
    for (let f = 0; f < 8; f++) {
      const p = st.board[r * 8 + f];
      if (!p) empty++;
      else {
        if (empty) { row += String(empty); empty = 0; }
        row += p;
      }
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  let castle = "";
  if (st.castling.K) castle += "K";
  if (st.castling.Q) castle += "Q";
  if (st.castling.k) castle += "k";
  if (st.castling.q) castle += "q";
  if (!castle) castle = "-";
  const epStr = st.ep >= 0 ? indexToCoord(st.ep) : "-";
  return `${rows.join("/")} ${st.turn} ${castle} ${epStr} ${st.halfmove} ${st.fullmove}`;
}

export function renderBoardText(state) {
  const st = normalizeChess(state);
  const lines = [];
  for (let r = 0; r < 8; r++) {
    const rank = 8 - r;
    const cells = [];
    for (let f = 0; f < 8; f++) {
      const p = st.board[r * 8 + f];
      cells.push(GLYPH[p] || GLYPH[""]);
    }
    lines.push(`${rank} ${cells.join(" ")}`);
  }
  lines.push("  a b c d e f g h");
  return lines.join("\n");
}

// Triggers in free text: start, forfeit, and coordinate moves.
const MOVE_RE = /([a-h][1-8])\s+to\s+([a-h][1-8])/gi;

export function parseChessTriggers(text) {
  const src = String(text ?? "");
  const low = src.toLowerCase();
  const wantsStart = /\bplay\s+chess\b/i.test(src);
  const wantsForfeit = /\bknock\s+over\s+the\s+board\b/i.test(src) || /\bforfeit\b/i.test(src);
  const moves = [];
  if (!src) return { wantsStart, wantsForfeit, moves };
  MOVE_RE.lastIndex = 0;
  let m;
  while ((m = MOVE_RE.exec(src)) !== null) {
    moves.push({ from: m[1].toLowerCase(), to: m[2].toLowerCase() });
    if (moves.length >= 4) break;
  }
  MOVE_RE.lastIndex = 0;
  void low;
  return { wantsStart, wantsForfeit, moves };
}

export function chessBlocks(st, lastNote) {
  const s = normalizeChess(st);
  if (!s.active && !s.moves.length && !lastNote) return [];
  const status = gameStatus(s);
  const last = s.moves.length ? s.moves[s.moves.length - 1] : null;
  const lines = [
    "[Chess - authoritative board. The engine owns the rules; roleplay the position, do not invent moves.]",
    `FEN: ${toFEN(s)}`,
    `Turn: ${s.turn === "w" ? "White (user)" : "Black (you as the character)"}${status.inCheck ? " - CHECK" : ""}`
  ];
  if (last) lines.push(`Last move: ${last.from.toUpperCase()} to ${last.to.toUpperCase()} by ${last.by === "w" ? "user" : "you"}${last.captured ? ` capturing ${last.captured}` : ""}.`);
  if (lastNote) lines.push(`Note: ${lastNote}`);
  if (!s.active && s.winner) {
    lines.push(s.winner === "draw" ? `Game over: draw (${s.reason}).` : `Game over: ${s.winner === "w" ? "user (White)" : "you (Black)"} wins (${s.reason}).`);
  } else if (s.active) {
    lines.push("You play Black. After the user moves, describe your reply move in character without breaking the game state.");
  }
  return [{ role: "system", content: lines.join("\n") }];
}

// Combined prompt blocks for every enabled stage, in stable order.
export function buildStageBlocks({ toggles, directorImmediate, directorPersistent, diceRolls, diceWho, worldState, chessState, chessNote }) {
  const t = normalizeToggles(toggles);
  const out = [];
  if (t.director) out.push(...directorBlocks(directorImmediate, directorPersistent));
  if (t.dice) out.push(...diceBlocks(diceRolls, diceWho));
  if (t.world) out.push(...worldBlocks(worldState));
  if (t.chess) out.push(...chessBlocks(chessState, chessNote));
  return out;
}
