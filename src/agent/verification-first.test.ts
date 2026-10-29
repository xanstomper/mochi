// Verification-first default mode — loop integration tests (scripted fake
// provider, REAL harness, REAL reproduction executions).
//
// The mode: on a fix task the agent must produce a recorded reproduction
// before editing (the reproduce-first gate), and after the agent concludes,
// the critic re-derives the conclusion from the recorded evidence alone —
// the SAME reproduction must fail before the fix and pass after it. A
// conclusion the evidence does not support is blocked with the gap named,
// never silently softened into a passing claim.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI, type FakeScriptResponse } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

const MATH_BUGGY = 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n';
const REPRO_JS = 'const { add } = require("./math.js");\nif (add(2, 3) !== 5) { console.log("WRONG: add(2,3)=" + add(2, 3)); process.exit(1); }\nconsole.log("OK");\n';
const EDIT_ARGS = JSON.stringify({ path: 'math.js', oldText: 'return a - b', newText: 'return a + b' });
/** Changes the file WITHOUT fixing the bug (a review marker above the export). */
const COSMETIC_ARGS = JSON.stringify({ path: 'math.js', oldText: 'module.exports = { add };', newText: '// reviewed\nmodule.exports = { add };' });

function makeConfig(dir: string, url: string, extraSafety: Record<string, unknown> = {}): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000, ...extraSafety },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

