// Item 17 (evidence-graded output): unit tests for the claim-grading seam.
//
// Pinned here:
//   * cited / test-backed / ungrounded classification, including run-activity
//     citations (file-level) vs in-text citations (file:line, disk-verified).
//   * THE NO-FABRICATION RULE: a path:line that does not resolve on disk is
//     never upgraded (the claim stays ungrounded and the bad ref is named);
//     a test named but never run stays ungrounded; a claim with no source in
//     the run never receives a citation.
//   * The default output path: the evidence footer is appended to the
//     summary, visibly marks ungrounded claims, and is absent when there is
//     nothing to grade (no behavior change).
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvidenceGrade,
  collectRunEvidence,
  evidenceFooterItems,
  extractClaims,
  gradeClaims,
  renderEvidenceFooter,
} from './claim-grade.js';

const dir = mkdtempSync(join(tmpdir(), 'mochi-claim-grade-'));
// Fixture "repo": small files with known line counts so path:line refs can
// be verified against real disk state.
mkdirSync(join(dir, 'src'), { recursive: true });
writeFileSync(join(dir, 'src', 'util.ts'), 'export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n'); // 5 lines
writeFileSync(join(dir, 'src', 'parse.ts'), 'export function parse(s: string): string {\n  return s.trim();\n}\n'); // 3 lines
writeFileSync(join(dir, 'src', 'util.test.ts'), 'import { add } from "./util.js";\n// covers the empty case\n'); // 2 lines

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

function ev(overrides: Partial<Parameters<typeof collectRunEvidence>[0]> = {}) {
  return collectRunEvidence({ cwd: dir, ...overrides });
}

describe('claim extraction', () => {
  it('extracts substantive sentences, skipping code fences, headings, meta openers and questions', () => {
    const text = [
      '## Summary',
      'Added the retry limiter to src/util.ts.',
      '```ts',
      'const x = add(1, 2); // code is not prose',
      '```',
      "Here's what changed overall.",
      'What line is the gate on?',
      'The gate lives in src/parse.ts and stamps its verdict on the run.',
      'Added the retry limiter to src/util.ts.', // duplicate collapses
    ].join('\n');
    const claims = extractClaims(text);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toBe('Added the retry limiter to src/util.ts.');
    expect(claims[1]).toBe('The gate lives in src/parse.ts and stamps its verdict on the run.');
  });

  it('splits multi-sentence lines without breaking file:line refs', () => {
    const claims = extractClaims('The gate lives in src/util.ts:2 now. The registry is in src/parse.ts.');
    expect(claims).toHaveLength(2);
    expect(claims[0]).toContain('src/util.ts:2');
    expect(claims[1]).toContain('src/parse.ts');
  });

  it('treats a bare ✓ result line as a verification claim', () => {
    const claims = extractClaims('✓ npm run typecheck');
    expect(claims).toHaveLength(1);
  });
});

describe('claim grading — cited', () => {
  it('grades an in-text file:line ref that resolves on disk as cited', () => {
    const report = gradeClaims('The add helper lives in src/util.ts:2 and returns the sum.', ev());
    expect(report.counts).toEqual({ total: 1, cited: 1, testBacked: 0, ungrounded: 0 });
    expect(report.claims[0].citation).toEqual({ path: 'src/util.ts', line: 2, via: 'in-text' });
  });

  it('grades a bare mention of a file the run MODIFIED as a run-activity citation (file-level, no line)', () => {
    const report = gradeClaims('Added the retry limiter to src/util.ts and removed the old path.', ev({ filesModified: ['src/util.ts'] }));
    expect(report.counts.cited).toBe(1);
    expect(report.claims[0].citation).toEqual({ path: 'src/util.ts', via: 'run-activity', op: 'modified' });
    expect(report.claims[0].citation?.line).toBeUndefined();
  });

  it('grades a bare mention of a file the run only READ as a read citation', () => {
    const report = gradeClaims('The parser is implemented in src/parse.ts.', ev({ filesRead: [join(dir, 'src', 'parse.ts')] }));
    expect(report.claims[0].grade).toBe('cited');
    expect(report.claims[0].citation).toEqual({ path: 'src/parse.ts', via: 'run-activity', op: 'read' });
  });
});

