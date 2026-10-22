// Frozen verifier for hist-feat-plan-network-reads.
// Derived from git commit 0792f0f (feat(agent): plan-mode network-read
// allowlist — declared dev hosts only, exact-host match) and its pin tests
// 61ad39e (test(plan): pin suffix/substring fail-closed semantics) and
// 850fab4 (test(plan): port exact-host + veto-counter pins). Runs with
// cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decidePlanBatch } = require('./plan-gate.js');

const fails = [];
const call = (id, name, args) => ({ id, name, arguments: args });
const post = (id, url, name = 'fetch') => call(id, name, { url, method: 'POST', allow_private: true });
const cfg = (hosts) => ({ safety: { planModeNetworkReads: hosts } });

function expectBatch(label, calls, config, wantRun, wantVetoed, wantCounted) {
  const got = decidePlanBatch(calls, config);
  const j = (a) => a.join(',');
  if (j(got.runIds) !== j(wantRun)) fails.push(`${label}: runIds got [${j(got.runIds)}], want [${j(wantRun)}]`);
  if (j(got.vetoedIds) !== j(wantVetoed)) fails.push(`${label}: vetoedIds got [${j(got.vetoedIds)}], want [${j(wantVetoed)}]`);
  if (got.vetoCounted !== wantCounted) fails.push(`${label}: vetoCounted got ${got.vetoCounted}, want ${wantCounted}`);
  const all = [...got.runIds, ...got.vetoedIds].sort();
  const ids = calls.map((c) => c.id).sort();
  if (j(all) !== j(ids)) fails.push(`${label}: every call id must be answered exactly once`);
}

// Declared host: a POST executes in plan mode.
expectBatch('declared host POST runs',
  [post('a', 'http://localhost:8080/graphql')], cfg(['localhost']),
  ['a'], [], false);
// No declaration: the same POST is vetoed and counts.
expectBatch('empty allowlist vetoes',
  [post('a', 'http://localhost:8080/graphql')], cfg([]),
  [], ['a'], true);
// Absent config key behaves like an empty list.
expectBatch('absent allowlist vetoes',
  [post('a', 'http://localhost:8080/graphql')], {},
  [], ['a'], true);
// FAIL CLOSED on suffix: 'ost' is a suffix of 'localhost' — substring
// matching would bless every host ENDING in a declared string.
expectBatch('suffix of declared host does not match',
  [post('a', 'http://localhost/x')], cfg(['ost']),
  [], ['a'], true);
// FAIL CLOSED on superstring: declaring 'localhost.evil.com' must not
// bless 'localhost' (the declared string CONTAINS the host).
expectBatch('superstring declaration does not match',
  [post('a', 'http://localhost/x')], cfg(['localhost.evil.com']),
  [], ['a'], true);
// Case-insensitive both ways.
expectBatch('case-insensitive declaration matches',
  [post('a', 'http://LOCALHOST:8080/x')], cfg(['LocalHost']),
  ['a'], [], false);
// NO subdomain extension: declaring a parent domain must not silently
// extend trust to every subdomain's side-effect profile.
expectBatch('subdomain is not exempted by parent declaration',
  [post('a', 'https://api.example.com/x')], cfg(['example.com']),
  [], ['a'], true);
// PUT is a mutating method too — exempted on a declared host.
expectBatch('PUT to declared host runs',
  [call('a', 'fetch', { url: 'http://dev.internal:9000/api', method: 'PUT' })], cfg(['dev.internal']),
  ['a'], [], false);
// Alias spelling of fetch canonicalizes before the exemption check.
expectBatch('web_fetch alias to declared host runs',
  [post('a', 'http://localhost:8080/graphql', 'web_fetch')], cfg(['localhost']),
  ['a'], [], false);
// Unparseable URL fails closed even with a non-empty allowlist.
expectBatch('unparseable URL is vetoed',
  [post('a', 'not a url')], cfg(['localhost']),
  [], ['a'], true);
// GET needs no exemption and never counts.
expectBatch('GET to undeclared host runs',
  [call('a', 'fetch', { url: 'https://example.com/x', method: 'GET' })], cfg([]),
  ['a'], [], false);
// Mixed batch: GET runs unconditionally; the undeclared POST is vetoed;
// the batch counts ONCE because a call was refused.
expectBatch('mixed batch: GET runs, undeclared POST vetoed, counted',
  [call('g', 'fetch', { url: 'https://example.com/x', method: 'GET' }),
   post('p', 'https://api.other.com/x')], cfg(['localhost']),
  ['g'], ['p'], true);
// Mixed batch: exempt POST + a genuinely mutating write — the fetch runs,
// the write is vetoed, and the batch counts (a call WAS refused).
expectBatch('exempt fetch runs while write is vetoed and counted',
  [post('f', 'http://localhost:8080/graphql'),
   call('w', 'write', { path: 'x.ts', content: 'y' })], cfg(['localhost']),
  ['f'], ['w'], true);
// Exempt-only batch never ticks the counter.
expectBatch('exempt fetch + read: nothing refused, not counted',
  [post('f', 'http://localhost:8080/graphql'),
   call('r', 'read', { path: 'x.ts' })], cfg(['localhost']),
  ['f', 'r'], [], false);

if (fails.length === 0) {
  console.log('PASS: plan-mode network-read allowlist — declared hosts execute (case-insensitive, port-stripped, alias-canonical), suffix/superstring/subdomain/unparseable fail closed, only refusals count');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