/** An existing (non-greenfield) git repo with a real failing repro. */
function makeRepo(opts: { testScript?: string; silentTest?: boolean } = {}): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-vf-'));
  const testScript = opts.testScript ?? 'node repro.js';
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: testScript } }));
  writeFileSync(resolve(dir, 'math.js'), MATH_BUGGY);
  writeFileSync(resolve(dir, 'repro.js'), REPRO_JS);
  if (opts.silentTest) writeFileSync(resolve(dir, 'other.test.js'), 'process.exit(0);\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@mochi.agent'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Mochi Test'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

interface RunCapture { logs: string[]; }

function wireBus(): { bus: EventBus; cap: RunCapture } {
  const bus = new EventBus();
  const cap: RunCapture = { logs: [] };
  bus.onAll((e) => {
    if (e.type === 'agent:log') cap.logs.push(String((e as { message?: unknown }).message ?? ''));
  });
  return { bus, cap };
}

async function runScripted(
  dir: string,
  taskTitle: string,
  taskDesc: string,
  script: FakeScriptResponse[],
  bus: EventBus,
  configExtras: Record<string, unknown> = {},
  taskOpts: { verificationCommand?: string; reproExempt?: boolean } = {},
) {
  const fake = await startFakeOpenAI(script);
  try {
    const config = makeConfig(dir, fake.url, configExtras);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal(taskTitle);
    const agent = new Agent({ role: 'coder', config, workspace, events: bus, cwd: dir, context });
    const task = createTask(taskTitle, taskDesc, taskOpts);
    const result = await agent.run(task);
    const toolMessages = context.getMessages().filter((m) => m.role === 'tool').map((m) => String(m.content ?? ''));
    return { result, toolMessages, taskId: task.id };
  } finally {
    await fake.close();
  }
}

const FIX_TITLE = 'Fix the bug in math.js: add() returns the wrong result';
const FIX_DESC = 'add(a, b) in math.js subtracts instead of adding, so the repro script repro.js fails. Diagnose the root cause in the existing code and correct the arithmetic.';

describe('verification-first default mode', () => {
  let dir: string | undefined;
  afterEach(() => {
    delete process.env.MOCHI_REPRO_FIRST;
    delete process.env.MOCHI_REPRO_SYNTH;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('records the reproduction and the critic passes the evidenced fix', async () => {
    dir = makeRepo();
    const { bus, cap } = wireBus();
    const { result, taskId } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
      { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: EDIT_ARGS } }] },
      // The veto sends the model to reproduce first; this run FAILS — that
      // is the before-half of the evidence.
      { finishReason: 'tool_calls', toolCalls: [{ id: 's1', function: { name: 'shell', arguments: JSON.stringify({ command: 'node repro.js' }) } }] },
      { finishReason: 'tool_calls', toolCalls: [{ id: 'e2', function: { name: 'edit', arguments: EDIT_ARGS } }] },
      { content: 'Fixed add() to return a + b; the repro now passes.', finishReason: 'stop' },
    ], bus);

    expect(result.success).toBe(true);
    // The critic's provenance line rides the summary.
    expect(result.summary).toContain('Critic:');
    expect(result.summary).toContain('node repro.js');
    expect(cap.logs.some((m) => m.includes('[verification-first] critic verdict: supported'))).toBe(true);
    // The reproduction is KEPT WITH THE TASK: pre-phase failing observation
    // + post-phase green re-run of the same command, persisted.
    const ledger = JSON.parse(readFileSync(resolve(dir, '.mochi/state/repro-ledger.json'), 'utf8'));
    const record = ledger.tasks[taskId];
    expect(record).toBeDefined();
    expect(record.observations.some((o: { phase: string; command: string; failed: boolean }) => o.phase === 'pre' && o.command === 'node repro.js' && o.failed)).toBe(true);
    expect(record.observations.some((o: { phase: string; command: string; failed: boolean }) => o.phase === 'post' && o.command === 'node repro.js' && !o.failed)).toBe(true);
  }, 180_000);

  it('critic blocks an evidence-free conclusion (edit after veto, no reproduction)', async () => {
    dir = makeRepo();
    const { bus, cap } = wireBus();
    const { result, toolMessages } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
      { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: EDIT_ARGS } }] },
      // Model insists WITHOUT reproducing: the bypass is recorded...
      { finishReason: 'tool_calls', toolCalls: [{ id: 'e2', function: { name: 'edit', arguments: EDIT_ARGS } }] },
      { content: 'Fixed add() to return a + b.', finishReason: 'stop' },
    ], bus, { maxVerifyRetries: 0 });

    expect(toolMessages.some((m) => m.includes('REPRODUCE FIRST'))).toBe(true);
    expect(cap.logs.some((m) => m.includes('[repro-first] model mutated without reproducing'))).toBe(true);
    // ...but the CONCLUSION is blocked: no reproduction exists, so the fix
    // cannot be recorded as done.
    expect(result.success).toBe(false);
    expect(result.stopReason).toBe('verification_failed');
    expect(result.summary).toContain('VERIFICATION CRITIC');
    expect(result.summary).toContain('no reproduction exists');
    expect(cap.logs.some((m) => m.includes('[verification-first] critic verdict: blocked'))).toBe(true);
  }, 180_000);

  it('critic catches a false fix: the recorded reproduction still fails after the edit', async () => {
    // The repo suite passes WITHOUT touching the bug (silent placeholder),
    // so the verify gate alone would pass the run — the reproduction pair
    // is what catches it.
    dir = makeRepo({ testScript: 'node other.test.js', silentTest: true });
    const { bus, cap } = wireBus();
    const { result } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
      // Reproduce FIRST (observed failure recorded), then a cosmetic edit
      // that does not fix anything, then claim done.
      { finishReason: 'tool_calls', toolCalls: [{ id: 's1', function: { name: 'shell', arguments: JSON.stringify({ command: 'node repro.js' }) } }] },
      { finishReason: 'tool_calls', toolCalls: [{ id: 'c1', function: { name: 'edit', arguments: COSMETIC_ARGS } }] },
      { content: 'Touched the function signature line; fixed.', finishReason: 'stop' },
    ], bus, { maxVerifyRetries: 0 });

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe('verification_failed');
    expect(result.summary).toContain('still fails after the fix');
    expect(cap.logs.some((m) => m.includes('[verification-first] critic verdict: blocked'))).toBe(true);
  }, 180_000);

  it('harness A/B produces the missing before-half when the model bypassed', async () => {
    dir = makeRepo();
    // Disable repro synthesis so nothing else produces the before-half —
    // only the critic's own stash A/B can.
    process.env.MOCHI_REPRO_SYNTH = '0';
    const { bus, cap } = wireBus();
    const { result } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
      { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: EDIT_ARGS } }] },
      { finishReason: 'tool_calls', toolCalls: [{ id: 'e2', function: { name: 'edit', arguments: EDIT_ARGS } }] },
      { content: 'Fixed add() to return a + b.', finishReason: 'stop' },
    ], bus, {}, { verificationCommand: 'node repro.js' });

    // The critic stashed the fix, ran the reproduction on the ORIGINAL tree
    // (failed), restored the fix, re-ran it (passed) — real executions.
    expect(result.success).toBe(true);
    expect(result.summary).toContain('harness A/B');
    expect(cap.logs.some((m) => m.includes('[verification-first] critic verdict: supported'))).toBe(true);
    // The fix survived the stash round-trip.
    expect(readFileSync(resolve(dir, 'math.js'), 'utf8')).toContain('return a + b');
  }, 180_000);

  it('task annotation reproExempt skips the gate and the critic, and is logged', async () => {
    dir = makeRepo();
    const { bus, cap } = wireBus();
    const { result, toolMessages } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
      { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: EDIT_ARGS } }] },
      { content: 'Fixed add() to return a + b.', finishReason: 'stop' },
    ], bus, {}, { reproExempt: true });

    expect(toolMessages.some((m) => m.includes('REPRODUCE FIRST'))).toBe(false);
    expect(cap.logs.some((m) => m.includes('[verification-first] not enforced on fix task: task annotation reproExempt'))).toBe(true);
    expect(result.success).toBe(true);
  }, 180_000);

  it('config safety.verificationFirst=false disables the mode (logged opt-out)', async () => {
    dir = makeRepo();
    const { bus, cap } = wireBus();
    const { result, toolMessages } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
      { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: EDIT_ARGS } }] },
      { content: 'Fixed add() to return a + b.', finishReason: 'stop' },
    ], bus, { verificationFirst: false });

    expect(toolMessages.some((m) => m.includes('REPRODUCE FIRST'))).toBe(false);
    expect(cap.logs.some((m) => m.includes('[verification-first] not enforced on fix task: safety.verificationFirst=false'))).toBe(true);
    expect(result.success).toBe(true);
  }, 180_000);
});
