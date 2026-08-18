import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { VerifierEngine } from './verification.js';
import { Workspace } from './workspace.js';
import { EventBus } from './events.js';
import { BudgetEngine } from './budget.js';
import { createTask } from './goals/task.js';
import { startFakeOpenAI, type FakeOpenAI } from './testutil/fake-openai.js';
import type { MochiConfig } from './types.js';

let fake: FakeOpenAI;
let baseConfig: MochiConfig;
let modelVerdictConfig: MochiConfig;

beforeAll(async () => {
  baseConfig = {
    model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-model' },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 10,
      maxIterations: 10,
      maxRuntimeMinutes: 10,
      maxConcurrentAgents: 2,
      contextBudgetTokens: 1000,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
    telemetry: false,
    projectDir: '.mochi',
    configDir: '/tmp',
    quiet: true,
    verbose: false,
    debug: false,
  } as unknown as MochiConfig;

  fake = await startFakeOpenAI([
    { content: '{"status":"PASS","passed":["criteria met"],"failed":[],"recommendation":"Complete"}', finishReason: 'stop', completionTokens: 40 },
  ]);
  modelVerdictConfig = {
    ...baseConfig,
    model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' },
  } as unknown as MochiConfig;
});

afterAll(async () => { await fake.close(); });

describe('VerifierEngine', () => {
  it('passes when verification commands succeed', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-verify-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const verifier = new VerifierEngine({
      cwd: dir,
      workspace,
      config: baseConfig,
      events: new EventBus(),
      budget: new BudgetEngine(baseConfig.safety),
    });
    const task = createTask('Add feature', 'Implement', { acceptanceCriteria: ['feature works'] });
    const result = await verifier.verify(task, 'Implemented feature');
    expect(result.status).toBe('PASS');
    expect(result.passed.join('\n')).toContain('npm test');
  });

  it('reports partial results when some checks fail', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-verify-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"', build: 'node -e "process.exit(1)"' } }));
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const verifier = new VerifierEngine({
      cwd: dir,
      workspace,
      config: baseConfig,
      events: new EventBus(),
      budget: new BudgetEngine(baseConfig.safety),
    });
    const task = createTask('Add feature', 'Implement', { acceptanceCriteria: ['feature works'] });
    const result = await verifier.verify(task, 'Implemented feature');
    expect(result.status).toBe('PARTIAL');
    expect(result.failed.join('\n')).toContain('build');
  });

  it('returns BLOCKED when no checks exist for acceptance criteria', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-verify-'));
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const verifier = new VerifierEngine({
      cwd: dir,
      workspace,
      config: baseConfig,
      events: new EventBus(),
      budget: new BudgetEngine(baseConfig.safety),
    });
    const task = createTask('Add feature', 'Implement', { acceptanceCriteria: ['feature works'] });
    const result = await verifier.verify(task, 'Implemented feature');
    expect(result.status).toBe('BLOCKED');
  });

  it('uses the model as an independent outcome judge', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-verify-'));
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const verifier = new VerifierEngine({
      cwd: dir,
      workspace,
      config: modelVerdictConfig,
      events: new EventBus(),
      budget: new BudgetEngine(modelVerdictConfig.safety),
    });
    const task = createTask('Add feature', 'Implement', { acceptanceCriteria: ['feature works'] });
    const result = await verifier.verify(task, 'Implemented feature');
    expect(result.status).toBe('PASS');
    expect(result.passed).toContain('criteria met');
  });
});
