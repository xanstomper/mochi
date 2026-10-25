// Per-hunk edit review (W3-4): unified-diff construction, per-tool review
// builders, accepted-subset arg rewriting — component tests in the
// scripted-input style used across the tui tests.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHunks } from '../apply.js';
import { writeTool } from '../tools/write.js';
import {
  diffLines,
  buildHunks,
  computeUnifiedDiff,
  splitHunks,
  buildEditReview,
  applyAcceptedHunks,
} from './edit-review.js';
import { normalizeApprovalDecision } from './approval.js';
import { patchTool } from '../tools/patch.js';

describe('diffLines + buildHunks', () => {
  it('a single contiguous change is one hunk with correct markers', () => {
    const ops = diffLines(['a', 'b', 'c'], ['a', 'B', 'c']);
    expect(ops.map((o) => o.t + o.s)).toEqual([' a', '-b', '+B', ' c']);
    const hunks = buildHunks(ops);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].split('\n')[0]).toBe('@@ -1,3 +1,3 @@');
    expect(hunks[0]).toContain('-b');
    expect(hunks[0]).toContain('+B');
  });

  it('distant changes land in separate hunks; nearby ones merge', () => {
    const a = Array.from({ length: 40 }, (_, i) => `line-${i}`);
    const b = [...a];
    b[0] = 'CHANGED-FIRST';
    b[39] = 'CHANGED-LAST';
    const far = buildHunks(diffLines(a, b));
    expect(far).toHaveLength(2);
    const near = a.slice();
    near[20] = 'CHANGED-A';
    near[24] = 'CHANGED-B';
    const merged = buildHunks(diffLines(a, near));
    expect(merged).toHaveLength(1);
  });

  it('a pure insertion writes a 0-line old count', () => {
    const hunks = buildHunks(diffLines(['a', 'b'], ['a', 'x', 'y', 'b']));
    expect(hunks).toHaveLength(1);
    expect(hunks[0].split('\n')[0]).toBe('@@ -1,2 +1,4 @@');
  });

  it('computeUnifiedDiff wraps hunks in git headers; no-change is empty', () => {
    const diff = computeUnifiedDiff('a\nb\n', 'a\nB\n', 'src/x.ts');
    expect(diff.split('\n')[0]).toBe('diff --git a/src/x.ts b/src/x.ts');
    expect(splitHunks(diff)).toHaveLength(1);
    expect(computeUnifiedDiff('same\n', 'same\n', 'src/x.ts')).toBe('');
  });

  it('splitHunks survives a round-trip: hunks reapply to the old content', () => {
    // Changes at line 0 and line 9: with context 3, the gap (8 unchanged
    // lines > 2*context) keeps them in SEPARATE hunks.
    const oldText = Array.from({ length: 10 }, (_, i) => (i === 0 || i === 9 ? `old-${i}` : `same-${i}`)).join('\n');
    const newText = Array.from({ length: 10 }, (_, i) => (i === 0 || i === 9 ? `new-${i}` : `same-${i}`)).join('\n');
    const diff = computeUnifiedDiff(oldText, newText, 'f.txt');
    const hunks = splitHunks(diff);
    expect(hunks).toHaveLength(2);
    // applyHunks consumes a FLAT list of diff lines; blocks flatten to it.
    expect(applyHunks(oldText, hunks.join('\n').split('\n'))).toBe(newText);
    // And a subset applies just that region.
    expect(applyHunks(oldText, hunks[0].split('\n'))).toBe(oldText.replace('old-0', 'new-0'));
  });
});

