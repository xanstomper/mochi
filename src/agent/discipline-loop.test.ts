// Reasoning discipline — loop-level scripted scenarios (fake provider).
//
// Each scenario scripts a model exhibiting one of the failure modes the
// discipline mechanisms exist to kill — self-debate after a repeated
// failure, an infinite re-read loop, scope drift, post-pass anxiety
// rounds — and asserts the harness response: suppressed re-plans, forced
// decisive finishes, one snap-back, a strategy switch, a refusal. Where a
// mechanism has a kill-switch, a discipline-off control run provides the
// before/after turn-count comparison.
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

// "Make npm test pass" wording: the task itself demands green, so the
// baseline debt-mask must not mask the intermediate failures under test
// (wantsGreen). CAREFUL: the text must not pair a creation verb with a
// greenfield noun (make + script, create + file, ...) or isGreenfieldTask
// classifies the fix as a from-scratch build and verify() skips the suite
// entirely — that is why "repro" appears without the word "script".
const FIX_TITLE = 'Fix the bug in math.js: add() returns the wrong result';
const FIX_DESC = 'Make npm test pass. add(a, b) in math.js subtracts instead of adding, so the repro fails. Correct the arithmetic in the existing code.';

function makeConfig(dir: string, url: string): MochiConfig {
  return {
    // preflight: false — the speculative preflight makes its OWN provider
    // calls on complex tasks, which would consume scripted responses meant
    // for the main loop and misalign every scenario. These tests are about
    // discipline, not preflight (which has its own suite).
    model: { provider: 'openai', baseUrl: url, model: 'fake-model', speculative: { preflight: false } },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

function makeRepo(testScript = 'node repro.js'): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-discipline-'));
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

function wireBus(): { bus: EventBus; logs: string[] } {
  const bus = new EventBus();
  const logs: string[] = [];
  bus.onAll((e) => {
    if (e.type === 'agent:log') logs.push(String((e as { message?: unknown }).message ?? ''));
  });
  return { bus, logs };
}

async function runScripted(dir: string, taskTitle: string, taskDesc: string, script: FakeScriptResponse[], bus: EventBus) {
  const fake = await startFakeOpenAI(script);
  try {
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal(taskTitle);
    const agent = new Agent({ role: 'coder', config, workspace, events: bus, cwd: dir, context });
    const result = await agent.run(createTask(taskTitle, taskDesc));
    const messages = context.getMessages().map((m) => String(m.content ?? ''));
    return { result, messages, requests: fake.requests.length };
  } finally {
    await fake.close();
  }
}

const edit = (id: string, oldText: string, newText: string): FakeScriptResponse => ({
  finishReason: 'tool_calls',
  toolCalls: [{ id, function: { name: 'edit', arguments: JSON.stringify({ path: 'math.js', oldText, newText }) } }],
});
const shell = (id: string, command: string): FakeScriptResponse => ({
  finishReason: 'tool_calls',
  toolCalls: [{ id, function: { name: 'shell', arguments: JSON.stringify({ command }) } }],
});
const claim = (content: string): FakeScriptResponse => ({ content, finishReason: 'stop' });

describe('reasoning discipline (loop scenarios)', () => {
  let dir: string | undefined;
  afterEach(() => {
    delete process.env.MOCHI_DISCIPLINE;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('(a) a repeated identical failure does NOT earn a second re-plan; the run completes on the original plan', async () => {
    dir = makeRepo();
    const { bus, logs } = wireBus();
    const { result, messages } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
      shell('s1', 'node repro.js'),                    // reproduce (fails — that is the point)
      edit('e1', 'return a - b', 'return a * b'),      // wrong fix #1
      claim('I believe the fix is in.'),               // -> verify FAILS (class A) -> diagnosis allowed
      edit('e2', 'return a * b', 'return a / b'),      // wrong fix #2
      claim('Fixed it this time.'),                    // -> verify FAILS (same class) -> re-plan SUPPRESSED
      edit('e3', 'return a / b', 'return a + b'),      // the actual fix
      claim('Fixed add() to return a + b.'),
    ], bus);

    expect(result.success).toBe(true);
    expect(readFileSync(resolve(dir, 'math.js'), 'utf8')).toContain('return a + b');
    // Exactly ONE full diagnosis package was injected — the second failure
    // brought no new evidence, so no second reconsideration happened.
    expect(messages.filter((m) => m.includes('Treat this as a HYPOTHESIS'))).toHaveLength(1);
    expect(messages.some((m) => m.includes('no new evidence, so no re-plan'))).toBe(true);
    expect(logs.some((m) => m.includes('[discipline] replan suppressed'))).toBe(true);
    // The pinned contract was present from the start.
    expect(messages.some((m) => m.includes('TASK CONTRACT (pinned'))).toBe(true);
  }, 120_000);

  it('(e) a NEW failure class escalates reasoning effort exactly once; the repeat does not', async () => {
    dir = makeRepo();
    const { bus, logs } = wireBus();
    const { result } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
      shell('s1', 'node repro.js'),
      edit('e1', 'return a - b', 'return a * b'),
      claim('I believe the fix is in.'),               // F1: new class -> hard signal -> effort up
      edit('e2', 'return a * b', 'return a / b'),
      claim('Fixed it this time.'),                    // F2: same class -> no further escalation
      edit('e3', 'return a / b', 'return a + b'),
      claim('Fixed add() to return a + b.'),
    ], bus);

    expect(result.success).toBe(true);
    expect(logs.some((m) => m.includes('[discipline] hard signal: new failure class'))).toBe(true);
    const effortLogs = logs.filter((m) => /\[discipline\] effort \w+ -> \w+/.test(m));
    expect(effortLogs).toHaveLength(1);
  }, 120_000);

  it('(f) same failure + same approach x3 forces a strategy switch; one more identical retry is refused', async () => {
    dir = makeRepo();
    const { bus, logs } = wireBus();
    const { result, messages, requests } = await runScripted(dir, FIX_TITLE, FIX_DESC, [
      shell('s1', 'node repro.js'),
      edit('e1', 'return a - b', 'return a * b'),
      claim('Done.'),                                  // F1: retry
      edit('e2', 'return a * b', 'return a / b'),
      claim('Done.'),                                  // F2: retry
      edit('e3', 'return a / b', 'return a - b'),
      claim('Done.'),                                  // F3: STRATEGY SWITCH REQUIRED
      edit('e4', 'return a - b', 'return a % b'),
      claim('Done.'),                                  // F4: identical approach retried -> REFUSED
    ], bus);

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe('verification_failed');
    expect(result.summary).toContain('Refusing another identical retry');
    expect(messages.some((m) => m.includes('STRATEGY SWITCH REQUIRED'))).toBe(true);
    expect(logs.some((m) => m.includes('[discipline] strategy switch forced'))).toBe(true);
    expect(logs.some((m) => m.includes('[discipline] identical retry refused'))).toBe(true);
    // Bounded: the refusal ended the run instead of riding to maxVerifyRetries.
    expect(requests).toBeLessThanOrEqual(11);
  }, 120_000);

  it('(c) edits wandering off-contract earn exactly one snap-back, then the run recovers', async () => {
    dir = makeRepo('node -e "process.exit(0)"');
    const { bus, logs } = wireBus();
    const write = (id: string, path: string, content: string): FakeScriptResponse => ({
      finishReason: 'tool_calls',
      toolCalls: [{ id, function: { name: 'write', arguments: JSON.stringify({ path, content }) } }],
    });
    const { result, messages } = await runScripted(dir,
      'Add a subtract function to math.js',
      'Add and export a subtract(a, b) function in the existing math.js module next to add().',
      [
        write('w1', 'unrelated-a.ts', 'export const a = 1;\n'),
        write('w2', 'notes-b.md', '# scratch notes\n'),
        write('w3', 'helper-c.js', 'module.exports = {};\n'),   // 3rd unrelated edit -> snap-back
        edit('e1', 'module.exports = { add };', 'function subtract(a, b) { return a - b; }\nmodule.exports = { add, subtract };'),
        claim('Added subtract() to math.js.'),
      ], bus);

    expect(result.success).toBe(true);
    expect(messages.filter((m) => m.includes('DRIFT SNAP-BACK'))).toHaveLength(1);
    expect(logs.filter((m) => m.includes('[discipline] drift snap-back'))).toHaveLength(1);
    expect(readFileSync(resolve(dir, 'math.js'), 'utf8')).toContain('function subtract');
  }, 120_000);

  it('(d) a simple task finishes decisively: evidenced first-pass verify skips the self-review round', async () => {
    // Passing-suite repo: the task only ADDS a function, so the suite must
    // be green at baseline — otherwise verify (correctly) fails on the
    // still-buggy add() and the scenario tests the wrong thing.
    dir = makeRepo('node -e "process.exit(0)"');
    const on = wireBus();
    const onRun = await runScripted(dir,
      'Add a subtract function to math.js',
      'Add and export a subtract(a, b) function in the existing math.js module next to add().',
      [
        edit('e1', 'module.exports = { add };', 'function subtract(a, b) { return a - b; }\nmodule.exports = { add, subtract };'),
        claim('Added subtract() to math.js.'),
      ], on.bus);
    expect(onRun.result.success).toBe(true);
    expect(on.logs.some((m) => m.includes('[discipline] decisive finish'))).toBe(true);

    // Control: discipline off — the anxiety round (self-review) runs and
    // costs at least one extra model call for the identical script.
    dir = makeRepo('node -e "process.exit(0)"');
    process.env.MOCHI_DISCIPLINE = '0';
    const off = wireBus();
    const offRun = await runScripted(dir,
      'Add a subtract function to math.js',
      'Add and export a subtract(a, b) function in the existing math.js module next to add().',
      [
        edit('e1', 'module.exports = { add };', 'function subtract(a, b) { return a - b; }\nmodule.exports = { add, subtract };'),
        claim('Added subtract() to math.js.'),
      ], off.bus);
    delete process.env.MOCHI_DISCIPLINE;
    expect(offRun.result.success).toBe(true);
    expect(off.logs.some((m) => m.includes('[discipline] decisive finish'))).toBe(false);
    expect(onRun.requests).toBeLessThan(offRun.requests);
  }, 120_000);

  it('(b) a re-read/reconsider loop is force-finished in a few turns (baseline burns many more)', async () => {
    const loopingScript = (): FakeScriptResponse[] => {
      let n = 0;
      return [{
        sticky: true,
        respondFn: () => {
          n++;
          return {
            content: 'Let me reconsider whether math.js is really the right file to look at here.',
            finishReason: 'tool_calls',
            toolCalls: [{ id: `r${n}`, function: { name: 'read', arguments: JSON.stringify({ path: 'math.js' }) } }],
          };
        },
      }];
    };

    dir = makeRepo();
    const on = wireBus();
    const onRun = await runScripted(dir, FIX_TITLE, FIX_DESC, loopingScript(), on.bus);
    expect(onRun.result.success).toBe(false);
    expect(onRun.result.stopReason).toBe('stuck_no_progress');
    expect(on.logs.some((m) => m.includes('[discipline] commit directive'))).toBe(true);
    expect(on.logs.some((m) => m.includes('[discipline] progress forcing'))).toBe(true);
    expect(onRun.requests).toBeLessThanOrEqual(7);

    // Baseline with discipline off: the same loop runs until the legacy
    // guards (identical-signature / heartbeat) stop it — many more turns.
    dir = makeRepo();
    process.env.MOCHI_DISCIPLINE = '0';
    const off = wireBus();
    const offRun = await runScripted(dir, FIX_TITLE, FIX_DESC, loopingScript(), off.bus);
    delete process.env.MOCHI_DISCIPLINE;
    expect(offRun.result.success).toBe(false);
    expect(offRun.requests).toBeGreaterThanOrEqual(onRun.requests + 8);
  }, 180_000);
});
