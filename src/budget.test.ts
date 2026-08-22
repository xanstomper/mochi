import { describe, it, expect } from 'vitest';
import { BudgetEngine, estimateCostUsd } from './budget.js';

const base = {
  mode: 'auto' as const,
  commandTimeoutSeconds: 30,
  maxIterations: 10,
  maxRuntimeMinutes: 10,
  maxConcurrentAgents: 2,
  contextBudgetTokens: 1000,
};

describe('BudgetEngine', () => {
  it('estimates cost per model', () => {
    expect(estimateCostUsd(1000, 'gpt-4o')).toBeGreaterThan(0);
    expect(estimateCostUsd({ promptTokens: 1000, completionTokens: 100 }, 'gpt-4o')).toBeCloseTo(0.0035);
    expect(estimateCostUsd(1000, 'deepseek-v4-flash-free')).toBe(0);
  });

  it('starts in full phase and throttles as budget is consumed', () => {
    const b = new BudgetEngine({ ...base, maxTokens: 1000 });
    b.start();
    expect(b.phase()).toBe('full');
    b.recordTokens(600, 'gpt-4o');
    expect(b.phase()).toBe('reduced');
    b.recordTokens(300, 'gpt-4o');
    expect(b.phase()).toBe('cheap');
    b.recordTokens(50, 'gpt-4o');
    expect(b.phase()).toBe('verify');
    b.recordTokens(60, 'gpt-4o');
    expect(b.phase()).toBe('exhausted');
    expect(b.canMakeModelCall()).toBe(false);
  });

  it('tracks model and tool call limits', () => {
    const b = new BudgetEngine({ ...base, maxModelCalls: 1, maxToolCalls: 1 });
    b.start();
    b.recordModelCall();
    expect(b.canMakeModelCall()).toBe(false);
    b.recordToolCall();
    expect(b.phase()).toBe('exhausted');
  });
});
