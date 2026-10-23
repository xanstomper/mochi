// Wave R1 — fast lane, loop-level behavior (fake provider, FIFO scripts).
//
// Proves the contract end to end:
//   (a) a simple one-file fix ENTERS the lane: shrunken advertised toolset,
//       no repo map in the first request, unified memory NOT injected;
//   (b) the same run under the standard profile pays for all of that
//       machinery (control);
//   (c) zero-change in the lane still BLOCKs (fast lane ≠ sloppy lane);
//   (d) a first verify failure RELEASES memory (struggle-gated recall)
//       without escalating;
//   (e) a task that secretly spans four files ESCALATES mid-run with
//       reason 'files-edited' and still completes;
//   (f) MOCHI_FASTLANE=0 keeps every run out of the lane.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { MemoryStore } from '../memory/memory.js';
import { loadFastLaneStats, falseShortRate } from '../core/fastlane-stats.js';
import { startFakeOpenAI, type FakeScriptResponse } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

const MATH_BUGGY = 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n';
const REPRO_JS = 'const { add } = require("./math.js");\nif (add(2, 3) !== 5) { console.log("WRONG: add(2,3)=" + add(2, 3)); process.exit(1); }\nconsole.log("OK");\n';
const MEMORY_TOKEN = 'PROBE-MEMORY-7f3d9';

const FIX_TITLE = 'Fix the add function in math.js';
const FIX_DESC = 'add(a, b) in math.js subtracts instead of adding. Correct the arithmetic so add(2, 3) returns 5.';

function makeConfig(dir: string, url: string, opts: { fastlane?: boolean; maxVerifyRetries?: number } = {}): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model', speculative: { preflight: false } },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000, maxVerifyRetries: opts.maxVerifyRetries ?? 3 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
    ...(opts.fastlane === false ? { fastlane: { enabled: false } } : {}),
  } as unknown as MochiConfig;
}

function gitRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-fastlane-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(resolve(dir, name), content);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@mochi.agent'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Mochi Test'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

function mathRepo(): string {
  return gitRepo({
    'package.json': JSON.stringify({ name: 'p', scripts: { test: 'node repro.js' } }),
    'math.js': MATH_BUGGY,
    'repro.js': REPRO_JS,
  });
}

function plantMemory(dir: string): void {
  const store = new MemoryStore(resolve(dir, '.mochi'));
  store.add({
    id: 'fastlane-probe',
    kind: 'convention',
    title: 'math.js add function convention',
    body: `When fixing the add function in math.js keep the CommonJS export shape. Probe token ${MEMORY_TOKEN}.`,
    tags: ['math'],
    source: 'fastlane-test',
  } as never);
}

function wireBus(): { bus: EventBus; logs: string[] } {
  const bus = new EventBus();
  const logs: string[] = [];
  bus.onAll((e) => {
    if (e.type === 'agent:log') logs.push(String((e as { message?: unknown }).message ?? ''));
  });
  return { bus, logs };
}

interface RunOpts { fastlane?: boolean; maxVerifyRetries?: number; verificationCommand?: string }

async function runScripted(dir: string, title: string, desc: string, script: FakeScriptResponse[], bus: EventBus, opts: RunOpts = {}) {
  const fake = await startFakeOpenAI(script);
  try {
    const config = makeConfig(dir, fake.url, opts);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal(title);
    const agent = new Agent({ role: 'coder', config, workspace, events: bus, cwd: dir, context });
    const task = createTask(title, desc, opts.verificationCommand ? { verificationCommand: opts.verificationCommand } : {});
    const result = await agent.run(task);
    return { result, requests: fake.requests.map((r) => r.body as Record<string, unknown>), agent };
  } finally {
    await fake.close();
  }
}

const tool = (id: string, name: string, args: Record<string, unknown>): FakeScriptResponse => ({
  finishReason: 'tool_calls',
  toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
});
const claim = (content: string): FakeScriptResponse => ({ content, finishReason: 'stop' });

const bodyText = (body: unknown): string => JSON.stringify(body);

