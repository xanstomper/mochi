// Reproduce-first gate + speculative-preflight default policy.
//
// Upgrade 1: the fix/debug kind hint always TOLD the model to reproduce
// before editing, but nothing enforced it. The gate vetoes the FIRST
// mutating call on a fix task until a shell/verify/bg_task call has actually
// executed (a failing repro counts — observing the failure is the point).
// One veto only: a model that insists is let through with the bypass
// recorded, so tasks with no runnable entrypoint are never trapped.
//
// Upgrade 2: speculative preflight used to be opt-in only
// (config.model.speculative.preflight === true), so it never ran. It now
// defaults ON for structurally complex tasks at medium+ reasoning, with
// explicit config and MOCHI_SPECULATIVE_PREFLIGHT=0 both able to kill it.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent, specPreflightDefault } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI, type FakeScriptResponse } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

const MATH_BUGGY = 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n';
const REPRO_JS = 'const { add } = require("./math.js");\nif (add(2, 3) !== 5) { console.log("WRONG: add(2,3)=" + add(2, 3)); process.exit(1); }\nconsole.log("OK");\n';

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

/** A small existing (non-greenfield) repo with a real failing repro. */
function makeRepo(testScript = 'node repro.js'): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-repro-'));
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: testScript } }));
  writeFileSync(resolve(dir, 'math.js'), MATH_BUGGY);
  writeFileSync(resolve(dir, 'repro.js'), REPRO_JS);
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

async function runScripted(dir: string, taskTitle: string, taskDesc: string, script: FakeScriptResponse[], bus: EventBus = new EventBus(), configExtras: Record<string, unknown> = {}) {
  const fake = await startFakeOpenAI(script);
  try {
    const config = makeConfig(dir, fake.url, configExtras);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal(taskTitle);
    const agent = new Agent({ role: 'coder', config, workspace, events: bus, cwd: dir, context });
    const result = await agent.run(createTask(taskTitle, taskDesc));
    // Tool results land in the context as role:'tool' messages — the veto
    // text is asserted from there (that's what the model actually sees).
    const toolMessages = context.getMessages().filter((m) => m.role === 'tool').map((m) => String(m.content ?? ''));
    return { result, toolMessages, requests: fake.requests.length };
  } finally {
    await fake.close();
  }
}

const FIX_TITLE = 'Fix the bug in math.js: add() returns the wrong result';
const FIX_DESC = 'add(a, b) in math.js subtracts instead of adding, so the repro script repro.js fails. Diagnose the root cause in the existing code and correct the arithmetic.';
const EDIT_ARGS = JSON.stringify({ path: 'math.js', oldText: 'return a - b', newText: 'return a + b' });

