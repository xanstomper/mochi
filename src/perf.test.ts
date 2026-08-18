import { describe, it, expect } from 'vitest';
import { benchmarkStream, formatPerfReport } from './perf.js';

describe('perf', () => {
  it('benchmarks the complete streaming pipeline', () => {
    const report = benchmarkStream(1000);
    expect(report.events).toBeGreaterThan(1000);
    expect(report.totalMs).toBeGreaterThan(0);
    const text = formatPerfReport(report);
    expect(text).toContain('Mochi performance pipeline');
    expect(text).toContain('parser:');
    expect(text).toContain('renderer:');
  });
});
