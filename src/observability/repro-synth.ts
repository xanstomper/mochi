// Repro synthesis — turn a raw failure (test output, stack trace, error
// text) into a MINIMAL, VALIDATED reproduction, automatically.
//
// Why: the verifier gate is reproduce-first, but until now the model had to
// hand-write the repro — hit or miss, and an unvalidated "repro" is just a
// claim. This module industrialises it (delta debugging applied to agent
// traces):
//
//   1. EXTRACT a candidate repro from the failure material: isolate the
//      failing test file/case, or reduce a script error to its entry call.
//   2. SHRINK the candidate's input (fixture data, file contents, args)
//      with ddmin, using "still fails with the same signature" as the
//      oracle. The result is 1-minimal at the shrink granularity — never
//      claimed globally minimal.
//   3. VALIDATE by execution, both directions: the repro must FAIL on the
//      pre-fix tree and, when the run produced a fix, PASS on the fixed
//      tree. A failure that cannot be reproduced yields an explicit
//      NO-REPRO outcome with diagnostics — never a fabricated script.
//   4. A both-directions-validated repro is a free FAIL_TO_PASS pair: it is
//      persisted in the curriculum's shape (see ReproPair) for the failure
//      curriculum / Phase-2 exporters, under the same eval-blocklist guard
//      as every other curriculum input (curriculum.ts hard rule 1).
//
// All shrinking and fixed-tree validation happen in isolated scratch
// copies (curriculum.createIsolatedCopy) — the user's real tree is never
// mutated by the shrinker. The single exception is `inPlace` mode (used by
// the agent loop's repro gate): one read-only confirmation run in the real
// tree, no shrinking, no pair emission.
//
// This module extends the autopsy subsystem (observability/autopsy.ts):
// synthesis results attach to the task's Autopsy via attachRepro there.

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  assertCurriculumTargetAllowed,
  createIsolatedCopy,
  createShellTestRunner,
  CurriculumError,
  type TestRunOutcome,
} from '../curriculum/curriculum.js';
import { classifyFailure, type FailureKind } from './diagnosis.js';
import { mochiStateDir } from '../core/mochi-dir.js';

// ---------------------------------------------------------------------------
// Inputs / outputs
// ---------------------------------------------------------------------------

export interface FailureRecord {
  /** Repo root the failure belongs to. Only ever read (scratch mode copies
   *  it; in-place mode runs read-only commands in it). */
  repoRoot: string;
  /** Raw failure material: failing test output, a stack trace, error text,
   *  or the task text that describes the failure. */
  text: string;
  source: 'test-output' | 'stack-trace' | 'error-text' | 'task-text';
  /** The repo's test command (e.g. "npx vitest run"), when the failure is
   *  test-shaped — used to build the file/case-scoped candidate command. */
  testCommand?: string;
  /** The command that produced the failure, for script errors
   *  (e.g. "node tools/report.mjs"). */
  entryCommand?: string;
  /** Post-fix contents of the files the run changed, keyed by repo-relative
   *  posix path. When present, the fixed direction is validated too. */
  fixedFiles?: Record<string, string>;
  /** Curriculum-guard provenance (eval-blocklist discipline). */
  instanceId?: string;
  repo?: string;
  baseCommit?: string;
  blocklistPaths?: string[];
  taskId?: string;
}

export interface ReproCandidate {
  kind: 'test' | 'script';
  /** Command run from the tree root. */
  command: string;
  /** Files materialized into the tree before running (synthesised scripts);
   *  empty when the entry/test already exists in the tree. */
  files: Array<{ path: string; content: string }>;
  /** Shrinkable input: a data file the candidate reads, whose contents the
   *  delta debugger minimises. Absent when nothing shrinkable was found. */
  shrinkTarget?: { path: string; content: string };
  /** Repo-relative posix path of the implicated file (the failing test, or
   *  the top stack frame inside the tree). This is the guard target. */
  implicatedFile?: string;
  /** How the candidate was derived, in one line — provenance for humans. */
  derivation: string;
}

