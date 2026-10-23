// Class fixture verifier for short-fix-retry. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { retry } = require('./retry.js');
let calls = 0;
const alwaysFail = async () => { calls += 1; throw new Error(`fail ${calls}`); };
let thrown = null;
try { await retry(alwaysFail, 3); } catch (e) { thrown = e; }
eq(calls, 3, 'exactly `attempts` total calls');
eq(thrown && thrown.message, 'fail 3', 'rethrows the LAST error');
calls = 0;
const failOnce = async () => { calls += 1; if (calls < 2) throw new Error('boom'); return 'ok'; };
eq(await retry(failOnce, 3), 'ok', 'returns on first success');
eq(calls, 2, 'stops after success');
calls = 0;
try { await retry(alwaysFail, 1); } catch { /* expected */ }
eq(calls, 1, 'attempts=1 means a single call');
console.log('PASS: retry call budget holds');
