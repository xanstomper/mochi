// Class fixture verifier for med-feature-config-precedence. Runs with cwd = the task workdir.
// Exit 0 = pass, 1 = fail. Node builtins only; deterministic; no network.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fail = (msg) => { console.log(`FAIL: ${msg}`); process.exit(1); };
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) fail(`${label}: expected ${e}, got ${a}`);
};
const { loadConfig } = require('./config/load.js');
eq(loadConfig(), { port: 8080, host: 'localhost', debug: false, workers: 2 }, 'defaults only');
eq(loadConfig({ file: { port: 3000 } }).port, 3000, 'file beats default');
eq(loadConfig({ file: { port: 3000 }, env: { APP_PORT: '9090' } }).port, 9090, 'env beats file, coerced to number');
eq(loadConfig({ env: { APP_DEBUG: 'true' } }).debug, true, 'boolean coercion');
eq(loadConfig({ env: { APP_DEBUG: 'false' } }).debug, false, 'boolean false coercion');
eq(loadConfig({ env: { APP_HOST: 'example.internal' } }).host, 'example.internal', 'string passthrough');
const withUnknown = loadConfig({ file: { nope: 1 }, env: { APP_NOPE: 'x' } });
eq('nope' in withUnknown, false, 'unknown keys are ignored');
let msg = null;
try { loadConfig({ env: { APP_WORKERS: 'abc' } }); } catch (e) { msg = e.message; }
eq(typeof msg === 'string' && msg.includes('workers'), true, 'bad number throws naming the key');
msg = null;
try { loadConfig({ env: { APP_DEBUG: 'yes' } }); } catch (e) { msg = e.message; }
eq(typeof msg === 'string' && msg.includes('debug'), true, 'bad boolean throws naming the key');
console.log('PASS: config precedence and coercion hold');
