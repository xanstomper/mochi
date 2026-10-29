// Evidence-graded output (queue item 17): the claim-grading seam.
//
// The user-facing gap: Mochi's answers assert things the user cannot check.
// This module is the seam that makes evidence the DEFAULT — every substantive
// claim in a finished response is classified as:
//
//   'cited'        — carries a file:line (or file) citation into the repo.
//                    In-text `path:line` refs are VERIFIED on disk (file
//                    exists inside cwd, line in bounds); a bare file mention
//                    is grounded only when THIS run actually read or wrote
//                    the file (run-activity citation, op recorded).
//   'test-backed'  — names a test/command that actually ran in this run
//                    (from the run's command:completed events), matched in
//                    the asserted direction (pass-language → green pool,
//                    fail-language → failed pool); a generic "tests pass"
//                    claim needs the run's verification evidence behind it.
//   'ungrounded'   — no source for it in this run. Never silently asserted
//                    as fact: the default output path marks it.
//
// THE NO-FABRICATION RULE (pinned by tests): the seam never invents evidence.
// A `path:line` that does not resolve on disk is NOT upgraded — the claim
// stays ungrounded and the bad ref is called out by name. A test named but
// never run stays ungrounded. A claim with no source in the run is never
// assigned a citation. There are no model round-trips anywhere here: the
// whole seam is pure + sync + bounded, so grading a summary costs nothing.
//
// The run record is where the grade lives (AgentResult.claimGrade + the
// summary:rendered event), not just in prose.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export type ClaimGrade = 'cited' | 'test-backed' | 'ungrounded';

/** What THIS run actually observed — the ONLY grounding source the seam will
 *  use. Built by collectRunEvidence() from run state; never synthesized. */
export interface RunEvidenceInput {
  /** Repo root used to resolve + verify on-disk citations. */
  cwd: string;
  /** Absolute or repo-relative paths this run modified (write/edit/delete). */
  filesModified?: readonly string[];
  /** Paths this run read (read-cache keys; absolute or relative). */
  filesRead?: readonly string[];
  /** Commands that completed with exit 0 during this run. */
  greenCommands?: readonly string[];
  /** Commands that completed with a nonzero exit (or failed outright). */
  failedCommands?: readonly string[];
  /** The completion gate's structured verdict (VerificationStatus), when one
   *  exists. Backs generic "the tests pass"-style claims. */
  verifyStatus?: string | null;
}

export interface RunEvidenceIndex {
  cwd: string;
  /** Repo-relative paths touched this run (read or modified). */
  touchedFiles: ReadonlySet<string>;
  /** Repo-relative paths this run wrote/edited. */
  modifiedFiles: ReadonlySet<string>;
  greenCommands: readonly string[];
  failedCommands: readonly string[];
  verifyStatus: string | null;
}

export interface ClaimCitation {
  /** Repo-relative path. */
  path: string;
  /** Present only for in-text `path:line` refs that resolve on disk. A
   *  run-activity citation deliberately has NO line: the run observed the
   *  file, not a line — inventing a line would be fabrication. */
  line?: number;
  /** 'in-text' = the response itself carried `path:line` (verified on disk);
   *  'run-activity' = the response named a file this run read/modified. */
  via: 'in-text' | 'run-activity';
  /** For run-activity citations: how the run touched the file. */
  op?: 'modified' | 'read';
}

export interface GradedClaim {
  /** The substantive claim (trimmed, capped). */
  claim: string;
  grade: ClaimGrade;
  /** Set only for 'cited'. */
  citation?: ClaimCitation;
  /** Set only for 'test-backed': "✓ <command>" or "✗ <command>" actually
   *  observed this run, or "verify gate: <STATUS>". */
  testRef?: string;
  /** For 'ungrounded': why, so the output can say it in one line. */
  note?: string;
}

export interface ClaimGradeReport {
  claims: GradedClaim[];
  counts: { total: number; cited: number; testBacked: number; ungrounded: number };
  /** (cited + testBacked) / total — the share of substantive claims a user
   *  can verify. 0 when there are no substantive claims. */
  groundedShare: number;
}

// ── Evidence collection ─────────────────────────────────────────────────────

const MAX_COMMANDS = 24;

function toRepoRel(p: string, cwd: string): string | null {
  if (!p) return null;
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null; // outside the repo
  return rel.split('\\').join('/');
}