export interface ShrinkReport {
  target: string;
  granularity: 'json-elements' | 'lines';
  beforeBytes: number;
  afterBytes: number;
  beforeUnits: number;
  afterUnits: number;
  oracleCalls: number;
  /** True only when every remaining unit was individually proven
   *  load-bearing (removing it makes the failure disappear). */
  oneMinimal: boolean;
}

export interface ReproValidation {
  baseExitCode: number | null;
  baseSignatureMatched: boolean;
  fixedExitCode?: number | null;
  fixedPassed?: boolean;
  signature?: string;
}

export type ReproResult =
  | {
      outcome: 'validated';
      candidate: ReproCandidate;
      validation: ReproValidation;
      shrink?: ShrinkReport;
      /** Set only when BOTH directions validated and the pair was saved. */
      pair?: ReproPair;
      pairPath?: string;
    }
  | { outcome: 'no-repro'; stage: 'extract' | 'base' | 'shrink'; diagnostics: string }
  | { outcome: 'refused'; reason: string };

export interface SynthesizeOptions {
  /** Where isolated copies live. Default: OS temp dir. Must be outside
   *  repoRoot (enforced by createIsolatedCopy). */
  scratchBase?: string;
  /** Gate mode: a single confirmation run in the real tree. No shrinking,
   *  no fixed-tree validation, no pair — candidates that would need files
   *  materialized are reported no-repro at the extract stage instead. */
  inPlace?: boolean;
  /** Delta-debugger budget: max oracle (repro execution) calls. */
  maxOracleCalls?: number;
  /** Per-execution timeout. */
  timeoutMs?: number;
  /** Where the FAIL_TO_PASS pair is written. Default:
   *  <repoRoot>/.mochi/repro-pairs. Pairs are only written on full
   *  both-directions validation. */
  outDir?: string;
  now?: Date;
}

/** Kill-switch, same convention as the repro-first gate itself
 *  (MOCHI_REPRO_FIRST=0) and the discipline layer (MOCHI_DISCIPLINE=0). */
export function reproSynthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MOCHI_REPRO_SYNTH !== '0';
}

// ---------------------------------------------------------------------------
// Failure signature — the oracle's fingerprint
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Remove a tree-root prefix (and its trailing separator) so a signature
 *  extracted under one root can match output produced under another
 *  (scratch copies live elsewhere). */
function normalizeForMatch(s: string, root: string): string {
  let out = stripAnsi(s);
  if (root) out = out.split(root).join('').split(root.split(sep).join('/')).join('');
  return out;
}

/** Extract the failure's headline: the first strong error/assertion line.
 *  Returns undefined when the text carries no recognisable headline — the
 *  oracle then falls back to exit-code-only matching (weaker, and the
 *  validation record says so via baseSignatureMatched=false). */
export function failureSignature(text: string, repoRoot = ''): string | undefined {
  const clean = normalizeForMatch(text, repoRoot);
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  const patterns: RegExp[] = [
    /AssertionError:.*/,
    /(?:TypeError|ReferenceError|RangeError|SyntaxError|EvalError|URIError): .*/,
    /^Error: .*/,
    /expected .{1,120} to (?:be|equal|deep equal|strictly equal) .{1,120}/,
    /^FAIL\s+.+/,
  ];
  for (const re of patterns) {
    for (const line of lines) {
      const m = line.match(re);
      if (m) return m[0].replace(/:\d+:\d+/g, '').slice(0, 200);
    }
  }
  return undefined;
}

function outputMatches(output: string, signature: string | undefined, workdir: string): boolean {
  if (!signature) return true; // exit code alone decides (caller checks it)
  return normalizeForMatch(output, workdir).includes(signature);
}

// ---------------------------------------------------------------------------
// Extraction — failure material → candidate repro
// ---------------------------------------------------------------------------

