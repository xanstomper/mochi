// Class fixture verifier for short-fix-groupby. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { groupBy } = require('./groupby.js');
eq(groupBy([1, 2, 3, 4], (x) => x % 2), { 0: [2, 4], 1: [1, 3] }, 'zero key kept');
eq(groupBy(['a', 'bb', 'c', 'dd'], (s) => s.length - 1), { 0: ['a', 'c'], 1: ['bb', 'dd'] }, 'length-minus-one keys');
eq(groupBy(['x', 'y'], () => ''), { '': ['x', 'y'] }, 'empty-string key kept');
eq(groupBy([true, false, true], (b) => b), { true: [true, true], false: [false] }, 'false key kept');
eq(groupBy([], (x) => x), {}, 'empty input');
console.log('PASS: groupBy keeps falsy keys');
