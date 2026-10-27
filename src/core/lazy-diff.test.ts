// MCH-lazy 14.2: lazy diffs — compact summary by default, full hunks on
// demand, and the never-silently-truncate guarantee for marked hunks.
import { describe, it, expect } from 'vitest';
import { lazyDiff, summarizeUnifiedDiff, renderDiffSummary } from './lazy-diff.js';

const MULTI = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,7 +10,9 @@ export function a() {
   context line
-  old line removed
+  new line added
+  another new line
   more context
@@ -40,3 +42,5 @@ export function b() {
+  added in second hunk
   kept line
+  added again
diff --git a/src/b.ts b/src/b.ts
index 3333333..4444444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,4 +1,4 @@
-  deleted from b
+  replaced in b
`;

describe('summarizeUnifiedDiff', () => {
  it('counts files, hunks, and per-file line deltas', () => {
    const s = summarizeUnifiedDiff(MULTI);
    expect(s.totalFiles).toBe(2);
    expect(s.totalHunks).toBe(3);
    expect(s.totalAdded).toBe(5);
    expect(s.totalDeleted).toBe(2);
    expect(s.files[0]).toEqual({ file: 'src/a.ts', added: 4, deleted: 1, hunks: 2, binary: false });
    expect(s.files[1]).toEqual({ file: 'src/b.ts', added: 1, deleted: 1, hunks: 1, binary: false });
  });

  it('flags binary files and detects marked hunk lines', () => {
    const d = `diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,3 +1,3 @@
-  throw new Error("boom: failure expected");
+  throw new Error("fixed");
`;
    const s = summarizeUnifiedDiff(d);
    expect(s.files[0]!.binary).toBe(true);
    expect(s.markedHunks.length).toBeGreaterThan(0);
  });
});

describe('lazyDiff', () => {
  it('defaults to the compact summary with an expansion hint', () => {
    const r = lazyDiff(MULTI, { recoveryHint: 'expand on demand: re-run diff with full: true' });
    expect(r.expanded).toBe(false);
    expect(r.text).toContain('[lazy diff: 2 files changed, 3 hunks, +5/-2 lines]');
    expect(r.text).toContain('src/a.ts');
    expect(r.text).toContain('+4/-1');
    expect(r.text).toContain('expand on demand: re-run diff with full: true');
    // The summary does NOT contain the full hunk bodies.
    expect(r.text).not.toContain('@@ -10,7 +10,9 @@');
  });

  it('EXPANSION: full mode returns the complete hunks, byte-for-byte', () => {
    const r = lazyDiff(MULTI, { full: true });
    expect(r.expanded).toBe(true);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe(MULTI);
    expect(r.text).toContain('@@ -10,7 +10,9 @@');
    expect(r.text).toContain('@@ -40,3 +42,5 @@');
  });

  it('NEVER truncates a failure-marked hunk silently: full-mode cut names the marked lines', () => {
    // Build a diff bigger than the budget whose later hunk carries a failure.
    const filler = Array.from({ length: 400 }, (_, i) => `+filler ${i}`).join('\n');
    const big = `diff --git a/src/big.ts b/src/big.ts
--- a/src/big.ts
+++ b/src/big.ts
@@ -1,5 +1,405 @@ context
${filler}
diff --git a/src/fail.ts b/src/fail.ts
--- a/src/fail.ts
+++ b/src/fail.ts
@@ -9,1 +9,1 @@ the failing test
-  assert.deepStrictEqual(actual, expected);
+  throw new Error('failing assertion: expected 5, received 6');
`;
    const r = lazyDiff(big, { full: true, maxFullChars: 4000, recoveryHint: 'narrow the diff' });
    expect(r.truncated).toBe(true);
    // The marker must EXPLICITLY surface the failure-marked hunk lines.
    expect(r.text).toContain('LAZY DIFF TRUNCATION MARKER');
    expect(r.text).toContain('failing assertion');
    expect(r.summary.markedHunks.length).toBeGreaterThan(0);
  });

  it('summary mode also samples marked hunk lines instead of dropping them', () => {
    const d = `diff --git a/src/c.ts b/src/c.ts
--- a/src/c.ts
+++ b/src/c.ts
@@ -1,2 +1,2 @@
-  ok();
+  FAIL: invariant violated here
`;
    const r = lazyDiff(d, { full: false });
    expect(r.text).toContain('invariant violated');
    expect(r.text).toContain('hunks carry marked lines');
  });

  it('renders per-file deltas aligned in the summary', () => {
    const s = summarizeUnifiedDiff(MULTI);
    const text = renderDiffSummary(s, 'hint');
    expect(text.split('\n').some((l) => l.includes('src/b.ts') && l.includes('+1/-1'))).toBe(true);
  });
});
