#!/usr/bin/env node
// Warm-daemon TTFT benchmark (feat/warm-daemon) — the proof metric for the
// item: time-to-first-token, cold vs warm, same repo, same fixed task, N runs
// each, medians + full table. Plus daemon RSS and idle CPU.
//
// The model is a LOCAL scripted OpenAI-compatible SSE server (the same wire
// contract as the real provider path — the agent's provider code is the real
// production code), so model latency is ~0 and near-constant: every
// millisecond of TTFT difference between modes is harness cost (process boot,
// config, module graph, goal engine, tools, skills, context build), which is
// exactly what the warm daemon claims to pre-pay.
//
// Modes:
//   cold-cli    one-shot CLI run per iteration (`node dist/cli.js -p task`) —
//               today's no-daemon path. TTFT measured from process spawn.
//   cold-daemon a fresh daemon per iteration, task posted immediately — what a
//               daemon WITHOUT preload pays on its first task.
//   warm-daemon ONE daemon started with warm preload; every iteration posts
//               the task over HTTP. TTFT measured from POST start.
//
// Usage: node bench/warm-ttft.mjs [N]   (default N=7 per mode)
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { createServer } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bin = resolve(root, 'dist/cli.js');
const daemonServer = resolve(root, 'dist/daemon/daemon-server.js');
const N = Number(process.argv[2] ?? process.env.N ?? 7);
const TASK = 'Create the file warm-ok.txt containing warm-ok. Stop after writing the file.';
const OUT_FILE = 'warm-ok.txt';
const OUT_CONTENT = 'warm-ok';

