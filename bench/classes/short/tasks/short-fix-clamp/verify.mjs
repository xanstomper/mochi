// Class fixture verifier for short-fix-clamp. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { clamp } = require('./clamp.js');
eq(clamp(15, 0, 10), 10, 'above range');
eq(clamp(-3, 0, 10), 0, 'below range');
eq(clamp(5, 0, 10), 5, 'inside range');
eq(clamp(2, 3, 8), 3, 'below offset range');
eq(clamp(9, 3, 8), 8, 'above offset range');
eq(clamp(0, 0, 0), 0, 'degenerate range');
eq(clamp(-5, -10, -1), -5, 'negative range inside');
eq(clamp(7.5, 0, 10), 7.5, 'fractional inside');
console.log('PASS: clamp contract holds');
