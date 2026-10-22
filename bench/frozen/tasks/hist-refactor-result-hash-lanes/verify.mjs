// Frozen verifier for hist-refactor-result-hash-lanes.
// Derived from git commit c3486a0 (refactor(loop): two-lane 32-bit FNV hash
// for tool results). Because the commit changes the hash ALGORITHM itself,
// the contract pins the new algorithm's known answers (computed from the
// algorithm the commit specifies) plus the behavioral contract from
// src/agent/loop tests: deterministic, distinct for distinct outputs —
// including the adjacent-transposition pair the second lane exists for.
// Speed bound (median of 15 hashes of a 48K-char string < 1.5 ms) was
// calibrated on the build machine: the two-lane hash measures ~0.12 ms
// median there; the parent BigInt hash measures ~3.8 ms — the bound sits
// >10x above the target implementation and >2x below the parent, so it
// discriminates by algorithm, not by machine noise.
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hashToolResult } = require('./result-hash.js');

const fails = [];

// Known answers for the two-lane construction.
const KNOWN = [
  ['', '811c9dc51b873593'],
  ['a', 'e40c292c6e1f7871'],
  ['ab', '4d2505cac2afed3b'],
  ['ba', '3c2ba6cc7752153b'],
  ['hello world', 'd58b3fa7df96b709'],
  ['function sum(arr){ let s=0;}', 'e36abf046f8f3f03'],
  ['résumé — ünïcode ✓', '14711f71afc38fed'],
];
for (const [input, want] of KNOWN) {
  const got = hashToolResult(input);
  if (got !== want) fails.push(`hash(${JSON.stringify(input.slice(0, 24))}) = ${got}, want ${want}`);
}

// Determinism.
if (hashToolResult('repeat me') !== hashToolResult('repeat me')) fails.push('not deterministic');

// Distinctness battery.
const samples = ['', 'a', 'b', 'ab', 'ba', 'aa', 'aab', 'aba', 'baa', '{"ok":true}', '{"ok":false}', 'Error: x', 'Error: y', 'line1\nline2', 'line2\nline1', 'x'.repeat(500), 'x'.repeat(501)];
const seen = new Map();
for (const s of samples) {
  const k = hashToolResult(s);
  if (seen.has(k)) fails.push(`collision between ${JSON.stringify(seen.get(k).slice(0, 20))}… and ${JSON.stringify(s.slice(0, 20))}…`);
  seen.set(k, s);
}

// Speed: median of 15 hashes over a ~48K-char output must be < 1.5 ms.
const big = Array.from({ length: 3000 }, (_, i) => `line ${i}: some tool output content here`).join('\n');
const times = [];
for (let i = 0; i < 15; i++) {
  const t0 = performance.now();
  hashToolResult(big);
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const median = times[Math.floor(times.length / 2)];
if (median >= 1.5) fails.push(`too slow: median ${median.toFixed(2)} ms per 48K-char hash (bound 1.5 ms; BigInt parent measures ~3.8 ms on the calibration machine)`);

if (fails.length === 0) {
  console.log(`PASS: two-lane hash matches known answers, deterministic, collision-free on the battery, median ${median.toFixed(2)} ms per 48K-char hash`);
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
