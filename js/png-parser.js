/* Polyglot png-parser — character card ingestion, zero dependencies.
   - PNG chunk walker: signature + length/type/data/CRC walk, CRC not enforced.
   - tEXt: keyword "chara" (V2) or "ccv3" (V3), Latin-1 value = base64 JSON.
   - zTXt: keyword + null + method(0) + zlib stream → decompress with
     DecompressionStream('deflate') → base64 JSON.
   - iTXt: keyword + null + compFlag + method + lang + translated-key + text;
     decompresses when flagged, UTF-8 text expected to be base64 JSON.
   - fileToAvatarDataURL: canvas shrink to 512 max, webp 0.82 with jpeg
     fallback (iOS Safari silently returns PNG when webp encode is missing).
   Browser-only parts (canvas) are isolated; parsePNGCard works anywhere. */

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function latin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function splitNull(bytes) {
  const i = bytes.indexOf(0);
  if (i === -1) return [bytes, new Uint8Array(0)];
  return [bytes.slice(0, i), bytes.slice(i + 1)];
}

function b64ToBytes(b64) {
  const clean = String(b64 ?? "").replace(/\s+/g, "");
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function decodeB64JSON(b64) {
  const bytes = b64ToBytes(b64);
  const text = new TextDecoder("utf-8").decode(bytes);
  return JSON.parse(text);
}

async function inflateZlib(data) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("E_ZLIB_UNSUPPORTED: zTXt/iTXt card needs zlib decompression, unsupported in this browser.");
  }
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([data]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

function walkChunks(u8) {
  // Returns [{type, data:Uint8Array}] in file order. Throws on truncation.
  for (let i = 0; i < PNG_SIG.length; i++) {
    if (u8[i] !== PNG_SIG[i]) throw new Error("E_PNG_SIG: not a PNG file (bad signature).");
  }
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const chunks = [];
  let pos = 8;
  for (;;) {
    if (pos + 8 > u8.length) throw new Error("E_PNG_TRUNC: truncated PNG (chunk header).");
    const len = view.getUint32(pos);
    const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
    if (pos + 12 + len > u8.length) throw new Error(`E_PNG_TRUNC: truncated PNG (chunk ${type}).`);
    chunks.push({ type, data: u8.slice(pos + 8, pos + 8 + len) });
    pos += 12 + len;
    if (type === "IEND") break;
    if (chunks.length > 500) throw new Error("E_PNG_MANY: PNG has too many chunks.");
  }
  return chunks;
}

async function textFromChunk(type, data) {
  // Returns {keyword, text} or null when the chunk carries no card payload.
  if (type === "tEXt") {
    const [kwB, valB] = splitNull(data);
    const keyword = latin1(kwB);
    if (keyword !== "chara" && keyword !== "ccv3") return null;
    return { keyword, text: latin1(valB) };
  }
  if (type === "zTXt") {
    const [kwB, rest] = splitNull(data);
    const keyword = latin1(kwB);
    if (keyword !== "chara" && keyword !== "ccv3") return null;
    if (rest.length < 1 || rest[0] !== 0) throw new Error("E_ZLIB_METHOD: unsupported zTXt compression method.");
    const raw = await inflateZlib(rest.slice(1));
    // Decompressed payload may be raw JSON or base64 JSON — accept both.
    const asText = new TextDecoder("utf-8").decode(raw);
    return { keyword, text: asText, maybeRaw: true };
  }
  if (type === "iTXt") {
    let p = 0;
    const nul = (from) => {
      const i = data.indexOf(0, from);
      if (i === -1) throw new Error("E_ITXT_MALFORMED: malformed iTXt chunk.");
      return i;
    };
    const kEnd = nul(0);
    const keyword = latin1(data.slice(0, kEnd));
    if (keyword !== "chara" && keyword !== "ccv3") return null;
    p = kEnd + 1;
    if (p + 2 > data.length) throw new Error("E_ITXT_MALFORMED: truncated iTXt header.");
    const compFlag = data[p];
    const compMethod = data[p + 1];
    p += 2;
    const langEnd = nul(p);
    p = langEnd + 1;
    const transEnd = nul(p);
    p = transEnd + 1;
    let payload = data.slice(p);
    if (compFlag === 1) {
      if (compMethod !== 0) throw new Error("E_ZLIB_METHOD: unsupported iTXt compression method.");
      payload = await inflateZlib(payload);
    }
    return { keyword, text: new TextDecoder("utf-8").decode(payload), maybeRaw: true };
  }
  return null;
}

function parsePayloadText(text, maybeRaw) {
  const t = String(text ?? "").trim();
  if (!t) throw new Error("E_CARD_EMPTY: card chunk is empty.");
  try {
    if (maybeRaw && (t.startsWith("{") || t.startsWith("["))) return JSON.parse(t);
    return decodeB64JSON(t);
  } catch (e) {
    throw new Error(`E_CARD_JSON: embedded card text is not valid JSON/base64 (${e.message}).`);
  }
}

// Extract raw card JSON from PNG bytes. Prefers ccv3 (V3) over chara (V2)
// when both are present.
export async function parsePNGCard(arrayBuffer) {
  const u8 = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  const chunks = walkChunks(u8);
  let v2 = null;
  let v3 = null;
  for (const c of chunks) {
    if (c.type !== "tEXt" && c.type !== "zTXt" && c.type !== "iTXt") continue;
    const got = await textFromChunk(c.type, c.data);
    if (!got) continue;
    const parsed = parsePayloadText(got.text, got.maybeRaw);
    if (got.keyword === "ccv3") {
      v3 = parsed;
      break; // V3 wins immediately
    }
    if (!v2) v2 = parsed;
  }
  if (v3) return { data: v3, kind: "ccv3" };
  if (v2) return { data: v2, kind: "chara" };
  throw new Error("E_CARD_NONE: no character data found (missing chara/ccv3 chunk).");
}

export function parseCharacterJSON(text) {
  let j;
  try {
    j = JSON.parse(String(text ?? ""));
  } catch (e) {
    throw new Error(`E_CARD_JSON: file is not valid JSON (${e.message}).`);
  }
  // Accept raw V2, {data:{...}} exports, and TavernAI card {spec, data} shape.
  const data = j?.data && typeof j.data === "object" && (j.data.name || j.spec) ? j.data : j;
  return { data, kind: data === j ? "json" : "card-json" };
}

function loreEntriesFromBook(book) {
  if (!book || !Array.isArray(book.entries)) return [];
  return book.entries.map((e, i) => ({
    keys: e.keys || e.keywords || e.key || [],
    content: e.content || e.entry || "",
    enabled: e.enabled !== false,
    insertion_order: e.insertion_order ?? e.order ?? i
  })).filter((e) => e.content);
}

// Map V2/V3 card JSON to a Polyglot character record + lorebook entries.
export function normalizeCharacter(data) {
  const d = data?.data && typeof data.data === "object" && data.data.name ? data.data : data;
  const rec = {
    name: String(d.name || d.char_name || "Imported").slice(0, 80),
    description: String(d.description || d.char_persona || ""),
    personality: String(d.personality || ""),
    scenario: String(d.scenario || ""),
    first_mes: String(d.first_mes || d.char_greeting || ""),
    mes_example: String(d.mes_example || d.char_example || "")
  };
  const book = d.character_book || d.char_book || null;
  return { character: rec, loreEntries: loreEntriesFromBook(book) };
}

// Shrink an image file to a small data URL for IndexedDB. Browser-only.
export async function fileToAvatarDataURL(file, maxDim = 512) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
  if (typeof bmp.close === "function") bmp.close();
  let url = "";
  try {
    url = canvas.toDataURL("image/webp", 0.82);
  } catch {
    url = "";
  }
  // iOS Safari cannot encode webp: it silently returns PNG. Fall back to jpeg.
  if (!url || (url.startsWith("data:image/png") && canvas.toDataURL("image/webp").startsWith("data:image/png"))) {
    try {
      url = canvas.toDataURL("image/jpeg", 0.82);
    } catch {
      url = canvas.toDataURL("image/png");
    }
  }
  return url;
}
