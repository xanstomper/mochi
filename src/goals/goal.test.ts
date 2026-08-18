import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { GoalEngine } from './goal.js';
import { Workspace } from '../workspace.js';
import { EventBus } from '../events.js';
import { createTask } from './task.js';
import { startFakeOpenAI, type FakeOpenAI } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

let fake: FakeOpenAI;
let config: MochiConfig;

beforeAll(async () => {
  fake = await startFakeOpenAI([
    {
      content: 'Writing file.',
      toolCalls: [
        {
          id: '1',
          type: 'function',
          function: { name: 'write', arguments: JSON.stringify({ path: 'generated.txt', content: 'mochi goal' }) },
        },
      ],
      finishReason: 'tool_calls',
    },
    { content: 'Done.', finishReason: 'stop', completionTokens: 8 },
    { content: '{"status":"PASS","passed":["file created","tests passed"],"failed":[],"recommendation":"Complete"}', finishReason: 'stop', completionTokens: 40 },
  ]);
  config = {
    model: {
      provider: 'openai',
      baseUrl: fake.url,
      model: 'fake-model',
    },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 10,
      maxIterations: 10,
      maxRuntimeMinutes: 10,
      maxConcurrentAgents: 2,
      contextBudgetTokens: 4000,
      maxModelCalls: 10,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
    telemetry: false,
    projectDir: '.mochi',
    configDir: '/tmp',
    quiet: true,
    verbose: false,
    debug: false,
  } as unknown as MochiConfig;
});

afterAll(async () => { await fake.close(); });

describe('GoalEngine', () => {
  it('runs a task through the builder, verifier, and scheduler', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-goal-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const engine = new GoalEngine(config, workspace, new EventBus(), dir);
    const goal = await engine.createGoal('create generated.txt');
    const task = createTask('Create file', 'Create generated.txt containing mochi goal', {
      acceptanceCriteria: ['generated.txt exists'],
    });
    const result = await engine.runGoal(goal, [task]);
    expect(result.success).toBe(true);
    expect(readFileSync(resolve(dir, 'generated.txt'), 'utf8')).toBe('mochi goal');
    expect(result.summary).toContain('1 done');
  });
});
