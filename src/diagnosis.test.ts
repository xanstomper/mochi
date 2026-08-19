import { describe, it, expect } from 'vitest';
import {
  classifyFailure,
  formInitialHypotheses,
  evaluateProbe,
  rankHypotheses,
  diagnosisToPrompt,
} from './diagnosis.js';

describe('classifyFailure', () => {
  it('recognises missing-binary / exit-127 as env_missing', () => {
    expect(classifyFailure('exit_code: 127\nsh: 1: tsc: not found\n').kind).toBe('env_missing');
  });

  it('recognises TS type errors', () => {
    expect(classifyFailure(`src/foo.ts:12:5 - error TS2322: Type 'string' is not assignable to type 'number'.`).kind).toBe('type');
  });

  it('recognises assertion failures (logic)', () => {
    expect(classifyFailure(`AssertionError: expected 'hello' to equal 'hello world'\n  at TestContext.<anonymous> (test/math.test.ts:8:5)`).kind).toBe('logic');
  });

  it('recognises weak-coverage / mutation-survived as test_gap', () => {
    expect(classifyFailure('Mutation X->Y in greet.ts SURVIVED: tests passed with the injected bug').kind).toBe('test_gap');
  });

  it('recognises ECONNREFUSED / network transport as env_runtime', () => {
    expect(classifyFailure('fetch failed: connect ECONNREFUSED 127.0.0.1:8080').kind).toBe('env_runtime');
  });

  it('recognises syntax errors', () => {
    expect(classifyFailure(`SyntaxError: Unexpected token 'export'`).kind).toBe('syntax');
  });

  it('recognises concurrency / lock failures', () => {
    expect(classifyFailure('race condition detected in foo.ts:10').kind).toBe('concurrency');
    expect(classifyFailure('EBUSY: resource busy or locked').kind).toBe('concurrency');
  });

  it('falls back to unknown for unrelated text', () => {
    expect(classifyFailure('today is a fine day').kind).toBe('unknown');
  });
});

describe('formInitialHypotheses', () => {
  it('produces type-error hypotheses anchored to changed files', () => {
    const h = formInitialHypotheses('type', ['src/x.ts']);
    expect(h.some((x) => x.id === 'type_changed_func')).toBe(true);
    expect(h.some((x) => x.probeCommand?.includes('tsc'))).toBe(true);
  });

  it('returns a generic test_gap hypothesis regardless of files', () => {
    const h = formInitialHypotheses('test_gap', []);
    expect(h[0].id).toBe('gap_add_assert');
    expect(h[0].confidence).toBeGreaterThan(0.5);
  });
});

describe('evaluateProbe', () => {
  it('raises confidence when the probe reproduces the error', () => {
    const h = { id: 'h', description: 'x', confidence: 0.4, status: 'pending' as const };
    const next = evaluateProbe(h, 'error: TS2322 Type mismatch');
    expect(next.confidence).toBeGreaterThan(h.confidence);
    expect(next.status).toBe('evidence_for');
  });

  it('lowers confidence when probe is clean', () => {
    const h = { id: 'h', description: 'x', confidence: 0.7, status: 'pending' as const };
    const next = evaluateProbe(h, 'no errors here, build succeeded');
    expect(next.confidence).toBeLessThan(h.confidence);
    expect(next.status).toBe('evidence_against');
  });
});

describe('rankHypotheses', () => {
  it('orders by confidence descending and returns a new array', () => {
    const arr = [
      { id: 'a', description: 'a', confidence: 0.3, status: 'pending' as const },
      { id: 'b', description: 'b', confidence: 0.8, status: 'pending' as const },
    ];
    const ranked = rankHypotheses(arr);
    expect(ranked[0].id).toBe('b');
    expect(ranked).not.toBe(arr);
  });
});

describe('diagnosisToPrompt', () => {
  it('summarises the top three hypotheses for the model', () => {
    const text = diagnosisToPrompt({
      kind: 'type',
      signals: ['type error'],
      hypotheses: [
        { id: 'a', description: 'TYPE mismatch in foo.ts', probeCommand: 'tsc', confidence: 0.7, status: 'pending' },
        { id: 'b', description: 'import path missing .js', confidence: 0.3, status: 'pending' },
      ],
      summary: '',
    });
    expect(text).toContain('kind=type');
    expect(text).toContain('TYPE mismatch');
    expect(text).toContain('conf 0.70');
    expect(text).toContain('-> probe: tsc');
  });
});