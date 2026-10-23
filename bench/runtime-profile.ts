#!/usr/bin/env tsx
// Runtime performance profile (Wave S1). Measures the HARNESS's own cost —
// never model time — on scripted, deterministic workloads:
//
//   1. token counting   approxTokens / cachedMessageTokens / estimateTokens{,Async}
//   2. context assembly ContextEngine.buildPacket at growing history sizes
//   3. run journal      RunJournal.recordStep cost per journaled step
//   4. agent run        a scripted multi-turn run against the in-process fake
//                       OpenAI server, with prototype-level timing wrappers on
//                       buildPacket / journal / event emission, so per-turn
//                       overhead is attributed, not guessed
//   5. memory           RSS/heap trend + emit-cost drift across repeated runs
//                       in one process (leak smoke detector)
//
// Usage: ./node_modules/.bin/tsx bench/runtime-profile.ts
//        NODE_OPTIONS=--expose-gc ./node_modules/.bin/tsx bench/runtime-profile.ts
//
// NOTE on environment: absolute numbers reflect the machine this runs on.
// On a loaded/shared box, wall-clock medians inflate; the in-process CPU-ish
// medians and the before/after deltas on the SAME box are the signal.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, openSync, appendFileSync, fsyncSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ContextEngine, approxTokens, heuristicTokenCount, cachedMessageTokens } from '../src/context.js';
import { RunJournal } from '../src/agent/run-journal.js';
import { Agent } from '../src/agent/loop.js';
import { EventBus } from '../src/events.js';
import { Workspace } from '../src/workspace.js';
import { createTask } from '../src/goals/task.js';
import { startFakeOpenAI, type FakeScriptResponse } from '../src/testutil/fake-openai.js';
import { isRustRuntimeAvailable } from '../src/native/agent-protocol.js';
import type { MochiConfig } from '../src/types.js';

// ── helpers ────────────────────────────────────────────────────────────────
function med(a: number[]): number { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function p90(a: number[]): number { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]; }
function fmt(ms: number): string { return ms >= 100 ? ms.toFixed(1) : ms >= 1 ? ms.toFixed(2) : ms.toFixed(3); }
function benchSync(label: string, fn: () => void, iters: number): number {
  fn(); // warm
  const times: number[] = [];
  for (let i = 0; i < iters; i++) { const t0 = performance.now(); fn(); times.push(performance.now() - t0); }
  console.log(`  ${label.padEnd(58)} median ${fmt(med(times))}ms  p90 ${fmt(p90(times))}ms  (n=${iters})`);
  return med(times);
}
async function benchAsync(label: string, fn: () => Promise<unknown>, iters: number): Promise<number> {
  await fn();
  const times: number[] = [];
  for (let i = 0; i < iters; i++) { const t0 = performance.now(); await fn(); times.push(performance.now() - t0); }
  console.log(`  ${label.padEnd(58)} median ${fmt(med(times))}ms  p90 ${fmt(p90(times))}ms  (n=${iters})`);
  return med(times);
}

function makeConfig(dir: string, url: string): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 200_000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false, projectDir: '.mochi', configDir: resolve(dir, '.config/mochi'), quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

