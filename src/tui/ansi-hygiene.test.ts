import { describe, it, expect } from 'vitest';
import { stripAllAnsi, scrubAnsiFragments, ANSI_RE, ORPHAN_SGR_RE } from './ansi-hygiene.js';

describe('ansi-hygiene', () => {
  it('strips complete SGR sequences', () => {
    expect(stripAllAnsi('\x1b[38;2;138;43;226m~/snake/index.html\x1b[0m')).toBe('~/snake/index.html');
    expect(stripAllAnsi('a\x1b[2Kb\x1b[1;32mgreen\x1b[0m')).toBe('abgreen');
  });

  it('scrubs orphaned truecolor payloads (the 138;43,226m bug)', () => {
    // ESC byte lost mid-chunk: the model sees and copies the bare payload.
    const parroted = 'at ~/snake/index.html138;43,226m from a previous session.';
    expect(scrubAnsiFragments(parroted)).toBe('at ~/snake/index.html from a previous session.');
  });

  it('scrubs orphaned 256-color payloads (the 250m bug)', () => {
    expect(scrubAnsiFragments('done;250m next line')).toBe('done next line');
    // Orphan ";num" after a WORD is scrubbed (it looks like a dropped 48;5 payload).
    expect(scrubAnsiFragments('pipeline step;250m threshold')).toBe('pipeline step threshold');
    // Full 24-bit/256 payloads are removed entirely, wherever they sit.
    expect(scrubAnsiFragments('x 48;5;233m y')).toBe('x  y');
    expect(scrubAnsiFragments('path38;2;138;43;226m suffix')).toBe('path suffix');
  });

  it('never eats legitimate prose containing digit patterns', () => {
    expect(scrubAnsiFragments('took 3;1m of pipe')).toContain('3;1m of pipe');
    expect(scrubAnsiFragments('version 1.2.3m main')).toBe('version 1.2.3m main');
    expect(scrubAnsiFragments('run 2331ms total')).toBe('run 2331ms total');
    expect(scrubAnsiFragments('3;1m')).toBe('3;1m'); // digit-prefixed ; stays
  });

  it('strips a dangling partial CSI tail at end of string', () => {
    expect(scrubAnsiFragments('text \x1b[38;2;1')).toBe('text ');
    expect(scrubAnsiFragments('text \x1b[')).toBe('text ');
  });

  it('leaves clean text untouched', () => {
    const clean = 'The file is 340 lines with 2331ms build time.';
    expect(scrubAnsiFragments(clean)).toBe(clean);
  });

  it('regexes are module-level (no per-call recompile) and global', () => {
    expect(ANSI_RE.global).toBe(true);
    expect(ORPHAN_SGR_RE.global).toBe(true);
  });
});
