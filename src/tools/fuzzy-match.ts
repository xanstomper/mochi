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
export function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/** Levenshtein distance between two strings */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const v0 = new Int32Array(b.length + 1);
  const v1 = new Int32Array(b.length + 1);

  for (let i = 0; i <= b.length; i++) v0[i] = i;

  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= b.length; j++) v0[j] = v1[j];
  }

  return v1[b.length];
}

/** Line similarity ratio from 0.0 to 1.0 */
export function lineSimilarity(a: string, b: string): number {
  const normA = normalizeLine(a);
  const normB = normalizeLine(b);
  if (normA === normB) return 1.0;
  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshtein(normA, normB);
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Find the single region in `text` that matches `needle` after whitespace
 * normalization or tolerant line similarity healing. Returns null when there is no match,
 * or when the match is ambiguous (more than one region). Line-ending differences (\r\n vs \n) are
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
  if (matches.length > 1) return null; // Ambiguous exact matches

  // 3-Way Tolerant Fallback: if strict whitespace match found 0 occurrences (e.g. 1 drifted line),
  // slide a window of size `normNeedle.length` across `normText` and score overall block similarity.
  let bestScore = 0;
  let bestIndex = -1;
  let secondBestScore = 0;

  for (let i = 0; i + normNeedle.length <= normText.length; i++) {
    let totalSim = 0;
    for (let j = 0; j < normNeedle.length; j++) {
      totalSim += lineSimilarity(normText[i + j], normNeedle[j]);
    }
    const avgSim = totalSim / normNeedle.length;
    if (avgSim > bestScore) {
      secondBestScore = bestScore;
      bestScore = avgSim;
      bestIndex = i;
    } else if (avgSim > secondBestScore) {
      secondBestScore = avgSim;
    }
  }

  // Require high overall similarity (>= 80%) and clear uniqueness margin (>= 15% above 2nd best)
  if (bestScore >= 0.80 && bestScore - secondBestScore >= 0.15 && bestIndex !== -1) {
    let start = 0;
    for (let k = 0; k < bestIndex; k++) start += textLines[k].length + 1;
    let end = start;
    for (let k = bestIndex; k < bestIndex + normNeedle.length; k++) end += textLines[k].length + 1;
    return { start, end: Math.max(start, end - 1) };
  }

  return null;
}
