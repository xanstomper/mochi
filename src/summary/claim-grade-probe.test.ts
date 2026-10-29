// Item 17 (evidence-graded output): the fixed probe set — the PROOF METRIC.
//
// User-verifiable claims per response: the share of substantive claims
// carrying a file:line into the repo or a test result that backs it,
// measured BEFORE (the raw response text — the status quo, where a bare
// assertion is all the user gets) vs AFTER (the default output path: the
// seam verifies in-text citations on disk, attaches run-activity citations
// for files the run actually touched, and test refs for commands that
// actually ran). Task success is measured on the SAME probes: every fact the
// answer must convey still appears verbatim after grading, and the claims
// known to lack a source in the run are VISIBLY marked — grading must add
// evidence, never drop or rewrite the answer.
//
// The probes are fixed (no model calls): each is a representative response
// for one of the three task shapes — a code question, a change summary, a
// verification report — plus the no-behavior-change and no-fabrication
// cases, over a small fixture repo the citations resolve against.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvidenceGrade,
  collectRunEvidence,
  extractClaims,
  gradeClaims,
} from './claim-grade.js';

const dir = mkdtempSync(join(tmpdir(), 'mochi-claim-probe-'));
for (const sub of ['src', 'src/core']) mkdirSync(join(dir, sub), { recursive: true });
writeFileSync(join(dir, 'src', 'gate.ts'), 'export function gate(): boolean {\n  return true;\n}\nexport const GATE_LINE = 2;\n'); // 4 lines
writeFileSync(join(dir, 'src', 'retry.ts'), 'export function retry(n: number): number {\n  return n + 1;\n}\n'); // 3 lines
writeFileSync(join(dir, 'src', 'retry.test.ts'), 'import { retry } from "./retry.js";\n'); // 2 lines
writeFileSync(join(dir, 'src', 'core', 'flaky.ts'), 'export const SCORE = 3;\n'); // 1 line
writeFileSync(join(dir, 'tsconfig.json'), '{ "strict": true }\n');

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
});

const blankEvidence = () => collectRunEvidence({ cwd: dir });

interface Probe {
  name: string;
  shape: 'code-question' | 'change-summary' | 'verification-report' | 'already-evidenced' | 'fabrication-attempt';
  /** The raw response text (the status quo output). */
  answer: string;
  /** What the run ACTUALLY did — the only evidence the seam may attach. */
  evidence: Parameters<typeof collectRunEvidence>[0];
  /** Facts the answer must convey — task success, before AND after. */
  mustMention: string[];
  /** Substrings of claims that MUST stay visibly ungrounded (no source). */
  expectUngrounded: string[];
  /** Whether the grounded share must strictly rise after the default path. */
  expectRise: boolean;
}

const PROBES: Probe[] = [
  {
    name: 'code question (chat): where things live',
    shape: 'code-question',
    answer: [
      'The verify gate lives in src/gate.ts:2 and returns the verdict.',
      'The flaky registry is implemented in src/core/flaky.ts.',
      'Strict mode is enabled in tsconfig.json.',
    ].join('\n'),
    evidence: { cwd: dir, filesRead: ['src/gate.ts', 'src/core/flaky.ts'] },
    mustMention: ['verify gate', 'flaky registry', 'Strict mode'],
    expectUngrounded: ['Strict mode is enabled in tsconfig.json.'],
    expectRise: true,
  },
  {
    name: 'change summary: what was edited and what passes',
    shape: 'change-summary',
    answer: [
      'Added the retry limiter to src/retry.ts and fixed the off-by-one in src/gate.ts.',
      'All tests pass after the change.',
    ].join('\n'),
    evidence: { cwd: dir, filesModified: ['src/retry.ts', 'src/gate.ts'], greenCommands: ['npm run test'], verifyStatus: 'PASS' },
    mustMention: ['retry limiter', 'off-by-one', 'All tests pass'],
    expectUngrounded: [],
    expectRise: true,
  },
  {
    name: 'verification report: what ran and what it covered',
    shape: 'verification-report',
    answer: [
      'Typecheck passes: npm run typecheck is clean.',
      'The new suite src/retry.test.ts covers the retry path.',
      'Coverage improved by 4 points.',
    ].join('\n'),
    evidence: { cwd: dir, greenCommands: ['npm run typecheck', 'npx vitest run src/retry.test.ts'], verifyStatus: 'PASS' },
    mustMention: ['Typecheck passes', 'retry.test.ts', 'Coverage improved'],
    expectUngrounded: ['Coverage improved by 4 points.'],
    expectRise: true,
  },
  {
    name: 'already-evidenced answer: citations in the text resolve — no behavior change',
    shape: 'already-evidenced',
    answer: [
      'The retry limiter lives in src/retry.ts:2 and bumps the count.',
      'The gate verdict lives in src/gate.ts:4.',
    ].join('\n'),
    evidence: { cwd: dir },
    mustMention: ['retry limiter', 'gate verdict'],
    expectUngrounded: [],
    expectRise: false,
  },
  {
    name: 'fabrication attempt: a wrong line ref is flagged, never upgraded',
    shape: 'fabrication-attempt',
    answer: [
      'The gate emits the verdict in src/gate.ts:3.',
      'The parser handles unicode escapes in src/parse.ts:99.',
      'It also supports unicode in JSON input now.',
    ].join('\n'),
    evidence: { cwd: dir, filesRead: ['src/gate.ts', 'src/parse.ts'] },
    mustMention: ['emits the verdict', 'unicode escapes', 'unicode in JSON input'],
    expectUngrounded: ['The parser handles unicode escapes in src/parse.ts:99.', 'It also supports unicode in JSON input now.'],
    expectRise: false, // honest grading does not manufacture a rise here
  },
  {
    name: 'failed-check report: a failure claim backed by the observed failing command',
    shape: 'verification-report',
    answer: [
      'The legacy parser test fails: bun test src/retry.test.ts errors on empty input.',
      'Fixed by normalizing the input in src/retry.ts.',
    ].join('\n'),
    evidence: { cwd: dir, failedCommands: ['bun test src/retry.test.ts'], filesModified: ['src/retry.ts'] },
    mustMention: ['legacy parser test fails', 'normalizing the input'],
    expectUngrounded: [],
    expectRise: true,
  },
];