describe('reproduce-first gate', () => {
  let dir: string | undefined;
  afterEach(() => {
    delete process.env.MOCHI_REPRO_FIRST;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('vetoes the first edit on a fix task, allows it after a repro shell run', async () => {
    dir = makeRepo();
    const { bus, cap } = wireBus();
    {
      const { result, toolMessages } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
        // Turn 1: edit immediately -> vetoed, nothing written.
        { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: EDIT_ARGS } }] },
        // Turn 2: reproduce via shell (exits 1 — that IS the reproduction).
        { finishReason: 'tool_calls', toolCalls: [{ id: 's1', function: { name: 'shell', arguments: JSON.stringify({ command: 'node repro.js' }) } }] },
        // Turn 3: the same edit now goes through.
        { finishReason: 'tool_calls', toolCalls: [{ id: 'e2', function: { name: 'edit', arguments: EDIT_ARGS } }] },
        // Turn 4: done.
        { content: 'Fixed add() to return a + b; the repro script now passes.', finishReason: 'stop' },
      ], bus);

      // The veto reached the model as a tool result with the directive.
      expect(toolMessages.some((m) => m.includes('REPRODUCE FIRST'))).toBe(true);
      expect(cap.logs.some((m) => m.includes('[repro-first] vetoed first mutating call'))).toBe(true);
      // The edit eventually landed and the run completed.
      expect(readFileSync(resolve(dir, 'math.js'), 'utf8')).toContain('return a + b');
      expect(result.success).toBe(true);
    }
  }, 120_000);

  it('lets a second mutation through (one veto, bypass logged) but the critic blocks the evidence-free conclusion', async () => {
    dir = makeRepo();
    const { bus, cap } = wireBus();
    {
      const { result, toolMessages } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
        { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: EDIT_ARGS } }] },
        // Model insists WITHOUT reproducing: allowed (never trap the run)...
        { finishReason: 'tool_calls', toolCalls: [{ id: 'e2', function: { name: 'edit', arguments: EDIT_ARGS } }] },
        { content: 'Fixed add() to return a + b.', finishReason: 'stop' },
      ], bus, { maxVerifyRetries: 0 });

      expect(toolMessages.some((m) => m.includes('REPRODUCE FIRST'))).toBe(true);
      expect(cap.logs.some((m) => m.includes('[repro-first] model mutated without reproducing'))).toBe(true);
      // ...verification-first: the CONCLUSION is not taken on the model's
      // word — with no reproduction recorded, the critic blocks it, and at
      // retry exhaustion the harness rolls the unevidenced edit back (the
      // work is not recorded as done, and it does not survive as "fixed").
      expect(result.success).toBe(false);
      expect(result.stopReason).toBe('verification_failed');
      expect(result.summary).toContain('VERIFICATION CRITIC');
      expect(readFileSync(resolve(dir, 'math.js'), 'utf8')).toContain('return a - b');
    }
  }, 120_000);

  it('does not veto an immediate edit on an implement task', async () => {
    // Passing suite: this test is about the gate, not verification — with
    // the failing repro as `npm test`, verify() would (correctly) roll the
    // edit back after the run, masking the gate behavior under test.
    dir = makeRepo('node -e "process.exit(0)"');
    const { toolMessages } = await runScripted(dir,
      'Add a subtract function to math.js',
      'Add and export a subtract(a, b) function in the existing math.js module next to add().',
      [
        { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: JSON.stringify({ path: 'math.js', oldText: 'module.exports = { add };', newText: 'function subtract(a, b) { return a - b; }\nmodule.exports = { add, subtract };' }) } }] },
        { content: 'Added subtract() to math.js.', finishReason: 'stop' },
      ]);

    expect(toolMessages.some((m) => m.includes('REPRODUCE FIRST'))).toBe(false);
    expect(readFileSync(resolve(dir, 'math.js'), 'utf8')).toContain('function subtract');
  }, 120_000);

  it('does not veto creating a NEW file, but still gates a later edit to an existing file', async () => {
    dir = makeRepo();
    const { bus, cap } = wireBus();
    {
      const { result, toolMessages } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
        // Turn 1: write a brand-new file (notes.txt does not exist yet).
        // Creating an artifact is not patching existing behavior: the gate
        // must skip it — no veto spent, no bypass recorded.
        { finishReason: 'tool_calls', toolCalls: [{ id: 'w1', function: { name: 'write', arguments: JSON.stringify({ path: 'notes.txt', content: 'diagnosis notes\n' }) } }] },
        // Turn 2: edit the EXISTING math.js, still without any repro. The
        // gate must fire HERE — the exempt creation in turn 1 neither spent
        // the veto nor disarmed the gate via fileChanged.
        { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: EDIT_ARGS } }] },
        // Turn 3: model insists — the single veto was spent on turn 2, so
        // this goes through as the recorded bypass and the edit lands.
        { finishReason: 'tool_calls', toolCalls: [{ id: 'e2', function: { name: 'edit', arguments: EDIT_ARGS } }] },
        { content: 'Created notes.txt and fixed add() to return a + b.', finishReason: 'stop' },
      ], bus, { maxVerifyRetries: 0 });

      // ...with exactly ONE veto in the whole run, spent on the existing-
      // file edit (turn 2), not on the creation (turn 1).
      expect(toolMessages.filter((m) => m.includes('REPRODUCE FIRST'))).toHaveLength(1);
      expect(cap.logs.filter((m) => m.includes('[repro-first] vetoed first mutating call'))).toHaveLength(1);
      // The bypass belongs to the post-veto existing-file edit in turn 3.
      expect(cap.logs.some((m) => m.includes('[repro-first] model mutated without reproducing'))).toBe(true);
      // Verification-first: the bypassed conclusion cannot complete — no
      // reproduction exists, so the critic blocks it; at retry exhaustion
      // the rollback wipes both the edit and the untracked notes file.
      expect(result.success).toBe(false);
      expect(result.summary).toContain('VERIFICATION CRITIC');
      expect(readFileSync(resolve(dir, 'math.js'), 'utf8')).toContain('return a - b');
    }
  }, 120_000);

  it('is disabled by MOCHI_REPRO_FIRST=0', async () => {
    dir = makeRepo();
    process.env.MOCHI_REPRO_FIRST = '0';
    const { toolMessages } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
      { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: EDIT_ARGS } }] },
      { content: 'Fixed add() to return a + b.', finishReason: 'stop' },
    ]);

    expect(toolMessages.some((m) => m.includes('REPRODUCE FIRST'))).toBe(false);
    expect(readFileSync(resolve(dir, 'math.js'), 'utf8')).toContain('return a + b');
  }, 120_000);
});

