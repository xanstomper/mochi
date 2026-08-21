// Pure helpers for mouse text selection in the chat transcript. These are
// importable so they can be unit-tested without booting a terminal.

const ANSI_M = /^\x1b\[[0-9;]*m/;

/** Count the visible (non-ANSI) cell width of a string, treating ANSI SGR
 *  sequences as zero-width. Double-width characters count as one cell here. */
export function visibleLen(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\x1b' && ANSI_M.test(s.slice(i))) {
      i += s.slice(i).match(ANSI_M)![0].length - 1;
      continue;
    }
    if (s.charCodeAt(i) >= 0x1100) {
      // Collapse wide East-Asian ranges so a plain JS slice stays aligned.
    }
    n++;
  }
  return n;
}

/** Slice an ANSI-colored string to the visible characters in [from,to),
 *  preserving color codes for the requested range so it renders correctly.
 *  If to exceeds the visible width, trailing color codes are preserved. */
export function sliceVisibleRange(s: string, from: number, to: number): string {
  if (to <= from) return '';
  let out = '';
  let vis = 0;
  let i = 0;
  while (i < s.length && vis < to) {
    if (s[i] === '\x1b' && ANSI_M.test(s.slice(i))) {
      const m = s.slice(i).match(ANSI_M)![0];
      out += m;
      i += m.length;
      continue;
    }
    if (vis >= from) out += s[i];
    vis++;
    i++;
  }
  if (vis > to) {
    // A double-width char straddled the boundary; drop the partial cell.
    out = out.slice(0, -1);
  }
  return out;
}

/** Wrap the visible chars [from,to) of a colored row in reverse-video. */
export function highlightRange(s: string, from: number, to: number): string {
  if (to <= from) return s;
  return (
    sliceVisibleRange(s, 0, from) +
    '\x1b[7m' +
    sliceVisibleRange(s, from, to) +
    '\x1b[27m' +
    sliceVisibleRange(s, Math.max(0, to), visibleLen(s))
  );
}