// Frozen verifier for hist-fix-dashboard-token-leak.
// Derived from git commit 55db719 (fix(daemon): stop leaking the bearer token
// via the dashboard, scope CORS to localhost) and its regression tests in
// src/daemon/daemon-dashboard-auth.test.ts — including its distinctive
// marker-token rule: any appearance of the real token in a response meant for
// an unauthenticated requester is the leak regressing.
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let mod;
try {
  mod = require('./dashboard-auth.js');
} catch (e) {
  console.log(`FAIL: dashboard-auth.js does not load (${e.message})`);
  process.exit(1);
}
const { dashboardResponseToken, corsAllowOrigin, isLocalhostOrigin, corsHeadersForOrigin } = mod;

const REAL_TOKEN = '<redacted>';
const fails = [];
const eq = (label, got, want) => { if (got !== want) fails.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

// Token embedding: the fix commit's own helper assertions.
eq('no token, not proven', dashboardResponseToken('', false, REAL_TOKEN), '');
eq('wrong guess, not proven', dashboardResponseToken('wrong-guess', false, REAL_TOKEN), '');
eq('no token, proven via other channel is still not possession', dashboardResponseToken('', false, REAL_TOKEN), '');
eq('proven possession embeds the token', dashboardResponseToken(REAL_TOKEN, true, REAL_TOKEN), REAL_TOKEN);
if (typeof dashboardResponseToken('anything', false, REAL_TOKEN) === 'string' && dashboardResponseToken('anything', false, REAL_TOKEN).includes(REAL_TOKEN)) {
  fails.push('unauthenticated response embeds the real token (the leak)');
}

// CORS: localhost origins reflected, everything else gets no grant.
if (typeof isLocalhostOrigin !== 'function') fails.push('isLocalhostOrigin not exported');
if (typeof corsHeadersForOrigin !== 'function') fails.push('corsHeadersForOrigin not exported');
if (fails.length === 0) {
  eq('localhost origin', isLocalhostOrigin('http://localhost:1234'), true);
  eq('127.0.0.1 origin', isLocalhostOrigin('http://127.0.0.1:8080'), true);
  eq('[::1] origin', isLocalhostOrigin('http://[::1]:3000'), true);
  eq('external origin', isLocalhostOrigin('https://evil.example.com'), false);
  eq('missing origin', isLocalhostOrigin(undefined), false);
  eq('malformed origin', isLocalhostOrigin('not a url'), false);
  eq('non-http scheme', isLocalhostOrigin('ftp://localhost/x'), false);
  eq('localhost reflected', corsAllowOrigin('http://localhost:9999'), 'http://localhost:9999');
  eq('external origin gets no grant', corsAllowOrigin('https://evil.example.com'), null);
  eq('wildcard never returned', corsAllowOrigin('http://localhost:1') === '*', false);
  const h = corsHeadersForOrigin('https://evil.example.com');
  if (h && Object.keys(h).length !== 0) fails.push('corsHeadersForOrigin grants headers to an external origin');
}

if (fails.length === 0) {
  console.log('PASS: real token embedded only on proven possession; CORS reflects loopback origins only, never the wildcard');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
