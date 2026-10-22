// Frozen-task fixture: history token sizing + in-place tool-output
// shrinking from src/context.ts as of c4f9c56^ (the parent of the
// per-message token-cache restructure), reduced to those two operations
// over a plain messages array.
//
// THE PROBLEM THIS STATE HAS: estimateHistoryTokens walks the ENTIRE
// history and JSON.stringify + tokenizes EVERY message on EVERY call —
// and sizing runs every turn (buildPacket, compaction checks), so a long
// session pays O(history) serialization+tokenization per turn, O(n^2)
// over the session, for numbers that almost never change.
//
// approxTokens is ported from src/context.ts: the native Rust counter
// when available, else ~4 chars/token. This fixture has no native core,
// so the deterministic fallback runs; tokenizeCalls() instruments how many
// times the tokenizer actually runs (the cost the restructure removes).

let tokenizeCount = 0;
function approxTokens(text) {
  tokenizeCount++;
  return Math.ceil(text.length / 4);
}
function tokenizeCalls() { return tokenizeCount; }
function resetTokenizeCalls() { tokenizeCount = 0; }

/** Total estimated tokens of the conversation history. */
function estimateHistoryTokens(messages) {
  let sum = 0;
  for (const m of messages) sum += approxTokens(JSON.stringify(m));
  return sum;
}

const RECENT_WINDOW = 12;      // never touch the newest ~6 turns
const SHRINK_THRESHOLD = 600;  // chars: outputs below this are already cheap
const KEEP_HEAD = 240;
const KEEP_TAIL = 160;
const MARK = '\n[…earlier tool output truncated in place to save context; re-run the tool if you need the full text…]';

/**
 * Shrink OLD tool outputs IN PLACE: cap each old, large tool result to
 * head+MARK+tail, keeping the conversation structure. (The archive of the
 * full text the real method performs first is a storage side effect,
 * omitted here.) Returns the estimated tokens saved.
 */
function shrinkOldToolOutputs(messages) {
  let saved = 0;
  const end = Math.max(0, messages.length - RECENT_WINDOW);
  for (let i = 0; i < end; i++) {
    const m = messages[i];
    if (m.role !== 'tool') continue;
    const c = typeof m.content === 'string' ? m.content : '';
    if (c.length < SHRINK_THRESHOLD || c.includes(MARK)) continue;
    const shrunk = c.slice(0, KEEP_HEAD) + MARK + (c.length > KEEP_HEAD + KEEP_TAIL ? c.slice(-KEEP_TAIL) : '');
    saved += c.length - shrunk.length;
    m.content = shrunk;
  }
  return Math.floor(saved / 3.8);
}

module.exports = { approxTokens, estimateHistoryTokens, shrinkOldToolOutputs, tokenizeCalls, resetTokenizeCalls, MARK };
