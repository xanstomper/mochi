// Item 15: blast-radius test selection as the DEFAULT verification gate.
//
// Before this module, the two gate paths (VerifierEngine.verify and the
// agent loop's verify) ran the targeted blast-radius subset only as a
// fail-fast PRE-check and then ALWAYS ran the full suite as the
// authoritative verdict — a ~10-minute wall on this repo (463 test files)
// for every change, however small. Items 11-14 made verification
// verification-first and proportional in the tool lane; this module makes
// the GATE itself proportional to the change.
//
// Policy (first match wins):
//   1. --full flag (opts.full) or MOCHI_GATE_FULL=1 env  → FULL (forced).
//   2. before-merge path (opts.beforeMerge)              → FULL (forced).
//   3. change set cannot be determined (git fails)        → FULL (fail-safe).
//   4. change set is empty (determinable, zero files)     → always-run core
//      set only; when that set is empty too               → FULL (fail-safe).
//   5. change touches shared/core surface — a named core file
//      (loop / runtime / tool executor / model router / config) or any file
//      whose reverse-dependency fan-out exceeds the threshold → FULL.
//   6. selection computation throws or exceeds its time budget → FULL.
//   7. the blast-radius selector declines (non-code change, test-infra
//      change, unmappable file, oversized change list, empty selection for
//      a non-empty change)                                 → FULL.
//   8. otherwise                                          → SELECTED:
//      reverse-import closure of the change ∪ always-run core set.
//
// WHAT "PASS" MEANS: unchanged. The selected run is the same vitest runner
// with the same config, the same assertions, and the same exit codes — the
// only difference is WHICH test files run. Every fail-safe above exists so
// the selection can never silently under-test: uncertainty degrades to the
// full suite, never to a narrower run.
//
// REUSE vs BUILT (audit note): the dependency graph is NOT new. This module
// reuses src/core/test-selection.ts's blast-radius selector and its
// file-level import graph (which itself reuses test-select.ts's stem
// semantics and tools/glob.ts's SKIP_DIRS). Barrel/re-export files resolve
// through the stem map (a `./barrel.js` import and a `./barrel/index.js`
// file collapse to the same stem), so transitive imports through barrels
// are covered where the file-level graph supports them. The codegraph
// (repo/codegraph.ts) is a SYMBOL-level graph for find_callers/blast_radius
// tooling — test selection needs file-level closure, so bolting the
// codegraph in would add a second graph without adding edges this policy
// can use; the AST-slicer (core/ast-slicer.ts) slices symbol-level
// dependencies for the ast_slice tool, same story. Built here: the gate
// policy (fail-safe rules, change-set determination incl. merge-base diff,
// always-run core set, rationale formatting) around the existing selector.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execArgvText } from '../exec.js';
import { mochiStateDir } from './mochi-dir.js';
import { normalizeRel, isTestFile, detectRunner, buildTargetedTestCommand, gitChangedFiles } from './test-select.js';
import {
  buildImportGraph,
  selectBlastRadiusTests,
  SelectionTimeoutError,
  type BlastOptions,
  type ImportGraph,
} from './test-selection.js';
import type { RepoInfo } from '../types.js';

// ─── Always-run core set ────────────────────────────────────────────────────

/** The repo's standing-gate suites: the selection machinery's own tests
 *  (the selector is on every gate path, so its tests run on every gate)
 *  plus the AAIF skill conformance suite. Existence-checked so repos
 *  without them simply don't include them. Extensible per repo via
 *  `.mochi/test-selection.json` → { "alwaysRun": [...] } (same file as the
 *  smoke config). */
const DEFAULT_ALWAYS_RUN = [
  'src/core/test-selection.test.ts',
  'src/skills/aaif-conformance.test.ts',
];

export function resolveAlwaysRun(cwd: string, extra?: string[]): string[] {
  let configured: string[] = [];
  try {
    const raw = JSON.parse(readFileSync(resolve(mochiStateDir(cwd), 'test-selection.json'), 'utf8'));
    if (Array.isArray(raw?.alwaysRun)) configured = raw.alwaysRun.filter((s: unknown): s is string => typeof s === 'string');
  } catch { /* no config */ }
  const candidates = [...configured, ...DEFAULT_ALWAYS_RUN, ...(extra ?? [])];
  return Array.from(new Set(candidates.map(normalizeRel)))
    .filter((f) => isTestFile(f) && existsSync(resolve(cwd, f)))
    .sort();
}

