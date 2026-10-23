// Failure curriculum v1 (D10) — SWE-smith-style bug injection on the user's
// OWN repos, turning passing modules into exact-verifier practice tasks.
//
// Idea (SWE-smith, arXiv 2504.21798): a bug is only a useful practice task
// when it is VALIDATED — the injected mutation must flip at least one
// existing test from PASS to FAIL. That flip is a free, exact verifier: the
// practice task is solved iff the previously-failing tests pass again (and
// nothing else broke). No model judges anything; generation is fully
// deterministic (operator flips from core/mutation.ts, no LLM in the loop),
// so generating a task costs zero tokens. Tokens are spent only when an
// agent PRACTISES, and practice runs are hard-capped (see runPracticeAttempt).
//
// HARD RULES (brief D10 — enforced in code, not by convention):
//   1. Never touch bench/frozen or the eval blocklist. Curriculum targets
//      under bench/frozen are refused, and any target whose instance id /
//      base commit / (repo, commit) pair appears in
//      bench/external/eval_blocklist.json or bench/frozen/
//      blocklist-additions.json is refused. The blocklist files are READ
//      here, never written.
//   2. Injected bugs never land on the user's real working tree. Generation
//      validates mutations inside a throwaway scratch copy; practice runs
//      materialize into an isolated copy (git worktree when the source is a
//      git repo, plain copy otherwise) under the OS temp dir by default.
//      Scratch/practice dirs INSIDE the source repo are refused outright.
//   3. Test files are never mutation targets — mutating the verifier would
//      manufacture fake FAIL_TO_PASS signal.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { enumerateMutations } from '../core/mutation.js';
import { runArgv, runShellString } from '../exec.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type CurriculumErrorCode =
  | 'guard'        // hard-rule violation (frozen / blocklist / tree escape)
  | 'not-green'    // baseline tests do not pass on the pristine module
  | 'no-flip'      // no candidate mutation flipped a test
  | 'bad-target'   // missing file, test file, unsupported target
  | 'io';          // filesystem / runner infrastructure failure

export class CurriculumError extends Error {
  readonly code: CurriculumErrorCode;
  constructor(code: CurriculumErrorCode, message: string) {
    super(message);
    this.name = 'CurriculumError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Test running — the exact verifier
// ---------------------------------------------------------------------------

export interface TestRunOutcome {
  exitCode: number | null;
  /** True iff the command exited 0 and did not time out. */
  passed: boolean;
  /** Ids of individual tests observed failing (empty for exit-code-only runs). */
  failedTestIds: string[];
  passedTestIds: string[];
  /** Combined stdout+stderr, tail-bounded. */
  output: string;
  durationMs: number;
}

/** Runs the repo's tests in `workdir`. Injectable so unit tests (and other
 *  harnesses with structured runners) can supply exact per-test results. */
export type TestRunnerFn = (workdir: string) => Promise<TestRunOutcome>;

/** Parse per-test ids out of common test output shapes:
 *   TAP          `ok 1 - name` / `not ok 2 - name`
 *   plain        `PASS <id>` / `FAIL <id>` (one per line)
 *   vitest-ish   `✓ name` / `× name` / `✗ name`
 *  Unknown shapes yield empty id lists — the exit code still decides pass. */
export function parseTestIds(output: string): { passedIds: string[]; failedIds: string[] } {
  const passedIds: string[] = [];
  const failedIds: string[] = [];
  const pushUnique = (arr: string[], v: string) => { if (v && !arr.includes(v)) arr.push(v); };
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^not ok\s+\d+\s*-\s*(.+)$/))) pushUnique(failedIds, m[1].trim());
    else if ((m = line.match(/^ok\s+\d+\s*-\s*(.+)$/))) pushUnique(passedIds, m[1].trim());
    else if ((m = line.match(/^FAIL\s+(.+)$/))) pushUnique(failedIds, m[1].trim());
    else if ((m = line.match(/^PASS\s+(.+)$/))) pushUnique(passedIds, m[1].trim());
    else if ((m = line.match(/^[×✗]\s+(.+)$/))) pushUnique(failedIds, m[1].trim());
    else if ((m = line.match(/^✓\s+(.+)$/))) pushUnique(passedIds, m[1].trim());
  }
  // A test reported both ways (retry/flaky output) counts as failing.
  return { passedIds: passedIds.filter((id) => !failedIds.includes(id)), failedIds };
}

/** Default runner: executes the repo owner's configured test command in the
 *  workdir. A string command goes through the shell (same trust class as
 *  verification commands in verification.ts); an argv array runs shell-free. */
