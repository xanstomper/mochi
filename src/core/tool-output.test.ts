import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { applyToolOutputPolicy } from './tool-output.js';

describe('applyToolOutputPolicy', () => {
  it('passes small outputs through untouched', () => {
    const r = applyToolOutputPolicy('line1\nline2\n');
    expect(r.truncated).toBe(false);
    expect(r.content).toBe('line1\nline2\n');
    expect(r.spillPath).toBeUndefined();
  });

  it('truncates by lines, keeps head and tail, spills full output', () => {
    const big = Array.from({ length: 1000 }, (_, i) => `line-${i}`).join('\n');
    const r = applyToolOutputPolicy(big, { maxLines: 100, toolName: 'shell' });
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe('lines');
    expect(r.totalLines).toBe(1000);
    // head preserved
    expect(r.content).toContain('line-0');
    // tail preserved
    expect(r.content).toContain('line-999');
    // middle dropped
    expect(r.content).not.toContain('line-500\n');
    // spill file exists with the FULL content and is referenced
    expect(r.spillPath).toBeDefined();
    expect(r.content).toContain(r.spillPath!);
    expect(existsSync(r.spillPath!)).toBe(true);
    expect(readFileSync(r.spillPath!, 'utf8')).toBe(big);
    rmSync(r.spillPath!);
  });

  it('truncates by bytes for few very long lines', () => {
    const long = Array.from({ length: 10 }, () => 'x'.repeat(5000)).join('\n');
    const r = applyToolOutputPolicy(long, { maxBytes: 4000 });
    expect(r.truncated).toBe(true);
    expect(r.truncatedBy).toBe('bytes');
    expect(r.totalBytes).toBe(50009);
    expect(r.content.length).toBeLessThan(long.length);
    rmSync(r.spillPath!);
  });

  it('never splits a line in the middle', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `L${i}-${'y'.repeat(80)}`);
    const big = lines.join('\n');
    const r = applyToolOutputPolicy(big, { maxLines: 50, maxBytes: 100_000 });
    for (const present of [lines[0], lines[499]]) {
      expect(r.content).toContain(present);
    }
    rmSync(r.spillPath!);
  });
});
