// Terminal-aware text wrapping shared by the TUI and its tests.
// Kept dependency-free so the wrap logic is unit-testable in isolation.

/** Visible (ANSI-stripped) length of a string. */
export function visibleLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/** Wrap `text` to at most `max` visible columns per line (word-aware).
 *  Fixes "fake wrapping": an unbroken token longer than `max` is hard-split
 *  so no line ever spills past the terminal width, and leading spaces are
 *  preserved so adjacent wrapped lines don't visually concatenate. */
export function wrap(text: string, max: number): string[] {
  if (!text) return [''];
  const out: string[] = [];
  const maxN = Math.max(1, max);
  for (const paragraph of text.split('\n')) {
    let line = '';
    let lineVis = 0; // visible length of `line`, kept O(1)
    const flush = () => { if (line.trim()) out.push(line.trimEnd()); line = ''; lineVis = 0; };
    for (const token of paragraph.split(/(\s+)/)) {
      let word = token;
      let wVis = visibleLen(word);
      if (wVis === 0) { line += word; continue; } // pure whitespace only
      if (lineVis + wVis > maxN) flush();
      // Hard-split a SINGLE token longer than the width so it can never spill
      // past the terminal (a real "fake wrapper" before).
      while (wVis > maxN) {
        out.push(line + word.slice(0, maxN));
        word = word.slice(maxN);
        wVis -= maxN;
        line = '';
      }
      line += word;
      lineVis += wVis;
    }
    out.push(line);
  }
  return out.length ? out : [''];
}