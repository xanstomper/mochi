import { describe, it, expect } from 'vitest';
import { clipToolOutput, HEAD_CHARS, TAIL_CHARS, DEFAULT_TOOL_RESULT_MAX_CHARS } from './output-budget.js';
import { shellTool } from './shell.js';

describe('clipToolOutput', () => {
  it('returns short output unchanged', () => {
    const s = 'hello world\n'.repeat(10);
    expect(clipToolOutput(s)).toBe(s);
  });

  it('clips huge output to head + elision marker + tail', () => {
    const head = 'FIRST LINE — the error started here\n' + 'x'.repeat(HEAD_CHARS);
    const tail = 'y'.repeat(TAIL_CHARS) + '\n42 failed, 3 passed';
    const big = head + '\nFILLER-'.repeat(50_000) + tail;
    const out = clipToolOutput(big);
    expect(out.length).toBeLessThan(HEAD_CHARS + TAIL_CHARS + 500);
    expect(out).toContain('FIRST LINE');
    // The tail survives — test summaries print at the END of output.
    expect(out.endsWith('42 failed, 3 passed')).toBe(true);
    // Honest elision: states how much was cut.
    expect(out).toMatch(/elided [\d,]+ chars/);
    // The omitted count must match reality.
    const omitted = Number.parseInt((out.match(/elided ([\d,]+) chars/) ?? [])[1]?.replace(/,/g, '') ?? '-1', 10);
    expect(omitted).toBe(big.length - HEAD_CHARS - TAIL_CHARS);
  });

  it('default budget is env-tunable and sane', () => {
    // 48K chars default (~12K tokens) — a fraction of the old 256K shell cap.
    expect(DEFAULT_TOOL_RESULT_MAX_CHARS).toBe(48_000);
    expect(HEAD_CHARS + TAIL_CHARS).toBeLessThanOrEqual(DEFAULT_TOOL_RESULT_MAX_CHARS);
  });
});

describe('shellTool output budget', () => {
  it('a verbose command comes back clipped, not at the old 256K cap', async () => {
    const result = await shellTool.execute(
      { command: 'seq 1 200000' },
      {
        cwd: '/tmp',
        config: {
          safety: {
            mode: 'safe',
            commandTimeoutSeconds: 30,
            maxIterations: 40,
            maxRuntimeMinutes: 240,
            maxConcurrentAgents: 2,
            contextBudgetTokens: 128_000,
          },
        },
      },
    );
    // Old behavior: ~1.39MB of digits. New: bounded head+tail.
    expect(result.length).toBeLessThan(60_000);
    expect(result).toMatch(/^exit_code: 0/);
    expect(result).toContain('1\n2\n3');           // head preserved
    expect(result).toMatch(/19999\d\n200000/);    // tail preserved
    expect(result).toMatch(/elided [\d,]+ chars/);
  }, 20_000);
});
