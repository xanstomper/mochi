// Class fixture verifier for med-fix-pagination. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { handleRequest } = require('./api/server.js');
const ids = (p) => handleRequest(`/items?page=${p}`).body.ids;
eq(ids(1), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'page 1');
eq(ids(2), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20], 'page 2');
eq(ids(3), [21, 22, 23, 24, 25], 'page 3 (partial)');
eq(ids(4), [], 'page 4 empty');
const walked = [1, 2, 3, 4].flatMap((p) => ids(p));
eq(walked, Array.from({ length: 25 }, (_, i) => i + 1), 'walk covers 1..25 with no gaps or duplicates');
eq(handleRequest('/items').body.ids, ids(1), 'default page is 1');
eq(handleRequest('/nope').status, 404, 'unknown path');
console.log('PASS: pagination contract holds end to end');
