/* Polyglot sse-streamer — chunk-safe OpenAI-style SSE decoder + <think> splitter.
   - TextDecoder('utf-8', {stream:true}) prevents multibyte corruption.
   - Handles <think>/</think> split across packets (partial-tag carry).
   - Routes provider reasoning_content deltas AND inline <think> text to reasoning.
   - Ignores SSE comments/keep-alives, stops at data: [DONE]. */

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const MAX_TAG_PREFIX = THINK_CLOSE.length - 1; // longest partial tag tail to hold

function isTagPrefix(s) {
  const t = s.toLowerCase();
  for (let i = 1; i <= MAX_TAG_PREFIX; i++) {
    const tail = t.slice(-i);
    if (THINK_OPEN.startsWith(tail) || THINK_CLOSE.startsWith(tail)) return i;
  }
  return 0;
}

// Splits streamed text into content vs reasoning on <think> boundaries.
export function createThinkSplitter(onContent, onReasoning) {
  let inThink = false;
  let carry = "";
  const emitContent = (s) => s && onContent && onContent(s);
  const emitReasoning = (s) => s && onReasoning && onReasoning(s);

  function push(chunk) {
    let buf = carry + String(chunk ?? "");
    carry = "";
    for (;;) {
      if (!inThink) {
        const idx = buf.toLowerCase().indexOf(THINK_OPEN);
        if (idx === -1) {
          const hold = isTagPrefix(buf);
          if (hold > 0 && buf.length <= 32) {
            carry = buf.slice(-hold);
            emitContent(buf.slice(0, -hold));
          } else {
            emitContent(buf);
          }
          return;
        }
        emitContent(buf.slice(0, idx));
        buf = buf.slice(idx + THINK_OPEN.length);
        inThink = true;
      } else {
        const idx = buf.toLowerCase().indexOf(THINK_CLOSE);
        if (idx === -1) {
          const hold = isTagPrefix(buf);
          if (hold > 0) {
            carry = buf.slice(-hold);
            emitReasoning(buf.slice(0, -hold));
          } else {
            emitReasoning(buf);
          }
          return;
        }
        emitReasoning(buf.slice(0, idx));
        buf = buf.slice(idx + THINK_CLOSE.length);
        inThink = false;
      }
    }
  }

  function flush() {
    if (carry) {
      if (inThink) emitReasoning(carry);
      else emitContent(carry);
      carry = "";
    }
  }

  return { push, flush, get inThink() { return inThink; } };
}

function extractDeltaText(payload) {
  // Returns {content, reasoning} from an OpenAI-style chunk payload.
  let content = "";
  let reasoning = "";
  const choices = payload?.choices;
  if (Array.isArray(choices)) {
    for (const ch of choices) {
      const d = ch?.delta || {};
      if (typeof d.content === "string") content += d.content;
      if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
      if (typeof d.reasoning === "string") reasoning += d.reasoning;
      // Some gateways put full text outside delta on first chunk.
      if (typeof ch?.message?.content === "string") content += ch.message.content;
    }
  } else if (typeof payload?.content === "string") {
    content += payload.content;
  }
  // Anthropic-style message chunks: {delta:{type:"text_delta",text}}
  const ev = payload?.delta;
  if (ev && typeof ev.text === "string") content += ev.text;
  if (ev && typeof ev.thinking === "string") reasoning += ev.thinking;
  return { content, reasoning };
}

// Consume a fetch Response with an SSE body. Resolves {content, reasoning}.
export async function streamSSE(response, { onContent, onReasoning, signal } = {}) {
  if (!response.body) {
    const text = await response.text();
    const splitter = createThinkSplitter(onContent, onReasoning);
    let reasoning = "";
    try {
      const data = JSON.parse(text);
      const got = extractDeltaText(data);
      splitter.push(got.content);
      if (got.reasoning) {
        reasoning += got.reasoning;
        if (onReasoning) onReasoning(got.reasoning);
      }
    } catch {
      splitter.push(text);
    }
    splitter.flush();
    // Caller accumulates via callbacks; return empty marker for non-stream path.
    return { content: "", reasoning, nonStream: true, raw: text };
  }

  const decoder = new TextDecoder("utf-8", { stream: true });
  const reader = response.body.getReader();
  const splitter = createThinkSplitter(onContent, onReasoning);
  let buf = "";
  let done = false;

  const abort = () => {
    done = true;
    try { reader.cancel(); } catch { /* already closed */ }
  };
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }

  try {
    for (;;) {
      const { value, done: readerDone } = await reader.read();
      if (done && readerDone !== false) break;
      if (value) buf += decoder.decode(value, { stream: true });
      if (readerDone) break;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(":")) continue;
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") {
          done = true;
          break;
        }
        try {
          const payload = JSON.parse(data);
          const { content, reasoning } = extractDeltaText(payload);
          if (content) splitter.push(content);
          if (reasoning && onReasoning) onReasoning(reasoning);
        } catch {
          /* Partial JSON on some proxies — skip the line, keep streaming. */
        }
      }
      if (done) break;
    }
    buf += decoder.decode();
    const rest = buf.trim();
    if (rest && rest !== "[DONE]") {
      if (rest.startsWith("data:")) {
        try {
          const payload = JSON.parse(rest.slice(5).trim());
          const { content, reasoning } = extractDeltaText(payload);
          if (content) splitter.push(content);
          if (reasoning && onReasoning) onReasoning(reasoning);
        } catch { /* ignore trailer */ }
      } else {
        splitter.push(rest);
      }
    }
  } finally {
    splitter.flush();
    if (signal) signal.removeEventListener("abort", abort);
    try { reader.releaseLock(); } catch { /* noop */ }
  }
  return { content: "", reasoning: "" };
}
