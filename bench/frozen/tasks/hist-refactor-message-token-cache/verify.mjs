// Frozen verifier for hist-refactor-message-token-cache.
// Derived from git commit c4f9c56 (perf(context): per-message token cache —
// O(1) history sizing instead of O(n) re-tokenization per turn). The frozen
// behavior is the commit's contract: identical estimates, each message
// tokenized ONCE across repeated sizings, and the in-place shrink path
// invalidating exactly the message it mutated (a cache without the
// invalidation the commit adds to shrinkOldToolOutputs returns stale
// totals — caught here by value, not just by count). Tokenizer invocations
// are counted deterministically via the fixture's instrumentation — this
// is an algorithmic check, not a timing benchmark.
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const mod = require('./token-cache.js');
const { estimateHistoryTokens, shrinkOldToolOutputs, tokenizeCalls, resetTokenizeCalls, MARK } = mod;

const fails = [];
const eq = (got, want, label) => { if (got !== want) fails.push(`${label}: got ${got}, want ${want}`); };

if (typeof mod.cachedMessageTokens !== 'function') fails.push('cachedMessageTokens is not exported');
if (typeof mod.invalidateMessageTokens !== 'function') fails.push('invalidateMessageTokens is not exported');

// A 16-message history: an OLD oversized tool result at index 1 (inside
// the shrink window), assorted turns, and a RECENT oversized tool result
// at index 14 (inside the protected recent window — must never shrink).
function buildHistory() {
  const msgs = [{ role: 'user', content: 'please debug the flaky test' }];
  msgs.push({ role: 'tool', name: 'shell', tool_call_id: 'c1', content: 'OLD-OUTPUT ' + 'x'.repeat(2000) });
  msgs.push({ role: 'assistant', content: 'looking at the failure', tool_calls: [{ id: 'c2', name: 'read' }] });
  msgs.push({ role: 'tool', name: 'read', tool_call_id: 'c2', content: 'short result' });
  for (let i = 0; i < 10; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ${'y'.repeat(40)}` });
  msgs.push({ role: 'tool', name: 'shell', tool_call_id: 'c9', content: 'RECENT-OUTPUT ' + 'z'.repeat(2000) });
  msgs.push({ role: 'assistant', content: 'wrapping up' });
  return msgs;
}
const naiveTotal = (msgs) => msgs.reduce((s, m) => s + Math.ceil(JSON.stringify(m).length / 4), 0);

const history = buildHistory();
eq(history.length, 16, 'fixture history size');

// 1. Estimates identical to the uncached computation.
resetTokenizeCalls();
eq(estimateHistoryTokens(history), naiveTotal(history), 'estimate equals naive per-message sum');
// 2. Each message tokenized exactly once on first sizing…
eq(tokenizeCalls(), 16, 'first sizing tokenizes each message once');
// …and NOTHING re-tokenizes on repeated sizings of an unchanged history.
for (let i = 0; i < 4; i++) estimateHistoryTokens(history);
eq(tokenizeCalls(), 16, 'repeated sizing of unchanged history re-tokenizes nothing');
eq(estimateHistoryTokens(history), naiveTotal(history), 'estimate still equals naive sum after repeats');

// 3. Appending one message tokenizes exactly that one.
history.push({ role: 'user', content: 'one more question' });
eq(estimateHistoryTokens(history), naiveTotal(history), 'estimate after append equals naive sum');
eq(tokenizeCalls(), 17, 'append tokenizes only the new message');

// 4. In-place shrink: same bytes as the uncached implementation, fresh
// totals afterwards, and exactly ONE re-tokenization (the shrunk message).
const beforeShrink = tokenizeCalls();
const saved = shrinkOldToolOutputs(history);
if (!(saved > 0)) fails.push(`shrink should report saved tokens, got ${saved}`);
if (!history[1].content.includes(MARK)) fails.push('old tool output was not shrunk in place (marker missing)');
if (history[1].content.length >= 2000) fails.push('old tool output did not get shorter');
if (history[14].content.includes(MARK)) fails.push('RECENT tool output must never be shrunk');
eq(estimateHistoryTokens(history), naiveTotal(history), 'estimate after shrink reflects the shrunk content (no stale cache)');
eq(tokenizeCalls() - beforeShrink, 1, 'shrink invalidates exactly the mutated message (one re-tokenization)');
// Shrinking again is a no-op (already-marked outputs are skipped).
eq(shrinkOldToolOutputs(history), 0, 'second shrink saves nothing');

// 5. The explicit invalidation contract: mutate + invalidate → fresh
// count for exactly that message.
if (typeof mod.invalidateMessageTokens === 'function') {
  const target = history[3];
  target.content = target.content + ' — appended evidence '.repeat(10);
  const beforeInv = tokenizeCalls();
  mod.invalidateMessageTokens(target);
  eq(estimateHistoryTokens(history), naiveTotal(history), 'estimate after mutate+invalidate equals naive sum');
  eq(tokenizeCalls() - beforeInv, 1, 'explicit invalidation re-tokenizes exactly one message');
}

if (fails.length === 0) {
  console.log('PASS: per-message token cache — identical estimates, tokenize-once across repeated sizings, shrink and explicit invalidation each re-tokenize exactly the mutated message');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
