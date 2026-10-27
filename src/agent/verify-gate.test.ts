// P0.5 — one verifier as the default gate.
//
// Before P0.5 the in-loop Agent.verify() auto-passed whole classes of runs:
// a fix/implement task that changed ZERO files completed as success ("No
// changes made to verify"), and changes with no covering check passed as
// "No verification configured". The strong VerifierEngine (scoped diff,
// mutation check, honest BLOCKED) only ran on the goals path for
// criteria-shaped tasks. These tests pin the ported evidence standard on
// the DEFAULT path: BLOCKED instead of PASS for unverifiable deliverables,
// the mutation downgrade for hollow test passes, and the preserved
// exemptions (read-only kinds, baseline debt-masking).
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import { detectRepo } from '../repo/repo.js';
import { failureSignature, type VerificationBaseline } from '../verification.js';
import type { MochiConfig } from '../types.js';

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

function gitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@mochi.agent'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Mochi Test'], { cwd: dir });
}

function commitAll(dir: string, message = 'initial'): void {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', message], { cwd: dir });
}

function makeAgent(dir: string, config: MochiConfig, id: string): Agent {
  const workspace = new Workspace(dir, '.mochi');
  workspace.ensure();
  const context = new ContextEngine(config, dir);
  return new Agent({ id, role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
}

const MATH_BUGGY = 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n';
const REPRO_JS = 'const { add } = require("./math.js");\nif (add(2, 3) !== 5) { console.log("WRONG: add(2,3)=" + add(2, 3)); process.exit(1); }\nconsole.log("OK");\n';

describe('P0.5 default completion gate (Agent.verify)', () => {
  it('(a) a fix task that changed no files fails via its repo checks instead of auto-passing it', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-p05-nochange-'));
    try {
      writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node repro.js' } }));
      writeFileSync(resolve(dir, 'math.js'), MATH_BUGGY);
      writeFileSync(resolve(dir, 'repro.js'), REPRO_JS);
      gitRepo(dir);
      commitAll(dir);
      const agent = makeAgent(dir, makeConfig(dir, 'http://localhost:0'), 'p05-nochange');
      const task = createTask('Fix the add function', 'Fix the add function in math.js so add(2, 3) returns 5.');
      const v = await (agent as any).verify(task, detectRepo(dir));
      expect(v.passed).toBe(false);
      // 43b68d5a: zero-change + runnable repo checks falls through to
      // the checks instead of BLOCKING. The repo check (`node repro.js`)
      // fails on the buggy math, so the verdict is FAIL via evidence,
      // not BLOCKED via no-evidence. Still fails, never auto-passes.
      expect(v.status).toBe('FAIL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(a) a fix run that never changes files ends verification_failed, not completed', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-p05-run-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node repro.js' } }));
    writeFileSync(resolve(dir, 'math.js'), MATH_BUGGY);
    writeFileSync(resolve(dir, 'repro.js'), REPRO_JS);
    gitRepo(dir);
    commitAll(dir);
    const fake = await startFakeOpenAI([
      {
        content: 'Running the repro first.',
        toolCalls: [{ id: 's1', function: { name: 'shell', arguments: JSON.stringify({ command: 'node repro.js' }) } }],
        finishReason: 'tool_calls',
      },
      { sticky: true, content: 'The add function is fixed now.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url, { maxVerifyRetries: 1 });
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('Fix the add function');
      const agent = new Agent({ id: 'p05-run', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
      const task = createTask('Fix the add function', 'Fix the add function in math.js so add(2, 3) returns 5.');
      const result = await agent.run(task);
      expect(result.success).toBe(false);
      expect(result.stopReason).toBe('verification_failed');
      // The prose completion was routed through verify(). 43b68d5a:
      // zero-change + runnable repo checks falls through to the checks,
      // and the failing repro check fails verification — so the run
      // still ends verification_failed, not completed, but the finish
      // summary no longer carries the old BLOCKED 'changed no files'
      // message; it carries the failing-check evidence instead.
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('(b) a research task still passes with no checks and no changes', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-p05-research-'));
    try {
      const agent = makeAgent(dir, makeConfig(dir, 'http://localhost:0'), 'p05-research');
      const task = createTask('Investigate the parser pipeline', 'Investigate how the parser handles empty input and report the findings.');
      const v = await (agent as any).verify(task, detectRepo(dir));
      expect(v.passed).toBe(true);
      expect(v.status).toBe('PASS');
      expect(v.summary).toContain('research');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(c) changes with no covering check are BLOCKED, not passed as "no verification configured"', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-p05-nochecks-'));
    try {
      // Bare directory: no package.json, no test runner, not a git repo —
      // detectRepo finds no check at all for the changed files. widget.js
      // is a REAL pre-existing file the run claims to have updated: a
      // modification of existing code with zero covering evidence.
      writeFileSync(resolve(dir, 'widget.js'), 'export function widget() { return 1; }\n');
      const agent = makeAgent(dir, makeConfig(dir, 'http://localhost:0'), 'p05-nochecks');
      (agent as any).fileChanged = true;
      const task = createTask('Update the widget', 'Update the widget behavior in widget.js.');
      const v = await (agent as any).verify(task, detectRepo(dir));
      expect(v.passed).toBe(false);
      expect(v.status).toBe('BLOCKED');
      expect(v.summary).toContain('Verification blocked');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(d) a surviving mutation downgrades a passing gate to PARTIAL on the default path', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-p05-mutation-'));
    try {
      writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node --test' } }));
      // Committed code + a committed test that covers ONLY util.add. The
      // run's change (calc.js) is exercised by no test, so an injected
      // === -> !== flip in it must survive — the hollow-pass signature.
      writeFileSync(resolve(dir, 'util.js'), 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n');
      execFileSync('mkdir', ['-p', resolve(dir, 'test')]);
      writeFileSync(
        resolve(dir, 'test', 'util.test.js'),
        'const test = require("node:test");\nconst assert = require("node:assert");\nconst { add } = require("../util.js");\ntest("add", () => { assert.strictEqual(add(1, 2), 3); });\n',
      );
      gitRepo(dir);
      commitAll(dir);
      // The run's change: a new source file with a flippable operator.
      writeFileSync(resolve(dir, 'calc.js'), 'function same(a, b) { return a === b; }\nmodule.exports = { same };\n');
      const agent = makeAgent(dir, makeConfig(dir, 'http://localhost:0'), 'p05-mutation');
      (agent as any).fileChanged = true;
      const task = createTask('Add the same helper', 'Add a same(a, b) helper to calc.js that reports whether two values are identical.', {
        verificationCommand: 'node --test',
      });
      const v = await (agent as any).verify(task, detectRepo(dir));
      expect(v.passed).toBe(false);
      expect(v.status).toBe('PARTIAL');
      expect(v.summary.toLowerCase()).toContain('mutation');
      // The mutation check must restore the file it flipped.
      const { readFileSync } = await import('node:fs');
      expect(readFileSync(resolve(dir, 'calc.js'), 'utf8')).toContain('a === b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('(e) baseline-masked pre-existing failures still pass the gate', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-p05-baseline-'));
    try {
      writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node fail.js' } }));
      // Deterministic pre-existing failure, identical before and after the run.
      writeFileSync(resolve(dir, 'fail.js'), 'console.error("FAIL src/calc.test.ts");\nconsole.error("AssertionError: expected 5 to be 6");\nprocess.exit(1);\n');
      gitRepo(dir);
      commitAll(dir);
      const agent = makeAgent(dir, makeConfig(dir, 'http://localhost:0'), 'p05-baseline');
      // Capture the baseline the same way the harness does: run the check
      // pre-change and record its failure signature.
      const out = await (agent as any).runShell('npm test', 60);
      const baseline: VerificationBaseline = {
        signatures: new Map([['npm test', failureSignature(out)]]),
        capturedAt: Date.now(),
      };
      (agent as any).verifyBaseline = baseline;
      (agent as any).fileChanged = true;
      const task = createTask('Update the widget', 'Update the widget behavior in widget.js.');
      const v = await (agent as any).verify(task, detectRepo(dir));
      expect(v.passed).toBe(true);
      expect(v.status).toBe('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