describe('buildEditReview', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mochi-edit-review-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } });

  it('edit: matched needle yields exactly one unified hunk (W3-4)', () => {
    const p = join(dir, 'a.ts');
    writeFileSync(p, 'function f() {\n  return 1;\n}\n');
    const review = buildEditReview('edit', { path: p, oldText: 'return 1;', newText: 'return 2;' }, dir);
    expect(review).toBeDefined();
    expect(review!.hunks).toHaveLength(1);
    expect(review!.hunks[0]).toContain('-  return 1;');
    expect(review!.hunks[0]).toContain('+  return 2;');
  });

  it('edit: unmatched needle → no review (plain menu, tool fails at exec)', () => {
    const p = join(dir, 'a.ts');
    writeFileSync(p, 'function f() {}\n');
    const review = buildEditReview('edit', { path: p, oldText: 'NOPE', newText: 'x' }, dir);
    expect(review).toBeUndefined();
  });

  it('write: full-file rewrite decomposes into per-region hunks', () => {
    const p = join(dir, 'b.md');
    // Two changed regions separated by > 2*context unchanged lines.
    const lines = [
      '# title', '', 'intro paragraph', '', 'filler-1', 'filler-2', 'filler-3', 'filler-4', 'filler-5',
      '', 'mid content', '', 'outro',
    ];
    writeFileSync(p, lines.join('\n'));
    const changed = [...lines];
    changed[0] = '# TITLE';
    changed[10] = 'MID CONTENT CHANGED';
    const review = buildEditReview('write', { path: p, content: changed.join('\n') }, dir);
    expect(review).toBeDefined();
    expect(review!.hunks.length).toBe(2);
    expect(review!.hunks[0]).toContain('-# title');
    expect(review!.hunks[0]).toContain('+# TITLE');
  });

  it('write: append=true and no-op writes get no review', () => {
    const p = join(dir, 'b.md');
    writeFileSync(p, 'stable\n');
    expect(buildEditReview('write', { path: p, content: 'stable\n', append: true }, dir)).toBeUndefined();
    expect(buildEditReview('write', { path: p, content: 'stable\n' }, dir)).toBeUndefined();
  });

  it('patch: each @@ group is one reviewable, re-emittable unit', () => {
    const p = join(dir, 'c.txt');
    writeFileSync(p, ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].join('\n'));
    const patch = [
      '*** Begin Patch',
      `*** Update File: ${p}`,
      '@@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
      '@@',
      ' epsilon',
      '-zeta',
      '+ZETA',
      '*** End Patch',
    ].join('\n');
    const review = buildEditReview('patch', { patch }, dir);
    expect(review).toBeDefined();
    expect(review!.hunks).toHaveLength(2);
    expect(review!.hunks[0]).toContain('*** Update File:');
    expect(review!.hunks[0]).toContain('-beta');
    // Each unit re-parses standalone (the rebuild contract).
    const reread = buildEditReview('patch', { patch: `*** Begin Patch\n${review!.hunks[0]}\n*** End Patch` }, dir);
    expect(reread).toBeDefined();
  });

  it('patch: add and delete sections are single units; malformed patch → undefined', () => {
    const addOnly = buildEditReview('patch', { patch: '*** Begin Patch\n*** Add File: new.ts\n+export const x = 1;\n*** End Patch' }, dir);
    expect(addOnly?.hunks).toHaveLength(1);
    expect(buildEditReview('patch', { patch: 'not a patch at all' }, dir)).toBeUndefined();
  });

  it('non-edit tools get no review', () => {
    expect(buildEditReview('shell', { command: 'ls' }, dir)).toBeUndefined();
  });
});

