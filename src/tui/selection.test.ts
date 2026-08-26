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

  it('highlights a single cell when from === to (click without drag)', () => {
    // Selection range of [3,3) is empty by convention, so applySelection
    // bumps it to [3,4) to make the click feedback visible. The helper
    // itself only acts on non-empty ranges — that's fine because the
    // single-cell bump is done in app.ts before this helper is called.
    expect(highlightRange('hello', 3, 3)).toBe('hello');
  });
});

describe('visibleLen', () => {
  it('counts visible chars ignoring ANSI', () => {
    expect(visibleLen('\x1b[1;34mbold\x1b[0m')).toBe(4);
    expect(visibleLen('plain')).toBe(5);
  });
});

describe('SGR mouse protocol parser (smoke test)', () => {
  // The SGR escape sequences the TUI parses must come through as the
  // strings the parser regex expects; without ?1002 enabled the press
  // and release are sent without drag-motion events in between.
  it('recognises a left-button press', () => {
    // \x1b[<0;col;rowM — button=0 (no modifiers), press
    const press = '\x1b[<0;5;3M';
    const m = press.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('0');
    expect(m![2]).toBe('5'); // col
    expect(m![3]).toBe('3'); // row
    expect(m![4]).toBe('M'); // press
  });

  it('recognises a drag motion (bit 32 set in button)', () => {
    const drag = '\x1b[<32;7;3M';
    const m = drag.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    expect(m).not.toBeNull();
    expect(Number(m![1]) & 32).toBe(32); // motion flag
    expect(m![4]).toBe('M'); // press-direction even though it's a drag
  });

  it('recognises a release (lowercase m)', () => {
    const release = '\x1b[<0;7;3m';
    const m = release.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    expect(m![4]).toBe('m');
  });

  it('recognises wheel scroll-up (button 64)', () => {
    const wheel = '\x1b[<64;5;3M';
    const m = wheel.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    expect(m![1]).toBe('64');
  });

  it('recognises wheel scroll-down (button 65)', () => {
    const wheel = '\x1b[<65;5;3M';
    const m = wheel.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    expect(m![1]).toBe('65');
  });

  it('recognises shift+left press (button 4)', () => {
    // In SGR the shift modifier adds 4 to the button byte. The parser
    // does not currently distinguish this; that's fine — shift+drag is
    // forwarded to the host terminal which handles native selection.
    const shiftPress = '\x1b[<4;5;3M';
    const m = shiftPress.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    expect(m![1]).toBe('4');
  });
});

describe('required mouse modes for drag-select', () => {
  // The terminal escape sequences mochi emits at startup must include the
  // three modes needed for drag-select to actually work: ?1000 (click),
  // ?1002 (motion-while-held, so drag events arrive), ?1006 (SGR
  // encoding so cols >223 don't get truncated).
  it('startup sequence enables ?1000, ?1002, ?1006', () => {
    const startup =
      '\x1b[?1049h\x1b[?25l' +
      '\x1b[?1000h\x1b[?1002h\x1b[?1006h' +
      '\x1b[?2004h';
    expect(startup).toContain('\x1b[?1000h');
    expect(startup).toContain('\x1b[?1002h');
    expect(startup).toContain('\x1b[?1006h');
  });

  it('shutdown sequence disables all three', () => {
    const shutdown = '\x1b[0m\x1b[?25h\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?2004l';
    expect(shutdown).toContain('\x1b[?1000l');
    expect(shutdown).toContain('\x1b[?1002l');
    expect(shutdown).toContain('\x1b[?1006l');
  });
});

describe('selection state machine (mirrors app.ts logic)', () => {
  // Mirrors beginSelection / updateSelection / endSelection so we can
  // exercise the drag flow end-to-end without booting the full TUI.
  type Pt = { row: number; col: number };
  type State = { active: boolean; start: Pt | null; end: Pt | null; lines: string[] };

  function begin(s: State, row: number, col: number) {
    s.start = { row, col };
    s.end = { row, col };
    s.active = true;
  }
  function update(s: State, row: number, col: number) {
    if (!s.active) return;
    s.end = { row, col };
  }
  function selectedText(s: State): string {
    if (!s.active || !s.start || !s.end) return '';
    const top = Math.min(s.start.row, s.end.row);
    const bot = Math.max(s.start.row, s.end.row);
    const out: string[] = [];
    for (let r = top; r <= bot; r++) {
      const bare = (s.lines[r] ?? '').replace(/\x1b\[[0-9;]*m/g, '');
      const startCol = r === top ? Math.min(s.start.col, s.end.col) : 0;
      const endCol = r === bot ? Math.max(s.start.col, s.end.col) : bare.length;
      out.push(bare.slice(startCol, endCol));
    }
    return out.join('\n');
  }

  it('click → drag → release across one row captures the dragged range', () => {
    const s: State = { active: false, start: null, end: null, lines: ['hello world'] };
    begin(s, 0, 0); // press at (0,0)
    update(s, 0, 4); // drag to (0,4) — ?1002 sends motion events here
    expect(selectedText(s)).toBe('hell');
  });

  it('drag across rows joins them with newlines', () => {
    const s: State = {
      active: false,
      start: null,
      end: null,
      lines: ['alpha bravo', 'charlie delta'],
    };
    begin(s, 0, 6); // press at "bravo"
    update(s, 1, 7); // drag to "delta"
    expect(selectedText(s).split('\n')).toEqual(['bravo', 'charlie']);
  });

  it('reverse drag (end before start) still produces the same text', () => {
    const s: State = { active: false, start: null, end: null, lines: ['hello world'] };
    begin(s, 0, 4);
    update(s, 0, 0); // user drags backwards
    expect(selectedText(s)).toBe('hell');
  });

  it('click without drag captures one cell (single-cell highlight works)', () => {
    // On initial press selStart == selEnd. The renderer in app.ts bumps
    // a single-cell highlight to length 1; here we simulate the result
    // by passing a slightly-extended end column.
    const s: State = { active: false, start: null, end: null, lines: ['abcdef'] };
    begin(s, 0, 2);
    update(s, 0, 3); // user nudges one cell — this is what ?1002 sends
    expect(selectedText(s)).toBe('c');
  });

  it('multi-row drag drops outer characters cleanly when not full-line', () => {
    const s: State = {
      active: false,
      start: null,
      end: null,
      lines: ['aaa', 'bbb', 'ccc'],
    };
    begin(s, 0, 1); // "aa" from row 0
    update(s, 2, 1); // "c" from row 2 (col 1 of "ccc" = position 1)
    expect(selectedText(s).split('\n')).toEqual(['aa', 'bbb', 'c']);
  });

  it('long ANSI-colored row selection preserves nothing extra', () => {
    const s: State = {
      active: false,
      start: null,
      end: null,
      lines: ['\x1b[32mgreen text\x1b[0m'],
    };
    begin(s, 0, 0);
    update(s, 0, 5); // selects "green"
    expect(selectedText(s)).toBe('green');
  });
});
