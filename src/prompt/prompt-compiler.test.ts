import { describe, it, expect } from 'vitest';
import { MochiPromptCompiler } from './prompt-compiler.js';

const compiler = new MochiPromptCompiler();

describe('MochiPromptCompiler — LOW tier', () => {
  it('produces a compact micro-dispatch directive with direct execution steps', () => {
    const spec = compiler.compile('rename variable x to counter', { reasoning: 'low' });
    expect(spec.reasoningLevel).toBe('low');
    // Low tier = 1 direct-execution phase
    expect(spec.phases).toHaveLength(1);
    expect(spec.phases[0].name).toBe('Direct Execution');
    // Markdown should be terse — no multi-section bloat
    expect(spec.compiledMarkdownPrompt).toContain('DIRECT TASK');
    expect(spec.compiledMarkdownPrompt).toContain('LOW (FAST MICRO-DISPATCH)');
    // Should NOT contain multi-section headers like "Assumptions"
    expect(spec.compiledMarkdownPrompt).not.toContain('## 3. Assumptions');
  });
});

describe('MochiPromptCompiler — MEDIUM tier', () => {
  it('produces a 2-step invariant contract', () => {
    const spec = compiler.compile('fix jwt expiry bug in auth middleware', { reasoning: 'medium' });
    expect(spec.reasoningLevel).toBe('medium');
    expect(spec.phases).toHaveLength(2);
    expect(spec.phases[0].name).toBe('Implementation & AST Validation');
    expect(spec.phases[1].name).toBe('Verification & Summary');
    expect(spec.compiledMarkdownPrompt).toContain('MEDIUM (STREAMLINED INVARIANT CONTRACT)');
    expect(spec.compiledMarkdownPrompt).toContain('Core Invariants');
    expect(spec.compiledMarkdownPrompt).toContain('Action Sequence');
  });
});

describe('MochiPromptCompiler — HIGH tier', () => {
  it('produces a 3-phase discovery-build-verify action blueprint', () => {
    const spec = compiler.compile('add pagination to the posts API endpoint', { reasoning: 'high' });
    expect(spec.reasoningLevel).toBe('high');
    expect(spec.phases).toHaveLength(3);
    expect(spec.compiledMarkdownPrompt).toContain('HIGH (ACTION MULTI-PHASE)');
    expect(spec.compiledMarkdownPrompt).toContain('Multi-Phase Plan');
    expect(spec.compiledMarkdownPrompt).toContain('Phase 1 — Discovery & Invariant Check');
    expect(spec.compiledMarkdownPrompt).toContain('Phase 2 — Implementation & AST Guard');
    expect(spec.compiledMarkdownPrompt).toContain('Phase 3 — Epistemic Verification & Summary');
  });
});

describe('MochiPromptCompiler — MAX tier', () => {
  it('produces a 5-phase architectural master specification', () => {
    const spec = compiler.compile('rebuild the entire agent harness and streaming pipeline', { reasoning: 'max' });
    expect(spec.reasoningLevel).toBe('max');
    expect(spec.phases).toHaveLength(5);
    expect(spec.compiledMarkdownPrompt).toContain('MAX (DEEP ARCHITECTURAL SPEC)');
    expect(spec.compiledMarkdownPrompt).toContain('## 1. Intent & Desired Outcome');
    expect(spec.compiledMarkdownPrompt).toContain('## 3. Assumptions & Default Inferences');
    expect(spec.compiledMarkdownPrompt).toContain('## 4. Priority Hierarchy');
    expect(spec.compiledMarkdownPrompt).toContain('## 5. Multi-Phase Execution Blueprint');
    expect(spec.compiledMarkdownPrompt).toContain('## 6. Verification & Acceptance Criteria');
    expect(spec.compiledMarkdownPrompt).toContain('## 7. Anti-Loop & Safety Enforcement');
    // Complexity auto-detected as SYSTEM_LEVEL for harness rebuild
    expect(spec.complexity).toBe('SYSTEM_LEVEL');
  });

  it('detects SYSTEM_LEVEL complexity and ARCHITECTURE classification for harness task', () => {
    const spec = compiler.compile('rebuild the entire agent harness and streaming pipeline', { reasoning: 'max' });
    expect(spec.classifications).toContain('ARCHITECTURE');
  });
});

describe('MochiPromptCompiler — tier defaults', () => {
  it('defaults to max when reasoning is not specified', () => {
    const spec = compiler.compile('make a calculator app');
    expect(spec.reasoningLevel).toBe('max');
    expect(spec.phases).toHaveLength(5);
  });
});