describe('specPreflightDefault policy', () => {
  it('defaults ON only for complex tasks at medium+ reasoning', () => {
    expect(specPreflightDefault({ complexity: 'complex', reasoning: 'medium' })).toBe(true);
    expect(specPreflightDefault({ complexity: 'complex', reasoning: 'high' })).toBe(true);
    expect(specPreflightDefault({ complexity: 'complex', reasoning: 'max' })).toBe(true);
    expect(specPreflightDefault({ complexity: 'complex', reasoning: 'low' })).toBe(false);
    expect(specPreflightDefault({ complexity: 'complex', reasoning: 'off' })).toBe(false);
    expect(specPreflightDefault({ complexity: 'standard', reasoning: 'max' })).toBe(false);
    expect(specPreflightDefault({ complexity: 'simple', reasoning: 'max' })).toBe(false);
    expect(specPreflightDefault({})).toBe(false);
  });

  it('explicit config wins both ways; env 0 is a hard kill-switch', () => {
    expect(specPreflightDefault({ configured: true, complexity: 'simple', reasoning: 'low' })).toBe(true);
    expect(specPreflightDefault({ configured: false, complexity: 'complex', reasoning: 'max' })).toBe(false);
    expect(specPreflightDefault({ configured: true, env: '0', complexity: 'complex', reasoning: 'max' })).toBe(false);
    expect(specPreflightDefault({ env: '1', complexity: 'complex', reasoning: 'high' })).toBe(true);
  });
});

describe('speculative preflight default (end-to-end)', () => {
  let dir: string | undefined;
  afterEach(() => {
    delete process.env.MOCHI_SPECULATIVE_PREFLIGHT;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a complex task triggers the preflight without any opt-in config', async () => {
    dir = makeRepo();
    let sawPreflight = false;
    const fake = await startFakeOpenAI([
      {
        sticky: true,
        respondFn: (body) => {
          const text = JSON.stringify(body?.messages ?? body);
          if (text.includes('strategy-generation stage')) {
            sawPreflight = true;
            return { content: JSON.stringify(['reproduce-minimal: run repro.js, observe WRONG, then patch add(). Riskiest assumption: the operator is wrong, not the caller. First step: node repro.js.']) };
          }
          if (text.includes('candidate-evaluation stage')) {
            return { content: 'MECHANISM: wrong operator.\nFIRST ACTIONS: node repro.js.\nRISKIEST ASSUMPTION: caller misuse.\nVERIFICATION: repro.js exits 0.\nPITFALLS: patching the test instead of the code.' };
          }
          if (text.includes('adversarial verifier')) {
            return { content: '{"index":1,"reason":"only candidate","scores":[8]}' };
          }
          // Main-loop turns: answer directly; the assertion is about the
          // preflight, not about completing the fix.
          return { content: 'Working on it.', finishReason: 'stop' };
        },
      },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      const title = 'Fix the intermittent regression in math.js and make all existing tests pass across every caller';
      context.setGoal(title);
      const { bus, cap } = wireBus();
      const agent = new Agent({ role: 'coder', config, workspace, events: bus, cwd: dir, context });
      await agent.run(createTask(title, 'add() in math.js intermittently returns wrong results; trace the root cause, fix the regression in the existing code, and keep the full existing test suite green for all callers.'));
      expect(sawPreflight).toBe(true);
      expect(cap.logs.some((m) => m.includes('[speculative-preflight] injected approach hint'))).toBe(true);
    } finally {
      await fake.close();
    }
  }, 120_000);

  it('a simple task does NOT trigger the preflight by default', async () => {
    dir = makeRepo();
    let sawPreflight = false;
    const fake = await startFakeOpenAI([
      {
        sticky: true,
        respondFn: (body) => {
          const text = JSON.stringify(body?.messages ?? body);
          if (text.includes('strategy-generation stage')) sawPreflight = true;
          return { content: 'It subtracts: return a - b.', finishReason: 'stop' };
        },
      },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('Fix math.js');
      const agent = new Agent({ role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
      await agent.run(createTask('Fix math.js', 'Fix math.js'));
      expect(sawPreflight).toBe(false);
    } finally {
      await fake.close();
    }
  }, 120_000);

  it('MOCHI_SPECULATIVE_PREFLIGHT=0 disables the default on a complex task', async () => {
    dir = makeRepo();
    process.env.MOCHI_SPECULATIVE_PREFLIGHT = '0';
    let sawPreflight = false;
    const fake = await startFakeOpenAI([
      {
        sticky: true,
        respondFn: (body) => {
          const text = JSON.stringify(body?.messages ?? body);
          if (text.includes('strategy-generation stage')) sawPreflight = true;
          return { content: 'Working on it.', finishReason: 'stop' };
        },
      },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      const title = 'Fix the intermittent regression in math.js and make all existing tests pass across every caller';
      context.setGoal(title);
      const agent = new Agent({ role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
      await agent.run(createTask(title, 'add() in math.js intermittently returns wrong results; trace the root cause, fix the regression in the existing code, and keep the full existing test suite green for all callers.'));
      expect(sawPreflight).toBe(false);
    } finally {
      await fake.close();
    }
  }, 120_000);
});
