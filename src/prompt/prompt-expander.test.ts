import { describe, it, expect } from 'vitest';
import { expandUserPrompt, classifyIntent } from './prompt-expander.js';

describe('Intelligent Prompt Expander', () => {
  it('classifies intents accurately from short keywords', () => {
    expect(classifyIntent('fix the failing auth test')).toBe('bugfix');
    expect(classifyIntent('optimize slow regex search')).toBe('performance');
    expect(classifyIntent('audit permissions in API routes')).toBe('security');
    expect(classifyIntent('refactor database client to use pool')).toBe('refactor');
    expect(classifyIntent('create new stripe webhook handler')).toBe('feature');
    expect(classifyIntent('improve agent harness reasoning and loop')).toBe('harness');
  });

  it('compiles a concise user prompt into a structured multi-phase execution blueprint', () => {
    const raw = 'fix broken payment webhook';
    const plan = expandUserPrompt(raw, { testCmd: 'npm test' });

    expect(plan.originalPrompt).toBe(raw);
    expect(plan.intentCategory).toBe('bugfix');
    expect(plan.phases.length).toBe(5);
    expect(plan.phases[0].name).toContain('Phase 0');
    expect(plan.phases[1].name).toContain('Phase 1');
    expect(plan.phases[2].name).toContain('Phase 2');
    expect(plan.phases[3].name).toContain('Phase 3');
    expect(plan.phases[4].name).toContain('Phase 4');

    expect(plan.compiledPrompt).toContain('# MOCHI MASTER EXECUTION BLUEPRINT');
    expect(plan.compiledPrompt).toContain('## Execution Invariants & Constraints');
    expect(plan.compiledPrompt).toContain('Phase 0 — Full Codebase & Architecture Audit');
    expect(plan.compiledPrompt).toContain('Phase 3 — Multi-Layer Verification & Epistemic Testing');
    expect(plan.compiledPrompt).toContain('Phase 4 — Cline-Grade Structured Summary & Closeout');
  });
});
