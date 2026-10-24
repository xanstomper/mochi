import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine } from './context.js';
import type { MochiConfig } from './types.js';

let isolatedSkillsDir: string;
beforeAll(() => { isolatedSkillsDir = mkdtempSync(join(tmpdir(), 'mochi-shrink-skills-')); });
afterAll(() => rmSync(isolatedSkillsDir, { recursive: true, force: true }));

function cfg(budget = 100_000): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fake-model' },
    safety: { contextBudgetTokens: budget, maxIterations: 50, maxRuntimeMinutes: 10, mode: 'safe' as const },
  } as MochiConfig;
}

function engineWithAgedOutputs(budget: number, aged = 20, chars = 4000): ContextEngine {
  const eng = new ContextEngine(cfg(budget), '/tmp', isolatedSkillsDir);
  eng.addMessage({ role: 'user', content: 'do the task' });
  for (let i = 0; i < aged; i++) {
    eng.addMessage({ role: 'assistant', content: `step ${i}` });
    eng.addMessage({ role: 'tool', name: 'read', content: `output ${i}: ${'x'.repeat(chars)}` });
  }
  eng.addMessage({ role: 'assistant', content: 'recent turn' });
  return eng;
}

describe('polling elision (SWE-agent cache-aware shrink)', () => {
  it('skips shrinking on non-poll turns when the packet is under budget', () => {
    const eng = engineWithAgedOutputs(100_000);
    // Call 1 (poll allowed): shrinks aged dense outputs.
    const first = eng.shrinkOldToolOutputs();
    expect(first).toBeGreaterThan(0);
    // Calls 2..3 (not multiples of ELIDE_POLL): skipped, prefix stable.
    expect(eng.shrinkOldToolOutputs()).toBe(0);
    expect(eng.shrinkOldToolOutputs()).toBe(0);
    // Call 4 (multiple of ELIDE_POLL): boundary advances again (may be 0 if
    // nothing newly aged past the window, but must not throw).
    expect(eng.shrinkOldToolOutputs()).toBeGreaterThanOrEqual(0);
  });

  it('polls immediately when the packet is over 80% of budget', () => {
    const eng = engineWithAgedOutputs(3_000);
    // First call: count 1 (1 % 4 !== 0) — but over budget, so it must NOT skip.
    const saved = eng.shrinkOldToolOutputs();
    expect(saved).toBeGreaterThan(0);
  });
});