// ─── Core surface (shared code → full suite) ────────────────────────────────

/** Named shared/core surface: a change here is a change to everything.
 *  Exact paths for THIS repo's hubs (existence-checked) plus a portable
 *  basename rule (loop/runtime/executor/router/config stems) so a temp
 *  checkout or another repo with the same anatomy gets the same protection. */
const DEFAULT_CORE_PATHS = [
  'src/agent/loop.ts', // the agent loop
  'src/runtime.ts', // runtime core
  'src/tools/index.ts', // tool executor (executeTool)
  'src/model/router.ts', // model router
  'src/config.ts', // config
];
const CORE_STEM_RE = /(^|\/)(loop|runtime|executor|router|config)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;

export function isCoreSurface(rel: string, cwd: string): boolean {
  const n = normalizeRel(rel);
  if (CORE_STEM_RE.test(n)) return true;
  return DEFAULT_CORE_PATHS.some((p) => existsSync(resolve(cwd, p)) && n === p);
}

// ─── Change-set determination ───────────────────────────────────────────────

async function git(cwd: string, args: string[]): Promise<string> {
  return execArgvText('git', args, { cwd, maxBuffer: 1024 * 1024 });
}

/** Merge base for the committed-but-unmerged part of the change set: the
 *  branch's upstream when set, else the first of origin/main, origin/master,
 *  main, master that resolves. null when none is available (the caller then
 *  uses the status-only change set — the diff-vs-merge-base part is simply
 *  absent, which the brief allows: "when one is available"). */
export async function mergeBaseOf(cwd: string): Promise<string | null> {
  const candidates: string[] = [];
  try {
    const upstream = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).trim();
    if (upstream) candidates.push(upstream);
  } catch { /* no upstream */ }
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      await git(cwd, ['rev-parse', '--verify', '--quiet', ref]);
      candidates.push(ref);
    } catch { /* ref does not exist */ }
  }
  for (const ref of candidates) {
    try {
      const mb = (await git(cwd, ['merge-base', 'HEAD', ref])).trim();
      if (mb) return mb;
    } catch { /* no common ancestor */ }
  }
  return null;
}

export interface ChangeSet {
  files: string[];
  /** where each part came from — for the rationale */
  uncommitted: string[];
  committed: string[];
  mergeBase: string | null;
}

/** The gate's change set: uncommitted + staged files (git status), PLUS the
 *  diff against the merge base when one is available (committed work on a
 *  feature branch is exactly what a before-merge gate must see). Returns
 *  null when the change set cannot be determined (not a git repo / git
 *  failing) — a fail-safe trigger, never an empty-set alias. */
export async function determineChangeSet(cwd: string): Promise<ChangeSet | null> {
  try {
    const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim();
    if (inside !== 'true') return null;
  } catch {
    return null;
  }
  // gitChangedFiles throws only if git itself is broken; rev-parse above
  // already established a working repo.
  const uncommitted = (await gitChangedFiles(cwd)).filter((p) => !p.startsWith('.mochi/'));
  let committed: string[] = [];
  let mergeBase: string | null = null;
  mergeBase = await mergeBaseOf(cwd);
  if (mergeBase) {
    try {
      const out = await git(cwd, ['diff', '--name-only', mergeBase, 'HEAD']);
      committed = out
        .split('\n')
        .map((l) => normalizeRel(l.trim()))
        .filter((p) => p && !p.startsWith('.mochi/'));
    } catch { /* merge base diff unavailable — status-only change set */ }
  }
  const files = Array.from(new Set([...uncommitted, ...committed])).sort();
  return { files, uncommitted, committed, mergeBase };
}

// ─── Gate plan ──────────────────────────────────────────────────────────────

export type GateRule =
  | 'forced-full-flag'
  | 'forced-full-env'
  | 'before-merge'
  | 'change-set-undetermined'
  | 'empty-change-set'
  | 'core-surface'
  | 'core-fan-out'
  | 'selection-failed'
  | 'selection-timeout'
  | 'selection-declined'
  | 'runner-cannot-target'
  | 'blast-radius';