export function createShellTestRunner(
  testCommand: string | string[],
  opts: { timeoutMs?: number } = {},
): TestRunnerFn {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return async (workdir: string): Promise<TestRunOutcome> => {
    const r = Array.isArray(testCommand)
      ? await runArgv(testCommand[0], testCommand.slice(1), { cwd: workdir, timeoutMs })
      : await runShellString(testCommand, { cwd: workdir, timeoutMs });
    const output = `${r.stdout}\n${r.stderr}`;
    const { passedIds, failedIds } = parseTestIds(output);
    return {
      exitCode: r.code,
      passed: r.code === 0 && !r.timedOut && !r.cancelled,
      failedTestIds: failedIds,
      passedTestIds: passedIds,
      output: output.slice(-8_000),
      durationMs: r.durationMs,
    };
  };
}

// ---------------------------------------------------------------------------
// Guards — frozen set + eval blocklist (hard rule 1)
// ---------------------------------------------------------------------------

function posixRel(p: string): string {
  return p.split(sep).join('/');
}

/** True when a repo-relative posix path lives under bench/frozen. */
export function isFrozenPath(relPosix: string): boolean {
  const norm = relPosix.replace(/^\.\//, '').replace(/^\/+/, '');
  return norm === 'bench/frozen' || norm.startsWith('bench/frozen/');
}

interface BlockedIds { instanceIds: Set<string>; baseCommits: Set<string>; pairs: Set<string> }

function pairKey(repo: string, commit: string): string {
  return `${repo.trim().toLowerCase().replace(/\.git$/, '')}@${commit.trim().toLowerCase()}`;
}

/** Read (never write) blocklist-shaped JSON files and union their blocked
 *  ids. Handles both eval_blocklist.json (datasets[] + extra_blocked) and
 *  bench/frozen/blocklist-additions.json (extra_blocked only). Missing or
 *  malformed files contribute nothing — the seed blocklist ships empty
 *  instance lists by design, and a fixture repo may have no blocklist at all. */
export function loadBlockedIds(paths: string[]): BlockedIds {
  const out: BlockedIds = { instanceIds: new Set(), baseCommits: new Set(), pairs: new Set() };
  const addBlock = (b: { instance_ids?: unknown; base_commits?: unknown; repo_commit_pairs?: unknown } | undefined) => {
    if (!b) return;
    if (Array.isArray(b.instance_ids)) for (const id of b.instance_ids) if (typeof id === 'string' && id) out.instanceIds.add(id);
    if (Array.isArray(b.base_commits)) for (const c of b.base_commits) if (typeof c === 'string' && c) out.baseCommits.add(c.toLowerCase());
    if (Array.isArray(b.repo_commit_pairs)) for (const p of b.repo_commit_pairs) {
      const pair = p as { repo?: unknown; base_commit?: unknown };
      if (typeof pair.repo === 'string' && typeof pair.base_commit === 'string') out.pairs.add(pairKey(pair.repo, pair.base_commit));
    }
  };
  for (const p of paths) {
    if (!existsSync(p)) continue;
    let data: { datasets?: unknown; extra_blocked?: unknown };
    try { data = JSON.parse(readFileSync(p, 'utf8')) as typeof data; } catch { continue; }
    if (Array.isArray(data.datasets)) {
      for (const ds of data.datasets) addBlock(ds as Parameters<typeof addBlock>[0]);
    }
    addBlock(data.extra_blocked as Parameters<typeof addBlock>[0]);
  }
  return out;
}

/** Default blocklist locations for a repo, mirroring the regression gate. */
export function defaultBlocklistPaths(repoRoot: string): string[] {
  return [
    join(repoRoot, 'bench', 'external', 'eval_blocklist.json'),
    join(repoRoot, 'bench', 'frozen', 'blocklist-additions.json'),
  ];
}

export interface GuardCandidate {
  repoRoot: string;
  /** Repo-relative posix path of the mutation target. */
  sourceFile: string;
  instanceId?: string;
  repo?: string;
  baseCommit?: string;
  blocklistPaths?: string[];
}

/** Hard-rule enforcement for one candidate target. Throws CurriculumError
 *  with code 'guard' on any violation; returns silently when allowed. */
export function assertCurriculumTargetAllowed(c: GuardCandidate): void {
  if (isFrozenPath(c.sourceFile)) {
    throw new CurriculumError('guard', `curriculum target ${c.sourceFile} is under bench/frozen — the frozen gate set is never practice material`);
  }
  const blocked = loadBlockedIds(c.blocklistPaths ?? defaultBlocklistPaths(c.repoRoot));
  if (c.instanceId && blocked.instanceIds.has(c.instanceId)) {
    throw new CurriculumError('guard', `curriculum target instance ${c.instanceId} is on the eval blocklist`);
  }
  if (c.baseCommit && blocked.baseCommits.has(c.baseCommit.toLowerCase())) {
    throw new CurriculumError('guard', `curriculum target base commit ${c.baseCommit} is on the eval blocklist`);
  }
  if (c.repo && c.baseCommit && blocked.pairs.has(pairKey(c.repo, c.baseCommit))) {
    throw new CurriculumError('guard', `curriculum target ${c.repo}@${c.baseCommit} is on the eval blocklist`);
  }
}

/** Test-file detector (mirrors core/mutation.ts conventions): mutating the
 *  verifier itself would fabricate FAIL_TO_PASS signal, so it is refused. */
export function isTestPath(relPosix: string): boolean {
  const base = (relPosix.split('/').pop() ?? '').toLowerCase();
  return /(^|[._-])(test|spec)([._-]|$)/.test(base) || base.startsWith('test_') || base.endsWith('_test.go') || base.endsWith('_test.rs');
}

/** Resolve + validate a mutation target inside repoRoot. */
function resolveTarget(repoRoot: string, sourceFile: string): { abs: string; relPosix: string } {
  const root = resolve(repoRoot);
  const abs = resolve(root, sourceFile);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || resolve(rel) === rel) {
    throw new CurriculumError('guard', `curriculum target ${sourceFile} escapes the repo root`);
  }
  const relPosix = posixRel(rel);
  if (isFrozenPath(relPosix)) {
    throw new CurriculumError('guard', `curriculum target ${relPosix} is under bench/frozen — never practice material`);
  }
  // A repo that itself lives under bench/frozen is entirely off-limits.
  if (posixRel(root).split('/').some((seg, i, a) => seg === 'frozen' && a[i - 1] === 'bench')) {
    throw new CurriculumError('guard', `repo root ${root} is inside bench/frozen — refusing all curriculum work`);
  }
  if (!existsSync(abs)) throw new CurriculumError('bad-target', `curriculum target not found: ${relPosix}`);
  if (isTestPath(relPosix)) {
    throw new CurriculumError('bad-target', `curriculum target ${relPosix} is a test file — mutating the verifier is not a practice task`);
  }
  return { abs, relPosix };
}