describe('claim grading — no-fabrication rule', () => {
  it('never upgrades a path:line whose line is out of bounds; the claim stays ungrounded and names the bad ref', () => {
    const report = gradeClaims('The add helper lives in src/util.ts:99 and returns the sum.', ev({ filesModified: ['src/util.ts'] }));
    // Even though the run modified the file, the SPECIFIC line ref is wrong —
    // no silent downgrade to a file-level citation either: the false pointer
    // must be visible.
    expect(report.counts.ungrounded).toBe(1);
    expect(report.claims[0].note).toContain('src/util.ts:99');
  });

  it('never upgrades a citation to a file outside the repo or a nonexistent file', () => {
    const outside = gradeClaims('The helper lives in ../outside/util.ts:1 and works.', ev());
    expect(outside.counts.ungrounded).toBe(1);
    const ghost = gradeClaims('The helper lives in src/ghost.ts:1 and works.', ev());
    expect(ghost.counts.ungrounded).toBe(1);
    expect(ghost.claims[0].note).toContain('src/ghost.ts:1');
  });

  it('never grounds a named test that did not run in this run', () => {
    const report = gradeClaims('The parse suite passes: npx vitest run src/parse.test.ts is green.', ev({ greenCommands: ['npm run typecheck'] }));
    expect(report.counts.testBacked).toBe(0);
    expect(report.counts.ungrounded).toBe(1);
  });

  it('never grounds a bare mention of a file this run never touched', () => {
    // src/parse.ts exists on disk, but this run never read or modified it —
    // the claim gets no citation, it is marked ungrounded.
    const report = gradeClaims('The parser is implemented in src/parse.ts.', ev({ filesModified: ['src/util.ts'] }));
    expect(report.counts.ungrounded).toBe(1);
    expect(report.claims[0].note).toBe('no file or test source in this run');
  });

  it('never grounds a "tests pass" claim without verification evidence', () => {
    const report = gradeClaims('All tests pass and the build is green.', ev({}));
    expect(report.counts.testBacked).toBe(0);
    expect(report.counts.ungrounded).toBe(1);
  });
});

describe('claim grading — test-backed', () => {
  it('grounds a claim naming a command that ran green in this run', () => {
    const report = gradeClaims('Typecheck passes: npm run typecheck is clean.', ev({ greenCommands: ['npm run typecheck'] }));
    expect(report.counts.testBacked).toBe(1);
    expect(report.claims[0].testRef).toBe('✓ npm run typecheck');
  });

  it('grounds a claim naming a test file that ran green in this run', () => {
    const report = gradeClaims('The new suite src/util.test.ts covers the empty case.', ev({ greenCommands: ['npx vitest run src/util.test.ts'] }));
    expect(report.counts.testBacked).toBe(1);
    expect(report.claims[0].testRef).toBe('✓ npx vitest run src/util.test.ts');
  });

  it('is direction-aware: a failure claim is backed by an observed FAILED command, not a green one', () => {
    const failed = gradeClaims('The legacy parser test fails: bun test src/util.test.ts errors on empty input.', ev({ failedCommands: ['bun test src/util.test.ts'] }));
    expect(failed.counts.testBacked).toBe(1);
    expect(failed.claims[0].testRef).toContain('✗ bun test src/util.test.ts');
    // Pass-language must NOT be backed by a failed command.
    const wrongDirection = gradeClaims('The legacy parser test passes: bun test src/util.test.ts is green.', ev({ failedCommands: ['bun test src/util.test.ts'] }));
    expect(wrongDirection.counts.testBacked).toBe(0);
  });

  it('backs a generic "all tests pass" claim with the run\'s green verification evidence', () => {
    const report = gradeClaims('All tests pass after the fix.', ev({ greenCommands: ['npm run test'], verifyStatus: 'PASS' }));
    expect(report.counts.testBacked).toBe(1);
    expect(report.claims[0].testRef).toBe('✓ npm run test');
  });

  it('backs a generic claim with the verify gate status when no raw commands are recorded', () => {
    const report = gradeClaims('All tests pass after the fix.', ev({ verifyStatus: 'PASS' }));
    expect(report.counts.testBacked).toBe(1);
    expect(report.claims[0].testRef).toBe('verify gate: PASS');
  });
});

