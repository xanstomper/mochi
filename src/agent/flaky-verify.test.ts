// Flaky-test quarantine at the in-loop completion gate (Agent.verify):
// a check that fails once and passes on a bounded re-run of the unchanged
// command must NOT block the run — it completes as FLAKY-PASS, loudly —
// while a consistent failure still ends the run verification_failed with
// bounded attempts. Scripted fake provider, real shell execution of the
// deterministic flake fixtures (counter files), same idiom as
// repro-first.test.ts.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI, type FakeScriptResponse } from '../testutil/fake-openai.js';
import { loadFlakyRegistry } from '../core/flaky.js';
import type { MochiConfig } from '../types.js';

const MATH_BUGGY = 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n';
const REPRO_JS = 'const { add } = require("./math.js");\nif (add(2, 3) !== 5) { console.log("WRONG"); process.exit(1); }\nconsole.log("OK");\n';

/** Fails on its first execution (counter file), passes afterwards. */
const FLAKE_ONCE_JS = `
const fs = require('fs');
const path = require('path');
const counter = path.join(__dirname, 'flake-count.txt');
let n = 0;
try { n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch {}
fs.writeFileSync(counter, String(n + 1));
if (n === 0) {
  console.log(' FAIL  test/counter.test.js > counter increments');
  console.log('AssertionError: expected 1 to be 2');
  process.exit(1);
}
console.log('counter check passed');
`;

const ALWAYS_FAIL_JS = `
const fs = require('fs');
const path = require('path');
const counter = path.join(__dirname, 'fail-count.txt');
let n = 0;
try { n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch {}
fs.writeFileSync(counter, String(n + 1));
console.log(' FAIL  test/broken.test.js > always broken');
console.log('AssertionError: expected true to be false');
process.exit(1);
`;

function makeConfig(dir: string, url: string): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000, maxVerifyRetries: 1 },
    // gitDestructive off: the exhausted-verify rollback would `git clean` the
    // untracked counter files these tests assert on. Rollback behavior is
    // covered elsewhere; this suite measures verify attempts.
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

function makeRepo(scriptName: string, scriptBody: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-flaky-loop-'));
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: {} }));
  writeFileSync(resolve(dir, 'math.js'), MATH_BUGGY);
  writeFileSync(resolve(dir, 'repro.js'), REPRO_JS);
  writeFileSync(resolve(dir, scriptName), scriptBody);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@mochi.agent'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Mochi Test'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

const FIX_TITLE = 'Fix the bug in math.js: add() returns the wrong result';
const FIX_DESC = 'add(a, b) in math.js subtracts instead of adding, so the repro script repro.js fails. Diagnose the root cause in the existing code and correct the arithmetic.';
const EDIT_ARGS = JSON.stringify({ path: 'math.js', oldText: 'return a - b', newText: 'return a + b' });

async function runScripted(dir: string, verificationCommand: string, script: FakeScriptResponse[]) {
  const fake = await startFakeOpenAI(script);
  const logs: string[] = [];
  try {
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const bus = new EventBus();
    bus.onAll((e) => {
      if (e.type === 'agent:log') logs.push(String((e as { message?: unknown }).message ?? ''));
    });
    const context = new ContextEngine(config, dir);
    context.setGoal(FIX_TITLE);
    const agent = new Agent({ role: 'coder', config, workspace, events: bus, cwd: dir, context });
    const task = createTask(FIX_TITLE, FIX_DESC, { verificationCommand });
    const result = await agent.run(task);
    return { result, logs };
  } finally {
    await fake.close();
  }
}

const SCRIPT_PREFIX: FakeScriptResponse[] = [
  // Reproduce first (the repro-first gate requires it on fix tasks).
  { finishReason: 'tool_calls', toolCalls: [{ id: 's1', function: { name: 'shell', arguments: JSON.stringify({ command: 'node repro.js' }) } }] },
  // Apply the fix.
  { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: EDIT_ARGS } }] },
];

describe('loop verify gate — flaky quarantine', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('(a) a fail-once check completes the run as FLAKY-PASS with the flake loudly surfaced', async () => {
    dir = makeRepo('flake-once.js', FLAKE_ONCE_JS);
    const { result, logs } = await runScripted(dir, 'node flake-once.js', [
      ...SCRIPT_PREFIX,
      { content: 'Fixed add() to return a + b.', finishReason: 'stop' },
    ]);
    expect(result.success).toBe(true);
    expect(result.stopReason).toBe('completed');
    // Loud in the run summary and the event log — never silent.
    expect(result.summary).toContain('FLAKY');
    expect(result.summary).toContain('test/counter.test.js > counter increments');
    expect(logs.some((m) => m.includes('[flaky]'))).toBe(true);
    // The check ran exactly twice: failure + one bounded re-run.
    expect(readFileSync(resolve(dir, 'flake-count.txt'), 'utf8')).toBe('2');
    // Registry persisted the flake under .mochi/state.
    expect(existsSync(resolve(dir, '.mochi', 'state', 'flaky-tests.json'))).toBe(true);
    const reg = loadFlakyRegistry(new Workspace(dir, '.mochi'));
    expect(reg.entries['test/counter.test.js > counter increments']?.score).toBe(1);
    expect(readFileSync(resolve(dir, 'math.js'), 'utf8')).toContain('return a + b');
  }, 120_000);

  it('(b) a consistent failure still fails the run, with bounded re-runs per verify', async () => {
    dir = makeRepo('always-fail.js', ALWAYS_FAIL_JS);
    const { result } = await runScripted(dir, 'node always-fail.js', [
      ...SCRIPT_PREFIX,
      { content: 'Fixed add() to return a + b.', finishReason: 'stop' },
      { content: 'Fixed add() to return a + b.', finishReason: 'stop' },
    ]);
    expect(result.success).toBe(false);
    expect(result.stopReason).toBe('verification_failed');
    // maxVerifyRetries = 1 → two verify passes; each pass executes the
    // failing command 1 + 2 bounded re-runs = 3 times. 6 total, not a loop.
    expect(readFileSync(resolve(dir, 'fail-count.txt'), 'utf8')).toBe('6');
    // Consistent failures never enter the flaky registry.
    const reg = loadFlakyRegistry(new Workspace(dir, '.mochi'));
    expect(reg.entries['test/broken.test.js > always broken']).toBeUndefined();
  }, 120_000);
});
