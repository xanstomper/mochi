// Class fixture verifier for short-feature-format-bytes. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { formatBytes } = require('./format.js');
const cases = [
  [0, '0 B'], [1, '1 B'], [512, '512 B'], [1023, '1023 B'],
  [1024, '1 KiB'], [1536, '1.5 KiB'], [2048, '2 KiB'],
  [1048576, '1 MiB'], [2621440, '2.5 MiB'], [1153433, '1.1 MiB'],
  [1073741824, '1 GiB'], [1099511627776, '1 TiB'],
];
for (const [n, want] of cases) eq(formatBytes(n), want, `formatBytes(${n})`);
console.log('PASS: formatBytes matches spec');
