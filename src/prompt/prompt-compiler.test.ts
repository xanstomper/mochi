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

describe('MochiPromptCompiler — per-kind reasoning protocols', () => {
  const FIX = 'fix the jwt expiry bug in auth middleware where sessions crash';
  const IMPLEMENT = 'add pagination to the posts API endpoint';
  const REFACTOR = 'refactor the session store to simplify token handling';
  const RESEARCH = 'research how the caching layer works and compare the options';
  const TEST = 'add unit tests for the invoice calculator covering edge cases';

  it('maps classifications to task kinds (fix / implement / refactor / test / research)', () => {
    expect(compiler.compile(FIX, { reasoning: 'max' }).protocolKind).toBe('fix');
    expect(compiler.compile(IMPLEMENT, { reasoning: 'max' }).protocolKind).toBe('implement');
    expect(compiler.compile(REFACTOR, { reasoning: 'max' }).protocolKind).toBe('refactor');
    expect(compiler.compile(TEST, { reasoning: 'max' }).protocolKind).toBe('test');
    const research = compiler.compile(RESEARCH, { reasoning: 'max' });
    expect(research.classifications).toContain('RESEARCH');
    expect(research.protocolKind).toBe('research');
  });

  it('gives debug/fix tasks the reproduce-first protocol', () => {
    const spec = compiler.compile(FIX, { reasoning: 'max' });
    const recovery = spec.failureRecovery.join('\n');
    // (a) falsifiable hypothesis before editing
    expect(recovery).toContain('Hypothesis first');
    expect(recovery).toContain('falsifiable hypothesis');
    // (b) reproduce with a concrete command/test and record the output
    expect(recovery).toContain('Reproduce first');
    expect(recovery).toContain('record its exact failing output');
    // (c) smallest change that tests the hypothesis
    expect(recovery).toContain('Smallest change');
    // (d) re-run the repro
    expect(recovery).toContain('Re-run the repro');
    // (e) two failed hypotheses -> stop and re-survey, no third guess
    expect(recovery).toContain('Two failed hypotheses = stop');
    expect(recovery).toContain('re-survey');
    // (f) regression test that fails without the fix
    expect(recovery).toContain('Regression lock');
    expect(recovery).toContain('fails without the fix');
    // Anti-loop is hypothesis-shaped too, not generic retry advice
    expect(spec.antiLoopRules.join('\n')).toContain('One hypothesis per iteration');
  });

  it('does NOT give implement tasks the fix protocol (protocols are kind-specific)', () => {
    const fix = compiler.compile(FIX, { reasoning: 'max' });
    const impl = compiler.compile(IMPLEMENT, { reasoning: 'max' });
    expect(impl.failureRecovery.join('\n')).not.toContain('Reproduce first');
    expect(impl.failureRecovery.join('\n')).toContain('Decompose first');
    expect(impl.failureRecovery.join('\n')).toContain('acceptance evidence for each step BEFORE coding');
    expect(impl.failureRecovery).not.toEqual(fix.failureRecovery);
    expect(impl.antiLoopRules).not.toEqual(fix.antiLoopRules);
  });

  it('gives refactor tasks a characterization-first protocol', () => {
    const spec = compiler.compile(REFACTOR, { reasoning: 'max' });
    const recovery = spec.failureRecovery.join('\n');
    expect(recovery).toContain('Characterize first');
    expect(recovery).toContain('No behavior change without a failing characterization');
    expect(recovery).toContain('Small verified steps');
    expect(spec.verificationPlanner.evidenceChecklist.join('\n')).toContain('Characterization baseline');
  });

  it('gives research tasks a triangulation protocol with a disconfirmation step', () => {
    const spec = compiler.compile(RESEARCH, { reasoning: 'max' });
    const recovery = spec.failureRecovery.join('\n');
    expect(recovery).toContain('Triangulate');
    expect(recovery).toContain('what would change the answer');
    const evidence = spec.verificationPlanner.evidenceChecklist.join('\n');
    expect(evidence).toContain('cites a concrete path/symbol');
    expect(evidence).toContain('two independent sources');
    // Research evidence is citations, not a test command
    expect(evidence).not.toContain('npm test');
    expect(spec.verificationPlanner.strategies).toContain('SOURCE_TRIANGULATION');
  });

  it('gives test tasks a red-before-green protocol', () => {
    const spec = compiler.compile(TEST, { reasoning: 'max' });
    expect(spec.failureRecovery.join('\n')).toContain('Red before green');
    expect(spec.verificationPlanner.evidenceChecklist.join('\n')).toContain('RED');
  });

  it('protocols differ across at least 3 kinds (recovery AND anti-loop)', () => {
    const specs = [FIX, IMPLEMENT, REFACTOR, RESEARCH].map((p) => compiler.compile(p, { reasoning: 'max' }));
    const recoveries = new Set(specs.map((s) => JSON.stringify(s.failureRecovery)));
    const antiLoops = new Set(specs.map((s) => JSON.stringify(s.antiLoopRules)));
    const checklists = new Set(specs.map((s) => JSON.stringify(s.verificationPlanner.evidenceChecklist)));
    expect(recoveries.size).toBe(4);
    expect(antiLoops.size).toBe(4);
    expect(checklists.size).toBe(4);
  });

  it('fix verification planner demands repro before/after evidence, not just the test command', () => {
    const spec = compiler.compile(FIX, { reasoning: 'max', testCommand: 'npm test' });
    const evidence = spec.verificationPlanner.evidenceChecklist.join('\n');
    expect(evidence).toContain('Repro output BEFORE the fix');
    expect(evidence).toContain('Repro output AFTER the fix');
    expect(evidence).toContain('Regression test that fails without the fix');
    expect(spec.verificationPlanner.primaryCommand).toBe('npm test');
    expect(spec.compiledMarkdownPrompt).toContain('Evidence Checklist');
    expect(spec.compiledMarkdownPrompt).toContain('Repro output BEFORE the fix');
  });

  it('renders the protocol at high and (condensed) at medium, but never bloats low', () => {
    const high = compiler.compile(FIX, { reasoning: 'high' });
    expect(high.compiledMarkdownPrompt).toContain('Reasoning Protocol (fix)');
    expect(high.compiledMarkdownPrompt).toContain('Reproduce first');
    expect(high.compiledMarkdownPrompt).toContain('Evidence required before claiming done:');

    const medium = compiler.compile(FIX, { reasoning: 'medium' });
    expect(medium.compiledMarkdownPrompt).toContain('Reasoning Protocol');
    expect(medium.compiledMarkdownPrompt).toContain('Reproduce first');
    // Condensed: the later protocol steps stay exclusive to high/max
    expect(medium.compiledMarkdownPrompt).not.toContain('Regression lock');

    const low = compiler.compile(FIX, { reasoning: 'low' });
    expect(low.compiledMarkdownPrompt).not.toContain('Reasoning Protocol');
    expect(low.compiledMarkdownPrompt).not.toContain('Hypothesis first');
    expect(low.compiledMarkdownPrompt).toContain('DIRECT TASK');
  });

  it('compiled output is deterministic (same input -> deep-equal spec)', () => {
    for (const tier of ['medium', 'high', 'max'] as const) {
      const a = compiler.compile(FIX, { reasoning: tier, testCommand: 'npm test' });
      const b = compiler.compile(FIX, { reasoning: tier, testCommand: 'npm test' });
      expect(a).toEqual(b);
    }
    const a = compiler.compile(RESEARCH, { reasoning: 'max' });
    const b = compiler.compile(RESEARCH, { reasoning: 'max' });
    expect(a).toEqual(b);
  });
});
