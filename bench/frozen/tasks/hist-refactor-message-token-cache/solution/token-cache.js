// Canned solution: the per-message token cache from c4f9c56 (perf
// (context): per-message token cache — O(1) history sizing instead of
// O(n) re-tokenization per turn), ported from src/context.ts. Each message
// is tokenized once; the WeakMap keys on the message OBJECT, so the cache
// is GC-safe and never serialized. Mutation sites must invalidate —
// shrinkOldToolOutputs does, in exactly the place the commit adds it.
let tokenizeCount = 0;
function approxTokens(text) {
  tokenizeCount++;
  return Math.ceil(text.length / 4);
}
function tokenizeCalls() { return tokenizeCount; }
function resetTokenizeCalls() { tokenizeCount = 0; }

// Per-message token-count cache. Sizing walks the ENTIRE history every
// turn and used to JSON.stringify + approxTokens each message each turn —
// O(n) serialization+tokenization per turn. With this cache each message
// is tokenized once.
const messageTokenCache = new WeakMap();
function cachedMessageTokens(m) {
  const hit = messageTokenCache.get(m);
  if (hit !== undefined) return hit;
  const n = approxTokens(JSON.stringify(m));
  messageTokenCache.set(m, n);
  return n;
}
/** Invalidate a message's cached token count after its content mutates
 *  (shrinkOldToolOutputs / condenseOutput rewrite tool results in place). */
function invalidateMessageTokens(m) {
  messageTokenCache.delete(m);
}

/** Total estimated tokens of the conversation history. */
function estimateHistoryTokens(messages) {
  let sum = 0;
  for (const m of messages) sum += cachedMessageTokens(m);
  return sum;
}

const RECENT_WINDOW = 12;      // never touch the newest ~6 turns
const SHRINK_THRESHOLD = 600;  // chars: outputs below this are already cheap
const KEEP_HEAD = 240;
const KEEP_TAIL = 160;
const MARK = '\n[…earlier tool output truncated in place to save context; re-run the tool if you need the full text…]';

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
    invalidateMessageTokens(m); // content mutated: drop cached token count
  }
  return Math.floor(saved / 3.8);
}

module.exports = { approxTokens, estimateHistoryTokens, shrinkOldToolOutputs, cachedMessageTokens, invalidateMessageTokens, tokenizeCalls, resetTokenizeCalls, MARK };