export interface GateRationale {
  mode: 'selected' | 'full';
  /** Which fail-safe rule (or selection rule) decided the mode. */
  rule: GateRule;
  reason: string;
  changedFiles: string[];
  /** Final file list the selected command runs (blast + always-run). */
  selectedTests: string[];
  /** Just the blast-radius part (reverse-import closure + mirrors). */
  blastTests: string[];
  /** The always-run core set portion actually on disk. */
  alwaysRun: string[];
  totalTestFiles: number;
}

export interface GatePlan {
  mode: 'selected' | 'full';
  /** The command that IS the gate for this change. Set iff mode='selected';
   *  mode='full' means "run the repo's full test command" (command omitted —
   *  same shape as the selector's fullRun convention). */
  command?: string;
  rationale: GateRationale;
}

/** Multi-line rationale block — printed as part of every gate run's output
 *  (evidence in VerifierEngine, summary + agent:log in the loop), never a
 *  side log. */
export function formatGateRationale(r: GateRationale): string {
  const count = r.totalTestFiles > 0 ? `${r.selectedTests.length}/${r.totalTestFiles} test files` : `${r.selectedTests.length} test files`;
  const head = r.mode === 'selected'
    ? `[GATE-SELECTED] ${count} — rule: ${r.rule}`
    : `[GATE-FULL] full suite (${r.totalTestFiles} test files) — rule: ${r.rule}`;
  const lines = [head, `  why: ${r.reason}`];
  const cf = r.changedFiles.length > 0 ? r.changedFiles.join(', ') : '(none — clean tree)';
  lines.push(`  changed files (${r.changedFiles.length}): ${cf.length > 400 ? cf.slice(0, 400) + '…' : cf}`);
  if (r.mode === 'selected') {
    lines.push(`  selected (${r.selectedTests.length}): ${r.selectedTests.join(', ') || '(none)'}`);
  }
  lines.push(`  always-run core set (${r.alwaysRun.length}): ${r.alwaysRun.join(', ') || '(none on disk)'}`);
  return lines.join('\n');
}

/** MOCHI_GATE_FULL=1 (or true/yes/on) forces the full suite everywhere the
 *  gate is consulted — engines, tools, and CLI callers all inherit it. */