describe('fast lane (loop)', () => {
  let dirs: string[] = [];
  afterEach(() => {
    delete process.env.MOCHI_FASTLANE;
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });
  const track = (d: string): string => { dirs.push(d); return d; };

  it('(a)+(b) a simple one-file fix enters the lane: fewer tools, no repo map, no memory — the standard profile pays for all three', async () => {
    const script = (): FakeScriptResponse[] => [
      tool('s1', 'shell', { command: 'node repro.js' }),
      tool('e1', 'edit', { path: 'math.js', oldText: 'return a - b', newText: 'return a + b' }),
      claim('Fixed add() to return a + b.'),
    ];

    // Fast lane run.
    const fastDir = track(mathRepo());
    plantMemory(fastDir);
    const fastBus = wireBus();
    const fast = await runScripted(fastDir, FIX_TITLE, FIX_DESC, script(), fastBus.bus, { verificationCommand: 'node repro.js' });
    expect(fast.result.success).toBe(true);
    expect(fast.result.fastLane?.entered).toBe(true);
    expect(fast.result.fastLane?.escalated).toBe(false);
    expect(fastBus.logs.some((m) => m.includes('[fastlane] entered'))).toBe(true);
    const fastFirst = fast.requests[0];
    const fastTools = (fastFirst.tools as unknown[] | undefined)?.length ?? 0;
    expect(fastTools).toBeGreaterThan(0);
    expect(fastTools).toBeLessThanOrEqual(14);
    expect(bodyText(fastFirst)).not.toContain('REPO MAP (');
    expect(bodyText(fastFirst)).not.toContain(MEMORY_TOKEN);
    // Stats recorded the entry.
    const stats = loadFastLaneStats(new Workspace(fastDir, '.mochi'));
    expect(stats.entries).toBe(1);
    expect(stats.completedInLane).toBe(1);
    expect(existsSync(resolve(fastDir, '.mochi/state/fastlane.json'))).toBe(true);

    // Standard control: same repo, same script, lane disabled by config.
    const stdDir = track(mathRepo());
    plantMemory(stdDir);
    const stdBus = wireBus();
    const std = await runScripted(stdDir, FIX_TITLE, FIX_DESC, script(), stdBus.bus, { fastlane: false, verificationCommand: 'node repro.js' });
    expect(std.result.success).toBe(true);
    expect(std.result.fastLane).toBeUndefined();
    const stdFirst = std.requests[0];
    const stdTools = (stdFirst.tools as unknown[] | undefined)?.length ?? 0;
    expect(stdTools).toBeGreaterThan(fastTools);
    // The standard profile pays for the machinery the lane skips: unified
    // memory retrieval lands the planted fact in its first request, and
    // its prompt is strictly larger overall. (No 'REPO MAP' contrast on
    // this fixture: the codegraph builds no symbol graph for a two-file
    // CommonJS repo, so neither profile renders one — the lane's map skip
    // is proven by construction and by the bench's token columns on
    // graphable repos.)
    expect(bodyText(stdFirst)).toContain(MEMORY_TOKEN);
    expect(bodyText(stdFirst).length).toBeGreaterThan(bodyText(fastFirst).length);
  }, 120_000);

  it('(c) zero-change in the lane still BLOCKs — the evidence standard is unchanged', async () => {
    const dir = track(mathRepo());
    const { bus } = wireBus();
    const { result } = await runScripted(dir, FIX_TITLE, FIX_DESC, [claim('All fixed, trust me.')], bus, { maxVerifyRetries: 1 });
    expect(result.success).toBe(false);
    expect(result.stopReason).toBe('verification_failed');
    expect(result.summary).toContain('changed no files');
    expect(result.fastLane?.entered).toBe(true);
  }, 120_000);

  it('(d) a first verify failure releases memory (struggle-gated recall) without escalating', async () => {
    const dir = track(mathRepo());
    plantMemory(dir);
    const { bus, logs } = wireBus();
    const { result, requests } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
      tool('s1', 'shell', { command: 'node repro.js' }),
      tool('e1', 'edit', { path: 'math.js', oldText: 'return a - b', newText: 'return a * b' }), // wrong fix
      claim('Fixed it.'),                                        // -> fast-lane verify FAILS
      tool('e2', 'edit', { path: 'math.js', oldText: 'return a * b', newText: 'return a + b' }),
      claim('Fixed add() to return a + b.'),
    ], bus, { verificationCommand: 'node repro.js' });

    expect(result.success).toBe(true);
    expect(result.fastLane?.entered).toBe(true);
    expect(result.fastLane?.escalated).toBe(false);
    expect(logs.some((m) => m.includes('memory released on struggle signal'))).toBe(true);
    // Memory absent while gated, present in the first request after release.
    expect(bodyText(requests[2])).not.toContain(MEMORY_TOKEN);
    expect(bodyText(requests[3])).toContain(MEMORY_TOKEN);
  }, 120_000);

  it('(e) a secretly four-file bug escalates with reason files-edited and still completes', async () => {
    const mod = (name: string): string => `function total_${name}(a, b) { return a - b; }\nmodule.exports = { total_${name} };\n`;
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'p', scripts: { test: 'node tests.js' } }),
      'tests.js': [
        'const mods = ["cart", "wishlist", "invoice", "checkout"];',
        'let failed = false;',
        'for (const m of mods) { const fn = require("./" + m + ".js")["total_" + m]; if (fn(2, 3) !== 5) { console.log("FAIL " + m + ".js"); failed = true; } }',
        'if (failed) process.exit(1);',
        'console.log("ALL OK");',
        '',
      ].join('\n'),
    };
    for (const m of ['cart', 'wishlist', 'invoice', 'checkout']) files[`${m}.js`] = mod(m);
    const dir = track(gitRepo(files));
    const { bus, logs } = wireBus();
    const fix = (id: string, f: string): FakeScriptResponse => tool(id, 'edit', { path: f, oldText: 'return a - b', newText: 'return a + b' });
    const { result } = await runScripted(dir, 'Fix the total bug in cart.js', 'total_cart(a, b) in cart.js subtracts instead of adding. Correct it so totals come out right.', [
      tool('s0', 'shell', { command: 'node tests.js' }),  // reproduce first (repro gate) — FAIL lists all four files
      tool('r1', 'read', { path: 'cart.js' }),
      fix('e1', 'cart.js'),
      tool('s1', 'shell', { command: 'node tests.js' }),  // FAIL wishlist/invoice/checkout
      { finishReason: 'tool_calls', toolCalls: ['wishlist', 'invoice', 'checkout'].map((m, i) => ({ id: `r${i + 2}`, function: { name: 'read', arguments: JSON.stringify({ path: `${m}.js` }) } })) },
      fix('e2', 'wishlist.js'),
      fix('e3', 'invoice.js'),
      fix('e4', 'checkout.js'),                          // 4th file edited -> escalation at next iteration
      tool('s2', 'shell', { command: 'node tests.js' }),
      claim('All four totals fixed.'),
    ], bus, { verificationCommand: 'node tests.js' });

    expect(result.success).toBe(true);
    expect(result.fastLane?.entered).toBe(true);
    expect(result.fastLane?.escalated).toBe(true);
    expect(result.fastLane?.escalationReason).toBe('files-edited');
    expect(logs.some((m) => m.includes('[fastlane] escalated'))).toBe(true);
    const stats = loadFastLaneStats(new Workspace(dir, '.mochi'));
    expect(stats.escalations).toBe(1);
    expect(stats.escalationsByReason['files-edited']).toBe(1);
    expect(falseShortRate(stats)).toBe(1);
  }, 120_000);

  it('(f) MOCHI_FASTLANE=0 keeps the run out of the lane entirely', async () => {
    process.env.MOCHI_FASTLANE = '0';
    const dir = track(mathRepo());
    const { bus, logs } = wireBus();
    const { result } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
      tool('s1', 'shell', { command: 'node repro.js' }),
      tool('e1', 'edit', { path: 'math.js', oldText: 'return a - b', newText: 'return a + b' }),
      claim('Fixed add() to return a + b.'),
    ], bus, { verificationCommand: 'node repro.js' });
    expect(result.success).toBe(true);
    expect(result.fastLane).toBeUndefined();
    expect(logs.some((m) => m.includes('[fastlane] entered'))).toBe(false);
  }, 120_000);
});
