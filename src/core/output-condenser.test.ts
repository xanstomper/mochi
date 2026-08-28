import { describe, it, expect } from 'vitest';
import { condenseOutput, stripAnsi } from './output-condenser.js';

describe('Output Condenser', () => {
  it('strips ANSI escape sequences cleanly', () => {
    const ansiText = '\x1b[31mError:\x1b[0m \x1b[1mFile not found\x1b[0m';
    expect(stripAnsi(ansiText)).toBe('Error: File not found');
  });

  it('preserves short outputs as-is without modification', () => {
    const shortText = 'Build completed in 1.2s\nAll 12 tests passed.';
    const res = condenseOutput(shortText);
    expect(res.condensed).toBe(shortText);
    expect(res.savingsPercent).toBe(0);
    expect(res.originalLineCount).toBe(2);
  });

  it('condenses large noisy compiler logs and isolates exact error lines with context', () => {
    const lines = [
      'Compiling 150 files...',
      'Header line 2...',
      ...Array.from({ length: 40 }, (_, i) => `Processing asset bundle chunk_${i}.js`),
      'src/auth/session.ts(42,15): error TS2339: Property "userId" does not exist on type "Session".',
      '    const id = session.userId;',
      '                       ~~~~~~',
      ...Array.from({ length: 40 }, (_, i) => `Emitting declaration maps chunk_${i}.d.ts`),
      'Found 1 error in 1.45s.',
    ];
    const raw = lines.join('\n');

    const res = condenseOutput(raw, { maxLines: 20 });
    expect(res.savingsPercent).toBeGreaterThan(50);
    expect(res.condensed).toContain('error TS2339');
    expect(res.condensed).toContain('session.userId');
    expect(res.detectedErrors.length).toBeGreaterThan(0);
    expect(res.condensed).toContain('lines omitted');
  });

  it('falls back to head and tail truncation when no specific error marker matches', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Verbose debug log trace step ${i}`);
    const raw = lines.join('\n');

    const res = condenseOutput(raw, { maxLines: 20 });
    expect(res.savingsPercent).toBeGreaterThan(60);
    expect(res.condensed).toContain('Verbose debug log trace step 0');
    expect(res.condensed).toContain('Verbose debug log trace step 99');
    expect(res.condensed).toContain('lines omitted by output condenser');
  });
});
