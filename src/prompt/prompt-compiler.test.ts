import { describe, it, expect } from 'vitest';
import { MochiPromptCompiler } from './prompt-compiler.js';

describe('MochiPromptCompiler — Master System Engine', () => {
  const compiler = new MochiPromptCompiler();

  it('transforms simple request into multi-phase specification', () => {
    const raw = 'make a calculator app';
    const spec = compiler.compile(raw, {
      repoName: 'my-calc',
      primaryLanguage: 'typescript',
      testCommand: 'npm test',
    });

    expect(spec.rawUserPrompt).toBe(raw);
    expect(spec.complexity).toBeDefined();
    expect(spec.classifications.length).toBeGreaterThan(0);
    expect(spec.assumptions.length).toBeGreaterThan(0);
    expect(spec.phases.length).toBe(5);

    // Assert Phase contracts
    for (const phase of spec.phases) {
      expect(phase.name).toBeDefined();
      expect(phase.objective).toBeDefined();
      expect(phase.tasks.length).toBeGreaterThan(0);
      expect(phase.tools.length).toBeGreaterThan(0);
      expect(phase.exitCriteria.length).toBeGreaterThan(0);
    }

    // Markdown contains complete structure
    expect(spec.compiledMarkdownPrompt).toContain('# MOCHI MASTER EXECUTION BLUEPRINT');
    expect(spec.compiledMarkdownPrompt).toContain('## 1. Intent & Desired Outcome');
    expect(spec.compiledMarkdownPrompt).toContain('## 2. Invariants & Strict Constraints');
    expect(spec.compiledMarkdownPrompt).toContain('## 3. Assumptions & Default Inferences');
    expect(spec.compiledMarkdownPrompt).toContain('## 4. Priority Hierarchy');
    expect(spec.compiledMarkdownPrompt).toContain('## 5. Multi-Phase Execution Blueprint');
    expect(spec.compiledMarkdownPrompt).toContain('## 6. Verification & Acceptance Criteria');
    expect(spec.compiledMarkdownPrompt).toContain('## 7. Anti-Loop & Safety Enforcement');
  });

  it('classifies system-level tasks and assigns appropriate complexity', () => {
    const raw = 'rebuild the entire agent harness and streaming pipeline';
    const spec = compiler.compile(raw);

    expect(spec.complexity).toBe('SYSTEM_LEVEL');
    expect(spec.classifications).toContain('ARCHITECTURE');
  });
});