// ── Scripted fake provider (same SSE contract as src/testutil/fake-openai) ──
// One sticky router: a request with no tool turn yet gets the write tool call;
// any follow-up gets the final answer. Deterministic for every run in every
// mode — no script queue to desync.
let arrivals = [];
function sseBody(content, finish, toolCalls) {
  const chunks = [];
  const id = `chatcmpl_${Math.random().toString(36).slice(2, 10)}`;
  const created = Math.floor(Date.now() / 1000);
  for (const tc of toolCalls ?? []) {
    chunks.push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'fake-model', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }] }, finish_reason: null }] })}\n\n`);
  }
  if (content) {
    chunks.push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'fake-model', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
  }
  chunks.push(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: 'fake-model', choices: [{ index: 0, delta: {}, finish_reason: finish, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }] })}\n\n`);
  chunks.push('data: [DONE]\n\n');
  return chunks.join('');
}
async function startFake() {
  arrivals = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      arrivals.push(Date.now());
      const parsed = JSON.parse(body || '{}');
      const hasToolTurn = (parsed.messages ?? []).some((m) => m.role === 'tool');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!hasToolTurn) {
        res.end(sseBody('', 'tool_calls', [{ id: 'call1', name: 'write', arguments: JSON.stringify({ path: OUT_FILE, content: OUT_CONTENT }) }]));
      } else {
        res.end(sseBody(`Created ${OUT_FILE}.`, 'stop'));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}/v1` };
}

// ── Fixture: the "repo the user already works in", held constant across modes ─
function makeFixture(fakeUrl, cfgDir) {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-warm-ttft-'));
  writeFileSync(resolve(dir, 'mochi.json'), JSON.stringify({
    model: { provider: 'openai', baseUrl: fakeUrl, model: 'fake-model', apiKey: 'fake' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000, skipReproGate: true },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false, quiet: true, verbose: false, debug: false,
    speculative: { preflight: false },
    longtask: { enabled: false },
  }));
  writeFileSync(resolve(dir, 'package.json'), '{"name":"warm-ttft-fixture","version":"1.0.0","type":"module"}\n');
  writeFileSync(resolve(dir, 'main.ts'), 'export const main = (): number => 1;\n');
  writeFileSync(resolve(dir, OUT_FILE), OUT_CONTENT); // stable untracked file: same porcelain every run
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'b@b'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'b'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
  return dir;
}

const completed = (dir) => existsSync(resolve(dir, OUT_FILE)) && readFileSync(resolve(dir, OUT_FILE), 'utf8') === OUT_CONTENT;

// ── Mode runners. Each returns { ttftMs, wallMs, ok } per run. ────────────────
async function runColdCli(fixture, cfgDir) {
  const t0 = Date.now();
  const r = await new Promise((done) => {
    const child = spawn(process.execPath, [bin, '-p', TASK], { cwd: fixture, timeout: 120_000, env: { ...process.env, MOCHI_CONFIG_DIR: cfgDir } });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('exit', (code) => done({ code, out: out + err }));
    child.on('error', (e) => done({ code: -1, out: String(e) }));
  });
  const ttft = arrivals.length ? arrivals[0] - t0 : -1;
  const wall = Date.now() - t0;
  arrivals = [];
  return { ttftMs: ttft, wallMs: wall, ok: r.code === 0 && completed(fixture) };
}

async function daemonRequest(port, token, path, method, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
}

async function stopDaemon(dir) {
  const infoPath = resolve(dir, '.mochi', 'daemon', 'info.json');
  if (!existsSync(infoPath)) return;
  const info = JSON.parse(readFileSync(infoPath, 'utf8'));
  try { process.kill(info.pid, 'SIGTERM'); } catch { /* gone */ }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && existsSync(infoPath)) await new Promise((r) => setTimeout(r, 50));
  if (existsSync(infoPath)) { try { process.kill(info.pid, 'SIGKILL'); } catch { /* gone */ } rmSync(infoPath, { force: true }); }
}

async function runColdDaemon(fixture, cfgDir, port) {
  const t0 = Date.now();
  // Detached daemon, NO warm preload (MOCHI_WARM_DAEMON unset).
  const child = spawn(process.execPath, [daemonServer, String(port), 'benchtok', fixture, '127.0.0.1'], {
    detached: true, stdio: 'ignore', env: { ...process.env, MOCHI_CONFIG_DIR: cfgDir },
  });
  child.unref();
  // Wait for listen.
  const deadline = Date.now() + 15_000;
  let up = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const h = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (h.ok) { up = true; break; }
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!up) return { ttftMs: -1, wallMs: -1, ok: false };
  const tSubmit = Date.now();
  let ok = false;
  try {
    const res = await daemonRequest(port, 'benchtok', '/api/prompt', 'POST', { task: TASK });
    const data = await res.json();
    ok = data.ok === true && data.success === true;
  } catch { ok = false; }
  const ttft = arrivals.length ? arrivals[0] - tSubmit : -1;
  const wall = Date.now() - t0;
  arrivals = [];
  await stopDaemon(fixture);
  return { ttftMs: ttft, wallMs: wall, ok };
}

async function startWarmDaemon(fixture, cfgDir, port) {
  const child = spawn(process.execPath, [daemonServer, String(port), 'benchtok', fixture, '127.0.0.1'], {
    detached: true, stdio: 'ignore', env: { ...process.env, MOCHI_CONFIG_DIR: cfgDir, MOCHI_WARM_DAEMON: '1' },
  });
  child.unref();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await daemonRequest(port, 'benchtok', '/api/warm', 'GET');
      const data = await res.json();
      if (data.warm?.state === 'ready') return true;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function runWarmTask(fixture, port) {
  const tSubmit = Date.now();
  let ok = false;
  try {
    const res = await daemonRequest(port, 'benchtok', '/api/prompt', 'POST', { task: TASK });
    const data = await res.json();
    ok = data.ok === true && data.success === true;
  } catch { ok = false; }
  const ttft = arrivals.length ? arrivals[0] - tSubmit : -1;
  arrivals = [];
  return { ttftMs: ttft, wallMs: -1, ok };
}

// ── Idle CPU sampling of the warm daemon (external, /proc — not self-reported) ─
function procCpu(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const utime = Number(parts[11]), stime = Number(parts[12]);
    return { ticks: utime + stime, at: Date.now() };
  } catch { return null; }
}
const TICK_MS = 10; // getconf CLK_TCK

const median = (arr) => {
  const s = [...arr].filter((x) => x >= 0).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : -1;
};
const fmt = (arr) => arr.map((x) => (x < 0 ? 'FAIL' : String(x))).join(', ');

// ── Run ────────────────────────────────────────────────────────────────────────
const cfgDir = mkdtempSync(resolve(tmpdir(), 'mochi-warm-ttft-cfg-')); // empty global config
const results = { 'cold-cli': [], 'cold-daemon': [], 'warm-daemon': [] };
let warmInfo = null;

{
  // 1. cold-cli: N one-shot runs, each a fresh process + fixture state.
  const warmupFake = await startFake();
  const fixture = makeFixture(warmupFake.url, cfgDir);
  // warm-up run (page cache + compile cache) so cold numbers are not dominated
  // by one-time OS effects — then N measured runs.
  await runColdCli(fixture, cfgDir);
  for (let i = 0; i < N; i++) {
    const fake = await startFake(); // fresh fake per run: arrivals reset
    // mochi.json must point at THIS fake instance — rewrite between runs.
    // (The fixture generator takes the URL; here we just re-point it.)
    const cfg = JSON.parse(readFileSync(resolve(fixture, 'mochi.json'), 'utf8'));
    cfg.model.baseUrl = fake.url;
    writeFileSync(resolve(fixture, 'mochi.json'), JSON.stringify(cfg));
    const r = await runColdCli(fixture, cfgDir);
    results['cold-cli'].push(r.ttftMs);
    if (!r.ok) console.error(`  cold-cli run ${i + 1}: NOT completed (ttft ${r.ttftMs}ms)`);
    await fake.server.close();
    await once(fake.server, 'close').catch(() => {});
  }
  await warmupFake.server.close();
  await once(warmupFake.server, 'close').catch(() => {});
  rmSync(fixture, { recursive: true, force: true });
}

{
  // 2. cold-daemon: fresh daemon per run, task posted immediately.
  const fake = await startFake();
  const fixture = makeFixture(fake.url, cfgDir);
  for (let i = 0; i < N; i++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const r = await runColdDaemon(fixture, cfgDir, port);
    results['cold-daemon'].push(r.ttftMs);
    if (!r.ok) console.error(`  cold-daemon run ${i + 1}: NOT completed (ttft ${r.ttftMs}ms)`);
  }
  await stopDaemon(fixture);
  await fake.server.close();
  rmSync(fixture, { recursive: true, force: true });
}

{
  // 3. warm-daemon: ONE preloaded daemon serves N runs.
  const fake = await startFake();
  const fixture = makeFixture(fake.url, cfgDir);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const up = await startWarmDaemon(fixture, cfgDir, port);
  if (!up) {
    console.error('warm daemon failed to reach ready state');
    results['warm-daemon'].push(-1);
  } else {
    const infoPath = resolve(fixture, '.mochi', 'daemon', 'info.json');
    const pid = JSON.parse(readFileSync(infoPath, 'utf8')).pid;
    // Idle CPU: sample /proc over a 10s quiet window (daemon just preloaded;
    // wait out the 60s busy-guard is unnecessary — the poll re-warm only runs
    // on INVALID state, and nothing changes here).
    const c0 = procCpu(pid);
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 10_000));
    const c1 = procCpu(pid);
    // ticks * TICK_MS = CPU ms; / wall ms = fraction; * 100 = percent of ONE core.
    const idleCpuPct = c0 && c1 ? ((c1.ticks - c0.ticks) * TICK_MS) / (c1.at - c0.at) * 100 : -1;
    // RSS from /proc (truth) + daemon self-report.
    const statusText = readFileSync(`/proc/${pid}/status`, 'utf8');
    const rssKb = Number(/VmRSS:\s+(\d+)\s+kB/.exec(statusText)?.[1] ?? 0);
    let selfWarm = null;
    try { selfWarm = (await (await daemonRequest(port, 'benchtok', '/api/warm', 'GET')).json()).warm; } catch { /* ignore */ }
    // N measured task runs (first one may pay a one-time re-warm if the state
    // changed during startup — it does not here; the fixture is static).
    for (let i = 0; i < N; i++) {
      const r = await runWarmTask(fixture, port);
      results['warm-daemon'].push(r.ttftMs);
      if (!r.ok) console.error(`  warm-daemon run ${i + 1}: NOT completed (ttft ${r.ttftMs}ms)`);
    }
    warmInfo = {
      pid,
      rssProcMB: Math.round(rssKb / 1024 * 10) / 10,
      rssSelfMB: selfWarm ? Math.round(selfWarm.rssBytes / 1024 / 1024 * 10) / 10 : null,
      idleCpuPct: Math.round(idleCpuPct * 100) / 100,
      idleCpuSelfPct: selfWarm?.idleCpuPct ?? null,
      preloadMs: selfWarm?.preloadMs ?? null,
      rewarmCount: selfWarm?.rewarmCount ?? null,
      invalidations: selfWarm?.invalidations?.length ?? 0,
      watcher: selfWarm?.watcher ?? null,
    };
  }
  await stopDaemon(fixture);
  await fake.server.close();
  rmSync(fixture, { recursive: true, force: true });
}
rmSync(cfgDir, { recursive: true, force: true });

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\nWarm daemon TTFT bench — task: "${TASK}" — N=${N} per mode (fake local provider, ~0ms model latency)`);
console.log('');
console.log('mode          runs (TTFT ms)' + ' '.repeat(30) + 'median');
for (const [mode, arr] of Object.entries(results)) {
  console.log(`${mode.padEnd(13)} ${fmt(arr).padEnd(42)} ${median(arr)}ms`);
}
const cold = median(results['cold-cli']);
const coldDaemon = median(results['cold-daemon']);
const warm = median(results['warm-daemon']);
if (cold > 0 && warm > 0) {
  console.log(`\ncold-cli  -> warm-daemon: ${cold}ms -> ${warm}ms  (${(cold / warm).toFixed(2)}x faster, saves ${cold - warm}ms)`);
}
if (coldDaemon > 0 && warm > 0) {
  console.log(`cold-daemon (no preload, first task) -> warm-daemon: ${coldDaemon}ms -> ${warm}ms (${(coldDaemon / warm).toFixed(2)}x)`);
}
if (warmInfo) {
  console.log(`\nwarm daemon resources: pid ${warmInfo.pid}, RSS ${warmInfo.rssProcMB}MB (/proc; self-report ${warmInfo.rssSelfMB}MB),`);
  console.log(`idle CPU ${warmInfo.idleCpuPct}% over a 10s window (/proc; self-report ${warmInfo.idleCpuSelfPct}%), preload ${warmInfo.preloadMs}ms, rewarms ${warmInfo.rewarmCount}, invalidations ${warmInfo.invalidations}, watcher ${warmInfo.watcher}`);
}
process.exit(0); // detached daemon children + keep-alive sockets must not hold the bench open
