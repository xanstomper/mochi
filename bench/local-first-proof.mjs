// Local-first model tier (item 19) — offline vs online proof.
//
// Runs a small FIXED task set through the REAL production model path
// (model/router.ts createProvider -> withFailover -> model/openai.ts) under
// six configurations, and MEASURES:
//
//   - completion rate: local tier vs remote provider (same tasks, same harness)
//   - egress: every fetch attempt is classified loopback (local model server)
//     vs remote; local-tier legs must show ZERO remote model calls
//   - degradation: dead local endpoint -> fast visible failure, remote
//     fallback only when explicitly enabled, never in offline mode
//
// HONESTY NOTE (stated plainly, per the item's requirement): no real local
// model server is installed on this VM, so the local "model" is a canned
// OpenAI-compatible SSE stub on 127.0.0.1 — completion measures the
// routing/egress machinery, NOT model quality. The remote leg uses the SAME
// stub in the remote role (no provider credentials exist in this shell; all
// dummy keys stay on loopback — nothing actually leaves this machine in any
// leg, and the egress counters prove the local-tier legs never even try).
//
// Run:  npm run bench:local-first   (or: npx tsx bench/local-first-proof.mjs)
import { createServer } from 'node:http';
import { createProvider, resetCapabilityRegistry } from '../src/model/router.js';
import { LocalTierError } from '../src/model/local.js';

const TASKS = [
  { id: 'T1', prompt: 'Summarize these three bullet points into one sentence.' },
  { id: 'T2', prompt: 'Extract every TODO item from this file listing.' },
  { id: 'T3', prompt: 'Classify this stack trace: frontend, backend, or infra?' },
  { id: 'T4', prompt: 'Which RFC 2119 keyword marks an optional requirement?' },
  { id: 'T5', prompt: 'Rewrite this log line in past tense.' },
  { id: 'T6', prompt: 'Name the tool-call JSON field that carries the function name.' },
];

const DEAD_LOCAL = 'http://127.0.0.1:9/v1'; // discard port: refuses instantly

// ── stub OpenAI-compatible SSE server (loopback only) ───────────────────────
function sse(content) {
  return `data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
}

async function startStub(tag) {
  const hits = { chat: 0 };
  const server = createServer((req, res) => {
    if ((req.url ?? '').includes('/chat/completions')) {
      hits.chat++;
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        // Canned answer encodes the server role so completions are attributable.
        res.end(sse(`DONE@${tag}`) + 'data: [DONE]\n\n');
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/v1`, hits };
}

// ── egress accounting: wrap globalThis.fetch for a leg ──────────────────────
function withFetchLedger(fn) {
  const ledger = { loopback: 0, remote: 0, remoteUrls: [] };
  const orig = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/\/(127\.0\.0\.1|localhost|\[::1\]|::1)[:/]/.test(url)) ledger.loopback++;
    else { ledger.remote++; ledger.remoteUrls.push(url); }
    return orig(input, init);
  };
  return Promise.resolve()
    .then(() => fn(ledger))
    .finally(() => { globalThis.fetch = orig; });
}

// ── harness: the SAME task driver for every leg ──────────────────────────────
async function runTasks(buildConfig) {
  const rows = [];
  for (const task of TASKS) {
    const t0 = performance.now();
    try {
      const provider = createProvider(buildConfig());
      const out = await provider.chat([{ role: 'user', content: task.prompt }], []);
      const ms = Math.round(performance.now() - t0);
      const done = typeof out.content === 'string' && out.content.startsWith('DONE@');
      rows.push({ task: task.id, ok: done, ms, answer: out.content ?? '', error: '' });
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      rows.push({ task: task.id, ok: false, ms, answer: '', error: err instanceof Error ? err.message : String(err) });
    }
  }
  return rows;
}

const summarize = (rows) => ({
  completed: rows.filter((r) => r.ok).length,
  total: rows.length,
  meanMs: Math.round(rows.reduce((a, r) => a + r.ms, 0) / rows.length),
});

// ── legs ─────────────────────────────────────────────────────────────────────
const legs = [];

// Leg R: REMOTE provider (online) — the same stub in the remote role.
{
  const stub = await startStub('remote');
  resetCapabilityRegistry();
  await withFetchLedger(async (ledger) => {
    const rows = await runTasks(() => ({
      provider: 'openai', baseUrl: stub.url, model: 'remote-model', apiKey: 'dummy-not-real',
    }));
    legs.push({ name: 'remote tier (online, stub in remote role)', rows, ledger, summary: summarize(rows) });
  });
  stub.server.close();
}

// Leg L: LOCAL tier, endpoint UP.
{
  const stub = await startStub('local');
  resetCapabilityRegistry();
  delete process.env.MOCHI_OFFLINE;
  delete process.env.MOCHI_LOCAL_ALLOW_REMOTE;
  await withFetchLedger(async (ledger) => {
    const rows = await runTasks(() => ({
      provider: 'local', local: { endpoint: stub.url, model: 'local-model' },
    }));
    legs.push({ name: 'local tier (endpoint up)', rows, ledger, summary: summarize(rows), stubHits: stub.hits.chat });
  });
  stub.server.close();
}

// Leg LO: LOCAL tier, OFFLINE mode, endpoint UP.
{
  const stub = await startStub('local');
  resetCapabilityRegistry();
  process.env.MOCHI_OFFLINE = '1';
  await withFetchLedger(async (ledger) => {
    const rows = await runTasks(() => ({
      provider: 'local', local: { endpoint: stub.url, model: 'local-model' },
    }));
    legs.push({ name: 'local tier (offline mode, endpoint up)', rows, ledger, summary: summarize(rows), stubHits: stub.hits.chat });
  });
  delete process.env.MOCHI_OFFLINE;
  stub.server.close();
}

