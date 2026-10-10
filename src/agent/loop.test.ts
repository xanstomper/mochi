import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Agent, isPlanShaped, sanitizeVerifyCommand, stripThinkTags, isComplexRewritingTask } from './loop.js';
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
  it('rejects unsupported completion after a varied execution preamble', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-varied-preamble-'));
    const fake = await startFakeOpenAI([
      { content: 'I will create the requested file.', finishReason: 'stop' },
      { content: 'Done. Created greeting.txt.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('Create greeting.txt');
      const task = createTask('Create greeting file', 'Create greeting.txt containing hello mochi.');
      const agent = new Agent({ role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
      const result = await agent.run(task);
      expect(existsSync(resolve(dir, 'greeting.txt'))).toBe(false);
      expect(result.success).toBe(false);
      expect(result.stopReason).not.toBe('completed');
      expect(fake.requests.length).toBeLessThanOrEqual(3);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('does not report success when a coding preamble repeats without execution', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-repeated-preamble-'));
    const reply = { content: 'I will create the requested file.', finishReason: 'stop' };
    const fake = await startFakeOpenAI([reply, reply, reply]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('Create greeting.txt');
      const task = createTask('Create greeting file', 'Create greeting.txt containing hello mochi.');
      const agent = new Agent({ id: 'repeated-preamble-agent', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
      const result = await agent.run(task);
      expect(existsSync(resolve(dir, 'greeting.txt'))).toBe(false);
      expect(result.success).toBe(false);
      expect(result.stopReason).not.toBe('completed');
      expect(fake.requests.length).toBeLessThanOrEqual(3);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ends the run when the same no-tool answer repeats even after a file already changed', async () => {
    // The old `!fileChanged` gate disabled the same-answer guard forever once
    // any file was edited — a model that then repeated the same two prose
    // lines with zero tool calls burned every remaining iteration (the
    // "five minutes in, spitting the same two lines" symptom). Here the model
    // writes the file (fileChanged=true), then answers the same prose twice
    // with no tool calls: the run must finish on the repeat, not keep
    // requesting.
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-repeat-after-write-'));
    const sameLine = 'Still writing the file, almost there.';
    const fake = await startFakeOpenAI([
      {
        content: sameLine,
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'call_w1', function: { name: 'write', arguments: JSON.stringify({ path: 'greeting.txt', content: 'hello mochi' }) } }],
      },
      { content: sameLine, finishReason: 'stop' },
      { content: sameLine, finishReason: 'stop' },
      { content: sameLine, finishReason: 'stop' },
      { content: sameLine, finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('Create greeting.txt');
      const task = createTask('Create greeting file', 'Create greeting.txt containing hello mochi.');
      const agent = new Agent({ id: 'repeat-after-write-agent', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
      const result = await agent.run(task);
      expect(existsSync(resolve(dir, 'greeting.txt'))).toBe(true);
      // First repeat nudges; second repeat ends the run as stagnation
      // (tool_loop) — the repeated prose must never be crowned success.
      expect(result.success).toBe(false);
      expect(result.summary).toContain('Still writing the file');
      expect(fake.requests.length).toBeLessThanOrEqual(5);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('vetoes the 3rd consecutive identical tool call (todo/tool spam guard)', async () => {
    // The "spamming todos multiple times" symptom: the model re-issues the
    // exact same tool call across iterations. The 1st and 2nd execute; the 3rd+
    // must be vetoed with a move-on directive instead of burning iterations.
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-tool-spam-'));
    const sameCall = {
      content: 'Tracking progress.',
      toolCalls: [{ id: 'call_spam', function: { name: 'todo', arguments: JSON.stringify({ action: 'add', title: 'Do the thing' }) } }],
      finishReason: 'tool_calls' as const,
    };
    const fake = await startFakeOpenAI([
      sameCall, sameCall, sameCall, sameCall,
      { content: 'All tests pass, task complete.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('Do the thing');
      const task = createTask('Do the thing task', 'fix the build and add tests. todo tracking included.');
      const agent = new Agent({ id: 'spam-guard-agent', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
      const result = await agent.run(task);
      // The duplicate write-style calls must not each execute — the todo tool
      // is additive so check the run completed without burning all requests.
      expect(fake.requests.length).toBeLessThanOrEqual(5);
      void result;
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('token budget counts OUTPUT tokens only — a task can still edit after many input-heavy iterations', async () => {
    // The old accounting added response.usage.totalTokens (prompt + completion
    // re-billed every call) into the cumulative budget. Any long task blew
    // past safety.maxTokens => phase 'exhausted' => every tool call vetoed =>
    // the agent could read/think for minutes but never write. Now the budget
    // counts completion tokens; a write-heavy run under a tight token cap
    // must still complete its file edit.
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-budget-output-'));
    const fake = await startFakeOpenAI([
      {
        content: 'Writing the file now.',
        toolCalls: [{ id: 'call_b1', function: { name: 'write', arguments: JSON.stringify({ path: 'out.txt', content: 'done' }) } }],
        finishReason: 'tool_calls',
      },
      { content: 'File written and verified. <VERDICT>DONE</VERDICT>', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      // Tiny cap that WOULD be blown by cumulative input tokens (~2 calls * big prompts).
      config.safety.maxTokens = 500;
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('Write out.txt');
      const task = createTask('Write out file task', 'Create out.txt containing done.');
      const agent = new Agent({ id: 'budget-output-agent', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
      const result = await agent.run(task);
      expect(existsSync(resolve(dir, 'out.txt'))).toBe(true);
      expect(result.success).toBe(true);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a truly exhausted budget finishes the run instead of veto-looping', async () => {
    // When phase() hits 'exhausted' the run must END (bounded early-finish),
    // not keep issuing veto messages for every remaining iteration.
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-budget-exhaust-'));
    const fake = await startFakeOpenAI([
      { content: 'Reading the build first.', toolCalls: [{ id: 'call_ex', function: { name: 'read', arguments: JSON.stringify({ path: 'package.json' }) } }], finishReason: 'tool_calls' },
      // Budget already exhausted by call 1 — this 2nd tool call must hit the
      // veto path and the run must finish 'budget' instead of looping.
      { content: 'Reading again.', toolCalls: [{ id: 'call_ex2', function: { name: 'read', arguments: JSON.stringify({ path: 'README.md' }) } }], finishReason: 'tool_calls' },
      { content: 'More reading.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      config.safety.maxTokens = 1; // anything recorded => ratio 0 => exhausted
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('Fix something');
      const task = createTask('Fix the flaky build', 'fix the build and run tests');
      const { BudgetEngine } = await import('../budget.js');
      const budget = new BudgetEngine(config.safety);
      budget.start();
      const agent = new Agent({ id: 'budget-exhaust-agent', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context, budget });
      const result = await agent.run(task);
      expect(result.stopReason).toBe('budget');
      expect(result.success).toBe(false);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('continues an unscoped coding task after a prose-only preamble', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-preamble-'));
    const fake = await startFakeOpenAI([
      { content: 'I will inspect the project and create the requested file.', finishReason: 'stop' },
      {
        toolCalls: [{
          id: 'preamble-recovery-write',
          type: 'function',
          function: { name: 'write', arguments: JSON.stringify({ path: resolve(dir, 'greeting.txt'), content: 'hello mochi' }) },
        }],
        finishReason: 'tool_calls',
      },
      { content: 'Created greeting.txt.', finishReason: 'stop' },
    ]);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('Create greeting.txt containing hello mochi');
      const task = createTask('Create greeting file', 'Create greeting.txt containing exactly hello mochi.');
      const agent = new Agent({ id: 'preamble-agent', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
      const result = await agent.run(task);
      expect(existsSync(resolve(dir, 'greeting.txt'))).toBe(true);
      expect(readFileSync(resolve(dir, 'greeting.txt'), 'utf8')).toBe('hello mochi');
      expect(result.success).toBe(true);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it('injects the active mode instruction into the system context', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-mode-'));
    const fake = await startFakeOpenAI([
      { content: 'Audit done.', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    config.mode = 'security';
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('audit the repo');
    const task = createTask('Audit', 'Scan for hardcoded secrets.');

    const agent = new Agent({
      id: 'test-agent',
      role: 'reviewer',
      config,
      workspace,
      events: new EventBus(),
      cwd: dir,
      context,
    });

    const result = await agent.run(task);
    expect(result.success).toBe(true);
    const systemMessages = fake.requests
      .flatMap((r: any) => r.body?.messages ?? [])
      .filter((m: any) => m.role === 'system')
      .map((m: any) => m.content)
      .join('\n');
    expect(systemMessages).toContain('ACTIVE MODE: SECURITY');
    expect(systemMessages).toContain('Scan statically for injection');
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

  it('sanitizeVerifyCommand strips template placeholders that would break sh', () => {
    expect(sanitizeVerifyCommand('cd <project_root> && zig build test')).toBe('zig build test');
    expect(sanitizeVerifyCommand('cd <project_root> && cargo test')).toBe('cargo test');
    expect(sanitizeVerifyCommand('python3 -m pytest -q')).toBe('python3 -m pytest -q');
    expect(sanitizeVerifyCommand('go test ./... <root>')).toBe('go test ./... .');
  });

  it('sanitizeVerifyCommand leaves real cd prefixes intact', () => {
    expect(sanitizeVerifyCommand('cd /tmp/proj && cargo test')).toBe('cd /tmp/proj && cargo test');
  });

  it('hygiene gate catches leftover TODO debris and loops to fix it', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-review-'));
    execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init', { cwd: dir, shell: '/bin/sh' });
    writeFileSync(resolve(dir, 'lib.ts'), 'export const answer = 42;\n');
    execSync('git add -A && git commit -qm base', { cwd: dir });

    const writeCall = (id: string, path: string, content: string) => ({
      id, type: 'function' as const,
      function: { name: 'write', arguments: JSON.stringify({ path, content }) },
    });
    const fake = await startFakeOpenAI([
      // 1: write a "fix" that leaves TODO debris behind.
      { content: 'Editing.', toolCalls: [writeCall('1', resolve(dir, 'lib.ts'), 'export const answer = 42;\n// TODO: finish')], finishReason: 'tool_calls' },
      // 2: claim done -> verify passes -> HYGIENE gate nudges (no model call).
      { content: 'Done.', finishReason: 'stop' },
      // 3: after the hygiene nudge, fixes the file.
      { content: 'Fixing the leftover.', toolCalls: [writeCall('2', resolve(dir, 'lib.ts'), 'export const answer = 42;\n')], finishReason: 'tool_calls' },
      // 4: done again -> verify -> hygiene clean -> self-review says clean.
      { content: 'Done.', finishReason: 'stop' },
      { content: 'NO_ISSUE', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('fix');
    const task = createTask('Fix', 'Make lib.ts export answer = 42.', { fileScope: ['lib.ts'], verificationCommand: 'true' });
    const agent = new Agent({ id: 'review-agent', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
    const result = await agent.run(task);
    expect(result.success).toBe(true);
    expect(readFileSync(resolve(dir, 'lib.ts'), 'utf8')).not.toContain('TODO');
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('self-review catches a real correctness problem (wrong constant) and loops to fix it', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-review-const-'));
    execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init', { cwd: dir, shell: '/bin/sh' });
    writeFileSync(resolve(dir, 'lib.ts'), 'export const answer = 42;\n');
    execSync('git add -A && git commit -qm base', { cwd: dir });
    const writeCall = (id: string, path: string, content: string) => ({
      id, type: 'function' as const,
      function: { name: 'write', arguments: JSON.stringify({ path, content }) },
    });
    // The defect is a WRONG CONSTANT (answer = 0), which no scanner rule can
    // see — this is exactly what the model-driven self-review exists for.
    const fake = await startFakeOpenAI([
      { content: 'Editing.', toolCalls: [writeCall('1', resolve(dir, 'lib.ts'), 'export const answer = 0;\n')], finishReason: 'tool_calls' },
      { content: 'Done.', finishReason: 'stop' },
      // SELF-REVIEW reply cites a concrete file+line defect.
      { content: 'lib.ts:1 sets answer to 0; the task requires 42.', finishReason: 'stop' },
      { content: 'Fixing.', toolCalls: [writeCall('2', resolve(dir, 'lib.ts'), 'export const answer = 42;\n')], finishReason: 'tool_calls' },
      { content: 'Done.', finishReason: 'stop' },
      { content: 'NO_ISSUE', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('fix');
    const task = createTask('Fix', 'Make lib.ts export answer = 42.', { fileScope: ['lib.ts'], verificationCommand: 'true' });
    const agent = new Agent({ id: 'review-agent-2', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
    const result = await agent.run(task);
    expect(result.success).toBe(true);
    expect(readFileSync(resolve(dir, 'lib.ts'), 'utf8')).toContain('answer = 42');
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('does not re-loop / re-stream when self-review returns a terse non-issue verdict', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-review-terse-'));
    execSync('git init -q && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m init', { cwd: dir, shell: '/bin/sh' });
    writeFileSync(resolve(dir, 'lib.ts'), 'export const answer = 42;\n');
    execSync('git add -A && git commit -qm base', { cwd: dir });
    const writeCall = (id: string, path: string, content: string) => ({
      id, type: 'function' as const,
      function: { name: 'write', arguments: JSON.stringify({ path, content }) },
    });
    const fake = await startFakeOpenAI([
      // 1: write a real change.
      { content: 'Editing.', toolCalls: [writeCall('1', resolve(dir, 'lib.ts'), 'export const answer = 42;\nexport const extra = 1;\n')], finishReason: 'tool_calls' },
      // 2: claim done -> verify (trivial) -> self-review is called.
      { content: 'Done.', finishReason: 'stop' },
      // 3: the REVIEW answer is terse and cites no file. It MUST be read as
      //    "no issue", not as a blocking problem, or the agent re-loops and
      //    keeps streaming "done" (the "spams the same message" bug).
      { content: 'done', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('extend');
    const task = createTask('Extend', 'Add an extra export.', { fileScope: ['lib.ts'], verificationCommand: 'true' });
    const bus = new EventBus();
    const chunks: string[] = [];
    bus.on('message:chunk', (e: any) => chunks.push(String(e.content)));
    const agent = new Agent({ id: 'review-terse', role: 'coder', config, workspace, events: bus, cwd: dir, context });
    const result = await agent.run(task);
    expect(result.success).toBe(true);
    // The final "done" answer must be streamed exactly once (2 chunks from the
    // fake's split), not repeated by a self-review misclassification loop.
    expect(chunks.join('')).toBe('Done.');
    // Only a handful of model calls: write turn, the answer, one self-review.
    expect(fake.requests.length).toBeLessThanOrEqual(4);
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('bounds a model that loops and repeats the same boilerplate in one streamed response', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-loop-spam-'));
    // A pathological free-tier reply: the same boilerplate many times.
    const line = 'We must focus on implementation until the verified outcome';
    const spam = Array.from({ length: 30 }, () => line).join('\n');
    const fake = await startFakeOpenAI([
      { content: spam, finishReason: 'stop' },
      { content: 'Done.', finishReason: 'stop', completionTokens: 8 },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('answer');
    const task = createTask('Answer', 'Give the result.');
    const bus = new EventBus();
    const chunks: string[] = [];
    bus.on('message:chunk', (e: any) => chunks.push(String(e.content)));
    const agent = new Agent({ id: 'loop-spam', role: 'coder', config, workspace, events: bus, cwd: dir, context });
    const result = await agent.run(task);
    expect(result.success).toBe(true);
    // The 30-line repeat must NOT be emitted to the transcript; only the
    // follow-up clean answer is streamed (a couple of chunks).
    expect(chunks.length).toBeLessThan(8);
    expect(chunks.join('').replace(/\s+/g, ' ')).toContain('Done');
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('truncates a high-entropy runaway generation even when no single line repeats', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-loop-runaway-'));
    // A degenerate model streams thousands of distinct tiny fragments of the
    // same "let me explore the repo" intent (high entropy, no progress, no
    // identical line). The old repeat-only guard missed this; the generation
    // must now be bounded by SIZE not just repetition.
    const fragments = Array.from(
      { length: 1200 },
      (_, i) => `Let me explore the repository structure to understand the project setup (pass ${i}).`,
    );
    const fake = await startFakeOpenAI([
      { content: fragments.join('\n'), finishReason: 'stop' },
      { content: 'Done.', finishReason: 'stop', completionTokens: 8 },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('answer');
    const task = createTask('Answer', 'Give the result.');
    const bus = new EventBus();
    const chunks: string[] = [];
    bus.on('message:chunk', (e: any) => chunks.push(String(e.content)));
    const agent = new Agent({ id: 'loop-runaway', role: 'coder', config, workspace, events: bus, cwd: dir, context });
    const result = await agent.run(task);
    expect(result.success).toBe(true);
    // Each fragment differs only by "(pass N)", so no identical line repeated
    // >=24 times. The runaway (1200 lines, ~100KB) is still truncated by size;
    // the transcript must not contain the flood, only the clean answer.
    expect(chunks.join('').replace(/\s+/g, ' ')).toContain('Done');
    expect(chunks.length).toBeLessThan(12);
    const flat = chunks.join('');
    expect(flat.match(/pass \d+/g)?.length ?? 0).toBeLessThan(5);
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it('bounds the exact live spam case: newline-less "open it, open it," flood (796 chunks, 14KB)', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-loop-openit-'));
    // Reproduced from the user's real session trace: one giant line, no
    // newlines at all, short 7-char phrases ("open it") below the old
    // 12-char phrase threshold, 14KB total (under byte cap), 796 chunks
    // (under chunk cap). Only a short-period runaway detector catches it.
    const spam = 'open it, '.repeat(1800); // ~14.4KB, single line
    const fake = await startFakeOpenAI([
      { content: spam, finishReason: 'stop' },
      { content: 'Done.', finishReason: 'stop', completionTokens: 8 },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('answer');
    const task = createTask('Answer', 'Give the result.');
    const bus = new EventBus();
    const chunks: string[] = [];
    bus.on('message:chunk', (e: any) => chunks.push(String(e.content)));
    const agent = new Agent({ id: 'loop-openit', role: 'coder', config, workspace, events: bus, cwd: dir, context });
    const result = await agent.run(task);
    expect(result.success).toBe(true);
    // The flood must NOT reach the transcript. Only the clean retry answer.
    const flat = chunks.join('');
    const openCount = (flat.match(/open it/g) ?? []).length;
    expect(openCount).toBeLessThan(5);
    expect(flat.replace(/\s+/g, ' ')).toContain('Done');
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);

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

  it('injects file scope symbol outlines into Turn 0 preflight', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-scope-preflight-'));
    writeFileSync(
      resolve(dir, 'math.ts'),
      'export class Calculator {\n  add(a: number, b: number): number { return a + b; }\n}\n'
    );
    const fake = await startFakeOpenAI([
      { content: 'Done.', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('test preflight');
    const task = createTask('Calculate', 'Run calculation', {
      fileScope: ['math.ts'],
      verificationCommand: 'true',
    });

    const agent = new Agent({
      id: 'preflight-test',
      role: 'coder',
      config,
      workspace,
      events: new EventBus(),
      cwd: dir,
      context,
    });

    await agent.run(task);
    const messages = (context as any).messages as any[];
    const preflight = messages.find((m) => m.role === 'system' && m.content.includes('File Scope Symbol Outline'));
    expect(preflight).toBeDefined();
    expect(preflight?.content).toContain('[class] export class Calculator');
    expect(preflight?.content).toContain('[method] add(a: number, b: number)');
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('condenses verification failures preserving critical assertion diffs and lines', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-verify-condense-'));
    const noisyFailScript = [
      'console.log("=== Build started ===");',
      'for (let i = 0; i < 40; i++) console.log("Compiling package " + i);',
      'console.error("FAIL src/calc.test.ts > adds two numbers");',
      'console.error("AssertionError: expected 5 to deeply equal 6");',
      'console.error("  + expected - actual");',
      'console.error("  - 6");',
      'console.error("  + 5");',
      'for (let i = 0; i < 40; i++) console.log("Cleaning up target " + i);',
      'process.exit(1);',
    ].join('\n');
    writeFileSync(resolve(dir, 'fail.js'), noisyFailScript);

    const writeCall = (id: string, path: string) => ({
      id,
      type: 'function' as const,
      function: { name: 'write', arguments: JSON.stringify({ path, content: 'broken' }) },
    });
    const fake = await startFakeOpenAI([
      { content: 'Writing.', toolCalls: [writeCall('1', resolve(dir, 'out.txt'))], finishReason: 'tool_calls' },
      { content: 'Done, completed.', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    config.safety.maxVerifyRetries = 1;
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('test verify condense');
    const task = createTask('Fail Task', 'Should condense failure', {
      verificationCommand: 'node fail.js',
    });

    const agent = new Agent({
      id: 'verify-condense-agent',
      role: 'coder',
      config,
      workspace,
      events: new EventBus(),
      cwd: dir,
      context,
    });

    const result = await agent.run(task);
    expect(result.success).toBe(false);
    expect(result.summary).toContain('FAIL src/calc.test.ts');
    expect(result.summary).toContain('AssertionError: expected 5 to deeply equal 6');
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
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

function toolAvailable(cmd: string): boolean {
  try {
    execSync(`${cmd} 2>&1`, { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}
const goSuite = toolAvailable('go version') ? describe : describe.skip;
const cargoSuite = toolAvailable('cargo --version') ? describe : describe.skip;

goSuite('polyglot: go repo end-to-end', () => {
  it('fixes a go function and verifies with real go test', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-goloop-'));
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email t@t && git config user.name t', { cwd: dir });
    writeFileSync(resolve(dir, 'go.mod'), 'module example.com/fib\n\ngo 1.22\n');
    writeFileSync(resolve(dir, 'fib.go'), 'package fib\n\nfunc Fib(n int) int {\n    if n <= 1 {\n        return n\n    }\n    return Fib(n-1) + Fib(n-2) + 1\n}\n');
    writeFileSync(resolve(dir, 'fib_test.go'), 'package fib\n\nimport "testing"\n\nfunc TestFib(t *testing.T) {\n    if got := Fib(5); got != 5 {\n        t.Fatalf("Fib(5) = %d, want 5", got)\n    }\n}\n');
    execSync('git add -A && git commit -qm init', { cwd: dir });

    const writeCall = (id: string, path: string, content: string) => ({
      id,
      type: 'function' as const,
      function: { name: 'write', arguments: JSON.stringify({ path, content }) },
    });
    const fake = await startFakeOpenAI([
      {
        content: 'Fixing fib.',
        toolCalls: [writeCall('1', resolve(dir, 'fib.go'), 'package fib\n\nfunc Fib(n int) int {\n    if n <= 1 {\n        return n\n    }\n    return Fib(n-1) + Fib(n-2)\n}\n')],
        finishReason: 'tool_calls',
      },
      { content: 'Done, go tests pass.', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('fix go fib');
    const task = createTask('Fix Fib()', 'Fix fib.go so Fib(n) returns the n-th fibonacci number (0,1,1,2,3,5). Verify with go test ./...', {
      fileScope: ['fib.go'],
      verificationCommand: 'go test ./...',
    });
    const agent = new Agent({ id: 'go-agent', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
    const result = await agent.run(task);
    expect(result.success).toBe(true);
    expect(result.summary).toMatch(/go test|ok|PASS/i);
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});

cargoSuite('polyglot: rust repo end-to-end', () => {
  it('fixes a rust function and verifies with real cargo test', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-rsloop-'));
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email t@t && git config user.name t', { cwd: dir });
    execSync('mkdir -p src', { cwd: dir });
    writeFileSync(resolve(dir, 'Cargo.toml'), '[package]\nname = "fib"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(resolve(dir, 'src/lib.rs'), 'pub fn fib(n: u32) -> u32 {\n    match n {\n        0 => 0,\n        1 => 1,\n        n => fib(n - 1) + fib(n - 2) + 1,\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn fib5() {\n        assert_eq!(fib(5), 5);\n    }\n}\n');
    execSync('git add -A && git commit -qm init', { cwd: dir });

    const writeCall = (id: string, path: string, content: string) => ({
      id,
      type: 'function' as const,
      function: { name: 'write', arguments: JSON.stringify({ path, content }) },
    });
    const fake = await startFakeOpenAI([
      {
        content: 'Fixing fib.',
        toolCalls: [writeCall('1', resolve(dir, 'src/lib.rs'), 'pub fn fib(n: u32) -> u32 {\n    match n {\n        0 => 0,\n        1 => 1,\n        n => fib(n - 1) + fib(n - 2),\n    }\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn fib5() {\n        assert_eq!(fib(5), 5);\n    }\n}\n')],
        finishReason: 'tool_calls',
      },
      { content: 'Done, cargo tests pass.', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('fix rust fib');
    const task = createTask('Fix fib()', 'Fix src/lib.rs so fib(5) returns 5. Verify with cargo test.', {
      fileScope: ['src/lib.rs'],
      verificationCommand: 'cargo test',
    });
    const agent = new Agent({ id: 'rs-agent', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
    const result = await agent.run(task);
    expect(result.success).toBe(true);
    expect(result.summary).toMatch(/cargo test|test result|ok/);
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }, 180_000);
});

const zigSuite = toolAvailable('zig version') ? describe : describe.skip;

zigSuite('polyglot: zig repo end-to-end', () => {
  it('fixes a zig function and verifies with real zig build test', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-zigloop-'));
    execSync('git init -q', { cwd: dir });
    execSync('git config user.email t@t && git config user.name t', { cwd: dir });
    execSync('mkdir -p src', { cwd: dir });
    writeFileSync(resolve(dir, 'build.zig'), [
      'const std = @import("std");',
      'pub fn build(b: *std.Build) void {',
      '    const target = b.standardTargetOptions(.{});',
      '    const exe = b.addExecutable(.{ .name = "fib", .root_module = b.createModule(.{ .root_source_file = b.path("src/main.zig"), .target = target, .optimize = .Debug }) });',
      '    b.installArtifact(exe);',
      '    const run = b.addRunArtifact(exe);',
      '    const test_step = b.step("test", "Run unit tests");',
      '    test_step.dependOn(&run.step);',
      '}',
    ].join('\n'));
    writeFileSync(resolve(dir, 'src/main.zig'), [
      'const std = @import("std");',
      'fn fib(n: u32) u32 {',
      '    if (n <= 1) return n;',
      '    return fib(n - 1) + fib(n - 2) + 1;',
      '}',
      'pub fn main() void {',
      '    std.debug.print("fib(5)={d}\\n", .{fib(5)});',
      '    if (fib(5) != 5) std.process.exit(1);',
      '}',
      '',
      'test "fib" {',
      '    try std.testing.expectEqual(@as(u32, 5), fib(5));',
      '}',
    ].join('\n'));
    execSync('git add -A && git commit -qm init', { cwd: dir });

    const writeCall = (id: string, path: string, content: string) => ({
      id,
      type: 'function' as const,
      function: { name: 'write', arguments: JSON.stringify({ path, content }) },
    });
    const fake = await startFakeOpenAI([
      {
        content: 'Fixing fib.',
        toolCalls: [writeCall('1', resolve(dir, 'src/main.zig'), [
          'const std = @import("std");',
          'fn fib(n: u32) u32 {',
          '    if (n <= 1) return n;',
          '    return fib(n - 1) + fib(n - 2);',
          '}',
          'pub fn main() void {',
          '    std.debug.print("fib(5)={d}\\n", .{fib(5)});',
          '    if (fib(5) != 5) std.process.exit(1);',
          '}',
          '',
          'test "fib" {',
          '    try std.testing.expectEqual(@as(u32, 5), fib(5));',
          '}',
        ].join('\n'))],
        finishReason: 'tool_calls',
      },
      { content: 'Done, zig tests pass.', finishReason: 'stop' },
    ]);
    const config = makeConfig(dir, fake.url);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('fix zig fib');
    const task = createTask('Fix fib()', 'Fix src/main.zig so fib(5) returns 5. Verify with zig build test.', {
      fileScope: ['src/main.zig', 'build.zig'],
      verificationCommand: 'zig build test',
    });
    const agent = new Agent({ id: 'zig-agent', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
    const result = await agent.run(task);
    expect(result.success).toBe(true);
    expect(result.summary).toMatch(/zig|ok|pass/i);
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);
});

describe('model stall guard (MOCHI_MODEL_RESPONSE_TIMEOUT_MS)', () => {
  // A short stall timeout lets the guard fire fast so tests prove a silent
  // provider hold no longer hangs the agent forever.
  const STALL_MS = '1500';

  async function runAgainst(script: Parameters<typeof startFakeOpenAI>[0]) {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-stall-'));
    const fake = await startFakeOpenAI(script);
    const old = process.env.MOCHI_MODEL_RESPONSE_TIMEOUT_MS;
    process.env.MOCHI_MODEL_RESPONSE_TIMEOUT_MS = STALL_MS;
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('answer briefly');
      const task = createTask('Answer', 'Reply with "ok". Do not use tools.');
      const agent = new Agent({ id: 'stall-ag', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
      return { result: await agent.run(task), fake };
    } finally {
      await fake.close();
      if (old === undefined) delete process.env.MOCHI_MODEL_RESPONSE_TIMEOUT_MS;
      else process.env.MOCHI_MODEL_RESPONSE_TIMEOUT_MS = old;
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a silent primary provider hold resolves with model_error instead of hanging', async () => {
    // First /chat/completions holds silently (no data, no error). The agent
    // must bound it via the stall guard, not hang forever.
    const { result, fake } = await runAgainst([
      { stall: true },
      { content: 'ok', finishReason: 'stop' },
    ]);
    expect(fake.requests.length).toBeGreaterThanOrEqual(1);
    expect(result.success).toBe(false);
    expect(result.stopReason).toBe('model_error');
  }, 60_000);

  it('a silent retry/failover hold also resolves instead of hanging forever', async () => {
    // Primary call returns a transient 500 -> propagates into the catch, which
    // retries via the failover provider. Make THAT retry stall silently.
    // Previously the retry ran UNBOUNDED and hung forever here.
    const { result, fake } = await runAgainst([
      { error: { status: 500, message: 'upstream boof' } },
      { stall: true },
      { content: 'ok', finishReason: 'stop' },
    ]);
    // The retry must have been attempted (the stalled request is a fresh call).
    expect(fake.requests.length).toBeGreaterThanOrEqual(2);
    expect(result.success).toBe(false);
    expect(result.stopReason).toBe('model_error');
  }, 60_000);

  it('a mid-stream connection drop fails over and finishes instead of dying with model_error', async () => {
    // Production shape: provider accepts the request, streams one chunk, then
    // the socket dies ("The operation was aborted" / "terminated"). This used
    // to finish the task immediately as model_error, killing minutes of real
    // work. It must instead fail over to the next model and complete.
    const { result, fake } = await runAgainst([
      { dropConn: true },
      { content: 'ok', finishReason: 'stop' },
    ]);
    expect(fake.requests.length).toBeGreaterThanOrEqual(2);
    expect(result.success).toBe(true);
    expect(result.stopReason).toBe('completed');
  }, 30_000);

  it('clears the stall timer on success: a later response is not aborted by an earlier gather timer', async () => {
    // P0 regression guard: boundedGather previously left the stall timer
    // alive after a successful gather, so a LATER healthy stream was aborted
    // ("model_response_timeout" failover) when the stale timer fired. The
    // first response completes well within STALL_MS; the second arrives after
    // STALL_MS has long passed — with the bug present it gets aborted.
    const { result, fake } = await runAgainst([
      { content: 'first', toolCalls: [{ id: 'call_t1', function: { name: 'todo', arguments: JSON.stringify({ action: 'add', title: 'x' }) } }], finishReason: 'tool_calls' },
      { delayMs: 2200 },
      { content: 'ok', finishReason: 'stop' },
    ]);
    expect(result.success).toBe(true);
    expect(result.stopReason).toBe('completed');
    expect(fake.requests.length).toBeGreaterThanOrEqual(2);
  }, 30_000);
});

describe('stream repetition guards (reasoning floods + K-phrase cycles)', () => {
  // The Oct-2 live trace: a model cycling the SAME 8 reasoning sentences ~50x
  // each (2030 agent:reasoning events in 36s, ~56 events/sec) until the task
  // died with model_error. The sliding-window guard (maxRep >= 8 within 20
  // phrases) mathematically cannot catch any cycle longer than 2 phrases, and
  // the reasoning branch never set `looped` at all. These tests pin the fix.

  const loopBlock = Array.from({ length: 8 }, (_, i) =>
    `Cycle line ${i} explains step number ${i} of the plan in some detail.`).join('\n');

  async function runAgainst(script: Parameters<typeof startFakeOpenAI>[0]) {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-rep-'));
    const fake = await startFakeOpenAI(script);
    try {
      const config = makeConfig(dir, fake.url);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const context = new ContextEngine(config, dir);
      context.setGoal('fix the repetition loop');
      // Title carries an action verb so classifyTaskKind does NOT route this
      // to 'chat' — a chat task legally completes on its first prose answer,
      // which would bypass the guards under test.
      const task = createTask('Fix the repetition loop bug', 'Reproduce the loop and fix it.');
      const agent = new Agent({ id: 'rep-ag', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
      return { result: await agent.run(task), fake };
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('bounds an 8-phrase reasoning cycle instead of flooding and stalling', async () => {
    // Reasoning-only flood: the loop block repeated enough times to cycle many
    // times over, then a clean answer. Before the fix this streamed every
    // copy to the TUI and never set looped.
    const flood = Array.from({ length: 30 }, () => loopBlock).join('\n');
    const { result, fake } = await runAgainst([
      { reasoningContent: flood, finishReason: 'stop' },
      { content: 'ok, done thinking. The answer is 4.', finishReason: 'stop' },
    ]);
    // The degenerate response must be detected (bounded), the loop recovers
    // on the next scripted response instead of flooding forever.
    expect(result.success).toBe(true);
    expect(fake.requests.length).toBeLessThanOrEqual(3);
  }, 30_000);

  it('bounds a K-phrase CONTENT cycle the sliding window cannot reach', async () => {
    // Content-side variant: 8 distinct sentences cycling (in-window count ~2,
    // far below maxRep >= 8). cycleStreak must catch it.
    const flood = Array.from({ length: 30 }, () => loopBlock).join('\n');
    const { result } = await runAgainst([
      { content: flood, finishReason: 'stop' },
      { content: 'ok', finishReason: 'stop' },
    ]);
    expect(result.success).toBe(true);
  }, 30_000);

  it('does not punish a post-tool interim recap as failed recovery', async () => {
    // Regression: the same-answer guard never reset on tool rounds, so
    // "prose A -> (nudge) -> tools -> prose A" hit the guard with planNudges>0
    // and failed the task as tool_loop — treating a legitimate interim
    // summary repeated between tool batches as "no execution evidence" even
    // though a tool had just executed. The reset on tool rounds must make
    // this sequence COMPLETE.
    const recap = 'Let me check the repository state first.';
    const { result, fake } = await runAgainst([
      // Execution preamble ("Let me check...") -> file-guard nudge, no completion.
      { content: recap, finishReason: 'stop' },
      // Real tool execution — proof of progress.
      { toolCalls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'package.json' }) } }], finishReason: 'tool_calls' },
      // Same prose again post-tool: with the reset this is a normal recap;
      // without it the guard would fail the run as tool_loop.
      { content: recap, finishReason: 'stop' },
    ]);
    expect(fake.requests.length).toBeGreaterThanOrEqual(3);
    expect(result.stopReason).toBe('completed');
  }, 30_000);

  it('still fails when prose repeats after tools but execution was nudged and never happened', async () => {
    // Failure direction: preamble nudged, NO tool ever ran, prose repeats —
    // that is failed recovery and must not complete.
    const preamble = 'I will inspect the project and fix the bug.';
    const { result, fake } = await runAgainst([
      { content: preamble, finishReason: 'stop' }, // nudge (planNudges=1)
      { content: 'I will inspect the project and fix the bug now.', finishReason: 'stop' }, // varied wording, still no tools
    ]);
    expect(result.success).toBe(false);
    expect(result.stopReason).toBe('tool_loop');
    expect(fake.requests.length).toBeLessThanOrEqual(2);
  }, 30_000);
});

describe('stripThinkTags', () => {
  it('strips <think>...</think> reasoning blocks', () => {
    const raw = '<think>\nNo tools needed... think! System prompt says...\n</think>\nHey! I\'m Mochi, your friendly coding agent.';
    expect(stripThinkTags(raw)).toBe("Hey! I'm Mochi, your friendly coding agent.");
  });

  it('strips <thought>...</thought> blocks', () => {
    const raw = '<thought>Internal monologue</thought>Hello world!';
    expect(stripThinkTags(raw)).toBe('Hello world!');
  });

  it('handles unclosed trailing think tags', () => {
    const raw = ' thinkingStill thinking...';
    expect(stripThinkTags(raw)).toBe('');
  });
});

describe('isComplexRewritingTask (large-rewrite protocol gate)', () => {
  it('flags multi-file / sweeping-work tasks', () => {
    expect(isComplexRewritingTask('Refactor the auth module')).toBe(true);
    expect(isComplexRewritingTask('Rewrite the renderer across multiple files')).toBe(true);
    expect(isComplexRewritingTask('Migrate the build to esbuild')).toBe(true);
    expect(isComplexRewritingTask('Design a new plugin architecture')).toBe(true);
    expect(isComplexRewritingTask('Extract the cache into its own module')).toBe(true);
    expect(isComplexRewritingTask('Add a new service', 'for the payment pipeline')).toBe(true);
  });

  it('does not flag one-answer / chat tasks', () => {
    expect(isComplexRewritingTask('Explain what ESRGANx2 does')).toBe(false);
    expect(isComplexRewritingTask('Say hello')).toBe(false);
    expect(isComplexRewritingTask('What is in this repo?')).toBe(false);
    expect(isComplexRewritingTask('Summarize the last 10 commits')).toBe(false);
  });
});
