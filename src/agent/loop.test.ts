import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Agent } from './loop.js';
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
});