/** Scratch/practice dirs must live OUTSIDE the source repo (hard rule 2):
 *  an injected bug must never appear in the user's real working tree, not
 *  even transiently under a subdirectory of it. */
function assertOutsideRepo(repoRoot: string, dir: string, what: string): void {
  const root = resolve(repoRoot);
  const d = resolve(dir);
  if (d === root || d.startsWith(root + sep)) {
    throw new CurriculumError('guard', `${what} dir ${d} is inside the source repo ${root} — injected bugs never land on the real working tree`);
  }
  if (isFrozenPath(posixRel(relative(root, d)))) {
    throw new CurriculumError('guard', `${what} dir ${d} is under bench/frozen`);
  }
}

// ---------------------------------------------------------------------------
// Mutation candidates — deterministic operator flips (core/mutation.ts)
// ---------------------------------------------------------------------------

export type Difficulty = 'easy' | 'medium' | 'hard';

/** Difficulty by operator subtlety: an arithmetic flip is loud (values are
 *  wildly wrong), a comparison flip is quieter, and a logical/equality flip
 *  can pass many inputs while breaking an edge — the hardest to hunt. */
export function difficultyForOperator(from: string): Difficulty {
  if (from === '+' || from === '-') return 'easy';
  if (from === '<' || from === '>' || from === '<=' || from === '>=') return 'medium';
  return 'hard';
}

export interface MutationCandidate {
  /** Byte index (string index) of the flipped operator in the source. */
  index: number;
  from: string;
  to: string;
  difficulty: Difficulty;
  mutatedSource: string;
}

export function applyMutation(source: string, index: number, from: string, to: string): string {
  return source.slice(0, index) + to + source.slice(index + from.length);
}

/** Enumerate distinct mutation candidates deterministically, in source
 *  order. Built on core/mutation.ts enumerateMutations (string/comment-
 *  aware, longest-flip-first per position); a given file always yields
 *  the same candidate list. */
