// MCH-lazy 14.3: lazy test output — failures + summary by default, passing
// runs as counts, and the A SUMMARY NEVER HIDES A FAILURE guarantee.
import { describe, it, expect } from 'vitest';
import { lazyTestOutput, parseTestOutput } from './lazy-test-output.js';

const VITEST_FAIL = `> mochi@0.31.0 test
> vitest run

 RUN  v5.0.3 /repo

 ❯ src/math.test.ts (3 tests | 1 failed) 12ms
   ✓ adds numbers 3ms
   × subtracts numbers 8ms
     → expected 1 to equal 2 // Object.is equality
   ✓ multiplies numbers 0ms

 FAIL  src/math.test.ts > subtracts numbers
AssertionError: expected 1 to equal 2

Expected: 2
Received: 1

 ❯ src/math.test.ts:14:24

 Test Files  1 failed (1)
      Tests  1 failed (3)
   Start at  2026-10-27 12:00:00
   Duration  1.20s (transform 120ms, setup 40ms)
`;

const VITEST_PASS = `> mochi@0.31.0 test
> vitest run

 RUN  v5.0.3 /repo

 ✓ src/math.test.ts (3 tests) 12ms
 ✓ src/other.test.ts (12 tests) 40ms

 Test Files  2 passed (2)
      Tests  15 passed (15)
   Duration  2.40s
`;

const BIG_FAIL = (() => {
  const suites: string[] = [];
  for (let i = 1; i <= 20; i++) {
    suites.push(
      ` FAIL  src/suite${i}.test.ts > case ${i}`,
      `AssertionError: expected ${i} to equal ${i + 1}`,
      ` ❯ src/suite${i}.test.ts:${i}:1`,
      '',
    );
  }
  return `RUN v5.0.3\n\n${suites.join('\n')}\n\n Test Files  20 failed (20)\n      Tests  20 failed (20)\n   Duration  9.99s\n`;
})();

describe('parseTestOutput', () => {
  it('parses vitest counts and failing test names', () => {
    const p = parseTestOutput(VITEST_FAIL);
    expect(p.framework).toBe('vitest');
    expect(p.counts).toEqual({ passed: null, failed: 1, skipped: null, total: null });
    expect(p.failures.some((f) => f.includes('subtracts numbers'))).toBe(true);
    expect(p.durationMsHint).toBe('1.20s');
  });
});

describe('lazyTestOutput — failing runs', () => {
  it('renders counts, the failure block, and never hides the failure', () => {
    const r = lazyTestOutput(VITEST_FAIL, { exitCode: 1 });
    expect(r.summary.framework).toBe('vitest');
    expect(r.summary.counts.failed).toBe(1);
    expect(r.text).toContain('[lazy test summary: FAIL]');
    expect(r.text).toContain('subtracts numbers');
    expect(r.text).toContain('AssertionError: expected 1 to equal 2');
    expect(r.text).toContain('Expected: 2');
    expect(r.truncated).toBe(false);
  });

  it('overflow failures are NAMED explicitly, never dropped silently', () => {
    const r = lazyTestOutput(BIG_FAIL, { exitCode: 1, maxFailureBlocks: 5 });
    // Every one of the 20 failing test names must appear.
    for (let i = 1; i <= 20; i++) {
      expect(r.text).toContain(`case ${i}`);
    }
    expect(r.text).toContain('FAILURE DETAIL TRUNCATED');
    expect(r.truncated).toBe(true);
    // Only 5 blocks rendered in full.
    expect(r.summary.failureBlocks.length).toBe(5);
  });

  it('guard backstop: failure lines absent from blocks are kept verbatim', () => {
    // Output whose failure wording evades the block parser entirely.
    const raw = [
      'running tests…',
      Array.from({ length: 200 }, (_, i) => `progress ${i}`).join('\n'),
      'some assertion blew up in src/edge.test.ts without a FAIL header',
      'SUMMARY: 1 failed, 0 passed',
    ].join('\n');
    const r = lazyTestOutput(raw, { exitCode: 1 });
    expect(r.text).toContain('some assertion blew up in src/edge.test.ts');
    expect(r.text).toContain('SUMMARY: 1 failed, 0 passed');
  });

  it('generic frameworks still surface FAIL lines', () => {
    const raw = 'mocha output\nFAIL poly/thing.js should frob\n1 of 2 tests failed';
    const r = lazyTestOutput(raw, { exitCode: 1 });
    expect(r.text).toContain('should frob');
  });
});

describe('lazyTestOutput — passing runs', () => {
  it('condenses passing output to counts with an expansion pointer', () => {
    const r = lazyTestOutput(VITEST_PASS, { exitCode: 0 });
    expect(r.text).toContain('[lazy test summary: PASS]');
    expect(r.text).toContain('15 passed');
    expect(r.text).toContain('2.40s');
    expect(r.text).toContain('archived for on-demand expansion');
    // A pass summary must NOT claim failures.
    expect(r.summary.counts.failed).toBe(0);
    expect(r.truncated).toBe(false);
  });

  it('a passing exit code with a reported failure is still treated as failed', () => {
    // Vitest prints FAIL lines but exit 0 would be a harness bug; the summary
    // must trust the failure markers over the exit code.
    const r = lazyTestOutput(VITEST_FAIL, { exitCode: 0 });
    expect(r.text).toContain('FAIL');
    expect(r.text).toContain('subtracts numbers');
    expect(r.summary.exitPassed).toBe(false);
  });

  it('unknown output without failure markers reports counts honestly', () => {
    const raw = Array.from({ length: 120 }, (_, i) => `build step ${i} ok`).join('\n');
    const r = lazyTestOutput(raw, { exitCode: 0 });
    expect(r.text).toContain('[lazy test summary: PASS]');
    expect(r.text).toContain('no failures detected');
  });
});
