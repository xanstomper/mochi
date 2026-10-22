// Trajectory skill attribution (B1): a scripted run that loads a skill must
// produce a trajectory export whose skills[] carries the skill id joined
// with the run's final VERIFIER-GATE verdict — and the same join must land
// in the unified skill registry (verified passes / kind counters / kind
// baseline). Modeled on run-success-memory.test.ts (fake OpenAI provider,
// real git fixture repo, real gate: `npm test` = node repro.js).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI, type FakeScriptResponse } from '../testutil/fake-openai.js';
import { TraceRecorder } from '../observability/trace.js';
import { exportTrajectory } from '../observability/trajectory.js';
import { loadSkillUsage, loadSkillKindStats } from '../skills/skills.js';
import type { MochiConfig } from '../types.js';

const MATH_BUGGY = 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n';
const REPRO_JS = 'const { add } = require("./math.js");\nif (add(2, 3) !== 5) { console.log("WRONG: add(2,3)=" + add(2, 3)); process.exit(1); }\nconsole.log("OK");\n';
const FIX_TITLE = 'Fix the bug in math.js: add() returns the wrong result';
const FIX_DESC = 'add(a, b) in math.js subtracts instead of adding, so the repro script repro.js fails. Diagnose the root cause in the existing code and correct the arithmetic.';
const EDIT_FIX = JSON.stringify({ path: 'math.js', oldText: 'return a - b', newText: 'return a + b' });
const EDIT_WRONG = JSON.stringify({ path: 'math.js', oldText: 'return a - b', newText: 'return a * b' });

function makeConfig(dir: string, url: string, maxVerifyRetries?: number): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000, ...(maxVerifyRetries !== undefined ? { maxVerifyRetries } : {}) },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

function makeRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-skill-attr-'));
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node repro.js' } }));
  writeFileSync(resolve(dir, 'math.js'), MATH_BUGGY);
  writeFileSync(resolve(dir, 'repro.js'), REPRO_JS);
  // A hand-written project skill (no lifecycle record — legacy/active).
  const skillDir = resolve(dir, '.mochi', 'skills', 'fix-math');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(resolve(skillDir, 'SKILL.md'), [
    '---',
    'name: fix-math',
    'description: Fix arithmetic bugs in math.js by correcting the operator',
    '---',
    '',
    '## When to use',
    'When math.js arithmetic returns wrong results.',
    '## Procedure',
    '1. Reproduce with the repro script.',
    '2. Correct the operator in the implementation.',
    '3. Re-run the repro and the test suite.',
    '',
  ].join('\n'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@mochi.agent'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Mochi Test'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

async function runScripted(
  dir: string,
  runId: string,
  script: FakeScriptResponse[],
  maxVerifyRetries?: number,
  taskText: { title: string; desc: string } = { title: FIX_TITLE, desc: FIX_DESC },
) {
  const fake = await startFakeOpenAI(script);
  const events = new EventBus();
  const recorder = new TraceRecorder(dir, runId).attach(events);
  try {
    const config = makeConfig(dir, fake.url, maxVerifyRetries);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal(taskText.title);
    const agent = new Agent({ role: 'coder', config, workspace, events, cwd: dir, context });
    return await agent.run(createTask(taskText.title, taskText.desc));
  } finally {
    recorder.close();
    await fake.close();
  }
}

describe('trajectory skill attribution (loop finish -> trace -> export + registry)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('(d) a passing run that loads a skill exports skills[] + PASS verdict and records the evidence', async () => {
    dir = makeRepo();
    const result = await runScripted(dir, 'run-attr-pass', [
      // Reproduce first (the gate requires a shell run before editing an
      // existing file on a fix task).
      { finishReason: 'tool_calls', toolCalls: [{ id: 's1', function: { name: 'shell', arguments: JSON.stringify({ command: 'node repro.js' }) } }] },
      { finishReason: 'tool_calls', toolCalls: [{ id: 'k1', function: { name: 'skill', arguments: JSON.stringify({ name: 'fix-math' }) } }] },
      { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: EDIT_FIX } }] },
      { content: 'Fixed add() to return a + b; the repro script now passes.', finishReason: 'stop' },
    ]);
    expect(result.success).toBe(true);

    const exported = exportTrajectory(dir, 'run-attr-pass');
    expect(exported).not.toBeNull();
    expect(exported!.record.skills).toEqual([{ id: 'fix-math', verdict: 'pass' }]);
    expect(exported!.record.verification).toEqual({ status: 'PASS', verdict: 'pass' });
    // NB: record.outcome is not asserted — task:completed is emitted by the
    // goals scheduler around agent.run(), not by the bare Agent harness.

    // The same join in the registry: one verified pass, ACE helpful, kind arm.
    const rec = loadSkillUsage(dir).get('fix-math');
    expect(rec?.verifiedPasses).toBe(1);
    expect(rec?.helpful).toBe(1);
    expect(rec?.kindLoads).toEqual({ fix: 1 });
    expect(rec?.kindPasses).toEqual({ fix: 1 });
    expect(rec?.lastVerdict).toBe('pass');
    expect(loadSkillKindStats(dir).fix).toEqual({ runs: 1, passes: 1 });
  }, 120_000);

  it('(d) a run whose loaded skill ends in gate FAIL exports verdict fail and records a harmful outcome', async () => {
    dir = makeRepo();
    const result = await runScripted(dir, 'run-attr-fail', [
      { finishReason: 'tool_calls', toolCalls: [{ id: 's1', function: { name: 'shell', arguments: JSON.stringify({ command: 'node repro.js' }) } }] },
      { finishReason: 'tool_calls', toolCalls: [{ id: 'k1', function: { name: 'skill', arguments: JSON.stringify({ name: 'fix-math' }) } }] },
      // Wrong fix: verification exhausts its retries -> gate FAIL.
      { finishReason: 'tool_calls', toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: EDIT_WRONG } }] },
      { content: 'Fixed add() to multiply instead.', finishReason: 'stop' },
    ], 1, {
      title: FIX_TITLE,
      desc: 'add(a, b) in math.js subtracts instead of adding, so the repro script repro.js fails. Correct the arithmetic so all tests pass.',
    });
    expect(result.success).toBe(false);

    const exported = exportTrajectory(dir, 'run-attr-fail');
    expect(exported).not.toBeNull();
    expect(exported!.record.skills).toEqual([{ id: 'fix-math', verdict: 'fail' }]);
    expect(exported!.record.verification?.verdict).toBe('fail');

    const rec = loadSkillUsage(dir).get('fix-math');
    expect(rec?.verifiedFails).toBe(1);
    expect(rec?.harmful).toBe(1);
    expect(rec?.verifiedPasses ?? 0).toBe(0);
    expect(loadSkillKindStats(dir).fix).toEqual({ runs: 1, passes: 0 });
  }, 120_000);
});
