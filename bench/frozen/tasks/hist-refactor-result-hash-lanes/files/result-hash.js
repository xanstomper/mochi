// Frozen-task fixture: the tool-result content hash from src/agent/loop.ts
// as of c3486a0^ (the parent of the hash-speed refactor), verbatim apart from
// TypeScript types and the CommonJS export. The loop hashes every tool
// result to detect repeated identical outputs (a stuck-loop signal); the
// parent hash is 64-bit FNV-1a computed with BigInt arithmetic — exact, but
// BigInt ops are slow enough that hashing every result shows up on the hot
// path of output-heavy runs.
function hashToolResult(text) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16);
}

module.exports = { hashToolResult };
