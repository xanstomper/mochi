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
  it('produces a 5-phase architectural master specification with full methodology sections', () => {
    const spec = compiler.compile('rebuild the entire agent harness and streaming pipeline', { reasoning: 'max' });
    expect(spec.reasoningLevel).toBe('max');
    expect(spec.phases).toHaveLength(5);
    // Output contract §32 — top-level sections
    expect(spec.compiledMarkdownPrompt).toContain('# TASK');
    expect(spec.compiledMarkdownPrompt).toContain('## OBJECTIVE');
    expect(spec.compiledMarkdownPrompt).toContain('## CONTEXT');
    expect(spec.compiledMarkdownPrompt).toContain('MAX (Exhaustive Architectural Decomposition)');
    // Requirements §3/§7/§8
    expect(spec.compiledMarkdownPrompt).toContain('## USER REQUIREMENTS');
    expect(spec.compiledMarkdownPrompt).toContain('## INFERRED REQUIREMENTS');
    // Assumptions engine §9 — table format
    expect(spec.compiledMarkdownPrompt).toContain('## ASSUMPTIONS');
    expect(spec.compiledMarkdownPrompt).toContain('| ID | Assumption | Confidence | Impact | Reason |');
    // Priority system §12
    expect(spec.compiledMarkdownPrompt).toContain('## PRIORITIES');
    expect(spec.compiledMarkdownPrompt).toContain('P0 = MUST NOT FAIL');
    // Existing-code preservation §36
    expect(spec.compiledMarkdownPrompt).toContain('## ARCHITECTURE / APPROACH');
    expect(spec.compiledMarkdownPrompt).toContain('DO NOT');
    // Reasoning framework §21 — PROBLEM → OBSERVATIONS → OPTIONS → DECISION
    expect(spec.compiledMarkdownPrompt).toContain('## REASONING STRATEGY §21');
    expect(spec.compiledMarkdownPrompt).toContain('PROBLEM');
    expect(spec.compiledMarkdownPrompt).toContain('OBSERVATIONS');
    expect(spec.compiledMarkdownPrompt).toContain('TRADEOFFS');
    // Evidence-driven execution §22 — CLAIM → EVIDENCE → VERIFICATION → STATUS
    expect(spec.compiledMarkdownPrompt).toContain('## VERIFICATION STRATEGY §22');
    expect(spec.compiledMarkdownPrompt).toContain('CLAIM');
    expect(spec.compiledMarkdownPrompt).toContain('EVIDENCE');
    // Anti-loop §26
    expect(spec.compiledMarkdownPrompt).toContain('## ANTI-LOOP RULES §26');
    expect(spec.compiledMarkdownPrompt).toContain('STOP  →  ANALYZE ROOT CAUSE  →  CHANGE STRATEGY');
    // Completion definition §38
    expect(spec.compiledMarkdownPrompt).toContain('## QUALITY REQUIREMENTS §38');
    expect(spec.compiledMarkdownPrompt).toContain('IMPLEMENTED  |  VERIFIED');
    // Acceptance criteria §24
    expect(spec.compiledMarkdownPrompt).toContain('## ACCEPTANCE CRITERIA §24');
    // Context management §27/28
    expect(spec.compiledMarkdownPrompt).toContain('## CONTEXT MANAGEMENT §27–28');
    // Cline-grade summary §39
    expect(spec.compiledMarkdownPrompt).toContain('## FINAL OUTPUT FORMAT §39');
    expect(spec.compiledMarkdownPrompt).toContain('WHAT CHANGED');
    expect(spec.compiledMarkdownPrompt).toContain('VERIFICATION');
    expect(spec.compiledMarkdownPrompt).toContain('UNRESOLVED');
    // Complexity
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