// Leg DEAD: LOCAL tier, dead endpoint, NO fallback (default).
{
  resetCapabilityRegistry();
  delete process.env.MOCHI_OFFLINE;
  await withFetchLedger(async (ledger) => {
    const rows = await runTasks(() => ({
      provider: 'local', local: { endpoint: DEAD_LOCAL, model: 'local-model' },
    }));
    legs.push({ name: 'local tier (endpoint DOWN, no fallback — default)', rows, ledger, summary: summarize(rows) });
  });
}

// Leg FB: LOCAL tier dead + explicit remote failover (user-chain opt-in) — fallback fires, LOUDLY.
{
  const stub = await startStub('remote');
  resetCapabilityRegistry();
  delete process.env.MOCHI_OFFLINE;
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => { warns.push(String(a[0] ?? '')); origWarn(...a); };
  await withFetchLedger(async (ledger) => {
    const rows = await runTasks(() => ({
      provider: 'local', local: { endpoint: DEAD_LOCAL, model: 'local-model' },
      failover: [{ provider: 'openai', baseUrl: stub.url, model: 'remote-model', apiKey: 'dummy-not-real' }],
    }));
    legs.push({
      name: 'local tier (endpoint DOWN + explicit failover opt-in)',
      rows, ledger, summary: summarize(rows),
      loudFallbackWarns: warns.filter((w) => w.includes('[failover] LOCAL TIER')).length,
    });
  });
  console.warn = origWarn;
  stub.server.close();
}

// Leg OFF-CHAIN: OFFLINE mode + explicit remote failover entry STILL configured — refused, zero egress.
{
  const stub = await startStub('remote');
  resetCapabilityRegistry();
  process.env.MOCHI_OFFLINE = '1';
  await withFetchLedger(async (ledger) => {
    const rows = await runTasks(() => ({
      provider: 'local', local: { endpoint: DEAD_LOCAL, model: 'local-model' },
      failover: [{ provider: 'openai', baseUrl: stub.url, model: 'remote-model', apiKey: 'dummy-not-real' }],
    }));
    legs.push({
      name: 'local tier (OFFLINE + remote entry present — refused)',
      rows, ledger, summary: summarize(rows),
      refusals: rows.filter((r) => r.error.includes('refusing model call to remote provider')).length,
    });
  });
  delete process.env.MOCHI_OFFLINE;
  stub.server.close();
}

// ── report ───────────────────────────────────────────────────────────────────
console.log('\n=== local-first proof: fixed task set, same harness ===');
console.log(`tasks per leg: ${TASKS.length} (T1–T6)\n`);
for (const leg of legs) {
  console.log(`— ${leg.name}`);
  console.log(`    completion : ${leg.summary.completed}/${leg.summary.total}  (mean ${leg.summary.meanMs}ms/task)`);
  console.log(`    egress     : loopback fetches=${leg.ledger.loopback}  REMOTE fetches=${leg.ledger.remote}${leg.ledger.remoteUrls.length ? ' -> ' + leg.ledger.remoteUrls.join(', ') : ''}`);
  if (leg.stubHits !== undefined) console.log(`    stub hits  : ${leg.stubHits} (/chat/completions on the local stub)`);
  if (leg.loudFallbackWarns !== undefined) console.log(`    loud warns : ${leg.loudFallbackWarns} ('[failover] LOCAL TIER')`);
  if (leg.refusals !== undefined) console.log(`    refusals   : ${leg.refusals} ('refusing model call to remote provider')`);
  for (const e of [...new Set(leg.rows.filter((r) => r.error).map((r) => r.error))].slice(0, 2)) {
    console.log(`    err sample : ${e.split('\n')[0].slice(0, 160)}`);
  }
}

// Hard assertions — the proof is not a table, it is checked:
const byName = Object.fromEntries(legs.map((l) => [l.name, l]));
const assert = (cond, msg) => { if (!cond) { console.error(`\nPROOF FAILED: ${msg}`); process.exit(1); } };
assert(byName['remote tier (online, stub in remote role)'].summary.completed === TASKS.length, 'remote leg completes all tasks');
assert(byName['local tier (endpoint up)'].summary.completed === TASKS.length, 'local leg completes all tasks');
assert(byName['local tier (offline mode, endpoint up)'].summary.completed === TASKS.length, 'offline-mode local leg completes all tasks');
for (const name of ['local tier (endpoint up)', 'local tier (offline mode, endpoint up)', 'local tier (endpoint DOWN, no fallback — default)', 'local tier (OFFLINE + remote entry present — refused)']) {
  assert(byName[name].ledger.remote === 0, `ZERO remote egress on: ${name}`);
}
assert(byName['local tier (endpoint DOWN, no fallback — default)'].summary.completed === 0, 'dead endpoint completes nothing without fallback');
assert(byName['local tier (endpoint DOWN + explicit failover opt-in)'].loudFallbackWarns === TASKS.length, 'fallback warns loudly per task');
assert(byName['local tier (OFFLINE + remote entry present — refused)'].ledger.remote === 0, 'offline mode refuses the remote entry — zero remote egress');
assert(byName['local tier (OFFLINE + remote entry present — refused)'].refusals === TASKS.length, 'offline mode refusals are visible per task');

console.log('\nPROOF OK: all assertions held.');
console.log(`PROOF_JSON=${JSON.stringify(legs.map(({ name, summary, ledger, stubHits, loudFallbackWarns, refusals }) => ({ name, summary, egress: { loopback: ledger.loopback, remote: ledger.remote }, stubHits, loudFallbackWarns, refusals })))}`);
