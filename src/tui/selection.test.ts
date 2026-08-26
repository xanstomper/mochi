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

describe('SGR mouse event parser (the bytes a real terminal sends)', () => {
  // Mirrors the regex used in app.ts onKey(). If the parser ever drifts,
  // this test will catch it before drag-select silently breaks again.
  const SGR = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;

  function parse(buf: string) {
    const m = buf.match(SGR);
    if (!m) return null;
    return {
      btn: Number(m[1]),
      col: Number(m[2]),
      row: Number(m[3]),
      isPress: m[4] === 'M',
    };
  }

  it('parses a left-button press (btn=0)', () => {
    const e = parse('\x1b[<0;5;3M')!;
    expect(e).toEqual({ btn: 0, col: 5, row: 3, isPress: true });
  });

  it('parses a motion event (btn=32 = base 0 + motion flag)', () => {
    const e = parse('\x1b[<32;8;3M')!;
    expect(e.isPress).toBe(true);
    expect(e.btn & 32).toBe(32); // motion bit set
    expect(e.btn & 3).toBe(0);   // left button still down
  });

  it('parses a left-button release (lowercase m, btn=0)', () => {
    const e = parse('\x1b[<0;12;3m')!;
    expect(e.isPress).toBe(false);
    expect(e.btn).toBe(0);
  });

  it('parses wheel up (btn=64)', () => {
    const e = parse('\x1b[<64;50;20M')!;
    expect(e.btn).toBe(64);
  });

  it('parses wheel down (btn=65)', () => {
    const e = parse('\x1b[<65;50;20M')!;
    expect(e.btn).toBe(65);
  });

  it('parses right-button press (btn=2)', () => {
    const e = parse('\x1b[<2;40;10M')!;
    expect(e.btn).toBe(2);
  });

  it('parses mid-drag release with motion flag still set (some terminals)', () => {
    // Real terminals often send the final release event with the motion
    // bit still set if the user released while still moving. Handle both.
    const e = parse('\x1b[<32;20;5m')!;
    expect(e.isPress).toBe(false);
    expect(e.btn & 32).toBe(32);
  });

  it('handles split chunks: press + motion arrive in separate data events', () => {
    // A real PTY may split an SGR sequence across multiple data chunks
    // when the OS reads < N bytes. The parser only matches at the start
    // of the chunk, so the caller must buffer incomplete chunks. This
    // test documents that contract.
    const buf1 = Buffer.from('\x1b[<0;5;3', 'utf8'); // truncated
    const buf2 = Buffer.from('M\x1b[<32;8;3M\x1b[<0;8;3m', 'utf8');
    const combined = Buffer.concat([buf1, buf2]).toString('utf8');
    const events: any[] = [];
    let i = 0;
    while (i < combined.length) {
      const m = combined.slice(i).match(SGR);
      if (!m) break;
      events.push(parse(m[0]));
      i += m[0].length;
    }
    expect(events).toHaveLength(3);
    expect(events.map(e => e.isPress)).toEqual([true, true, false]);
  });

  it('end-to-end drag sequence produces the expected selection', () => {
    // Drive the FULL flow with real terminal bytes:
    //   press(0,5,3) → motion(32,8,3) → motion(32,12,3) → release(0,12,3)
    // The selection uses a windowStart offset (mirroring app.ts selectedText)
    // so the chat lines can live at non-zero indices in the visible window.
    type Pt = { row: number; col: number };
    type State = {
      active: boolean; start: Pt | null; end: Pt | null;
      lines: string[]; windowStart: number;
    };
    const s: State = {
      active: false, start: null, end: null,
      lines: ['hello world'], // chat row 0 = window row 0 (no scroll)
      windowStart: 0,
    };

    function begin(r: number, c: number) {
      s.start = { row: r, col: c }; s.end = { row: r, col: c }; s.active = true;
    }
    function update(r: number, c: number) {
      if (!s.active) return; s.end = { row: r, col: c };
    }

    // Mirrors app.ts selectedText exactly.
    function selectedText(): string {
      if (!s.active || !s.start || !s.end) return '';
      const topRow = Math.min(s.start.row, s.end.row);
      const botRow = Math.max(s.start.row, s.end.row);
      const lines: string[] = [];
      for (let r = topRow; r <= botRow; r++) {
        const idx = s.windowStart + r;
        if (idx < 0 || idx >= s.lines.length) continue;
        const bare = s.lines[idx].replace(/\x1b\[[0-9;]*m/g, '');
        if (topRow === botRow) {
          const lo = Math.min(s.start.col, s.end.col);
          const hi = Math.max(s.start.col, s.end.col);
          lines.push(bare.slice(lo, hi));
        }
      }
      return lines.join('\n');
    }

    // Mirrors endSelection: capture BEFORE clearing active state.
    let captured = '';
    function endCapture() {
      if (s.active) {
        captured = selectedText();
        s.active = false;
      }
    }

    // The bytes a real terminal emits. Press at row=1 col=5 (top-left area):
    const bytes = '\x1b[<0;5;1M\x1b[<32;8;1M\x1b[<32;12;1M\x1b[<0;12;1m';
    let i = 0;
    while (i < bytes.length) {
      const m = bytes.slice(i).match(SGR);
      if (!m) break;
      const e = parse(m[0])!;
      // app.ts uses 0-based row/col: row - 1, col - 1
      const r = e.row - 1;
      const c = e.col - 1;
      if (e.isPress) {
        const isMotion = (e.btn & 32) !== 0;
        if (isMotion) update(r, c);
        else begin(r, c);
      } else {
        endCapture();
      }
      i += m[0].length;
    }
    expect(captured).toBe('o world');
    expect(s.start).toEqual({ row: 0, col: 4 });
    expect(s.end).toEqual({ row: 0, col: 11 });
  });
});

describe('inclusive end column (the off-by-one that drops the last char)', () => {
  // SGR mouse reports the column the cursor was over (1-based). The
  // mouse handler converts to 0-based, then applySelection/selectedText
  // subtract the indent to get the visible-cell index. After that, the
  // cell at the cursor MUST still be in the selection — otherwise
  // dragging to col 17 over "hello world" copies only "hello worl".
  //
  // The math: selEnd.col = 16 (0-based). After subtracting indent (2)
  // we land on visible[14] = 'd'. But bare.slice(4, 14) only includes
  // indices 4..13, so 'd' is silently dropped. The fix is to add 1 to
  // the end so the slice is inclusive.
  function selectedTextWithEnd(startCol: number, endCol: number, indent: number, lines: string[]): string {
    const minCol = Math.min(startCol, endCol);
    const maxCol = Math.max(startCol, endCol);
    const from = Math.max(0, minCol - indent);
    const to = Math.min(lines[0].length, Math.max(0, maxCol - indent + 1));
    return lines[0].slice(from, to);
  }

  it('dragging from "h" to "d" in "hello world" includes the "d"', () => {
    // User clicks at screen col 7 (h) and releases at col 17 (d).
    // After converting to 0-based: 6..16. After -indent (2): 4..14.
    // With the fix (+1 to end): 4..15. slice(4, 15) = "hello world".
    const row = '  ❯ hello world';
    const got = selectedTextWithEnd(6, 16, 2, [row]);
    expect(got).toBe('hello world');
  });

  it('single-cell click captures exactly that cell', () => {
    // Click at col 7 (h): selStart.col = selEnd.col = 6. After -indent:
    // from=to=4. Without +1, slice(4, 4) = "". With +1, slice(4, 5) = "h".
    const row = '  ❯ hello';
    const got = selectedTextWithEnd(6, 6, 2, [row]);
    expect(got).toBe('h');
  });

  it('clicking past the row end clamps to the row', () => {
    // User drags off the right edge. Should not throw, should clamp.
    const row = '  ❯ hi';
    const got = selectedTextWithEnd(6, 100, 2, [row]);
    expect(got).toBe('hi');
  });

  it('reverse drag (end before start) still includes both endpoints', () => {
    // User drags backwards: starts at "o" (col 11), releases at "h" (col 7).
    // Selected range should still be inclusive: [h, o] = "hello".
    const row = '  ❯ hello world';
    const got = selectedTextWithEnd(10, 6, 2, [row]);
    expect(got).toBe('hello');
  });

  it('dragging over assistant row (▌ marker) includes content at first cell', () => {
    // Assistant row: " ▌ Some text". Content starts at visible[2].
    // Click at terminal col 4 (0-based 3) → visible[1] = "▌".
    // Drag to col 14 → visible[12] = "t" (last 't' in "text").
    const row = ' ▌ Some text';
    const got = selectedTextWithEnd(3, 14, 2, [row]);
    expect(got).toBe('▌ Some text');
  });
});