export function enumerateMutationCandidates(source: string, maxCandidates = 24): MutationCandidate[] {
  return enumerateMutations(source).slice(0, maxCandidates).map((m) => ({
    index: m.index, from: m.from, to: m.to,
    difficulty: difficultyForOperator(m.from),
    mutatedSource: applyMutation(source, m.index, m.from, m.to),
  }));
}

// ---------------------------------------------------------------------------
// Isolated copies — scratch validation + practice materialization
// ---------------------------------------------------------------------------

const COPY_EXCLUDE = new Set(['node_modules', '.git', 'dist', 'coverage', '__pycache__']);

/** Remove the bytecode cache sitting next to a scratch source file.
 *  Python validates a .pyc by its source's mtime+size, so a same-length
 *  mutation written within the same second as the baseline run is shadowed
 *  by the baseline's cache: the mutated code never executes, the test
 *  stays green, and the flip check reports a false "mutation survived".
 *  (Found by the audit-fix wave: the sleeptime curriculum fixtures'
 *  `a + b` → `a - b` mutation was invisible to the runner this way.)
 *  Purging after every rewrite of the target removes the race. */
function purgeSiblingBytecodeCache(sourceAbs: string): void {
  rmSync(join(dirname(sourceAbs), '__pycache__'), { recursive: true, force: true });
}

/** Copy a repo tree (minus deps/build/VCS internals) into dest. */
export function copyRepoTree(srcRoot: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  cpSync(srcRoot, dest, {
    recursive: true,
    filter: (s: string) => !s.split(sep).some((seg) => COPY_EXCLUDE.has(seg)),
  });
}

function gitOk(cwd: string, args: string[]): Promise<boolean> {
  return new Promise((res) => {
    execFile('git', args, { cwd, timeout: 30_000 }, (err) => res(!err));
  });
}

/** Materialize an isolated practice copy of `repoRoot` at `dest`:
 *  a detached git worktree when the source is a git repo (cheap, shares
 *  objects), otherwise a plain tree copy. The source working tree is only
 *  ever READ. Returns how the copy was made + a cleanup that removes the
 *  copy (and unregisters the worktree) without touching the source. */
export async function createIsolatedCopy(
  repoRoot: string,
  dest: string,
): Promise<{ path: string; kind: 'worktree' | 'copy'; cleanup: () => Promise<void> }> {
  assertOutsideRepo(repoRoot, dest, 'practice');
  const isGit = existsSync(join(repoRoot, '.git')) && (await gitOk(repoRoot, ['rev-parse', '--git-dir']));
  if (isGit) {
    mkdirSync(dirname(dest), { recursive: true });
    const added = await gitOk(repoRoot, ['worktree', 'add', '--detach', '--force', dest, 'HEAD']);
    if (added) {
      return {
        path: dest, kind: 'worktree',
        cleanup: async () => {
          await gitOk(repoRoot, ['worktree', 'remove', '--force', dest]);
          if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
          await gitOk(repoRoot, ['worktree', 'prune']);
        },
      };
    }
    // Fall through to a plain copy if worktree creation failed (e.g. a
    // dirty/locked repo) — isolation matters more than the mechanism.
  }
  copyRepoTree(repoRoot, dest);
  return {
    path: dest, kind: 'copy',
    cleanup: async () => { if (existsSync(dest)) rmSync(dest, { recursive: true, force: true }); },
  };
}

// ---------------------------------------------------------------------------
// The practice task
// ---------------------------------------------------------------------------

