// Class fixture verifier for short-fix-debounce. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { debounce } = require('./debounce.js');
// Deterministic fake scheduler.
let now = 0; let nextId = 1; const timers = new Map();
const scheduler = {
  setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
  clearTimeout: (id) => { timers.delete(id); },
};
const advance = (ms) => {
  now += ms;
  for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
    if (t.at <= now) { timers.delete(id); t.fn(); }
  }
};
const calls = [];
const d = debounce((x) => calls.push(x), 100, scheduler);
d('a'); d('b'); d('c');
advance(99);
eq(calls, [], 'not fired before wait elapses after last call');
advance(1);
eq(calls, ['c'], 'fired once with last args');
d('d');
advance(100);
eq(calls, ['c', 'd'], 'fires again for a later burst');
console.log('PASS: debounce fires once, trailing edge, last args');