describe('applyAcceptedHunks', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'mochi-edit-review-')); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } });

  it('patch: applying the accepted subset lands ONLY those hunks', async () => {
    const p = join(dir, 'd.txt');
    writeFileSync(p, ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].join('\n'));
    const patch = [
      '*** Begin Patch',
      `*** Update File: ${p}`,
      '@@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
      '@@',
      ' delta',
      '-epsilon',
      '+EPSILON',
      '*** End Patch',
    ].join('\n');
    const review = buildEditReview('patch', { patch }, dir)!;
    // Reject hunk 0 (index 0), accept hunk 1.
    const revised = applyAcceptedHunks('patch', { patch }, review, [1], dir);
    expect(revised).toBeDefined();
    const res = await patchTool.execute(revised!, { cwd: dir, events: { emit: () => {} }, agentId: 't', config: {}, workspace: { dir }, readCache: new Map() } as never);
    const after = readFileSync(p, 'utf8');
    expect(after).toContain('beta'); // rejected hunk did NOT land
    expect(after).not.toContain('BETA');
    expect(after).toContain('EPSILON'); // accepted hunk landed
    expect(res).toContain('Applied patch');
  });

  it('write: accepting a subset merges the accepted regions only', async () => {
    const p = join(dir, 'e.txt');
    // Two changed lines separated by > 2*context unchanged lines.
    const oldText = ['a1', 'a2', 'a3', 'f1', 'f2', 'f3', 'f4', 'f5', 'b1', 'b2', 'b3', 'c1', 'c2', 'c3'].join('\n');
    const newText = ['a1', 'A2', 'a3', 'f1', 'f2', 'f3', 'f4', 'f5', 'b1', 'b2', 'b3', 'c1', 'C2', 'c3'].join('\n');
    writeFileSync(p, oldText);
    const review = buildEditReview('write', { path: p, content: newText }, dir)!;
    expect(review.hunks).toHaveLength(2);
    const revised = applyAcceptedHunks('write', { path: p, content: newText }, review, [1], dir); // keep only the C2 change
    expect(revised).toBeDefined();
    // End-to-end: the REVISED args flow through the real write tool.
    await writeTool.execute(revised!, { cwd: dir, events: { emit: () => {} }, agentId: 't', config: {}, workspace: { dir }, readCache: new Map() } as never);
    const after = readFileSync(p, 'utf8');
    expect(after).toContain('a2'); // rejected change did not land
    expect(after).not.toContain('A2');
    expect(after).toContain('C2'); // accepted change landed
  });

  it('edit is single-hunk: no revision, args pass through', () => {
    const p = join(dir, 'f.txt');
    writeFileSync(p, 'keep change\n');
    const review = buildEditReview('edit', { path: p, oldText: 'change', newText: 'CHANGE' }, dir)!;
    expect(applyAcceptedHunks('edit', { path: p, oldText: 'change', newText: 'CHANGE' }, review, [0], dir)).toBeUndefined();
  });

  it('out-of-range and empty accepted sets are refused', () => {
    const p = join(dir, 'g.txt');
    writeFileSync(p, 'x\n');
    const review = buildEditReview('write', { path: p, content: 'y\n' }, dir)!;
    expect(applyAcceptedHunks('write', { path: p, content: 'y\n' }, review, [], dir)).toBeUndefined();
    expect(applyAcceptedHunks('write', { path: p, content: 'y\n' }, review, [99], dir)).toBeUndefined();
  });
});

describe('normalizeApprovalDecision', () => {
  it('plain string decisions pass through', () => {
    expect(normalizeApprovalDecision('allow-once')).toEqual({ decision: 'allow-once' });
    expect(normalizeApprovalDecision('allow-always')).toEqual({ decision: 'allow-always' });
    expect(normalizeApprovalDecision('deny')).toEqual({ decision: 'deny' });
  });

  it('hunk subset decisions fold into decision + acceptedHunks', () => {
    expect(normalizeApprovalDecision({ decision: 'allow-once', acceptedHunks: [1, 2] }))
      .toEqual({ decision: 'allow-once', acceptedHunks: [1, 2] });
  });

  it('malformed objects fail closed to deny', () => {
    expect(normalizeApprovalDecision({ decision: 'deny', acceptedHunks: [0] } as never).decision).toBe('deny');
    expect(normalizeApprovalDecision({ decision: 'allow-once' } as never).decision).toBe('deny');
    expect(normalizeApprovalDecision(42 as never).decision).toBe('deny');
  });
});
