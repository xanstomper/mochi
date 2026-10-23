// Class fixture verifier for med-feature-rate-limit. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { createRouter } = require('./http/router.js');
let t = 0;
const router = createRouter({ now: () => t });
const api = () => router.dispatch('GET', '/api/data');
eq(api().status, 200, 'burst 1');
eq(api().status, 200, 'burst 2');
eq(api().status, 200, 'burst 3');
const denied = api();
eq(denied.status, 429, 'fourth rapid request is limited');
eq(denied.headers['retry-after'], '1', 'retry-after is 1s');
eq(denied.body, { error: 'rate limited' }, 'denied body');
t += 500;
eq(api().status, 429, 'half a token is not enough');
t += 500;
eq(api().status, 200, 'one full second refills one token');
// /health is never limited.
for (let i = 0; i < 10; i++) eq(router.dispatch('GET', '/health').status, 200, `health ${i} exempt`);
// Idle time cannot bank more than capacity.
t += 60 * 1000;
eq(api().status, 200, 'after idle 1');
eq(api().status, 200, 'after idle 2');
eq(api().status, 200, 'after idle 3');
eq(api().status, 429, 'capacity caps the banked burst');
eq(router.dispatch('GET', '/nope').status, 404, 'unknown route still 404');
console.log('PASS: rate limiting behaves per spec');