/** This machine has intermittent EPERM write windows (see AGENTS.md);
 *  fixture creation retries through them instead of dying. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function retryEperm<T>(fn: () => T, label: string): T {
  const deadline = Date.now() + 900_000;
  let announced = false;
  for (;;) {
    try { return fn(); } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EPERM' || Date.now() > deadline) throw e;
      if (!announced) { console.log(`  [eperm-wait] ${label} — write window closed, waiting…`); announced = true; }
      sleepSync(3000);
    }
  }
}
/** Block until a probe write succeeds (one launch survives a full window). */
function waitForWrites(): void {
  retryEperm(() => {
    const probe = join(tmpdir(), `mochi-s1-probe-${process.pid}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
  }, 'write-window probe');
}

function fixtureWorkspace(): string {
  return retryEperm(() => {
    const root = mkdtempSync(join(tmpdir(), 'mochi-s1-prof-'));
    mkdirSync(join(root, '.mochi', 'memory'), { recursive: true });
    mkdirSync(join(root, '.mochi', 'state'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'prof-fixture', type: 'module', scripts: { test: 'node -e "process.exit(0)"' } }));
    writeFileSync(join(root, 'seed.txt'), 'seed content line\n'.repeat(50));
    writeFileSync(join(root, '.mochi', 'project.md'), '# Project\nProfile fixture.\n');
    return root;
  }, 'fixtureWorkspace');
}

/** Synthetic history: alternating user/assistant/tool messages with
 *  realistic tool-output sizes (~2KB each). */
function growHistory(engine: ContextEngine, turns: number): void {
  const toolText = ('file content line with some code tokens: const value = compute(input);\n').repeat(28); // ~2KB
  for (let i = 0; i < turns; i++) {
    engine.addMessage({ role: 'user', content: `Step ${i}: inspect module ${i} and report` } as never);
    engine.addMessage({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read', arguments: '{"path":"seed.txt"}' } }] } as never);
    engine.addMessage({ role: 'tool', name: 'read', tool_call_id: `c${i}`, content: toolText } as never);
    engine.addMessage({ role: 'assistant', content: `Inspected module ${i}; it defines compute() and exports it.` } as never);
  }
}

const SECTIONS = new Set((process.env.S1_SECTIONS ?? 'tokens,digests,packet,journal,agent').split(','));
const want = (s: string): boolean => SECTIONS.has(s);

async function main(): Promise<void> {
  console.log('== Mochi runtime profile (Wave S1) ==');
  console.log(`node ${process.version}  rustRuntimeAvailable=${isRustRuntimeAvailable()}  gc=${typeof (globalThis as { gc?: unknown }).gc === 'function'}`);
  const gc = (globalThis as { gc?: () => void }).gc;
  waitForWrites();

  // ── 1. Token counting ───────────────────────────────────────────────────
  if (want('tokens')) {
  console.log('\n[1] Token counting');
  const texts: Array<[string, string]> = [
    ['10KB prose/code mix', ('The quick brown fox refactors the module. '.repeat(240))],
    ['100KB tool-output-like', ('src/agent/loop.ts:2023: const ctxTokens = await this.context.estimateTokensAsync();\n').repeat(1250)],
    ['1MB transcript-like', ('{"role":"tool","content":"line of output with tokens and symbols <>[]{} \\n"}\n').repeat(12500)],
  ];
  for (const [label, text] of texts) {
    benchSync(`heuristicTokenCount ${label} (${text.length} chars)`, () => { heuristicTokenCount(text); }, 15);
    benchSync(`approxTokens ${label}`, () => { approxTokens(text); }, 15);
  }
  {
    const root = fixtureWorkspace();
    const cfg = makeConfig(root, 'http://127.0.0.1:1/v1');
    for (const turns of [10, 50, 150, 300]) {
      const engine = new ContextEngine(cfg, root, join(root, 'no-skills'));
      engine.setGoal('Profile token counting at scale');
      growHistory(engine, turns);
      const msgs = engine.getMessages();
      benchSync(`estimateTokens() sync @ ${msgs.length} msgs`, () => { engine.estimateTokens(); }, 25);
      await benchAsync(`estimateTokensAsync() @ ${msgs.length} msgs`, () => engine.estimateTokensAsync(), 15);
      // cachedMessageTokens: cold (fresh objects per iteration) vs warm
      benchSync(`cachedMessageTokens cold @ ${msgs.length} msgs`, () => { for (const m of msgs) cachedMessageTokens({ ...m }); }, 5);
      benchSync(`cachedMessageTokens warm @ ${msgs.length} msgs`, () => { for (const m of msgs) cachedMessageTokens(m); }, 25);
    }
    rmSync(root, { recursive: true, force: true });
  }

  }
  // ── 1b. Prompt digests: per-turn disk-backed renders ────────────────────
  if (want('digests')) {
  console.log('\n[1b] Prompt digests (called by buildSystemPrompt EVERY turn)');
  {
    const home = retryEperm(() => {
      const h = mkdtempSync(join(tmpdir(), 'mochi-s1-home-'));
      mkdirSync(join(h, '.mochi'), { recursive: true });
      const facts = Array.from({ length: 200 }, (_, i) => JSON.stringify({
        id: `f${i}`, ts: Date.now() - i * 1000, category: i % 3 === 0 ? 'preference' : 'fact',
        statement: `Fact ${i}: the parser module handles token ${i} with a dedicated branch and caches results`,
        source: 'session', attempts: 2, success_count: 1,
      })).join('\n') + '\n';
      writeFileSync(join(h, 'facts.jsonl'), facts);
      const fb = Array.from({ length: 60 }, (_, i) => JSON.stringify({
        ts: Date.now() - i * 1000, session: 'bench', turn: i, verdict: i % 4 === 0 ? 'bad' : 'good',
        snippet: `answer ${i} snippet text`, ...(i % 4 === 0 ? { reason: 'missed the point' } : {}),
      })).join('\n') + '\n';
      writeFileSync(join(h, '.mochi', 'feedback.jsonl'), fb);
      return h;
    }, 'digest fixture');
    const prevHome = process.env.HOME;
    const prevMem = process.env.MOCHI_MEMORY_FILE;
    process.env.HOME = home;
    process.env.MOCHI_MEMORY_FILE = join(home, 'facts.jsonl');
    try {
      const { memoryDigest } = await import('../src/memory/memory-store.js');
      const { feedbackDigest } = await import('../src/observability/feedback.js');
      const ctx = 'Fix the parser bug in src/parser.ts and run the tests to verify';
      benchSync('memoryDigest (200-fact store)', () => { memoryDigest(ctx); }, 30);
      benchSync('feedbackDigest (60-entry store)', () => { feedbackDigest(); }, 30);
    } finally {
      process.env.HOME = prevHome;
      if (prevMem === undefined) delete process.env.MOCHI_MEMORY_FILE; else process.env.MOCHI_MEMORY_FILE = prevMem;
      rmSync(home, { recursive: true, force: true });
    }
  }

  }
  // ── 2. Context assembly ─────────────────────────────────────────────────
  if (want('packet')) {
  console.log('\n[2] Context assembly (buildPacket per turn)');
  {
    const root = fixtureWorkspace();
    const cfg = makeConfig(root, 'http://127.0.0.1:1/v1');
    const task = { title: 'Profile assembly', description: 'Profile buildPacket cost', acceptanceCriteria: [] } as never;
    for (const turns of [10, 50, 150, 300]) {
      const engine = new ContextEngine(cfg, root, join(root, 'no-skills'));
      engine.setGoal('Profile assembly at scale');
      growHistory(engine, turns);
      benchSync(`buildPacket @ ${engine.getMessages().length} msgs`, () => { engine.buildPacket([], task); }, 25);
    }
    rmSync(root, { recursive: true, force: true });
  }

  }
  // ── 3. Run journal ──────────────────────────────────────────────────────
  if (want('journal')) {
  console.log('\n[3] Run journal writes');
  {
    const root = fixtureWorkspace();
    const journal = RunJournal.open({ baseDir: join(root, '.mochi'), runId: 's1-profile-run', taskId: 's1' });
    journal.beginRun({ taskId: 's1', title: 'profile' });
    const out = 'tool output payload line\n'.repeat(80); // ~2KB
    const times: number[] = [];
    const N = 200;
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      journal.recordStep({ stepId: `step-${i}`, toolName: 'read', args: { path: 'seed.txt', offset: i }, output: out, durationMs: 1 });
      times.push(performance.now() - t0);
    }
    journal.finishRun('completed');
    const size = statSync(join(root, '.mochi', 'journals', 's1-profile-run.jsonl')).size;
    console.log(`  recordStep (~2KB output)                            median ${fmt(med(times))}ms  p90 ${fmt(p90(times))}ms  (n=${N})  durable=${journal.isDurable}`);
    console.log(`  journal file: ${(size / 1024).toFixed(0)}KB for ${N} steps`);
    rmSync(root, { recursive: true, force: true });

    // Component split of the per-line pattern appendLine uses today
    // (mkdir + open + append + fsync + close per line) vs a cached fd —
    // pure node:fs, decides whether fd caching is worth touching the
    // durability path at all.
    const fsDir = retryEperm(() => {
      const d = mkdtempSync(join(tmpdir(), 'mochi-s1-fs-'));
      mkdirSync(join(d, 'journals'), { recursive: true });
      return d;
    }, 'fs-pattern fixture');
    const line = JSON.stringify({ kind: 'step', payload: 'x'.repeat(1900) }) + '\n';
    const perLinePath = join(fsDir, 'journals', 'per-line.jsonl');
    const t1: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      mkdirSync(join(fsDir, 'journals'), { recursive: true });
      const fd = openSync(perLinePath, 'a');
      appendFileSync(fd, line);
      fsyncSync(fd);
      closeSync(fd);
      t1.push(performance.now() - t0);
    }
    const cachedPath = join(fsDir, 'journals', 'cached.jsonl');
    const cfd = openSync(cachedPath, 'a');
    const t2: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      appendFileSync(cfd, line);
      fsyncSync(cfd);
      t2.push(performance.now() - t0);
    }
    closeSync(cfd);
    const t3: number[] = [];
    const cfd2 = openSync(cachedPath, 'a');
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      appendFileSync(cfd2, line); // NO fsync — isolates the fsync share
      t3.push(performance.now() - t0);
    }
    closeSync(cfd2);
    console.log(`  fs pattern per-line open+fsync+close                median ${fmt(med(t1))}ms  p90 ${fmt(p90(t1))}ms  (n=100)`);
    console.log(`  fs pattern cached fd + fsync                        median ${fmt(med(t2))}ms  p90 ${fmt(p90(t2))}ms  (n=100)`);
    console.log(`  fs pattern cached fd, no fsync (fsync share)        median ${fmt(med(t3))}ms  p90 ${fmt(p90(t3))}ms  (n=100)`);
    rmSync(fsDir, { recursive: true, force: true });
  }

  }
  // ── 4+5. Scripted agent run: per-turn attribution + memory trend ────────
  if (want('agent')) {
  console.log('\n[4] Scripted agent run (fake model, in-process HTTP)');
  const script: FakeScriptResponse[] = [];
  for (let r = 0; r < 3; r++) {
    script.push({ finishReason: 'tool_calls', toolCalls: [{ id: `read-${r}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'seed.txt' }) } }] });
    script.push({ finishReason: 'tool_calls', toolCalls: [{ id: `write-${r}`, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: `out-${r}.txt`, content: `result ${r}\n` }) } }] });
    script.push({ finishReason: 'tool_calls', toolCalls: [{ id: `shell-${r}`, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'npm test' }) } }] });
  }
  script.push({ content: 'All three rounds are complete: seed read, outputs written, shell verified.', finishReason: 'stop' });

  // Instrumentation (prototype wrappers; restored never — bench process only).
  const timers = { buildPacketMs: 0, buildPacketCalls: 0, journalMs: 0, journalCalls: 0, emitMs: 0, emitCalls: 0 };
  const packetCallTimes: number[] = [];
  const origBuild = ContextEngine.prototype.buildPacket;
  ContextEngine.prototype.buildPacket = function (...args: never[]) {
    const t0 = performance.now(); const out = (origBuild as (...a: never[]) => unknown).apply(this, args);
    const dt = performance.now() - t0;
    timers.buildPacketMs += dt; timers.buildPacketCalls++; packetCallTimes.push(dt); return out;
  } as never;
  const origRecord = RunJournal.prototype.recordStep;
  RunJournal.prototype.recordStep = function (...args: never[]) {
    const t0 = performance.now(); const out = (origRecord as (...a: never[]) => unknown).apply(this, args);
    timers.journalMs += performance.now() - t0; timers.journalCalls++; return out;
  } as never;
  const origEmit = EventBus.prototype.emit;
  EventBus.prototype.emit = function (...args: never[]) {
    const t0 = performance.now(); const out = (origEmit as (...a: never[]) => unknown).apply(this, args);
    timers.emitMs += performance.now() - t0; timers.emitCalls++; return out;
  } as never;

  // Model roundtrip floor: bare fetches against a THROWAWAY fake — fetching
  // from the scripted server would consume script entries (the fake serves
  // the script to every POST), corrupting the run below.
  {
    const floorFake = await startFakeOpenAI([{ content: 'ok', finishReason: 'stop' }]);
    const rt: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      await fetch(`${floorFake.url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake-model', messages: [], stream: true }) }).then((r) => r.text());
      rt.push(performance.now() - t0);
    }
    console.log(`  bare fake-server roundtrip floor: median ${fmt(med(rt))}ms (n=10)`);
    await floorFake.close();
  }
  {
    const RUNS = 15;
    const rssTrend: number[] = [];
    const heapTrend: number[] = [];
    const emitTrend: number[] = [];
    let firstRun: { wall: number; turns: number } | null = null;
    for (let run = 0; run < RUNS; run++) {
      // Fresh fake per run: the script is consumed entry-by-entry, so a
      // shared server would serve later runs its exhausted-script fallback.
      const fake = await startFakeOpenAI(script);
      const dir = fixtureWorkspace();
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('Profile scripted run');
      const task = createTask('Profile scripted run', 'Read seed.txt, write out files, run echo, report.');
      const agent = new Agent({ role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
      const before = { ...timers };
      const reqBefore = 0;
      const t0 = performance.now();
      const result = await agent.run(task) as { success?: boolean; stopReason?: string; summary?: string } | undefined;
      const wall = performance.now() - t0;
      const turns = fake.requests.length - reqBefore;
      if (run === 0) {
        firstRun = { wall, turns };
        const bp = timers.buildPacketMs - before.buildPacketMs;
        const jr = timers.journalMs - before.journalMs;
        const em = timers.emitMs - before.emitMs;
        console.log(`  run #1 wall ${fmt(wall)}ms over ${turns} model turns (${turns ? fmt(wall / turns) : '—'}ms/turn incl. model roundtrip)  success=${result?.success ?? '?'} stop=${result?.stopReason ?? '?'}`);
        if (result?.summary) console.log(`    run summary: ${String(result.summary).slice(0, 200)}`);
        const shapes = fake.requests.slice(reqBefore).map((r) => (r.body as { messages?: unknown[] })?.messages?.length ?? -1);
        console.log(`    model requests in run: ${turns} (history length per request: ${shapes.join(', ')})`);
        console.log(`    buildPacket  total ${fmt(bp)}ms  (${timers.buildPacketCalls - before.buildPacketCalls} calls: ${packetCallTimes.map((t) => fmt(t)).join(', ')})`);
        console.log(`    journal      total ${fmt(jr)}ms  (${timers.journalCalls - before.journalCalls} recordStep calls)`);
        console.log(`    event emit   total ${fmt(em)}ms  (${timers.emitCalls - before.emitCalls} emits)`);
        console.log(`    residual/turn (dispatch+provider client+tools+misc): ${turns ? fmt((wall - bp - jr - em) / turns) : '—'}ms`);
      }
      const dEmits = timers.emitCalls - before.emitCalls;
      emitTrend.push(dEmits ? ((timers.emitMs - before.emitMs) / dEmits) * 1000 : 0);
      gc?.();
      const mu = process.memoryUsage();
      rssTrend.push(mu.rss / 1048576);
      heapTrend.push(mu.heapUsed / 1048576);
      rmSync(dir, { recursive: true, force: true });
      await fake.close();
    }
    console.log(`\n[5] Memory trend across ${RUNS} sequential runs in one process`);
    console.log(`  RSS MB per run:  ${rssTrend.map((v) => v.toFixed(0)).join(' ')}`);
    console.log(`  heapUsed MB/run: ${heapTrend.map((v) => v.toFixed(0)).join(' ')}  (gc ${gc ? 'forced' : 'NOT exposed — heap may include uncollected garbage'})`);
    const slope = (rssTrend[rssTrend.length - 1] - rssTrend[2]) / Math.max(1, rssTrend.length - 3);
    console.log(`  RSS slope after warmup: ${slope.toFixed(2)} MB/run; avg emit cost run1 ${(emitTrend[0]).toFixed(1)}µs vs last ${(emitTrend[emitTrend.length - 1]).toFixed(1)}µs`);
    console.log(`  process listeners: unhandledRejection=${process.listenerCount('unhandledRejection')} uncaughtException=${process.listenerCount('uncaughtException')} warning=${process.listenerCount('warning')}`);
    void firstRun;
  }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