describe('evidence footer (default output path)', () => {
  it('renders counts, per-claim references, and visibly marks ungrounded claims', () => {
    const report = gradeClaims(
      [
        'Added the retry limiter to src/util.ts.',
        'Typecheck passes: npm run typecheck is clean.',
        'The parser handles unicode escapes now.',
      ].join('\n'),
      ev({ filesModified: ['src/util.ts'], greenCommands: ['npm run typecheck'] }),
    );
    expect(report.counts).toEqual({ total: 3, cited: 1, testBacked: 1, ungrounded: 1 });
    const footer = renderEvidenceFooter(report)!;
    expect(footer).toContain('Evidence: 2/3 claims verified (67%) — 1 cited, 1 test-backed; 1 ungrounded.');
    expect(footer).toContain('[cited] "Added the retry limiter to src/util.ts." → src/util.ts (modified this run)');
    expect(footer).toContain('[test-backed] "Typecheck passes: npm run typecheck is clean." → ✓ npm run typecheck');
    expect(footer).toContain('[ungrounded] "The parser handles unicode escapes now." (no file or test source in this run)');
  });

  it('returns null and leaves the summary unchanged when there is nothing to grade', () => {
    const report = gradeClaims('Thanks, let me know if you need anything else.', ev());
    expect(report.counts.total).toBe(0);
    expect(renderEvidenceFooter(report)).toBeNull();
    const text = 'Thanks, let me know if you need anything else.';
    expect(appendEvidenceGrade(text, report)).toBe(text);
  });

  it('appendEvidenceGrade keeps the original prose intact and appends the block', () => {
    const report = gradeClaims('Added the retry limiter to src/util.ts.', ev({ filesModified: ['src/util.ts'] }));
    const out = appendEvidenceGrade('Added the retry limiter to src/util.ts.', report);
    expect(out.startsWith('Added the retry limiter to src/util.ts.')).toBe(true);
    expect(out).toContain('Evidence: 1/1 claims verified (100%)');
  });

  it('caps per-grade footer lists and reports the overflow', () => {
    const files = Array.from({ length: 8 }, (_, i) => `src/file${i}.ts`);
    for (let i = 0; i < 8; i++) writeFileSync(join(dir, 'src', `file${i}.ts`), 'x\n');
    const report = gradeClaims(
      files.map((f) => `Added the module in ${f} now.`).join('\n'),
      ev({ filesModified: files }),
    );
    expect(report.counts.cited).toBe(8);
    const footer = renderEvidenceFooter(report)!;
    expect(footer.match(/\[cited\]/g)).toHaveLength(5);
    expect(footer).toContain('(+3 more cited)');
  });

  it('evidenceFooterItems mirrors the footer as structured items (the run record, not just prose)', () => {
    const report = gradeClaims('Added the retry limiter to src/util.ts.', ev({ filesModified: ['src/util.ts'] }));
    const items = evidenceFooterItems(report);
    expect(items.length).toBe(2);
    expect(items[0].priority).toBe('P1');
    expect(items[0].text).toContain('Evidence: 1/1');
    expect(items[1].priority).toBe('P2');
    expect(items[1].text).toContain('[cited]');
    expect(evidenceFooterItems(gradeClaims('Nothing to grade here.', ev()))).toEqual([]);
  });
});