export function gateEnvFull(): boolean {
  const v = (process.env.MOCHI_GATE_FULL ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export interface GateOptions extends Omit<BlastOptions, 'graph'> {
  /** --full flag: force the full suite. */
  full?: boolean;
  /** Before-merge path: ALWAYS the full suite. */
  beforeMerge?: boolean;
  /** Override the change set (tests / explicit diffs); else determined from git. */
  changedFiles?: string[];
  /** Wall-clock budget for the selection computation (default 10s). The
   *  budget is enforced cooperatively inside graph build + closure walk;
   *  exceeding it throws → the gate degrades to FULL. */
  selectionTimeoutMs?: number;
  /** Prebuilt graph (tests); built from cwd when absent. */
  graph?: ImportGraph;
  /** Extra always-run files on top of the default core set + config. */
  alwaysRun?: string[];
}

export async function planGateTests(cwd: string, repo: RepoInfo, opts: GateOptions = {}): Promise<GatePlan> {
  const timeoutMs = opts.selectionTimeoutMs ?? 10_000;
  const forced = (why: string, rule: GateRule, changed: string[] = [], totalTestFiles = 0): GatePlan => ({
    mode: 'full',
    rationale: { mode: 'full', rule, reason: why, changedFiles: changed, selectedTests: [], blastTests: [], alwaysRun: resolveAlwaysRun(cwd, opts.alwaysRun), totalTestFiles },
  });

  // 1-2. Forced-full overrides.
  if (opts.full) return forced('--full flag set — full suite forced', 'forced-full-flag');
  if (gateEnvFull()) return forced('MOCHI_GATE_FULL=1 — full suite forced', 'forced-full-env');
  if (opts.beforeMerge) return forced('before-merge path always runs the full suite', 'before-merge');

  // 3. Change-set determination (fail-safe: undeterminable → full).
  let changeSet: ChangeSet | null;
  try {
    changeSet = opts.changedFiles !== undefined
      ? { files: opts.changedFiles, uncommitted: opts.changedFiles, committed: [], mergeBase: null }
      : await determineChangeSet(cwd);
  } catch {
    changeSet = null;
  }
  if (changeSet === null) {
    return forced('change set could not be determined (git unavailable or not a repo) — full suite by fail-safe', 'change-set-undetermined');
  }
  const changed = changeSet.files;

  // 4. Empty change set: nothing to gate → the always-run core set as a
  //    health check. With no core set on disk either, there is nothing
  //    meaningful to narrow to — full suite (fail-safe).
  const alwaysRun = resolveAlwaysRun(cwd, opts.alwaysRun);
  if (changed.length === 0) {
    if (alwaysRun.length === 0) {
      return forced('change set is empty and no always-run core set exists — full suite by fail-safe', 'empty-change-set');
    }
    const runner = detectRunner(cwd, repo, repo.testCommand);
    const command = buildTargetedTestCommand(repo, alwaysRun, runner);
    if (!command) return forced('change set is empty but the runner cannot target the always-run core set', 'runner-cannot-target');
    return {
      mode: 'selected',
      command,
      rationale: {
        mode: 'selected', rule: 'empty-change-set',
        reason: 'change set is empty (clean tree) — running only the always-run core set as a standing-gate health check',
        changedFiles: [], selectedTests: alwaysRun, blastTests: [], alwaysRun, totalTestFiles: 0,
      },
    };
  }

  // 5-7. Shared/core surface → full (named core files, then the
  //      reverse-dependency fan-out threshold). The selector runs inside the
  //      same budget; ANY failure here — graph build, poisoned graph,
  //      timeout, selector decline — degrades to the FULL suite.
  const deadline = Date.now() + timeoutMs;
  const core = changed.find((f) => !isTestFile(f) && isCoreSurface(f, cwd));
  if (core) {
    return forced(`change touches shared/core surface (${core}: loop / runtime / tool executor / model router / config are imported repo-wide) — full suite by fail-safe`, 'core-surface', changed);
  }
  try {
    const graph = opts.graph ?? buildImportGraph(cwd, { deadlineMs: deadline });
    const totalTestFiles = graph.testFiles.length;
    const fanInLimit = Math.max(opts.maxFanIn ?? 25, Math.ceil(graph.files.length * 0.1));
    const fanOutFile = changed.find((f) => !isTestFile(f) && (graph.importersOf.get(f)?.size ?? 0) > fanInLimit);
    if (fanOutFile) {
      const fan = graph.importersOf.get(fanOutFile)!.size;
      return forced(`${fanOutFile} has reverse-dependency fan-out ${fan} > threshold ${fanInLimit} — full suite by fail-safe`, 'core-fan-out', changed, totalTestFiles);
    }
    const selection = selectBlastRadiusTests(cwd, changed, {
      ...opts,
      graph,
      deadlineMs: deadline,
    });
    if (selection.fullRun) {
      return forced(selection.reasons[0] ?? 'selection declined to narrow', 'selection-declined', changed, totalTestFiles);
    }
    // Selected: blast closure ∪ always-run core set, as one command.
    const selectedTests = Array.from(new Set([...selection.tests, ...alwaysRun])).sort();
    const runner = detectRunner(cwd, repo, repo.testCommand);
    const command = buildTargetedTestCommand(repo, selectedTests, runner);
    if (!command) {
      return forced(`${selectedTests.length} test file(s) selected but runner "${runner}" cannot target files — full suite by fail-safe`, 'runner-cannot-target', changed, totalTestFiles);
    }
    return {
      mode: 'selected',
      command,
      rationale: {
        mode: 'selected',
        rule: 'blast-radius',
        reason: [
          `reverse-import closure of ${changed.length} changed file(s)`,
          ...(selection.reasons.slice(1).length ? selection.reasons.slice(1) : []),
        ].join('; '),
        changedFiles: changed,
        selectedTests,
        blastTests: selection.tests.filter((t) => !alwaysRun.includes(t)),
        alwaysRun,
        totalTestFiles: selection.totalTests,
      },
    };
  } catch (err) {
    if (err instanceof SelectionTimeoutError) {
      return forced(`selection exceeded its ${timeoutMs}ms time budget — full suite by fail-safe`, 'selection-timeout', changed);
    }
    return forced(`selection computation failed (${err instanceof Error ? err.message : String(err)}) — full suite by fail-safe`, 'selection-failed', changed);
  }
}
