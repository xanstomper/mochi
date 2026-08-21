import { describe, it, expect } from 'vitest';
import { sliceVisibleRange, highlightRange, visibleLen } from './selection.js';

describe('sliceVisibleRange', () => {
  it('returns empty when range is empty', () => {
    expect(sliceVisibleRange('hello', 2, 2)).toBe('');
  });

  it('slices plain text by visible chars', () => {
    expect(sliceVisibleRange('hello world', 0, 5)).toBe('hello');
    expect(sliceVisibleRange('hello world', 6, 11)).toBe('world');
  });

  it('ignores ANSI color codes for width', () => {
    const s = '\x1b[31mhello\x1b[0m';
    expect(sliceVisibleRange(s, 0, 5)).toBe('\x1b[31mhello');
    expect(sliceVisibleRange(s, 2, 5)).toBe('\x1b[31mllo');
  });

  it('reslices a selected portion out of a colored string', () => {
    const s = '\x1b[32mgreen\x1b[0m';
    const bare = sliceVisibleRange(s, 1, 4);
    expect(bare.replace(/\x1b\[[0-9;]*m/g, '')).toBe('ree');
  });

  it('clamps gracefully beyond the visible width', () => {
    expect(sliceVisibleRange('abc', 1, 10)).toBe('bc');
  });
});

describe('highlightRange', () => {
  it('returns the input unchanged when nothing is selected', () => {
    expect(highlightRange('hello', 2, 2)).toBe('hello');
  });

  it('wraps the selected visible range in reverse-video', () => {
    const out = highlightRange('hello', 1, 4);
    expect(out).toContain('\x1b[7m');
    expect(out).toContain('\x1b[27m');
    // All content is retained; only the selected slice is wrapped.
    expect(out.replace(/\x1b\[[0-9;]*m/g, '')).toBe('hello');
    expect(out).toBe('h\x1b[7mell\x1b[27mo');
  });

  it('preserves surrounding ANSI color codes', () => {
    const s = '\x1b[32mgreen\x1b[0m';
    const out = highlightRange(s, 0, 5);
    expect(out).toContain('\x1b[32m');
    expect(out.replace(/\x1b\[[0-9]*m/g, '')).toBe('green');
  });
});

describe('visibleLen', () => {
  it('counts visible chars ignoring ANSI', () => {
    expect(visibleLen('\x1b[1;34mbold\x1b[0m')).toBe(4);
    expect(visibleLen('plain')).toBe(5);
  });
});