import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Agent, isPlanShaped } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

function makeConfig(dir: string, url: string): MochiConfig {
  return {
    model: {
      provider: 'openai',
      baseUrl: url,
      model: 'fake-model',
    },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 10,
      maxIterations: 10,
      maxRuntimeMinutes: 5,
      maxConcurrentAgents: 1,
      contextBudgetTokens: 4000,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true,
    verbose: false,
    debug: false,
  } as unknown as MochiConfig;
}

describe('Agent', () => {
  it('runs a task and writes a file', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-agent-'));
    const fake = await startFakeOpenAI([
      {
        content: 'I will write the file now.',
        toolCalls: [
          {
            id: '1',
            type: 'function',
            function: { name: 'write', arguments: JSON.stringify({ path: resolve(dir, 'hello.txt'), content: 'hello mochi' }) },
          },
        ],
        finishReason: 'tool_calls',
      },
      { content: 'Done.', finishReason: 'stop', completionTokens: 8 },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('write a greeting');
    const task = createTask('Write greeting', 'Create hello.txt with "hello mochi".');

    const agent = new Agent({
      id: 'test-agent',
      role: 'coder',
      config,
      workspace,
      events: new EventBus(),
      cwd: dir,
      context,
    });

    const result = await agent.run(task);
    expect(result.success).toBe(true);
    expect(readFileSync(resolve(dir, 'hello.txt'), 'utf8')).toBe('hello mochi');
    await fake.close();
  });

  it('plan mode vetoes edits, then accepts the plan without writing', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-plan-'));
    const fake = await startFakeOpenAI([
      {
        content: 'I will change the file.',
        toolCalls: [
          {
            id: '1',
            type: 'function',
            function: { name: 'write', arguments: JSON.stringify({ path: resolve(dir, 'plan.txt'), content: 'should not appear' }) },
          },
        ],
        finishReason: 'tool_calls',
      },
      { content: 'PLAN:\n1. Create plan.txt\n2. Add a greeting\n3. Verify with read', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('plan a change');
    const task = createTask('Plan change', 'Produce a plan to modify plan.txt.');

    const agent = new Agent({
      id: 'plan-agent',
      role: 'coder',
      config,
      workspace,
      events: new EventBus(),
      cwd: dir,
      context,
      planMode: true,
    });

    const result = await agent.run(task);
    // Plan mode must not change any file, and the plan must surface in the result.
    expect(result.success).toBe(true);
    expect(result.summary).toContain('PLAN');
    expect(() => readFileSync(resolve(dir, 'plan.txt'), 'utf8')).toThrow();
    await fake.close();
  });

  it('rolls the repo back when verification fails repeatedly', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-rollback-'));
    // Clean git repo so the pre-edit snapshot engages.
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email t@t && git config user.name t', { cwd: dir });
    execSync('git commit --allow-empty -m init', { cwd: dir });

    // Script: write a file, then keep claiming "done" so verification runs and
    // fails (the verification command always exits 1). Each retry loop needs a
    // write or claim; the fake repeats its last response when exhausted.
    const writeCall = (id: string, path: string) => ({
      id,
      type: 'function' as const,
      function: { name: 'write', arguments: JSON.stringify({ path, content: 'broken' }) },
    });
    const fake = await startFakeOpenAI([
      { content: 'Writing now.', toolCalls: [writeCall('1', resolve(dir, 'out.txt'))], finishReason: 'tool_calls' },
      { content: 'Done, the change is complete.', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('rollback check');
    const task = createTask('Break things', 'Write out.txt; verification always fails.', {
      verificationCommand: 'false',
    });

    const agent = new Agent({
      id: 'rollback-agent',
      role: 'coder',
      config,
      workspace,
      events: new EventBus(),
      cwd: dir,
      context,
    });

    const result = await agent.run(task);
    expect(result.success).toBe(false);
    expect(result.summary).toContain('Verification failed repeatedly');
    expect(result.summary).toContain('Rolled back to pre-edit state');
    // The agent's edit was rolled back and the tree is clean again (the
    // harness's own .mochi state dir intentionally survives).
    expect(existsSync(resolve(dir, 'out.txt'))).toBe(false);
    const leftover = execSync('git status --porcelain', { cwd: dir, encoding: 'utf8' })
      .split('\n').filter((l) => l.trim() && !l.includes('.mochi'));
    expect(leftover).toEqual([]);
    await fake.close();
  });

  it('plan mode vetoes patch and unknown tools (default-deny), not just write/edit/shell', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-plan2-'));
    const patchText = [
      '*** Begin Patch',
      `*** Add File: sneaky.txt`,
      '+created in plan mode',
      '*** End Patch',
    ].join('\n');
    const fake = await startFakeOpenAI([
      {
        content: 'Applying my plan.',
        toolCalls: [
          { id: '1', type: 'function', function: { name: 'patch', arguments: JSON.stringify({ patch: patchText }) } },
          { id: '2', type: 'function', function: { name: 'some_mcp_tool', arguments: '{}' } },
          { id: '3', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: resolve(dir, 'notes.md') }) } },
        ],
        finishReason: 'tool_calls',
      },
      { content: 'PLAN:\n1. Read notes\n2. Sneaky patch is blocked\n3. Ship it after approval', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('plan only');
    const task = createTask('Plan patch', 'Plan changes without applying them.');

    const agent = new Agent({
      id: 'plan2-agent',
      role: 'coder',
      config,
      workspace,
      events: new EventBus(),
      cwd: dir,
      context,
      planMode: true,
    });

    const result = await agent.run(task);
    expect(result.success).toBe(true);
    expect(result.summary).toContain('PLAN');
    expect(existsSync(resolve(dir, 'sneaky.txt'))).toBe(false);
    await fake.close();
  });

  it('hook vetoes answer the tool_call_id instead of dangling it', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-hook-'));
    // File-based hook the real HookManager reads from the workspace dir.
    // Exit 1 on before_tool vetoes every tool call, like a real policy hook.
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    writeFileSync(resolve(workspace.dir, 'hooks.json'), JSON.stringify({ before_tool: ['exit 1'] }));
    const fake = await startFakeOpenAI([
      {
        content: 'Writing.',
        toolCalls: [
          { id: '1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: resolve(dir, 'x.txt'), content: 'nope' }) } },
        ],
        finishReason: 'tool_calls',
      },
      { content: 'Understood, the edit was blocked, so my final answer is a summary instead.', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const context = new ContextEngine(config, dir);
    context.setGoal('blocked write');
    const task = createTask('Blocked write', 'Write x.txt (will be vetoed).');

    const agent = new Agent({
      id: 'hook-agent',
      role: 'coder',
      config,
      workspace,
      events: new EventBus(),
      cwd: dir,
      context,
    });

    const result = await agent.run(task);
    expect(result.success).toBe(true);
    expect(existsSync(resolve(dir, 'x.txt'))).toBe(false);
    // The provider must have received a tool-role reply for the vetoed call.
    const messages = fake.requests.flatMap((r) => r.body?.messages ?? []);
    const toolReplies = messages.filter((m: any) => m.role === 'tool');
    expect(toolReplies.length).toBeGreaterThan(0);
    expect(toolReplies.some((m: any) => String(m.content).includes('before_tool hook vetoed write'))).toBe(true);
    await fake.close();
  });

  it('writes an autopsy record when verification fails repeatedly', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-autopsy-loop-'));
    // Script: the model claims "done" but verification always fails (exit 1),
    // forcing a 3-strike rollback. The loop must persist an autopsy with at
    // least one DebugAttempt describing the diagnostic.
    const writeCall = (id: string) => ({
      id,
      type: 'function' as const,
      function: { name: 'write', arguments: JSON.stringify({ path: resolve(dir, 'broken.txt'), content: 'broken' }) },
    });
    const fake = await startFakeOpenAI([
      { content: 'Will write.', toolCalls: [writeCall('1')], finishReason: 'tool_calls' },
      { content: 'Done.', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('autopsy test');
    const task = createTask('Bad edit', 'Will be rolled back', { verificationCommand: 'false' });

    const agent = new Agent({
      id: 'autopsy-agent',
      role: 'coder',
      config,
      workspace,
      events: new EventBus(),
      cwd: dir,
      context,
    });

    const result = await agent.run(task);
    expect(result.success).toBe(false);
    // Autopsy persisted at <workspace>/autopsies/<taskId>.json with kind + attempts.
    const auts = await import('../autopsy.js');
    const autopsyFile = resolve(workspace.dir, 'autopsies', `${task.id}.json`);
    expect(existsSync(autopsyFile)).toBe(true);
    const a = auts.loadOrCreateAutopsy(workspace.dir, task.id, 'autopsy-agent', 'Bad edit');
    expect(['syntax', 'unknown']).toContain(a.failureKind ?? 'unknown'); // 'false' is not classified
    expect(a.attempts.length).toBeGreaterThan(0);
    expect(a.outcome).toBe('unresolved');
    // recordFailure must have persisted a procedural lesson so the next run
    // in this workspace starts with prior context.
    const lessons = await import('../lessons.js');
    const all = lessons.loadLessons(workspace.dir);
    expect(all.length).toBeGreaterThan(0);
    const failLesson = all.find((l) => l.id.endsWith(':fail'));
    expect(failLesson).toBeDefined();
    expect(failLesson!.lesson).toMatch(/AVOID/);
    await fake.close();
  });

  it('isPlanShaped rejects preamble text and accepts structured plans', () => {
    expect(isPlanShaped("I'll research the codebase first to understand the project structure and")).toBe(false);
    expect(isPlanShaped('Let me look into this before proposing anything.')).toBe(false);
    expect(isPlanShaped('ok')).toBe(false);
    // Numbered steps.
    expect(isPlanShaped('PLAN:\n1. Create plan.txt\n2. Add a greeting\n3. Verify with read')).toBe(true);
    expect(isPlanShaped('1) add parser module\n2) wire it into main\n3) test')).toBe(true);
    // Two or more bullets.
    expect(isPlanShaped('- add parser.ts\n- write tests\n- run vitest')).toBe(true);
    // Substantive prose with a plan header.
    expect(isPlanShaped([
      'Steps:',
      '1. Create the module in src/.',
      '2. Export the public API.',
      '3. Add unit tests and run them.',
      'Risks: minimal; the module is new.',
    ].join('\n'))).toBe(true);
  });

  it('plan mode nudges a preamble response instead of accepting it as done', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-plan-nudge-'));
    const fake = await startFakeOpenAI([
      { content: "I'll research the codebase first to understand the project structure and", finishReason: 'stop' },
      { content: 'PLAN:\n1. Create plan.txt\n2. Add a greeting\n3. Verify with read', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('plan a change');
    const task = createTask('Plan change', 'Produce a plan to modify plan.txt.');

    const agent = new Agent({
      id: 'plan-nudge-agent',
      role: 'coder',
      config,
      workspace,
      events: new EventBus(),
      cwd: dir,
      context,
      planMode: true,
    });

    const result = await agent.run(task);
    // The preamble must NOT finish the run; the plan must be the summary.
    expect(result.success).toBe(true);
    expect(result.summary).toContain('PLAN');
    expect(result.summary).toContain('Add a greeting');
    expect(result.attempts).toBeGreaterThanOrEqual(1);
    await fake.close();
  });

  it('plan mode fails when the model never produces a plan (nudge budget exhausted)', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-plan-giveup-'));
    // The fake replays its last entry forever, so the loop sees preambles on
    // every iteration and must terminate with a failure, not spin.
    const fake = await startFakeOpenAI([
      { content: "I'll research the codebase first shortly", finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('plan a change');
    const task = createTask('Plan change', 'Produce a plan.');

    const agent = new Agent({
      id: 'plan-giveup-agent',
      role: 'coder',
      config,
      workspace,
      events: new EventBus(),
      cwd: dir,
      context,
      planMode: true,
    });

    const result = await agent.run(task);
    expect(result.success).toBe(false);
    expect(result.summary).toContain('Planner never produced a plan');
    await fake.close();
  });
});

// Polyglot E2E: the agent works on a Python repo end to end. Uses the fake
// model to script the edit, but verification runs a REAL `pytest` subprocess
// via the loop's verify() path, so this proves repo detection -> test detect
// -> subprocess verification across languages, not just JS/TS.
function testPytest(): boolean {
  try {
    const out = execSync('python3 -m pytest --version 2>&1', { encoding: 'utf8' });
    return /pytest/i.test(out);
  } catch {
    return false;
  }
}
const pytestSuite = testPytest() ? describe : describe.skip;

pytestSuite('polyglot: python repo end-to-end', () => {
  it('fixes a python function and verifies with real pytest', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-pyloop-'));
    // Git repo the preflight runs in.
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email t@t && git config user.name t', { cwd: dir });
    writeFileSync(resolve(dir, 'arith.py'), 'def double(x):\n    return x * 3\n');
    writeFileSync(resolve(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    execSync('git add -A && git commit -qm init', { cwd: dir });

    // Script: write a correct impl + a passing test. The model uses the write
    // tool twice, then claims done.
    const writeCall = (id: string, path: string, content: string) => ({
      id,
      type: 'function' as const,
      function: { name: 'write', arguments: JSON.stringify({ path, content }) },
    });
    const fake = await startFakeOpenAI([
      {
        content: 'Fixing double and adding a test.',
        toolCalls: [
          writeCall('1', resolve(dir, 'arith.py'), 'def add(x, y):\n    return x + y\n'),
          writeCall('2', resolve(dir, 'test_arith.py'), 'from arith import add\n\ndef test_add():\n    assert add(2, 3) == 5\n'),
        ],
        finishReason: 'tool_calls',
      },
      { content: 'Done, the tests now pass.', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('fix python math');
    const task = createTask('Fix add()', 'Fix arith.py so add(x,y) returns x+y and write test_arith.py asserting add(2,3)==5. Verify with pytest.', {
      fileScope: ['arith.py', 'test_arith.py'],
      verificationCommand: 'python3 -m pytest -q',
    });

    const agent = new Agent({
      id: 'python-agent',
      role: 'coder',
      config,
      workspace,
      events: new EventBus(),
      cwd: dir,
      context,
    });

    const result = await agent.run(task);
    expect(result.success).toBe(true);
    expect(result.summary).toMatch(/pytest|passed/);
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});