/** Normalize raw run state into the evidence index. Pure bookkeeping: dedupe,
 *  relativize, cap. Never touches disk and never invents entries. */
export function collectRunEvidence(input: RunEvidenceInput): RunEvidenceIndex {
  const touched = new Set<string>();
  const modified = new Set<string>();
  for (const p of input.filesModified ?? []) {
    const rel = toRepoRel(p, input.cwd);
    if (rel) { modified.add(rel); touched.add(rel); }
  }
  for (const p of input.filesRead ?? []) {
    const rel = toRepoRel(p, input.cwd);
    if (rel) touched.add(rel);
  }
  const cap = (cmds?: readonly string[]): string[] =>
    Array.from(new Set((cmds ?? []).map((c) => c.trim()).filter(Boolean))).slice(0, MAX_COMMANDS);
  return {
    cwd: input.cwd,
    touchedFiles: touched,
    modifiedFiles: modified,
    greenCommands: cap(input.greenCommands),
    failedCommands: cap(input.failedCommands),
    verifyStatus: input.verifyStatus ?? null,
  };
}

// ── Claim extraction ────────────────────────────────────────────────────────

/** A sentence carrying a verifiable assertion. Deliberately a broad,
 *  deterministic cue list — false positives just get graded ungrounded
 *  (honest), false negatives would silently assert. */
const ASSERTION_CUE = new RegExp(
  '\\b(?:is|are|was|were|has|have|had|will|would|can|cannot|now|adds?|added|removes?|removed' +
  '|deletes?|deleted|creates?|created|writes?|wrote|fixes?|fixed|updates?|updated|changes?|changed' +
  '|modif(?:ies|ied|y)|implements?|implemented|refactors?|refactored|extends?|extended' +
  '|passes?|passed|fails?|failed|failing|works?|working|supports?|supported|handles?|handled' +
  '|uses?|used|using|includes?|included|contains?|returns?|returned|throws?|threw|emits?|emitted' +
  '|breaks?|broke|broken|verifies?|verified|tests?|tested|exists?|resolves?|resolved|covers?|covered' +
  '|defaults?|gates?|gated|skips?|skipped|lands?|landed|exposes?|exposed|attaches?|attached' +
  '|marks?|marked|tracks?|tracked|introduces?|introduced|improves?|improved)\\b',
  'i',
);