function shareOf(text: string, evidence: Parameters<typeof collectRunEvidence>[0]): { share: number; total: number } {
  const report = gradeClaims(text, collectRunEvidence(evidence));
  return { share: report.groundedShare, total: report.counts.total };
}

function factsSurvive(text: string, probe: Probe): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  for (const m of probe.mustMention) if (!text.includes(m)) problems.push(`lost fact: ${m}`);
  return { ok: problems.length === 0, problems };
}

/** AFTER-only: claims with no source in the run must be graded ungrounded AND
 *  visibly marked in the output text. */
function ungroundedMarked(afterText: string, probe: Probe): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const graded = gradeClaims(afterText, collectRunEvidence(probe.evidence));
  for (const u of probe.expectUngrounded) {
    const claim = graded.claims.find((c) => c.claim.includes(u));
    if (!claim) problems.push(`claim not graded: ${u}`);
    else if (claim.grade !== 'ungrounded') problems.push(`claim should be ungrounded but is ${claim.grade}: ${u}`);
    else if (!afterText.includes('[ungrounded]') || !afterText.includes(u)) problems.push(`ungrounded claim not visibly marked: ${u}`);
  }
  return { ok: problems.length === 0, problems };
}

describe('probe set: user-verifiable claims per response (before vs after the default output path)', () => {
  it('rises on the probe set with no task-success regression', () => {
    let beforeClaims = 0;
    let afterGrounded = 0;
    let beforeGrounded = 0;
    let afterClaims = 0;
    let successBefore = 0;
    let successAfter = 0;
    const lines: string[] = [];
    for (const probe of PROBES) {
      const before = shareOf(probe.answer, blankEvidence());
      const afterReport = gradeClaims(probe.answer, collectRunEvidence(probe.evidence));
      const afterText = appendEvidenceGrade(probe.answer, afterReport);
      const after = { share: afterReport.groundedShare, total: afterReport.counts.total };
      beforeClaims += before.total;
      afterClaims += after.total;
      beforeGrounded += before.share * before.total;
      afterGrounded += after.share * after.total;
      const factsBefore = factsSurvive(probe.answer, probe);
      const factsAfter = factsSurvive(afterText, probe);
      const marked = ungroundedMarked(afterText, probe);
      if (factsBefore.ok) successBefore++;
      if (factsAfter.ok && marked.ok) successAfter++;
      if (probe.expectRise) {
        expect(after.share, `${probe.name}: share must rise`).toBeGreaterThan(before.share);
      } else {
        expect(after.share, `${probe.name}: share must not fall`).toBeGreaterThanOrEqual(before.share);
      }
      // The graded output must still convey every fact (append-only).
      expect(factsAfter.problems, `${probe.name}: facts after grading`).toEqual([]);
      // Ungrounded claims known to the probe are visibly marked after grading.
      expect(marked.problems, `${probe.name}: ungrounded marking`).toEqual([]);
      expect(afterReport.counts.total, `${probe.name}: claim count stable`).toBe(extractClaims(probe.answer).length);
      lines.push(
        `${probe.shape.padEnd(22)} ${probe.name}\n` +
        `  before: ${Math.round(before.share * 100)}% grounded (${Math.round(before.share * before.total)}/${before.total}) | ` +
        `after: ${Math.round(after.share * 100)}% grounded (${Math.round(after.share * after.total)}/${after.total}) | ` +
        `task success: before ${factsBefore.ok ? 'ok' : `FAIL ${factsBefore.problems.join('; ')}`}, after ${(factsAfter.ok && marked.ok) ? 'ok' : `FAIL ${[...factsAfter.problems, ...marked.problems].join('; ')}`}`,
      );
    }
    const beforePct = Math.round((beforeGrounded / beforeClaims) * 100);
    const afterPct = Math.round((afterGrounded / afterClaims) * 100);
    lines.push(`PROBE TOTAL: before ${beforePct}% (${beforeGrounded}/${beforeClaims}) -> after ${afterPct}% (${afterGrounded}/${afterClaims}); task success ${successBefore}/${PROBES.length} -> ${successAfter}/${PROBES.length}`);
    console.log(`\n[item 17 probe set]\n${lines.join('\n')}\n`);
    expect(afterPct, 'the grounded share must rise on the probe set').toBeGreaterThan(beforePct);
    expect(successAfter, 'no task-success regression on the probes').toBe(PROBES.length);
    expect(successBefore, 'the probes themselves are answerable').toBe(PROBES.length);
  });

  it('grading never changes which facts the answer conveys (no information dropped)', () => {
    for (const probe of PROBES) {
      const report = gradeClaims(probe.answer, collectRunEvidence(probe.evidence));
      const out = appendEvidenceGrade(probe.answer, report);
      expect(out.startsWith(probe.answer)).toBe(true); // append-only: prose untouched
    }
  });
});
