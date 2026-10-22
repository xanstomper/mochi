// Canned solution: the two-lane 32-bit result hash from src/agent/loop.ts as
// of c3486a0 (refactor(loop): two-lane 32-bit FNV hash for tool results —
// BigInt hashing was hot-path overhead). The implementation below is the
// fix's own, verbatim apart from TypeScript types and the export.
// Two INDEPENDENT 32-bit FNV-1a lanes combined into a 64-bit key: lane 1 is
// plain FNV-1a over the code units; lane 2 is FNV-1a over ROTATED code units
// with a different offset basis and multiplier, so inputs that collide or
// correlate in one lane decorrelate in the other — an adjacent-transposition
// pair like 'ab'/'ba' hashes differently. Math.imul keeps all arithmetic in
// fast 32-bit integer ops (no BigInt).
function hashToolResult(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x1b873593;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193);
    const rot = ((ch << 9) | (ch >>> 7)) & 0xffff;
    h2 = Math.imul(h2 ^ rot, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16).padStart(8, '0');
}

module.exports = { hashToolResult };
