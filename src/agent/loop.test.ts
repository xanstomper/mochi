import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import type { MochiConfig, ModelResponse } from '../types.js';

function makeConfig(dir: string): MochiConfig {
  return {
    model: {
      provider: 'mock',
      baseUrl: '',
      model: 'mock',
      mockResponses: [
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
        { content: 'Done.', finishReason: 'stop' },
      ] as unknown as ModelResponse['toolCalls'],
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
    const config = makeConfig(dir);
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
  });
});