/** Conversational meta/noise openers — not claims about the world. */
const META_OPENER = /^(?:here(?:'s| is| are)\b|let me\b|i'?ll\b|i'?ve\b|i'?m\b|we'?ll\b|we'?ve\b|note that\b|please\b|thanks\b|hello\b|hi\b|sure\b|got it\b|in summary\b|overall,?\s|tl;dr\b|next steps?\b|how to verify\b)/i;

/** Any line starting with a check glyph IS a verification claim. */
const RESULT_LINE = /^[✓✗]/;

/** `path.ext:line` — the shape of an in-text citation (requires a dotted
 *  extension so `node:fs` or `12:34` never match). */
const PATHLINE_REF_SRC = '([A-Za-z0-9_][\\w./-]*\\.[A-Za-z]{1,8}):(\\d{1,6})';
const PATHLINE_TEST = new RegExp(PATHLINE_REF_SRC);
const PATHLINE_SCAN = new RegExp(PATHLINE_REF_SRC, 'g');

/** A bare dotted file path (no line). */
const BARE_PATH_REF_SRC = '(?:^|[\\s(`[>\'"])([A-Za-z0-9_][\\w./-]*\\.[A-Za-z]{1,8})(?=[\\s)\\]`\'.,:!?]|$)';
const BARE_PATH_TEST = new RegExp(BARE_PATH_REF_SRC);
const BARE_PATH_SCAN = new RegExp(BARE_PATH_REF_SRC, 'g');

/** Global regexes carry lastIndex across .test()/matchAll calls; every scan
 *  goes through here so each call starts (and ends) at a clean state. */
function scanGlobal(re: RegExp, s: string): RegExpMatchArray[] {
  re.lastIndex = 0;
  const out = Array.from(s.matchAll(re));
  re.lastIndex = 0;
  return out;
}

const MAX_CLAIM_LEN = 200;

/** Split one line into sentence-ish units. The ender must be followed by
 *  whitespace + a sentence starter, so `loop.ts:9612` (dot followed by 't')
 *  and `v1.2.3` (no space after the dots) never split. */
function splitSentences(line: string): string[] {
  return line
    .split(/(?<=[.!?])\s+(?=[A-Z`*>"'\-\d])/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Extract the substantive claims from a response. Pure + deterministic:
 *  line-based (code fences, headings, and bare bullets are skipped), then
 *  sentence-split within a line. Duplicate sentences collapse. */
export function extractClaims(text: string): string[] {
  const claims: string[] = [];
  const seen = new Set<string>();
  let inFence = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence || !line) continue;
    if (/^#{1,6}\s/.test(line)) continue; // heading
    if (/^(?:[-*+]|\d+\.)\s*$/.test(line)) continue; // bare bullet marker
    if (/^(?:-{3,}|={3,}|\*{3,})$/.test(line)) continue; // horizontal rule
    for (const sentence of splitSentences(line)) {
      if (!isSubstantive(sentence)) continue;
      const key = sentence.toLowerCase().replace(/[^a-z0-9 ]/g, '');
      if (seen.has(key)) continue;
      seen.add(key);
      claims.push(sentence.length > MAX_CLAIM_LEN ? `${sentence.slice(0, MAX_CLAIM_LEN - 1)}…` : sentence);
    }
  }
  return claims;
}

function isSubstantive(sentence: string): boolean {
  if (sentence.length < 15 || !sentence.includes(' ')) return false;
  if (sentence.endsWith('?')) return false;
  if (META_OPENER.test(sentence)) return false;
  return RESULT_LINE.test(sentence) || ASSERTION_CUE.test(sentence)
    || PATHLINE_TEST.test(sentence) || BARE_PATH_TEST.test(sentence);
}

// ── Grounding checks ────────────────────────────────────────────────────────

/** Files larger than this are not line-verified (we refuse to confirm a line
 *  we did not read — no blind trust, no fabrication). */
const MAX_LINECHECK_BYTES = 8 * 1024 * 1024;

/** Verify an in-text `path:line` ref against disk: the file must exist inside
 *  the repo and the line must be in bounds. Anything else → null (the ref is
 *  NOT counted — this is the anti-fabrication gate on citations). */
function resolveCitation(pathPart: string, lineStr: string, cwd: string): ClaimCitation | null {
  const rel = toRepoRel(pathPart, cwd);
  if (!rel) return null;
  const abs = resolve(cwd, rel);
  if (!existsSync(abs)) return null;
  let size = 0;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    size = st.size;
  } catch { return null; }
  const line = Number.parseInt(lineStr, 10);
  if (!Number.isFinite(line) || line < 1) return null;
  if (size > MAX_LINECHECK_BYTES) return null;
  try {
    const lineCount = readFileSync(abs, 'utf8').split('\n').length;
    if (line > lineCount) return null;
  } catch { return null; }
  return { path: rel, line, via: 'in-text' };
}

const FAIL_LANGUAGE = /\bfail(?:s|ed|ing|ure)?\b|\bbreaks?\b|\bbroken\b|\berrors?\b|\bthrows?\b/i;
/** A specific test/command named in a claim (`npm run typecheck`,
 *  `src/x.test.ts`, `tsc --noEmit`, `bun test …`). */
const SPECIFIC_TEST_REF = /(?:\b(?:npm(?: run)?|npx|pnpm|bun|yarn|node|make|cargo|pytest|vitest|jest|tsc|eslint|golang|go)\b(?:\s+[\w@:./\\-]+)+)|(?:\b[\w./\\-]+\.(?:test|spec)\.[tj]sx?\b)|(?:\btests?\/[\w./\\-]+\b)/gi;
/** Suite-level language with no specific target ("all tests pass"). */
const GENERIC_TEST_LANGUAGE = /\b(?:tests?|test suite|unit tests?|integration tests?|typecheck|type-check|lint|build|verification)\b/i;

const RUNNER_STOP_TOKENS = new Set(['npm', 'npx', 'pnpm', 'bun', 'yarn', 'node', 'make', 'run', 'exec', 'sh', 'bin', 'and', 'the', 'for', 'with', 'this', 'that', 'test', 'tests', 'suite']);

function normSlash(s: string): string {
  return s.toLowerCase().split('\\').join('/');
}

/** Does `ref` (a specific test/command token from a claim) appear in `cmd`?
 *  Token-based so `tsc --noEmit` matches `./node_modules/.bin/tsc --noEmit`. */
function refInCommand(ref: string, cmd: string): boolean {
  const c = normSlash(cmd);
  const tokens = normSlash(ref).split(/[\s'"`]+/).filter((t) => t.length >= 3 && !RUNNER_STOP_TOKENS.has(t));
  if (tokens.length === 0) return false;
  return tokens.some((t) => c.includes(t));
}

interface TestMatch { ref: string; pool: 'green' | 'failed' }

/** Match a claim's test/command language against the commands THIS run
 *  actually executed. Direction-aware: pass-language checks the green pool,
 *  fail-language checks the failed pool — a "passes" claim is never backed
 *  by a command that failed. */
function matchTestRef(sentence: string, evidence: RunEvidenceIndex): TestMatch | null {
  const wantsFailure = FAIL_LANGUAGE.test(sentence);
  const pool = wantsFailure ? evidence.failedCommands : evidence.greenCommands;
  const otherPool = wantsFailure ? evidence.greenCommands : evidence.failedCommands;
  const refs = Array.from(scanGlobal(SPECIFIC_TEST_REF, sentence), (m) => m[0].trim());
  if (refs.length > 0) {
    for (const ref of refs) {
      for (const cmd of pool) {
        if (refInCommand(ref, cmd)) return { ref: `${wantsFailure ? '✗' : '✓'} ${cmd}`, pool: wantsFailure ? 'failed' : 'green' };
      }
    }
    // A SPECIFIC name with no matching run observation is never backed by a
    // different command that happened to run — that would be fabrication by
    // substitution. The claim stays ungrounded.
    return null;
  }
  if (!GENERIC_TEST_LANGUAGE.test(sentence)) return null;
  if (pool.length > 0) return { ref: `${wantsFailure ? '✗' : '✓'} ${pool[0]}`, pool: wantsFailure ? 'failed' : 'green' };
  const statusOk = evidence.verifyStatus === 'PASS' || evidence.verifyStatus === 'FLAKY-PASS';
  const statusFail = evidence.verifyStatus === 'FAIL';
  if (!wantsFailure && statusOk && otherPool.length === 0) return { ref: `verify gate: ${evidence.verifyStatus}`, pool: 'green' };
  if (wantsFailure && statusFail) return { ref: `verify gate: ${evidence.verifyStatus}`, pool: 'failed' };
  return null;
}

// ── Grading ─────────────────────────────────────────────────────────────────

function gradeOne(sentence: string, evidence: RunEvidenceIndex): GradedClaim {
  // 1. In-text `path:line` — verified on disk. First resolving ref wins.
  //    (A sentence with several refs is graded by its strongest evidence.)
  const pathlineRefs = scanGlobal(PATHLINE_SCAN, sentence);
  for (const m of pathlineRefs) {
    const citation = resolveCitation(m[1], m[2], evidence.cwd);
    if (citation) return { claim: sentence, grade: 'cited', citation };
  }
  // 2. A named test/command that actually ran in this run.
  const test = matchTestRef(sentence, evidence);
  if (test) return { claim: sentence, grade: 'test-backed', testRef: test.ref };
  // 3. An in-text citation that does NOT resolve is surfaced by name, never
  //    silently upgraded and never silently dropped (no-fabrication rule).
  if (pathlineRefs.length > 0) {
    const bad = pathlineRefs.map((m) => `${m[1]}:${m[2]}`).join(', ');
    return { claim: sentence, grade: 'ungrounded', note: `citation ${bad} does not resolve in this repo` };
  }
  // 4. A bare file path this run actually read or wrote → run-activity
  //    citation (file-level; the run observed the file, not a line).
  for (const m of scanGlobal(BARE_PATH_SCAN, sentence)) {
    const rel = toRepoRel(m[1], evidence.cwd);
    if (!rel) continue;
    if (evidence.modifiedFiles.has(rel)) {
      return { claim: sentence, grade: 'cited', citation: { path: rel, via: 'run-activity', op: 'modified' } };
    }
    if (evidence.touchedFiles.has(rel)) {
      return { claim: sentence, grade: 'cited', citation: { path: rel, via: 'run-activity', op: 'read' } };
    }
  }
  // 5. No source anywhere in this run → visibly ungrounded.
  return { claim: sentence, grade: 'ungrounded', note: 'no file or test source in this run' };
}

/** Grade every substantive claim in `text` against the run's evidence. */
export function gradeClaims(text: string, evidence: RunEvidenceIndex): ClaimGradeReport {
  const claims = extractClaims(text).map((c) => gradeOne(c, evidence));
  const counts = { total: claims.length, cited: 0, testBacked: 0, ungrounded: 0 };
  for (const c of claims) {
    if (c.grade === 'cited') counts.cited++;
    else if (c.grade === 'test-backed') counts.testBacked++;
    else counts.ungrounded++;
  }
  return {
    claims,
    counts,
    groundedShare: counts.total === 0 ? 0 : (counts.cited + counts.testBacked) / counts.total,
  };
}

// ── Default output path ─────────────────────────────────────────────────────

const MAX_FOOTER_PER_GRADE = 5;
const MAX_FOOTER_UNGROUNDED = 3;

const q = (s: string): string => `"${s}"`;
const citeStr = (c: ClaimCitation): string =>
  `${c.path}${c.line ? `:${c.line}` : ''}${c.via === 'run-activity' && c.op ? ` (${c.op} this run)` : ''}`;

/** The visible evidence block for a graded response. Null when there is
 *  nothing to grade (no footer is appended — no behavior change). */
export function renderEvidenceFooter(report: ClaimGradeReport): string | null {
  if (report.counts.total === 0) return null;
  const { cited, testBacked, ungrounded, total } = report.counts;
  const pct = Math.round(((cited + testBacked) / total) * 100);
  const lines = [
    `Evidence: ${cited + testBacked}/${total} claims verified (${pct}%) — ${cited} cited, ${testBacked} test-backed; ${ungrounded} ungrounded.`,
  ];
  const citedClaims = report.claims.filter((c) => c.grade === 'cited' && c.citation);
  const tbClaims = report.claims.filter((c) => c.grade === 'test-backed' && c.testRef);
  const ugClaims = report.claims.filter((c) => c.grade === 'ungrounded');
  for (const c of citedClaims.slice(0, MAX_FOOTER_PER_GRADE)) lines.push(`- [cited] ${q(c.claim)} → ${citeStr(c.citation!)}`);
  if (citedClaims.length > MAX_FOOTER_PER_GRADE) lines.push(`- (+${citedClaims.length - MAX_FOOTER_PER_GRADE} more cited)`);
  for (const c of tbClaims.slice(0, MAX_FOOTER_PER_GRADE)) lines.push(`- [test-backed] ${q(c.claim)} → ${c.testRef}`);
  if (tbClaims.length > MAX_FOOTER_PER_GRADE) lines.push(`- (+${tbClaims.length - MAX_FOOTER_PER_GRADE} more test-backed)`);
  for (const c of ugClaims.slice(0, MAX_FOOTER_UNGROUNDED)) lines.push(`- [ungrounded] ${q(c.claim)}${c.note ? ` (${c.note})` : ''}`);
  if (ugClaims.length > MAX_FOOTER_UNGROUNDED) lines.push(`- (+${ugClaims.length - MAX_FOOTER_UNGROUNDED} more ungrounded)`);
  return lines.join('\n');
}

/** Append the evidence block to the user-facing summary. Claims already
 *  carrying their evidence are untouched in the prose; the block only ADDS
 *  the checkable references and the visible ungrounded markers. */
export function appendEvidenceGrade(text: string, report: ClaimGradeReport): string {
  const footer = renderEvidenceFooter(report);
  return footer ? `${text}\n\n${footer}` : text;
}

/** The same evidence block as structured summary-card items (one per line of
 *  the footer), so the run's summary document carries the grade too —
 *  structurally compatible with SummaryItem without importing the engine. */
export function evidenceFooterItems(report: ClaimGradeReport): Array<{ text: string; priority: 'P1' | 'P2' }> {
  const footer = renderEvidenceFooter(report);
  if (!footer) return [];
  return footer.split('\n').map((line, i) => ({ text: line, priority: i === 0 ? 'P1' as const : 'P2' as const }));
}
