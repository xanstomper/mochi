// Wave S4 — structured verifier objection units.
import { describe, it, expect } from 'vitest';
import { buildObjection, renderObjection, renderObjectionClosed, objectionDigestLine, salientFailureLines, OBJECTION_MARKER } from './verifier-objection.js';

const FAIL_SUMMARY = [
  'Check failed: npm test',
  'const { add } = require("./math.js");',
  'WRONG: add(2,3)=-1',
  'npm ERR! Test failed.',
].join('\n');

describe('buildObjection', () => {
  it('extracts the failing check and the salient evidence lines', () => {
    const o = buildObjection({ status: 'FAIL', summary: FAIL_SUMMARY, attempt: 1 });
    expect(o.failedChecks).toEqual(['npm test']);
    expect(o.salientLines).toContain('WRONG: add(2,3)=-1');
    expect(o.attempt).toBe(1);
    expect(o.remedy).toContain('npm test');
  });

  it('collects multiple failing checks in order', () => {
    const o = buildObjection({
      status: 'FAIL',
      summary: 'Check failed: npm run lint\nExpected 0 warnings\nCheck failed: npm test\nAssertionError: boom',
      attempt: 2,
    });
    expect(o.failedChecks).toEqual(['npm run lint', 'npm test']);
    expect(o.salientLines.some((l) => l.includes('AssertionError'))).toBe(true);
  });

  it('BLOCKED gets the produce-evidence remedy', () => {
    const o = buildObjection({ status: 'BLOCKED', summary: 'Verification blocked: the task expected file changes but none were made.', attempt: 1 });
    expect(o.failedChecks).toEqual([]);
    expect(o.remedy).toMatch(/edit or write a file/);
  });

  it('falls back to the output head when nothing pattern-matches', () => {
    const o = buildObjection({ status: 'FAIL', summary: 'Check failed: make check\nline one\nline two', attempt: 1 });
    expect(o.salientLines).toEqual(['line one', 'line two']);
  });

  it('rendered objection is bounded and carries marker, attempt, check, evidence, remedy', () => {
    const o = buildObjection({ status: 'FAIL', summary: FAIL_SUMMARY, attempt: 3 });
    const text = renderObjection(o);
    expect(text).toContain(`${OBJECTION_MARKER} — OPEN (attempt 3, status FAIL)`);
    expect(text).toContain('Failing check(s): npm test');
    expect(text).toContain('WRONG: add(2,3)=-1');
    expect(text).toContain('To close this objection:');
    expect(text.length).toBeLessThan(900);
  });

  it('the closed render keeps the marker (single upsert target) and says CLOSED', () => {
    const text = renderObjectionClosed(2);
    expect(text).toContain(OBJECTION_MARKER);
    expect(text).toContain('CLOSED');
  });

  it('the knownErrors digest is one bounded line naming the current objection', () => {
    const o = buildObjection({ status: 'FAIL', summary: FAIL_SUMMARY, attempt: 1 });
    const line = objectionDigestLine(o);
    expect(line).not.toContain('\n');
    expect(line).toContain('npm test');
    expect(line).toContain('add(2,3)=-1');
    expect(line.length).toBeLessThanOrEqual(220);
  });
});

// P3 gun 6 (self-poisoning class): Mochi's own harness annotations — the
// fast-lane marker and the PARTIAL targeted pre-check suffix — must never
// enter the evidence channel or pollute the failing-command the remedy names.
describe('buildObjection harness-annotation hygiene', () => {
  it('a fast-lane failure names the check and keeps the lane header out of the evidence', () => {
    const summary = 'Check failed (fast lane): npm test\nAssertionError: expected 42 to be 0';
    const o = buildObjection({ status: 'FAIL', summary, attempt: 1 });
    expect(o.failedChecks).toEqual(['npm test']);
    expect(o.remedy).toContain('`npm test`');
    expect(o.salientLines).not.toContain('Check failed (fast lane): npm test');
    expect(o.salientLines.some((l) => l.includes('AssertionError'))).toBe(true);
  });

  it('the PARTIAL targeted pre-check annotation never becomes part of the failing command', () => {
    const summary = 'Check failed: npm test (PARTIAL targeted pre-check: budget guard)\nError: expected 5 to be 6';
    const o = buildObjection({ status: 'FAIL', summary, attempt: 1 });
    expect(o.failedChecks).toEqual(['npm test']);
    expect(o.remedy).toContain('`npm test`');
    expect(o.remedy).not.toContain('PARTIAL');
    expect(o.salientLines.every((l) => !l.startsWith('Check failed:'))).toBe(true);
  });

  it('salientFailureLines keeps both header shapes out of the evidence lines', () => {
    expect(salientFailureLines('Check failed: npm test\nError: boom')).not.toContain('Check failed: npm test');
    expect(salientFailureLines('Check failed (fast lane): npm test\nError: boom')).not.toContain('Check failed (fast lane): npm test');
  });
});
