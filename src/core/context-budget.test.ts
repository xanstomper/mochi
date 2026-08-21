import { describe, it, expect } from 'vitest';
import { estimateTokens, foldToolResult, ContextBudgetManager } from './context-budget.js';

describe('ContextBudgetManager', () => {
  it('estimates token count accurately based on character heuristics', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBeGreaterThanOrEqual(1);
    expect(estimateTokens('a'.repeat(400))).toBe(106);
  });

  it('folds large tool results while preserving head and tail signatures', () => {
    const lines = [];
    lines.push('--- vitest start ---');
    for (let i = 1; i <= 200; i++) {
      lines.push(`test line ${i}: passed`);
    }
    lines.push('--- vitest summary: 200 passed ---');
    const content = lines.join('\n');

    const folded = foldToolResult(content, 100);
    expect(folded).toContain('--- vitest start ---');
    expect(folded).toContain('--- vitest summary: 200 passed ---');
    expect(folded).toContain('lines omitted');
    expect(estimateTokens(folded)).toBeLessThan(estimateTokens(content));
  });

  it('allocates 6-tier budget slices within overall token limits', () => {
    const mgr = new ContextBudgetManager(64_000);
    const plan = mgr.getBudgetPlan();

    expect(plan.maxTokens).toBe(64_000);
    expect(plan.reservedTokens).toBe(9_600);
    expect(plan.activeDialogTokens).toBeGreaterThan(10_000);
    expect(plan.identityTokens).toBeLessThanOrEqual(3_000);
  });

  it('fits history within token budget without discarding latest turns', () => {
    const mgr = new ContextBudgetManager(20_000);
    const messages = [
      { role: 'user' as const, content: 'first turn old message' },
      { role: 'assistant' as const, content: 'first response' },
      { role: 'user' as const, content: 'second turn message' },
      { role: 'assistant' as const, content: 'second response' },
      { role: 'user' as const, content: 'active recent turn' },
    ];

    const fitted = mgr.fitHistory(messages, 500);
    expect(fitted.length).toBeGreaterThan(0);
    expect(fitted[fitted.length - 1].content).toBe('active recent turn');
  });
});