const TEST_FILE_RE = /(?:^|[\s"'(])((?:[\w@.+-]+\/)*[\w.+-]+\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))/gm;
const ANY_CODE_FILE_RE = /(?:^|[\s"'(])((?:[\w@.+-]+\/)*[\w.+-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))/;
/** Stack-frame paths: relative (`src/x.mjs:1:2`) or absolute / file://
 *  (`at fn (file:///repo/src/x.mjs:1:2)`) — Node prints the latter for ESM. */
const FRAME_PATH_RE = /(?:file:\/\/)?(\/?(?:[\w@.+-]+\/)+[\w.+-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)):\d+:\d+/g;
const ABS_TEST_FILE_RE = /(?:file:\/\/)?(\/(?:[\w@.+-]+\/)+[\w.+-]+\.(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))/g;
const DATA_REF_RE = /readFileSync\(\s*['"`]([^'"`]+)['"`]/g;

/** Normalize a path found in failure text (absolute or relative) to a
 *  repo-relative posix path, or undefined when it lives outside the tree. */
function toTreeRel(root: string, p: string): string | undefined {
  const rel = p.startsWith('/') ? relative(root, p).split(sep).join('/') : p.replace(/^\.\//, '');
  if (!rel || rel.startsWith('..') || rel.includes('node_modules')) return undefined;
  return rel;
}

function posixRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

function firstExisting(root: string, candidates: string[]): string | undefined {
  for (const c of candidates) {
    const rel = c.replace(/^\.\//, '');
    if (!rel.startsWith('..') && existsSync(resolve(root, rel))) return rel;
  }
  return undefined;
}

/** A test/data file the candidate's code reads — the shrinkable input. */
function findShrinkTarget(root: string, codeFileRel: string): ReproCandidate['shrinkTarget'] {
  try {
    const content = readFileSync(resolve(root, codeFileRel), 'utf8');
    for (const m of content.matchAll(DATA_REF_RE)) {
      const ref = m[1];
      if (ref.includes('${') || ref.startsWith('/')) continue;
      // Code reads data via paths resolved against the file's own dir
      // (__dirname-style) or against the process cwd (repo root when the
      // harness runs it) — accept whichever actually exists.
      for (const base of [dirname(codeFileRel), '.']) {
        const abs = resolve(root, base, ref);
        const rel = posixRel(root, abs);
        if (!rel.startsWith('..') && existsSync(abs)) {
          return { path: rel, content: readFileSync(abs, 'utf8') };
        }
      }
    }
  } catch { /* unreadable code file — no shrink target */ }
  return undefined;
}

function scopedTestCommand(testCommand: string | undefined, file: string, testName?: string): string {
  const tc = (testCommand ?? '').trim();
  if (/vitest/.test(tc)) {
    const base = tc.replace(/\s+run\s*$/, '');
    return `${base} run ${file}${testName ? ` -t ${JSON.stringify(testName)}` : ''}`;
  }
  if (/jest/.test(tc)) return `npx jest ${file}${testName ? ` -t ${JSON.stringify(testName)}` : ''}`;
  if (/node\s+--test/.test(tc)) return `node --test ${file}`;
  // Unknown runner shape: a test file that runs standalone is the most
  // portable candidate (self-executing test scripts are a common repo
  // convention, and vitest/jest files also execute under plain node in
  // node:test-style repos). The base validation decides if it reproduces.
  return `node ${file}`;
}

/** Derive a candidate repro from failure material. Pure (reads the tree,
 *  executes nothing) so it can be unit-tested and reused by the gate. */
export function extractCandidate(
  record: FailureRecord,
): { candidate: ReproCandidate } | { reason: string } {
  const root = resolve(record.repoRoot);
  const text = stripAnsi(record.text);

  // --- test-shaped: a test file is named in the output -------------------
  const testFiles: string[] = [];
  for (const m of text.matchAll(TEST_FILE_RE)) testFiles.push(m[1]);
  for (const m of text.matchAll(ABS_TEST_FILE_RE)) {
    const rel = toTreeRel(root, m[1]);
    if (rel) testFiles.push(rel);
  }
  const testFile = firstExisting(root, testFiles);
  if (testFile) {
    let testName: string | undefined;
    for (const line of text.split('\n')) {
      const m = line.match(/[×✗●]\s+(.+?)\s*$/) || line.match(/FAIL\s+\S+\s+>\s+(.+?)\s*$/);
      if (m) { testName = m[1].trim(); break; }
    }
    return {
      candidate: {
        kind: 'test',
        command: scopedTestCommand(record.testCommand, testFile, testName),
        files: [],
        shrinkTarget: findShrinkTarget(root, testFile),
        implicatedFile: testFile,
        derivation: `isolated failing test file ${testFile}${testName ? ` (case "${testName}")` : ''} from the failure output`,
      },
    };
  }

  // --- script-shaped: an entry command and/or a stack trace ---------------
  const inTreeFrames: string[] = [];
  for (const m of text.matchAll(FRAME_PATH_RE)) {
    const rel = toTreeRel(root, m[1]);
    if (rel) inTreeFrames.push(rel);
  }
  const stackFile = firstExisting(root, inTreeFrames);

  let entryFile: string | undefined;
  let entryCommand: string | undefined;
  const cmdText = record.entryCommand
    ?? text.split('\n').map((l) => l.trim()).find((l) => /^(?:\$\s*)?node\s+\S+/.test(l))?.replace(/^\$\s*/, '');
  if (cmdText) {
    const m = cmdText.match(ANY_CODE_FILE_RE);
    if (m) {
      const rel = firstExisting(root, [m[1]]);
      if (rel) { entryFile = rel; entryCommand = cmdText; }
    }
  }
  if (!entryFile && stackFile) {
    // The entry is the LAST in-tree frame (the outermost call); the throw
    // site is the first. Without a recorded command, run the outermost
    // frame's file directly.
    const outermost = firstExisting(root, [...inTreeFrames].reverse());
    if (outermost) { entryFile = outermost; entryCommand = `node ${outermost}`; }
  }
  if (entryFile && entryCommand) {
    return {
      candidate: {
        kind: 'script',
        command: entryCommand,
        files: [],
        shrinkTarget: findShrinkTarget(root, entryFile),
        implicatedFile: stackFile ?? entryFile,
        derivation: `entry call \`${entryCommand}\` reduced from the stack trace${stackFile ? ` (throw site ${stackFile})` : ''}`,
      },
    };
  }

  return { reason: 'no test file, entry command, or in-tree stack frame could be extracted from the failure material' };
}

// ---------------------------------------------------------------------------
// Delta debugging — ddmin over lines / JSON-array elements
// ---------------------------------------------------------------------------

interface ShrinkUnits { units: string[]; granularity: ShrinkReport['granularity']; render: (units: string[]) => string }

function splitUnits(content: string): ShrinkUnits | undefined {
  const trimmed = content.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown[];
      if (Array.isArray(arr) && arr.length >= 2) {
        return {
          units: arr.map((el) => JSON.stringify(el)),
          granularity: 'json-elements',
          render: (units) => `[\n${units.join(',\n')}\n]\n`,
        };
      }
    } catch { /* not JSON — fall through to lines */ }
  }
  const lines = content.split('\n');
  // A trailing newline is the last line's terminator, not an extra line.
  const trailingNewline = lines.length > 1 && lines[lines.length - 1] === '';
  const body = trailingNewline ? lines.slice(0, -1) : lines;
  if (body.length >= 2) {
    return {
      units: body,
      granularity: 'lines',
      render: (units) => units.join('\n') + (trailingNewline ? '\n' : ''),
    };
  }
  return undefined;
}

