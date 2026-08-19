// Fuzzy text matching for edits. Exact-match replacement fails whenever the
// model's remembered whitespace differs even slightly from disk (indentation,
// trailing spaces, tabs-vs-spaces, line endings). Rather than erroring and
// burning a retry round-trip, we find the unique region that matches after
// normalizing insignificant whitespace, and map the replacement back to the
// file's real coordinates so the file's own indentation style is preserved.
//
// The approach:
//   1. Normalize: collapse runs of whitespace to a single space per line and
//      compare case-sensitively otherwise (identifiers matter).
//   2. Find every candidate start where the normalized needle matches.
//   3. Require uniqueness: multiple matches are ambiguous and we refuse
//      rather than silently editing the wrong occurrence.
//   4. Map back: the matched region's start/end in the ORIGINAL text is
//      computed during the scan so the replacement lands exactly.

export interface FuzzyMatch {
  start: number;
  end: number;
}

/** Normalize one line for comparison: trim ends, collapse inner whitespace. */
function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/**
 * Find the single region in `text` that matches `needle` after whitespace
 * normalization. Returns null when there is no match, or when the match is
 * ambiguous (more than one region). Line-ending differences (\r\n vs \n) are
 * normalized away as well.
 */
export function fuzzyFindUnique(text: string, needle: string): FuzzyMatch | null {
  if (needle.trim() === '') return null;

  const textLines = text.split('\n');
  const needleLines = needle.replace(/\r\n/g, '\n').split('\n');
  // Drop empty leading/trailing needle lines: models often pad blocks.
  while (needleLines.length && needleLines[0].trim() === '') needleLines.shift();
  while (needleLines.length && needleLines[needleLines.length - 1].trim() === '') needleLines.pop();
  if (needleLines.length === 0) return null;

  const normNeedle = needleLines.map(normalizeLine);
  const normText = textLines.map(normalizeLine);

  const matches: FuzzyMatch[] = [];
  for (let i = 0; i + normNeedle.length <= normText.length; i++) {
    let ok = true;
    for (let j = 0; j < normNeedle.length; j++) {
      if (normText[i + j] !== normNeedle[j]) { ok = false; break; }
    }
    if (!ok) continue;
    // Compute original-text offsets for the matched line range.
    let start = 0;
    for (let k = 0; k < i; k++) start += textLines[k].length + 1;
    let end = start;
    for (let k = i; k < i + normNeedle.length; k++) end += textLines[k].length + 1;
    // `end` points one past the final newline; the match region should not
    // include that trailing newline.
    matches.push({ start, end: Math.max(start, end - 1) });
  }

  if (matches.length === 1) return matches[0];
  return null;
}
