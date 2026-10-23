// Class fixture verifier for med-fix-session-expiry. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { SessionStore } = require('./session/store.js');
const { isAuthenticated } = require('./session/middleware.js');
const MIN = 60 * 1000;
let t = 1_000_000;
const store = new SessionStore(() => t);
const id = store.create('user-1');
eq(isAuthenticated(store, id), true, 'fresh session is valid');
// Stay active every 10 minutes for 50 minutes.
for (let i = 0; i < 5; i++) { t += 10 * MIN; store.touch(id); }
eq(store.get(id).lastSeenAt, t, 'touch records last-seen activity');
t = 1_000_000 + 29 * MIN;
eq(isAuthenticated(store, id), true, 'still valid at 29 minutes');
t = 1_000_000 + 31 * MIN;
eq(isAuthenticated(store, id), false, 'expired at 31 minutes despite constant activity');
eq(isAuthenticated(store, 'sess-999'), false, 'unknown session is not authenticated');
console.log('PASS: absolute expiry holds under activity');
