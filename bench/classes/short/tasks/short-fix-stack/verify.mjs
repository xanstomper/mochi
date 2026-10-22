// Class fixture verifier for short-fix-stack. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { Stack } = require('./stack.js');
const s = new Stack();
eq(s.isEmpty(), true, 'starts empty');
s.push(1); s.push(2); s.push(3);
eq(s.size, 3, 'size after pushes');
eq(s.peek(), 3, 'peek shows top');
eq(s.size, 3, 'peek does not mutate');
eq(s.peek(), 3, 'peek is repeatable');
eq(s.pop(), 3, 'pop returns top');
eq(s.pop(), 2, 'pop order');
eq(s.peek(), 1, 'peek after pops');
eq(s.pop(), 1, 'last pop');
eq(s.isEmpty(), true, 'empty at end');
eq(s.pop(), undefined, 'pop on empty');
eq(s.peek(), undefined, 'peek on empty');
console.log('PASS: stack contract holds');
