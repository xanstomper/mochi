import { describe, it, expect } from 'vitest';
import { SpeculativeEngine } from './speculative.js';
import { BudgetEngine } from './budget.js';
import type { MochiConfig } from './types.js';

const config = {
  model: {
    provider: 'mock',
    baseUrl: '',
    model: 'mock',
    mockResponses: [
      { content: '["inspect types","reproduce with logging","check dependencies"]' },
      { content: 'Inspect the inferred types and fix the caller.' },
      { content: 'Add logging and reproduce the failure.' },
      { content: 'Check dependency versions and imports.' },
      { content: '{"index":1,"reason":"Type inspection finds the root cause most directly."}' },
    ],
  },
  safety: {
    mode: 'auto',
    commandTimeoutSeconds: 10,
    maxIterations: 10,
    maxRuntimeMinutes: 10,
    maxConcurrentAgents: 2,
    contextBudgetTokens: 1000,
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

describe('SpeculativeEngine', () => {
  it('generates strategies, evaluates them, and selects the best candidate', async () => {
    const budget = new BudgetEngine(config.safety);
    budget.start();
    const engine = new SpeculativeEngine(config, budget, 3);
    const result = await engine.speculate('TypeScript TS2345 error');
    expect(result.candidates).toHaveLength(3);
    expect(result.best?.strategy).toBe('inspect types');
    expect(result.best?.response).toContain('inferred types');
  });

  it('disables speculation when the budget is exhausted', async () => {
    const budget = new BudgetEngine({ ...config.safety, maxModelCalls: 0 });
    budget.start();
    const engine = new SpeculativeEngine(config, budget, 3);
    const result = await engine.speculate('anything');
    expect(result.candidates).toEqual([]);
    expect(result.verifierNotes).toContain('Budget exhausted');
  });
});
