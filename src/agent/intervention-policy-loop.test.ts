// InterventionPolicy — loop-level proof that the per-call cap binds.
// A run where a struggle signal and a commit directive compete for the same
// model call must deliver exactly one soft nudge (the commit, higher
// priority) and suppress the other (logged + counted in finish telemetry).
//
// Mechanism: two premature completion claims are consecutive deliberative
// turns (commit queues after the second) and each fails verification, so
// the next turn top has a struggle signal (verify attempts) while the commit
// is still queued. The flush before that turn's model call must pick commit.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

// Same task wording as discipline-loop.test.ts (classification-sensitive).
const FIX_TITLE = 'Fix the bug in math.js: add() returns the wrong result';
const FIX_DESC = 'Make npm test pass. add(a, b) in math.js subtracts instead of adding, so the repro fails. Correct the arithmetic in the existing code.';

function makeConfig(dir: string, url: string): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model', speculative: { preflight: false } },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

function makeRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-intervention-'));
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node repro.js' } }));
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

async function runScripted(dir: string, script: FakeScriptResponse[], bus: EventBus) {
  const fake = await startFakeOpenAI(script);
  try {
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal(FIX_TITLE);
    const agent = new Agent({ role: 'coder', config, workspace, events: bus, cwd: dir, context });
    const result = await agent.run(createTask(FIX_TITLE, FIX_DESC));
    const messages = context.getMessages().map((m) => String(m.content ?? ''));
    return { result, messages };
  } finally {
    await fake.close();
  }
}

const shell = (id: string, command: string): FakeScriptResponse => ({
  finishReason: 'tool_calls',
  toolCalls: [{ id, function: { name: 'shell', arguments: JSON.stringify({ command }) } }],
});
const edit = (id: string, oldText: string, newText: string): FakeScriptResponse => ({
  finishReason: 'tool_calls',
  toolCalls: [{ id, function: { name: 'edit', arguments: JSON.stringify({ path: 'math.js', oldText, newText }) } }],
});
const claim = (content: string): FakeScriptResponse => ({ content, finishReason: 'stop' });

describe('intervention policy (loop)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a commit directive beats a struggle summary for the same model call; the struggle is suppressed, not stacked', async () => {
    dir = makeRepo();
    const { bus, logs } = wireBus();
    // Turn parity matters: the struggle throttle (once per 2 iters) must
    // ALLOW the contested top. The read at i=2 is a progress turn (first
    // read = new ground), so deliberation lands on i=3 (odd) and i=4
    // (even, commit queues post) — and the i=5 top can queue struggle
    // alongside the queued commit, forcing the policy to choose.
    const read = (id: string, path: string): FakeScriptResponse => ({
      finishReason: 'tool_calls',
      toolCalls: [{ id, function: { name: 'read', arguments: JSON.stringify({ path }) } }],
    });
    const { result, messages } = await runScripted(dir, [
      shell('s1', 'node repro.js'), // reproduce (fails — observes the failure, unblocks edits)
      edit('e0', 'return a - b', 'return a * b'), // wrong fix (so the first claim has changes to verify)
      read('r1', 'math.js'), // progress turn: aligns deliberation to odd/even
      claim('I believe the fix is in.'), // deliberative 1 -> verify FAILS (wrong fix)
      claim('Fixed it this time.'), // deliberative 2 -> commit queued -> verify FAILS again
      edit('e1', 'return a * b', 'return a + b'), // next turn top: struggle queues too -> flush picks commit
      claim('Fixed add() to return a + b.'),
    ], bus);

    expect(result.success).toBe(true);
    // Exactly one soft nudge won the contested call: the commit directive.
    expect(messages.some((m) => m.includes('COMMIT — you have spent'))).toBe(true);
    // The struggle summary for the contested turn (turn 6) never reached the model.
    expect(messages.filter((m) => m.includes('STRUGGLE STATE (turn 6)'))).toHaveLength(0);
    // The suppression was logged and counted in finish telemetry.
    expect(logs.some((m) => m.includes('[intervention] struggle summary suppressed'))).toBe(true);
    expect(logs.some((m) => m.includes('[intervention-telemetry]') && m.includes('suppressed: 1'))).toBe(true);
  }, 120_000);
});
