import { describe, expect, it } from 'vitest';
import { wrap, visibleLen } from './wrap.js';

describe('wrap', () => {
  it('wraps a normal sentence to the given width without overflow', () => {
    const lines = wrap('the quick brown fox jumps over the lazy dog', 12);
    for (const l of lines) {
      expect(visibleLen(l)).toBeLessThanOrEqual(12);
    }
    expect(lines[0]).toBe('the quick');
    // Reconstructing the words preserves every non-space character.
    expect(lines.join(' ').replace(/\s+/g, ' ')).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('hard-splits an unbroken token longer than the width (no "fake wrapper")', () => {
    const lines = wrap('supercalifragilisticexpialidocious', 12);
    expect(lines.every((l) => visibleLen(l) <= 12)).toBe(true);
    // The token is split across exactly as many 12-char lines as needed.
    expect(lines).toEqual(['supercalifra', 'gilisticexpi', 'alidocious']);
    // No characters lost or invented.
    expect(lines.join('')).toBe('supercalifragilisticexpialidocious');
  });

  it('does not lose spaces between words across line boundaries', () => {
    const lines = wrap('alpha bravo charlie delta echo', 10);
    // Every line within width.
    expect(lines.every((l) => visibleLen(l) <= 10)).toBe(true);
    // Word separation preserved after removing wrap line breaks.
    expect(lines.join(' ').replace(/\s+/g, ' ')).toBe('alpha bravo charlie delta echo');
  });

  it('preserves intentional newlines as hard breaks', () => {
    const lines = wrap('line one\nline two', 80);
    expect(lines).toEqual(['line one', 'line two']);
  });

  it('honors a minimum width of one and handles empty input', () => {
    expect(wrap('', 4)).toEqual(['']);
    const one = wrap('x'.repeat(20), 1);
    expect(one.every((l) => visibleLen(l) <= 1)).toBe(true);
    expect(one.length).toBe(20);
  });
});