/** Classic ddmin (Zeller): repeatedly try removing chunks at increasing
 *  granularity. Ends 1-minimal at the granularity when allowed to finish;
 *  the oracle-call budget can cut it short, which the report states
 *  honestly via oneMinimal=false. */
async function ddmin(
  initial: string[],
  oracle: (units: string[]) => Promise<boolean>,
  budget: { calls: number; max: number },
): Promise<{ units: string[]; oneMinimal: boolean }> {
  let units = [...initial];
  const tryOracle = async (u: string[]): Promise<boolean | undefined> => {
    if (budget.calls >= budget.max) return undefined;
    budget.calls++;
    return oracle(u);
  };

  if (units.length === 1) {
    const empty = await tryOracle([]);
    if (empty) return { units: [], oneMinimal: true };
    return { units, oneMinimal: empty !== undefined };
  }

  let n = 2;
  while (units.length >= 2) {
    const chunk = Math.ceil(units.length / n);
    let reduced = false;
    for (let i = 0; i < units.length; i += chunk) {
      const candidate = units.filter((_, j) => j < i || j >= i + chunk);
      if (candidate.length === units.length) continue;
      const stillFails = await tryOracle(candidate);
      if (stillFails === undefined) return { units, oneMinimal: false }; // budget exhausted mid-pass
      if (stillFails) {
        units = candidate;
        n = Math.max(2, n - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= units.length) break;
      n = Math.min(units.length, n * 2);
    }
  }

  // 1-minimality proof: every single remaining unit must be load-bearing.
  let oneMinimal = units.length > 0;
  for (let i = 0; i < units.length && oneMinimal; i++) {
    const without = units.filter((_, j) => j !== i);
    const stillFails = await tryOracle(without);
    if (stillFails === undefined) { oneMinimal = false; break; }
    if (stillFails) oneMinimal = false;
  }
  return { units, oneMinimal };
}

// ---------------------------------------------------------------------------
// The FAIL_TO_PASS pair — curriculum shape
// ---------------------------------------------------------------------------

export interface ReproPair {
  kind: 'mochi-repro-pair';
  version: 1;
  id: string;
  createdAt: string;
  /** Provenance: the repo the failure came from. Never written to. */
  repoRoot: string;
  source: FailureRecord['source'];
  failureKind: FailureKind | null;
  implicatedFile?: string;
  /** The repro invocation: fails on the pre-fix tree, passes on the fixed
   *  tree — the FAIL_TO_PASS oracle, in CurriculumTask's sense. */
  reproCommand: string;
  reproFiles: Array<{ path: string; content: string }>;
  /** The shrunk input file (when shrinking happened) and its content. */
  inputPath?: string;
  inputBeforeBytes?: number;
  inputAfter?: string;
  inputAfterSha256?: string;
  failToPass: string[];
  failingOutputExcerpt: string;
  shrink?: ShrinkReport;
  validation: ReproValidation;
  prompt: string;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function saveReproPair(pair: ReproPair, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const p = join(outDir, `${pair.id}.json`);
  writeFileSync(p, JSON.stringify(pair, null, 2) + '\n');
  return p;
}

export function loadReproPair(path: string): ReproPair {
  let t: ReproPair;
  try { t = JSON.parse(readFileSync(path, 'utf8')) as ReproPair; } catch (e) {
    throw new Error(`cannot read repro pair ${path}: ${(e as Error).message}`);
  }
  if (t.kind !== 'mochi-repro-pair' || t.version !== 1 || typeof t.reproCommand !== 'string') {
    throw new Error(`${path} is not a v1 repro pair`);
  }
  if (t.inputAfter !== undefined && t.inputAfterSha256 !== sha256(t.inputAfter)) {
    throw new Error(`repro pair ${t.id}: shrunk-input hash mismatch — pair file was tampered with`);
  }
  return t;
}

export function defaultReproPairDir(repoRoot: string): string {
  return join(mochiStateDir(repoRoot), 'repro-pairs');
}

// ---------------------------------------------------------------------------
// Synthesis — extract → guard → validate (base) → shrink → validate (fixed)
// ---------------------------------------------------------------------------

function materialize(dir: string, files: Array<{ path: string; content: string }>): void {
  for (const f of files) {
    const abs = resolve(dir, f.path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
}

export async function synthesizeRepro(
  record: FailureRecord,
  opts: SynthesizeOptions = {},
): Promise<ReproResult> {
  const repoRoot = resolve(record.repoRoot);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const signature = failureSignature(record.text, repoRoot);
  const { kind: failureKind } = classifyFailure(record.text);

  // 1. Extract -------------------------------------------------------------
  const extracted = extractCandidate(record);
  if ('reason' in extracted) {
    return { outcome: 'no-repro', stage: 'extract', diagnostics: extracted.reason };
  }
  const candidate = extracted.candidate;

  // 2. Guard — the eval-blocklist discipline applies to repro pairs exactly
  //    as to every other curriculum input: a pair derived from a frozen or
  //    blocklisted task would contaminate the eval it came from.
  if (candidate.implicatedFile) {
    try {
      assertCurriculumTargetAllowed({
        repoRoot,
        sourceFile: candidate.implicatedFile,
        instanceId: record.instanceId,
        repo: record.repo,
        baseCommit: record.baseCommit,
        blocklistPaths: record.blocklistPaths,
      });
    } catch (e) {
      if (e instanceof CurriculumError && e.code === 'guard') {
        return { outcome: 'refused', reason: e.message };
      }
      throw e;
    }
  }

  const runCandidate = (workdir: string): Promise<TestRunOutcome> =>
    createShellTestRunner(candidate.command, { timeoutMs })(workdir);
  const failsAsExpected = (r: TestRunOutcome, workdir: string): boolean =>
    !r.passed && outputMatches(r.output, signature, workdir);

  // 3a. In-place mode (agent-loop gate): one confirmation run, nothing else.
  if (opts.inPlace) {
    if (candidate.files.length > 0) {
      return {
        outcome: 'no-repro', stage: 'extract',
        diagnostics: 'candidate requires materializing a synthesised script; in-place gate mode never writes to the real tree',
      };
    }
    const r = await runCandidate(repoRoot);
    if (!failsAsExpected(r, repoRoot)) {
      return {
        outcome: 'no-repro', stage: 'base',
        diagnostics: `candidate \`${candidate.command}\` did not reproduce in place (exit ${r.exitCode}): ${r.output.slice(-400)}`,
      };
    }
    return {
      outcome: 'validated',
      candidate,
      validation: {
        baseExitCode: r.exitCode,
        baseSignatureMatched: signature !== undefined,
        ...(signature ? { signature } : {}),
      },
    };
  }

  // 3b. Scratch mode: isolated copies for everything.
  const scratchBase = opts.scratchBase ?? tmpdir();
  const scratch = mkdtempSync(join(scratchBase, 'mochi-repro-'));
  const cleanups: Array<() => Promise<void>> = [];
  try {
    const base = await createIsolatedCopy(repoRoot, join(scratch, 'base'));
    cleanups.push(base.cleanup);
    materialize(base.path, candidate.files);
    if (candidate.shrinkTarget) {
      materialize(base.path, [{ path: candidate.shrinkTarget.path, content: candidate.shrinkTarget.content }]);
    }

    const baseRun = await runCandidate(base.path);
    if (!failsAsExpected(baseRun, base.path)) {
      return {
        outcome: 'no-repro', stage: 'base',
        diagnostics: `candidate \`${candidate.command}\` did not reproduce on the pre-fix tree (exit ${baseRun.exitCode}, signature ${signature ? 'unmatched' : 'n/a'}): ${baseRun.output.slice(-400)}`,
      };
    }

    // 4. Shrink -------------------------------------------------------------
    let shrink: ShrinkReport | undefined;
    let shrunkContent: string | undefined;
    if (candidate.shrinkTarget) {
      const split = splitUnits(candidate.shrinkTarget.content);
      if (split) {
        const target = candidate.shrinkTarget;
        const budget = { calls: 0, max: opts.maxOracleCalls ?? 48 };
        const oracle = async (units: string[]): Promise<boolean> => {
          materialize(base.path, [{ path: target.path, content: split.render(units) }]);
          const r = await runCandidate(base.path);
          return failsAsExpected(r, base.path);
        };
        const { units, oneMinimal } = await ddmin(split.units, oracle, budget);
        shrunkContent = split.render(units);
        shrink = {
          target: target.path,
          granularity: split.granularity,
          beforeBytes: Buffer.byteLength(target.content),
          afterBytes: Buffer.byteLength(shrunkContent),
          beforeUnits: split.units.length,
          afterUnits: units.length,
          oracleCalls: budget.calls,
          oneMinimal,
        };
        // The shrunk input must still reproduce — ddmin's oracle guarantees
        // it for the final set unless the budget cut the run short before
        // any reduction; re-verify once so the claim is executed, not assumed.
        materialize(base.path, [{ path: target.path, content: shrunkContent }]);
        const verifyRun = await runCandidate(base.path);
        if (!failsAsExpected(verifyRun, base.path)) {
          return {
            outcome: 'no-repro', stage: 'shrink',
            diagnostics: `shrunk input no longer reproduces (exit ${verifyRun.exitCode}) — refusing to claim a minimal repro`,
          };
        }
      }
    }

    const validation: ReproValidation = {
      baseExitCode: baseRun.exitCode,
      baseSignatureMatched: signature !== undefined,
      ...(signature ? { signature } : {}),
    };

    // 5. Fixed direction + pair emission -----------------------------------
    let pair: ReproPair | undefined;
    let pairPath: string | undefined;
    if (record.fixedFiles && Object.keys(record.fixedFiles).length > 0) {
      const fixed = await createIsolatedCopy(repoRoot, join(scratch, 'fixed'));
      cleanups.push(fixed.cleanup);
      materialize(fixed.path, candidate.files);
      materialize(fixed.path, Object.entries(record.fixedFiles).map(([path, content]) => ({ path, content })));
      if (candidate.shrinkTarget && shrunkContent !== undefined) {
        materialize(fixed.path, [{ path: candidate.shrinkTarget.path, content: shrunkContent }]);
      }
      const fixedRun = await runCandidate(fixed.path);
      validation.fixedExitCode = fixedRun.exitCode;
      validation.fixedPassed = fixedRun.passed;
      if (fixedRun.passed) {
        const now = (opts.now ?? new Date()).toISOString();
        const idSeed = `${candidate.command}\n${candidate.implicatedFile ?? ''}\n${shrunkContent ?? ''}`;
        pair = {
          kind: 'mochi-repro-pair',
          version: 1,
          id: `repro-${sha256(idSeed).slice(0, 12)}`,
          createdAt: now,
          repoRoot,
          source: record.source,
          failureKind,
          ...(candidate.implicatedFile ? { implicatedFile: candidate.implicatedFile } : {}),
          reproCommand: candidate.command,
          reproFiles: candidate.files,
          ...(candidate.shrinkTarget && shrunkContent !== undefined
            ? {
                inputPath: candidate.shrinkTarget.path,
                inputBeforeBytes: Buffer.byteLength(candidate.shrinkTarget.content),
                inputAfter: shrunkContent,
                inputAfterSha256: sha256(shrunkContent),
              }
            : {}),
          failToPass: [candidate.command],
          failingOutputExcerpt: baseRun.output.slice(-1_000),
          ...(shrink ? { shrink } : {}),
          validation,
          prompt: [
            `A validated reproduction fails on this tree: \`${candidate.command}\``,
            candidate.implicatedFile ? `Implicated file: ${candidate.implicatedFile}` : '',
            signature ? `Failure signature: ${signature}` : '',
            'Make the reproduction pass without weakening it; the repro is the verifier.',
          ].filter(Boolean).join('\n'),
        };
        pairPath = saveReproPair(pair, opts.outDir ?? defaultReproPairDir(repoRoot));
      }
    }

    return { outcome: 'validated', candidate, validation, ...(shrink ? { shrink } : {}), ...(pair ? { pair, pairPath } : {}) };
  } finally {
    for (const c of cleanups.reverse()) { try { await c(); } catch { /* best effort */ } }
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}
