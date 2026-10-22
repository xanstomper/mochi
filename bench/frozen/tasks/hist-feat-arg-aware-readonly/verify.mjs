// Frozen verifier for hist-feat-arg-aware-readonly.
// Derived from git commit e9eec54 (feat(core): arg-aware read-only
// classification — GET fetch rejoins the parallel read batch) and its test
// src/core/arg-aware-readonly.test.ts: the fetch predicate cases (GET/HEAD
// read; POST and the ['POST'] array coercion mutating) and the dispatcher
// ordering discriminator (POST starts last once GET rejoins the read batch).
// Runs with cwd = the task workdir. Exit 0 = pass, 1 = fail.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { toolToCapability, dispatchBatch } = require('./classify.js');

const fails = [];
const eq = (got, want, label) => { if (got !== want) fails.push(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

// --- Capability shape -------------------------------------------------------
const fetchCap = toolToCapability('fetch');
eq(fetchCap.isReadOnly, false, 'fetch static isReadOnly stays false (arg-blind flag is conservative)');
if (typeof fetchCap.isReadOnlyForArgs !== 'function') {
  fails.push('fetch capability has no isReadOnlyForArgs predicate');
} else {
  const p = fetchCap.isReadOnlyForArgs;
  eq(p({ url: 'https://x' }), true, 'fetch predicate: absent method is a read (GET default)');
  eq(p({ url: 'https://x', method: 'GET' }), true, 'fetch predicate: GET is a read');
  eq(p({ url: 'https://x', method: 'HEAD' }), true, 'fetch predicate: HEAD is a read');
  eq(p({ url: 'https://x', method: 'POST' }), false, 'fetch predicate: POST mutates');
  eq(p({ url: 'https://x', method: 'PUT' }), false, 'fetch predicate: PUT mutates');
  eq(p({ url: 'https://x', method: 'PATCH' }), false, 'fetch predicate: PATCH mutates');
  eq(p({ url: 'https://x', method: 'DELETE' }), false, 'fetch predicate: DELETE mutates');
  eq(p({ url: 'https://x', method: 'post' }), false, 'fetch predicate: lowercase post still mutates (wire coercion)');
  eq(p({ url: 'https://x', method: ['POST'] }), false, "fetch predicate: ['POST'] array coerces to 'POST' on the wire, so it mutates here too");
}

// verify deliberately has NO predicate (a command classifier is too coarse
// to admit shell commands by argument); its static flag alone decides.
const verifyCap = toolToCapability('verify');
eq(verifyCap.isReadOnlyForArgs, undefined, 'verify must NOT gain an isReadOnlyForArgs predicate');
eq(verifyCap.isReadOnly, true, 'verify static flag unchanged');
// A plain static read tool: read-only, no predicate.
const readCap = toolToCapability('read');
eq(readCap.isReadOnly, true, 'read static isReadOnly');
eq(readCap.isReadOnlyForArgs, undefined, 'read has no arg predicate');
// A mutating tool: not read-only, no predicate invented for it.
const writeCap = toolToCapability('write');
eq(writeCap.isReadOnly, false, 'write static isReadOnly');
eq(writeCap.isReadOnlyForArgs, undefined, 'write has no arg predicate');

// --- Dispatcher ordering ----------------------------------------------------
// Batch: [POST fetch, GET fetch, read]. With arg-aware classification the
// read-only phase runs FIRST (GET fetch + read concurrently), so the POST
// starts only after both reads started. Under static-only classification
// the POST would start ahead of the GET (both fetches sequential, FIFO).
const starts = [];
const executor = async (call) => {
  const m = call.arguments && typeof call.arguments === 'object' ? call.arguments.method : undefined;
  starts.push(`${call.name}:${m ?? ''}`);
  await new Promise((r) => setTimeout(r, 1));
  return 'ok';
};
const results = await dispatchBatch([
  { id: 'p1', name: 'fetch', arguments: { url: 'http://127.0.0.1:9/slow', method: 'POST', body: 'x', allow_private: true } },
  { id: 'r1', name: 'fetch', arguments: { url: 'http://127.0.0.1:9/fast', method: 'GET', allow_private: true } },
  { id: 'r2', name: 'read', arguments: { path: '/tmp/does-not-exist-frozen' } },
], executor);
eq(results.length, 3, 'dispatcher returns one result per call');
eq(results.map((r) => r.id).join(','), 'p1,r1,r2', 'dispatcher results are in input order');
eq(starts[starts.length - 1], 'fetch:POST', 'POST fetch starts LAST (mutating calls wait for the read phase)');
if (!starts.slice(0, 2).includes('fetch:GET')) fails.push(`GET fetch did not start in the concurrent read phase (starts: ${starts.join(', ')})`);
if (!starts.slice(0, 2).includes('read:')) fails.push(`read did not start in the concurrent read phase (starts: ${starts.join(', ')})`);

// Fail closed: a fetch call whose arguments are not an object must NOT be
// admitted to the read phase even though fetch has a predicate.
const starts2 = [];
const results2 = await dispatchBatch([
  { id: 'w1', name: 'fetch', arguments: null },
  { id: 'w2', name: 'read', arguments: { path: '/tmp/x' } },
], async (call) => { starts2.push(call.name); return 'ok'; });
eq(results2.length, 2, 'fail-closed batch returns all results');
eq(starts2[0], 'read', 'odd-shaped fetch args fail closed: read (static read-only) starts first');
eq(starts2[starts2.length - 1], 'fetch', 'odd-shaped fetch args fail closed: fetch runs in the sequential phase');

if (fails.length === 0) {
  console.log('PASS: arg-aware classification — fetch predicate matches the wire (GET/HEAD read, POST/PUT/PATCH/DELETE incl. array coercion mutating), verify has no predicate, POST starts last, odd args fail closed');
  process.exit(0);
}
console.log(`FAIL: ${fails.join('; ')}`);
process.exit(1);