export interface CurriculumTask {
  kind: 'mochi-curriculum-task';
  version: 1;
  id: string;
  createdAt: string;
  /** Provenance: the repo the module came from. Practice copies are always
   *  materialized elsewhere; this path is never written to. */
  repoRoot: string;
  /** Repo-relative posix path of the mutated module. */
  sourceFile: string;
  testCommand: string;
  mutation: { index: number; from: string; to: string; difficulty: Difficulty };
  originalContent: string;
  mutatedContent: string;
  originalSha256: string;
  mutatedSha256: string;
  /** SWE-bench FAIL_TO_PASS: tests that pass on the original and fail with
   *  the bug injected. With an exit-code-only runner this holds the single
   *  entry `<testCommand>` (the whole suite is the flipping test). */
  failToPass: string[];
  /** Sample of tests green both before and after injection (PASS_TO_PASS). */
  passToPassSample: string[];
  failingOutputExcerpt: string;
  /** How many candidate mutations were tried before one validated. */
  candidatesTried: number;
  /** Hard token cap for any single practice attempt on this task. */
  tokenCap: number;
  prompt: string;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export const DEFAULT_TOKEN_CAP = 50_000;
export const DEFAULT_MAX_CANDIDATES = 24;

export interface GenerateOptions {
  repoRoot: string;
  /** Repo-relative (or absolute, inside the repo) path of a passing module. */
  sourceFile: string;
  testCommand: string;
  runner?: TestRunnerFn;
  maxCandidates?: number;
  /** Where validation scratch copies live. Default: OS temp dir. Must be
   *  outside repoRoot (enforced). */
  scratchBase?: string;
  tokenCap?: number;
  instanceId?: string;
  repo?: string;
  baseCommit?: string;
  blocklistPaths?: string[];
  now?: Date;
}

/** A failure caused by the mutated file not even parsing (SyntaxError and
 *  friends) is not a logic bug — it makes a trivial, unrealistic task, so
 *  such candidates are rejected during validation. */
const PARSE_ERROR_RE = /SyntaxError|Unexpected token|Cannot use import|Failed to parse|Parse error/i;

/**
 * Generate ONE validated practice task from a passing module:
 *   1. guards (frozen / blocklist / test-file / tree-escape),
 *   2. copy the repo to a scratch dir; baseline tests MUST pass there,
 *   3. try mutation candidates in order; the first whose injection makes
 *      the suite FAIL (without a parse error) is the validated bug,
 *   4. restore the original in scratch and confirm the suite passes again
 *      (the falsifiable property: verifier red with bug, green without),
 *   5. emit the task. The source repo is only ever read.
 */
export async function generateCurriculumTask(opts: GenerateOptions): Promise<CurriculumTask> {
  const repoRoot = resolve(opts.repoRoot);
  const { abs, relPosix } = resolveTarget(repoRoot, opts.sourceFile);
  assertCurriculumTargetAllowed({
    repoRoot, sourceFile: relPosix,
    instanceId: opts.instanceId, repo: opts.repo, baseCommit: opts.baseCommit,
    blocklistPaths: opts.blocklistPaths,
  });

  const originalContent = readFileSync(abs, 'utf8');
  const candidates = enumerateMutationCandidates(originalContent, opts.maxCandidates ?? DEFAULT_MAX_CANDIDATES);
  if (candidates.length === 0) {
    throw new CurriculumError('no-flip', `${relPosix} has no flippable operator to mutate`);
  }
  const runner = opts.runner ?? createShellTestRunner(opts.testCommand);
  const scratchBase = opts.scratchBase ?? tmpdir();
  assertOutsideRepo(repoRoot, scratchBase === tmpdir() ? join(scratchBase, 'mochi-curriculum-scratch') : scratchBase, 'scratch');
  const scratch = mkdtempSync(join(scratchBase, 'mochi-curriculum-'));
  try {
    copyRepoTree(repoRoot, scratch);
    const targetInScratch = join(scratch, relPosix);
    purgeSiblingBytecodeCache(targetInScratch);

    const baseline = await runner(scratch);
    if (!baseline.passed) {
      throw new CurriculumError('not-green', `baseline tests do not pass for ${relPosix} — a curriculum source must start green (exit ${baseline.exitCode})`);
    }
    const baselinePassedIds = baseline.passedTestIds;

    let chosen: { cand: MutationCandidate; outcome: TestRunOutcome; tried: number } | null = null;
    let tried = 0;
    for (const cand of candidates) {
      tried++;
      writeFileSync(targetInScratch, cand.mutatedSource);
      purgeSiblingBytecodeCache(targetInScratch);
      const outcome = await runner(scratch);
      if (outcome.passed) continue;                    // mutation survived → not a task
      if (PARSE_ERROR_RE.test(outcome.output)) continue; // syntax break → trivial, skip
      chosen = { cand, outcome, tried };
      break;
    }
    if (!chosen) {
      throw new CurriculumError('no-flip', `none of ${tried} mutation candidates in ${relPosix} flipped a test PASS→FAIL`);
    }

    // Restore-and-reverify: the exact falsifiable property of the task.
    writeFileSync(targetInScratch, originalContent);
    purgeSiblingBytecodeCache(targetInScratch);
    const restored = await runner(scratch);
    if (!restored.passed) {
      throw new CurriculumError('io', `restoring the original ${relPosix} did not return the suite to green — refusing to emit an unverifiable task`);
    }

    const failToPass = chosen.outcome.failedTestIds.length > 0
      ? chosen.outcome.failedTestIds
      : [opts.testCommand];
    const passToPassSample = baselinePassedIds
      .filter((id) => !failToPass.includes(id))
      .slice(0, 20);
    const failingExcerpt = chosen.outcome.output.trim().slice(-1_500);
    const now = (opts.now ?? new Date()).toISOString();
    const id = `curr-${basename(relPosix).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${sha256(`${relPosix}:${chosen.cand.index}:${chosen.cand.from}`).slice(0, 10)}`;
    const prompt = [
      `A regression was introduced into \`${relPosix}\`. The existing test suite now fails.`,
      ``,
      `Failing tests (FAIL_TO_PASS): ${failToPass.join(', ')}`,
      `Test command: ${opts.testCommand}`,
      ``,
      `Find and fix the bug in \`${relPosix}\` so the failing tests pass again without breaking any other test. Do not modify test files.`,
      ``,
      `Failing test output (excerpt):`,
      '```',
      failingExcerpt || '(no output captured)',
      '```',
    ].join('\n');

    return {
      kind: 'mochi-curriculum-task',
      version: 1,
      id,
      createdAt: now,
      repoRoot,
      sourceFile: relPosix,
      testCommand: opts.testCommand,
      mutation: { index: chosen.cand.index, from: chosen.cand.from, to: chosen.cand.to, difficulty: chosen.cand.difficulty },
      originalContent,
      mutatedContent: chosen.cand.mutatedSource,
      originalSha256: sha256(originalContent),
      mutatedSha256: sha256(chosen.cand.mutatedSource),
      failToPass,
      passToPassSample,
      failingOutputExcerpt: failingExcerpt,
      candidatesTried: chosen.tried,
      tokenCap: opts.tokenCap ?? DEFAULT_TOKEN_CAP,
      prompt,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface GenerateBatchResult {
  tasks: CurriculumTask[];
  skipped: { sourceFile: string; code: CurriculumErrorCode; reason: string }[];
}

/** Generate tasks for several modules. Per-file 'not-green' / 'no-flip' /
 *  'bad-target' outcomes are collected as skips; GUARD violations abort the
 *  whole batch loudly — a blocklist/frozen hit must never be silently
 *  absorbed into a skip list. */
export async function generateCurriculum(
  opts: Omit<GenerateOptions, 'sourceFile'> & { sourceFiles: string[]; maxTasks?: number },
): Promise<GenerateBatchResult> {
  const tasks: CurriculumTask[] = [];
  const skipped: GenerateBatchResult['skipped'] = [];
  const seenIds = new Set<string>();
  for (const sourceFile of opts.sourceFiles) {
    if (opts.maxTasks !== undefined && tasks.length >= opts.maxTasks) break;
    try {
      const task = await generateCurriculumTask({ ...opts, sourceFile });
      if (seenIds.has(task.id)) continue;
      seenIds.add(task.id);
      tasks.push(task);
    } catch (e) {
      if (e instanceof CurriculumError && e.code === 'guard') throw e;
      if (e instanceof CurriculumError) {
        skipped.push({ sourceFile, code: e.code, reason: e.message });
      } else {
        skipped.push({ sourceFile, code: 'io', reason: (e as Error).message });
      }
    }
  }
  return { tasks, skipped };
}

// ---------------------------------------------------------------------------
// Persistence — a task is self-contained (both file versions travel with it)
// ---------------------------------------------------------------------------

export function saveCurriculumTask(task: CurriculumTask, outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const p = join(outDir, `${task.id}.json`);
  writeFileSync(p, JSON.stringify(task, null, 2) + '\n');
  return p;
}

export function loadCurriculumTask(path: string): CurriculumTask {
  let t: CurriculumTask;
  try { t = JSON.parse(readFileSync(path, 'utf8')) as CurriculumTask; } catch (e) {
    throw new CurriculumError('io', `cannot read curriculum task ${path}: ${(e as Error).message}`);
  }
  if (t.kind !== 'mochi-curriculum-task' || t.version !== 1 || typeof t.mutatedContent !== 'string') {
    throw new CurriculumError('io', `${path} is not a v1 curriculum task`);
  }
  if (sha256(t.mutatedContent) !== t.mutatedSha256 || sha256(t.originalContent) !== t.originalSha256) {
    throw new CurriculumError('io', `curriculum task ${t.id}: content hash mismatch — task file was tampered with`);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Practice runs — isolated, token-capped (hard rule: worktrees + cap)
// ---------------------------------------------------------------------------

/** The practising agent: works inside the practice workdir (bug present),
 *  returns how many tokens it spent. Receives the remaining budget so a
 *  well-behaved agent can stop itself before the hard cap bites. */
export type PracticeAgentFn = (
  task: CurriculumTask,
  workdir: string,
  budget: { tokenCap: number },
) => Promise<{ tokensUsed: number; detail?: string }>;

export type PracticeStatus = 'passed' | 'failed' | 'over-cap' | 'error';

export interface PracticeAttemptResult {
  taskId: string;
  status: PracticeStatus;
  tokensUsed: number;
  tokenCap: number;
  /** Verifier outcome; absent when the attempt was rejected for cap before
   *  verification, or errored before the verifier could run. */
  verifier?: TestRunOutcome;
  workdirKind?: 'worktree' | 'copy';
  detail: string;
  durationMs: number;
}

/** Materialize a task's buggy state into an EXISTING isolated copy dir. */
export function applyBugToWorkdir(task: CurriculumTask, workdir: string): void {
  const target = join(workdir, task.sourceFile);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, task.mutatedContent);
}

/** Restore the pristine module inside a practice workdir (the "solution"
 *  state — used by tests and by dry-run/smoke agents). */
export function restoreOriginalInWorkdir(task: CurriculumTask, workdir: string): void {
  const target = join(workdir, task.sourceFile);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, task.originalContent);
}

/** Run the task's verifier (its test command) inside a workdir. */
export async function verifyWorkdir(
  task: CurriculumTask,
  workdir: string,
  runner?: TestRunnerFn,
): Promise<TestRunOutcome> {
  return (runner ?? createShellTestRunner(task.testCommand))(workdir);
}

/**
 * One practice attempt: materialize the buggy module into an isolated copy
 * of the source repo, let the agent work there under a HARD token cap, then
 * run the exact verifier. An attempt that reports tokens over the cap is
 * 'over-cap' and never counts as a pass — the verifier is not even run;
 * the cap is a budget rule, not a grading hint. The source repo is never
 * written; the practice copy is always cleaned up unless keepWorkdir.
 */
export async function runPracticeAttempt(opts: {
  task: CurriculumTask;
  agent: PracticeAgentFn;
  sourceRepoRoot?: string;
  workBase?: string;
  runner?: TestRunnerFn;
  tokenCap?: number;
  keepWorkdir?: boolean;
}): Promise<PracticeAttemptResult> {
  const started = Date.now();
  const task = opts.task;
  const cap = opts.tokenCap ?? task.tokenCap;
  const sourceRepoRoot = resolve(opts.sourceRepoRoot ?? task.repoRoot);
  const workBase = opts.workBase ?? tmpdir();
  const dest = mkdtempSync(join(workBase, 'mochi-practice-'));
  // mkdtemp created a placeholder dir; the isolated copy wants a fresh path.
  rmSync(dest, { recursive: true, force: true });
  let iso: Awaited<ReturnType<typeof createIsolatedCopy>> | null = null;
  try {
    iso = await createIsolatedCopy(sourceRepoRoot, dest);
    applyBugToWorkdir(task, iso.path);
    const agentRes = await opts.agent(task, iso.path, { tokenCap: cap });
    const tokensUsed = Math.max(0, Math.floor(agentRes.tokensUsed ?? 0));
    if (tokensUsed > cap) {
      return {
        taskId: task.id, status: 'over-cap', tokensUsed, tokenCap: cap,
        workdirKind: iso.kind, durationMs: Date.now() - started,
        detail: `agent reported ${tokensUsed} tokens, over the hard cap of ${cap}; attempt discarded before verification`,
      };
    }
    const verifier = await verifyWorkdir(task, iso.path, opts.runner);
    return {
      taskId: task.id,
      status: verifier.passed ? 'passed' : 'failed',
      tokensUsed, tokenCap: cap, verifier, workdirKind: iso.kind,
      durationMs: Date.now() - started,
      detail: verifier.passed
        ? `verifier green after fix (${agentRes.detail ?? 'agent fix'})`
        : `verifier still red: failing ${verifier.failedTestIds.join(', ') || '(exit-code only)'}`,
    };
  } catch (e) {
    return {
      taskId: task.id, status: 'error', tokensUsed: 0, tokenCap: cap,
      workdirKind: iso?.kind, durationMs: Date.now() - started,
      detail: (e as Error).message,
    };
  } finally {
    if (!opts.keepWorkdir && iso) await iso.cleanup().catch(() => { /* best effort */ });
    if (!opts.keepWorkdir && !iso && existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Progress gate — when does practice advance the curriculum?
// ---------------------------------------------------------------------------

export interface AttemptRecord {
  taskId: string;
  difficulty: Difficulty;
  status: PracticeStatus;
  tokensUsed: number;
  at: string;
}

export type ProgressRecommendation = 'advance' | 'hold' | 'retreat';

export interface ProgressEvaluation {
  difficulty: Difficulty;
  attempts: number;
  passes: number;
  passRate: number;
  recommendation: ProgressRecommendation;
  reason: string;
}

/** The progress gate: a difficulty tier is only "cleared" with enough
 *  evidence — at least `minAttempts` graded attempts (passed/failed only;
 *  over-cap and error attempts are discarded, never counted either way) and
 *  a pass rate at or above `advanceAt`. A pass rate at or below `retreatAt`
 *  sends the learner back down a tier instead of grinding on tasks it
 *  cannot yet do. Pure function of the attempt history. */
export function evaluateProgress(
  records: AttemptRecord[],
  difficulty: Difficulty,
  opts: { minAttempts?: number; advanceAt?: number; retreatAt?: number } = {},
): ProgressEvaluation {
  const minAttempts = opts.minAttempts ?? 4;
  const advanceAt = opts.advanceAt ?? 0.75;
  const retreatAt = opts.retreatAt ?? 0.3;
  const graded = records.filter(
    (r) => r.difficulty === difficulty && (r.status === 'passed' || r.status === 'failed'),
  );
  const attempts = graded.length;
  const passes = graded.filter((r) => r.status === 'passed').length;
  const passRate = attempts === 0 ? 0 : passes / attempts;
  if (attempts < minAttempts) {
    return {
      difficulty, attempts, passes, passRate, recommendation: 'hold',
      reason: `only ${attempts}/${minAttempts} graded attempts at ${difficulty} — not enough evidence to move`,
    };
  }
  if (passRate >= advanceAt) {
    return {
      difficulty, attempts, passes, passRate, recommendation: 'advance',
      reason: `pass rate ${(passRate * 100).toFixed(0)}% ≥ ${(advanceAt * 100).toFixed(0)}% over ${attempts} attempts at ${difficulty}`,
    };
  }
  if (passRate <= retreatAt) {
    return {
      difficulty, attempts, passes, passRate, recommendation: 'retreat',
      reason: `pass rate ${(passRate * 100).toFixed(0)}% ≤ ${(retreatAt * 100).toFixed(0)}% over ${attempts} attempts at ${difficulty}`,
    };
  }
  return {
    difficulty, attempts, passes, passRate, recommendation: 'hold',
    reason: `pass rate ${(passRate * 100).toFixed(0)}% is between retreat and advance thresholds at ${difficulty}`,
  };
}

/** Is this task mastered? A single in-cap pass is enough — the verifier is
 *  exact, so a pass cannot be luck in the way a judged answer could be. */
export function isMastered(records: AttemptRecord[], taskId: string): boolean {
  return records.some((r) => r.taskId === taskId && r.status === 'passed');
}

/** Append-only attempt ledger with JSON round-trip (the sleep-time
 *  orchestrator persists this between nights). */
export class CurriculumProgress {
  records: AttemptRecord[] = [];

  record(result: PracticeAttemptResult, difficulty: Difficulty, at: Date = new Date()): AttemptRecord {
    const rec: AttemptRecord = {
      taskId: result.taskId, difficulty, status: result.status,
      tokensUsed: result.tokensUsed, at: at.toISOString(),
    };
    this.records.push(rec);
    return rec;
  }

  evaluate(difficulty: Difficulty, opts?: Parameters<typeof evaluateProgress>[2]): ProgressEvaluation {
    return evaluateProgress(this.records, difficulty, opts);
  }

  mastered(taskId: string): boolean {
    return isMastered(this.records, taskId);
  }

  toJSON(): { kind: 'mochi-curriculum-progress'; version: 1; records: AttemptRecord[] } {
    return { kind: 'mochi-curriculum-progress', version: 1, records: this.records };
  }

  static fromJSON(data: unknown): CurriculumProgress {
    const d = data as { kind?: string; records?: AttemptRecord[] };
    if (!d || d.kind !== 'mochi-curriculum-progress' || !Array.isArray(d.records)) {
      throw new CurriculumError('io', 'not a curriculum progress ledger');
    }
    const p = new CurriculumProgress();
    p.records = d.records;
    return p;
  }
}

