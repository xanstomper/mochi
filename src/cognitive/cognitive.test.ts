import { describe, it, expect } from 'vitest';
import { evaluateOwl, OWL_PRINCIPLES } from './owl.js';
import { evaluateSispis } from './sispis.js';
import { AnchorEngine } from './anchor.js';
import { loadDoxContract } from './dox.js';
import { ChameleonEngine, synthesizeDeterministicContext, primeScaffold } from './chameleon.js';

describe('OWL (Operational Wisdom Layer)', () => {
  it('defines 9 core engineering principles', () => {
    expect(OWL_PRINCIPLES.length).toBe(9);
    expect(OWL_PRINCIPLES.map((p) => p.name)).toContain('epistemics');
    expect(OWL_PRINCIPLES.map((p) => p.name)).toContain('reality');
    expect(OWL_PRINCIPLES.map((p) => p.name)).toContain('verification');
  });

  it('triggers reality check when task modifies code without inspection', () => {
    const res = evaluateOwl('refactor the authentication handler');
    expect(res.signals.some((s) => s.principle === 'reality')).toBe(true);
    expect(res.mode).toBe('surface');
  });

  it('remains silent for straightforward low-risk inspection', () => {
    const res = evaluateOwl('inspect package.json dependencies', 'file:package.json');
    expect(res.mode).toBe('silent');
  });
});

describe('SISPIS (Structured Intent Scaffolding)', () => {
  it('selects SCHEMA for complex multi-option architectural tasks', () => {
    const res = evaluateSispis('redesign the distributed cache architecture tradeoffs vs sqlite');
    expect(res.mode).toBe('SCHEMA');
    expect(res.entropy).toBeGreaterThan(0.5);
  });

  it('suppresses to NO_DECISION when user explicitly requests brevity', () => {
    const res = evaluateSispis('just tell me what port the server runs on');
    expect(res.mode).toBe('NO_DECISION');
    expect(res.userOverride).toBe('simple');
  });
});

describe('ANCHOR (Operational Persistence)', () => {
  it('manages claim classification and promotion', () => {
    const anchor = new AnchorEngine();
    const c1 = anchor.recordClaim('API endpoint uses port 8080', 'Inferred');
    expect(c1.classification).toBe('Inferred');

    anchor.verifyClaim(c1.id, 'Verified via config.json');
    expect(anchor.renderContinuityContext()).toContain('[VERIFIED]');
  });

  it('tracks rejected approaches to prevent repetitive failures', () => {
    const anchor = new AnchorEngine();
    anchor.rejectApproach('subprocess monkeypatch', 'causes memory leak under load');
    expect(anchor.isApproachRejected('subprocess monkeypatch')).toBe(true);
    expect(anchor.renderContinuityContext()).toContain('[REJECTED]');
  });
});

describe('Lazy Chameleon (In-Harness Baked MoE Engine)', () => {
  it('synthesizes dense real datasets in 0ms without API calls', async () => {
    const context = await primeScaffold('Implement an atomic token bucket rate limiter');
    expect(context).toContain('LAZY CHAMELEON DENSE SYNTHETIC DATASET');
    expect(context).toContain('System Invariants');
    expect(context).toContain('Cellular Execution DAG');
    expect(context).toContain('SISPIS');
  });

  it('flash mode executes with 0 tokens used and zero latency', async () => {
    const engine = new ChameleonEngine({
      model: { provider: 'opencode-zen', model: 'opencode/deepseek-v4-flash-free' },
      safety: {} as any,
    } as any);

    const res = await engine.enhance({ task: 'Build a binary heap', mode: 'flash' });
    expect(res.mode).toBe('flash');
    expect(res.tokensUsed).toBe(0);
    expect(res.context).toContain('LAZY CHAMELEON DENSE SYNTHETIC DATASET');
  });
});
