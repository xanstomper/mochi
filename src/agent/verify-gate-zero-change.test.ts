// verifyGate zero-change behavior (Ben 2026-10-26: done but reported
// failed). A task whose deliverable already holds must not report failed
// just because this run changed nothing — but the no-evidence BLOCK stays.
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
import { detectRepo } from '../repo/repo.js';
import type { MochiConfig } from '../types.js';

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

function makeBareAgent(dir: string) {
  const config = makeConfig(dir, 'http://localhost:0');
  const workspace = new Workspace(dir, '.mochi');
  workspace.ensure();
  const context = new ContextEngine(config, dir);
  const agent = new Agent({ role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
  return agent;
}

function makeGitRepo(testScript: string): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-zero-change-'));
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: testScript } }));
  writeFileSync(resolve(dir, 'math.js'), 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@mochi.agent'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Mochi Test'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

describe('verifyGate zero-change', () => {
  it('green repo checks PASS a zero-change run (deliverable already holds)', async () => {
    const dir = makeGitRepo('node -e "process.exit(0)"');
    try {
      const agent = makeBareAgent(dir);
      const task = createTask(FIX_TITLE, FIX_DESC);
      const result = await (agent as any).verifyGate(task, detectRepo(dir));
      expect(result.passed).toBe(true);
      expect(result.status).toBe('PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('red repo checks FAIL a zero-change run (not BLOCKED — evidence ran)', async () => {
    const dir = makeGitRepo('node -e "process.exit(1)"');
    try {
      const agent = makeBareAgent(dir);
      const task = createTask(FIX_TITLE, FIX_DESC);
      const result = await (agent as any).verifyGate(task, detectRepo(dir));
      expect(result.passed).toBe(false);
      expect(result.status).toBe('FAIL');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('no runnable checks still BLOCKS a zero-change run (the P0.5 hole stays shut)', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-zero-change-'));
    try {
      writeFileSync(resolve(dir, 'math.js'), 'function add(a, b) { return a + b; }\nmodule.exports = { add };\n');
      const agent = makeBareAgent(dir);
      const task = { ...createTask(FIX_TITLE, FIX_DESC), fileScope: ['math.js'] };
      const result = await (agent as any).verifyGate(task, detectRepo(dir));
      expect(result.passed).toBe(false);
      expect(result.status).toBe('BLOCKED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// EDIT-1 (2026-10-27): the ungrounded escape is closed. The old gate only
// BLOCKed a zero-change mutation run when the workspace/task GROUNDED the
// change expectation (git repo, detected repo check, verification command,
// criteria, fileScope, or a named existing file) — everything else fell
// through to the historical PASS 'No changes made to verify.' A mutation-kind
// task with zero changes, zero checks, and NO grounding signal now BLOCKs
// like the grounded no-checks case; only the real exemptions keep the pass.
describe('verifyGate zero-change, ungrounded (EDIT-1)', () => {
  // Vague wording: no file path named anywhere in the text, no fileScope,
  // no acceptance criteria, no verification command. Empty non-git scratch
  // dir: no git workspace, no detectable repo check. Every grounding signal
  // is absent — the exact shape that used to auto-pass.
  const VAGUE_TITLE = 'Fix the bug';
  const VAGUE_DESC = 'Correct the behavior so the function returns the specified result.';

  it('ungrounded mutation-kind zero-change run BLOCKS instead of passing', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-edit1-ungrounded-'));
    try {
      const agent = makeBareAgent(dir);
      const task = createTask(VAGUE_TITLE, VAGUE_DESC);
      const result = await (agent as any).verifyGate(task, detectRepo(dir));
      expect(result.passed).toBe(false);
      expect(result.status).toBe('BLOCKED');
      expect(result.checks).toEqual([]);
      expect(result.summary).toContain('requires file changes');
      expect(result.summary).toContain('changed no files');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('reviewer roles keep the zero-change pass', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-edit1-reviewer-'));
    try {
      for (const role of ['reviewer', 'pr_reviewer'] as const) {
        const agent = makeBareAgent(dir);
        // Force the mutation kind so the read-only early return is NOT what
        // saves the run — the role exemption in the zero-change branch is.
        (agent as any).taskKind = 'fix';
        const task = createTask(VAGUE_TITLE, VAGUE_DESC, { role });
        const result = await (agent as any).verifyGate(task, detectRepo(dir));
        expect(result.passed).toBe(true);
        expect(result.status).toBe('PASS');
        expect(result.summary).toBe('No changes made to verify.');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('a policy-denied verify keeps the zero-change pass', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-edit1-denied-'));
    try {
      const agent = makeBareAgent(dir);
      // The run's verification attempt was vetoed by policy: the gate must
      // not BLOCK for missing evidence the policy forbade gathering.
      (agent as any).vetoLog.push({ tool: 'verify', reason: 'denied by policy' });
      const task = createTask(VAGUE_TITLE, VAGUE_DESC);
      const result = await (agent as any).verifyGate(task, detectRepo(dir));
      expect(result.passed).toBe(true);
      expect(result.status).toBe('PASS');
      expect(result.summary).toBe('No changes made to verify.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('warm starts keep the zero-change pass', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-edit1-warm-'));
    try {
      const agent = makeBareAgent(dir);
      // This run's changes predate it (a previous run did the changing and
      // was judged then): the no-change BLOCK must not fire.
      (agent as any).reproFileChangedAtRunStart = true;
      const task = createTask(VAGUE_TITLE, VAGUE_DESC);
      const result = await (agent as any).verifyGate(task, detectRepo(dir));
      expect(result.passed).toBe(true);
      expect(result.status).toBe('PASS');
      expect(result.summary).toBe('No changes made to verify.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('simple-script tasks keep the zero-change pass', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-edit1-script-'));
    try {
      const agent = makeBareAgent(dir);
      // Create-and-run shape (isSimpleScriptTask): the run itself is the
      // deliverable check. 'add.js' does NOT exist in the dir, so without
      // the exemption this task would BLOCK.
      const task = createTask('Create add.js', 'Create add.js that prints the sum of two numbers, then run node add.js.');
      const result = await (agent as any).verifyGate(task, detectRepo(dir));
      expect(result.passed).toBe(true);
      expect(result.status).toBe('PASS');
      expect(result.summary).toBe('No changes made to verify.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
