// P4: blast-radius test selection + verification policy.
//
// AUDIT CONTEXT (what existed before this module — MCH-72, core/test-select.ts):
// changed-file → related-test selection already existed and was wired into
// the verifier, the agent loop, and the verify tool. But its mapping was
// name-based only: mirrored test filenames plus a ONE-hop scan of test files'
// direct imports. A test that reaches the changed module transitively
// (test → helper → changed) was silently missed, the codegraph was never
// consulted, and there was no smoke set, no history input, and no cadence /
// confidence policy beyond "too many files / non-code file → full".
//
// This module is the policy-complete selector:
//   1. BLAST RADIUS — a file-level import graph over the whole repo; the
//      selected set is the reverse-import closure of the diff (tests that
//      transitively depend on anything changed), plus mirrored tests.
//      (The codegraph in repo/codegraph.ts is a SYMBOL graph for the
//      blast_radius/find_callers tools; test selection needs file-level
//      dependency closure — tests import files, not symbols — so the graph
//      here is built from the same specifier/stem semantics as test-select.)
//   2. SMOKE SET — a small always-run set (project-configurable, else
//      auto-detected entry-point tests) so a fundamental break is caught
//      even when the closure is narrow.
//   3. HISTORY — the flaky registry is the only per-test history store in
//      the harness (there is NO per-file failure history — audit finding).
//      Known-flaky/quarantined tests in the diff's area are added: they are
//      the tests with demonstrated sensitivity, and the flake machinery
//      downstream already knows how to excuse them if they misfire.
//   4. POLICY — full runs are forced on a cadence, on large diffs, and on
//      low confidence (test-infrastructure changes, high fan-in core
//      modules, unmappable changed files). On the substitution path (the
//      agent's verify tool), a selection covering most of the suite also
//      declines to narrow — running the suite's own command is cheaper
//      than a lookalike; fail-fast consumers still get the subset as an
//      ordering device regardless of coverage.
//
// THE EVIDENCE RULE (enforced by construction + labels, not by hope):
// selection is for IN-LOOP SPEED ONLY. Every plan this module returns is
// labeled: scope 'targeted' ⇒ label 'PARTIAL', certifying=false. A partial
// result can never certify anything — skill promotion, gate baselines,
// release verification, and the verifier's final PASS all require a FULL
// run (the verifier/loop call sites keep their existing shape: targeted
// runs are a fail-fast pre-check and the full suite still produces the
// verdict). Consumers that record outcomes (trajectory, skill attribution)
// only ever see verdicts derived from full runs; a PARTIAL verdict in
// their vocabulary increments verifiedPartials, never verifiedPasses, and
// isVerifiedRecord() rejects it. The tests in test-selection.test.ts wire
// those real consumers to prove a PARTIAL cannot satisfy them.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execArgvText } from '../exec.js';
import { SKIP_DIRS } from '../tools/glob.js';
import type { RepoInfo } from '../types.js';
import {
  normalizeRel,
  isTestFile,
  isCodeFile,
  candidateTestPaths,
  stemOf,
  resolveSpecifierStem,
  extractRelativeSpecifiers,
  detectRunner,
  buildTargetedTestCommand,
  gitChangedFiles,
} from './test-select.js';
import { KNOWN_FLAKE_SCORE, flakeFileOf, type FlakyRegistry } from './flaky.js';
import { mochiStateDir } from './mochi-dir.js';

// ─── Import graph ───────────────────────────────────────────────────────────

export interface ImportGraph {
  /** All code files in the repo (repo-relative, forward slashes). */
  files: string[];
  testFiles: string[];
  /** file → files that directly import it. */
  importersOf: Map<string, Set<string>>;
  /** file → files it directly imports (resolved, existing only). */
  importsOf: Map<string, Set<string>>;
  /** stem (deleted/unresolvable module) → files whose imports dangle on it. */
  danglingImporters: Map<string, Set<string>>;
}

/**
 * Build the file-level import graph by scanning relative import specifiers
 * and resolving them with test-select's stem semantics. JS/TS-family files
 * get real edges; other languages contribute nodes (their mirrored tests
 * still resolve) but few edges — the selector's low-confidence rules treat
 * an edgeless changed file accordingly.
 */
export function buildImportGraph(cwd: string, opts: { maxFiles?: number } = {}): ImportGraph {
  const maxFiles = opts.maxFiles ?? 20000;
  const files: string[] = [];
  const stack: string[] = ['.'];
  while (stack.length > 0 && files.length < maxFiles) {
    const relDir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(resolve(cwd, relDir));
    } catch {
      continue;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const rel = normalizeRel(join(relDir, name));
      const abs = resolve(cwd, rel);
      let isDir: boolean;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        stack.push(rel);
        continue;
      }
      if (isCodeFile(rel)) files.push(rel);
    }
  }
  files.sort();
  const byStem = new Map<string, string[]>();
  for (const f of files) {
    const s = stemOf(f);
    const arr = byStem.get(s) ?? [];
    arr.push(f);
    byStem.set(s, arr);
  }
  const importersOf = new Map<string, Set<string>>();
  const importsOf = new Map<string, Set<string>>();
  const danglingImporters = new Map<string, Set<string>>();
  const addEdge = (map: Map<string, Set<string>>, k: string, v: string) => {
    const set = map.get(k) ?? new Set<string>();
    set.add(v);
    map.set(k, set);
  };
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(resolve(cwd, f), 'utf8');
    } catch {
      continue;
    }
    for (const spec of extractRelativeSpecifiers(content)) {
      const stem = resolveSpecifierStem(f, spec);
      if (!stem) continue;
      const targets = byStem.get(stem);
      if (targets && targets.length > 0) {
        for (const t of targets) {
          if (t === f) continue;
          addEdge(importsOf, f, t);
          addEdge(importersOf, t, f);
        }
      } else {
        addEdge(danglingImporters, stem, f);
      }
    }
  }
  return {
    files,
    testFiles: files.filter(isTestFile),
    importersOf,
    importsOf,
    danglingImporters,
  };
}

// ─── Policy helpers ─────────────────────────────────────────────────────────

const TEST_INFRA_DIRS = new Set(['testutil', 'test-utils', 'testing', '__mocks__', '__fixtures__', 'fixtures']);
const RUNNER_CONFIG_RE = /(^|\/)(vitest|jest|mocha|karma|ava|tap|playwright|cypress)\.config\.[^/]+$/i;
const SETUP_FILE_RE = /(^|\/)(setup|test-setup|global-setup|conftest)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|py)$/i;

/** True when a changed file can invalidate the WHOLE suite's mapping:
 *  test-runner config, shared setup, or shared test-support code. */
export function isTestInfraChange(rel: string): boolean {
  const n = normalizeRel(rel);
  if (RUNNER_CONFIG_RE.test(n) || SETUP_FILE_RE.test(n)) return true;
  return n.split('/').some((seg) => TEST_INFRA_DIRS.has(seg));
}

function areaPrefix(rel: string): string {
  const parts = normalizeRel(rel).split('/');
  return parts.slice(0, Math.min(2, parts.length - 1)).join('/');
}

// ─── Selector ───────────────────────────────────────────────────────────────

export interface SelectionBreakdown {
  blast: string[];
  smoke: string[];
  history: string[];
  changedTests: string[];
}

export interface BlastSelection {
  /** true ⇒ do not narrow; run the full suite. `tests` is empty then. */
  fullRun: boolean;
  confidence: 'high' | 'low';
  tests: string[];
  breakdown: SelectionBreakdown;
  reasons: string[];
  totalTests: number;
  graphFiles: number;
}

export interface BlastOptions {
  maxChangedFiles?: number;
  /** Reverse-import closure depth. */
  depth?: number;
  /** A changed file with more direct importers than this is a core module:
   *  confidence drops and the full suite runs. */
  maxFanIn?: number;
  /** Planner-level (substitution path): if the selection would cover more
   *  than this fraction of all tests, narrowing buys nothing — run full. */
  maxSelectedFraction?: number;
  smokeLimit?: number;
  /** Explicit smoke set (else project config, else auto-detected). */
  smoke?: string[];
  /** The persisted flaky registry (read-only use). */
  flakyRegistry?: Pick<FlakyRegistry, 'entries'> | null;
  /** Prebuilt graph (tests / measurement); built from `cwd` when absent. */
  graph?: ImportGraph;
}

const EMPTY_BREAKDOWN: SelectionBreakdown = { blast: [], smoke: [], history: [], changedTests: [] };

function full(confidence: 'high' | 'low', reason: string, totalTests: number, graphFiles: number): BlastSelection {
  return { fullRun: true, confidence, tests: [], breakdown: { ...EMPTY_BREAKDOWN }, reasons: [reason], totalTests, graphFiles };
}

/** Project smoke config: `.mochi/test-selection.json` → { "smoke": [...] }. */
export function loadSmokeConfig(cwd: string): string[] | null {
  try {
    const raw = JSON.parse(readFileSync(resolve(mochiStateDir(cwd), 'test-selection.json'), 'utf8'));
    if (Array.isArray(raw?.smoke)) return raw.smoke.filter((s: unknown): s is string => typeof s === 'string');
  } catch {
    /* no config — auto-detect */
  }
  return null;
}

const ENTRY_TEST_RE = /(^|\/)(index|cli|main|app|runtime)\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;

/** Auto smoke set: tests mirroring entry-point modules, smallest first
 *  (file size is the only offline proxy for "fast"), capped. */
function autoSmoke(cwd: string, graph: ImportGraph, limit: number): string[] {
  const cands = graph.testFiles.filter((f) => ENTRY_TEST_RE.test(f) && f.split('/').length <= 3);
  const sized = cands.map((f) => {
    let size = Number.MAX_SAFE_INTEGER;
    try {
      size = statSync(resolve(cwd, f)).size;
    } catch { /* keep */ }
    return { f, size };
  });
  sized.sort((a, b) => a.size - b.size || a.f.localeCompare(b.f));
  return sized.slice(0, limit).map((s) => s.f);
}

export function selectBlastRadiusTests(cwd: string, changed: string[], opts: BlastOptions = {}): BlastSelection {
  const maxChangedFiles = opts.maxChangedFiles ?? 30;
  const depth = opts.depth ?? 3;
  const maxFanIn = opts.maxFanIn ?? 25;
  const smokeLimit = opts.smokeLimit ?? 4;

  const files = Array.from(new Set(changed.map(normalizeRel).filter(Boolean)));
  if (files.length === 0) return full('low', 'no changed files', 0, 0);
  if (files.length > maxChangedFiles) {
    return full('low', `${files.length} changed files exceeds the ${maxChangedFiles}-file selection limit`, 0, 0);
  }
  const nonCode = files.find((f) => !isCodeFile(f));
  if (nonCode) return full('low', `non-code change (${nonCode}) can affect the whole suite`, 0, 0);
  const infra = files.find((f) => isTestInfraChange(f));
  if (infra) return full('low', `test-infrastructure change (${infra}) invalidates the test mapping`, 0, 0);

  const graph = opts.graph ?? buildImportGraph(cwd);
  const totalTests = graph.testFiles.length;
  const graphFiles = graph.files.length;
  if (totalTests === 0) return full('low', 'no test files found in the repo', totalTests, graphFiles);
  const onDisk = new Set(graph.files);

  // Fan-in guard: a change to a module a large FRACTION of the repo imports
  // directly (type hubs, barrels — semantic reach far beyond what tests
  // touching it can cover) is a change to everything, whatever the closure
  // says. The threshold scales with repo size (floor of maxFanIn): on the
  // Mochi repo the biggest real module (agent/loop.ts, ~43 importers of
  // ~1000 files) stays selectable, while a hub imported by >10% of all
  // files trips the guard.
  const fanInLimit = Math.max(maxFanIn, Math.ceil(graphFiles * 0.1));
  for (const f of files) {
    if (isTestFile(f)) continue;
    const fanIn = graph.importersOf.get(f)?.size ?? 0;
    if (fanIn > fanInLimit) {
      return full('low', `${f} is imported by ${fanIn} files (core module, fan-in > ${fanInLimit})`, totalTests, graphFiles);
    }
  }

  // Reverse-import closure, computed PER changed file so coverage is exact:
  // a test covers f iff it sits in f's own reverse closure (it transitively
  // imports f). Deleted files are not on disk, so nothing imports them in
  // the graph — their former importers dangle on the deleted stem instead,
  // and seed that file's closure.
  const blast = new Set<string>();
  const changedTests: string[] = [];
  const unmappable: string[] = [];
  const affected = new Set<string>();
  for (const f of files) {
    if (isTestFile(f)) {
      if (onDisk.has(f)) changedTests.push(f);
      continue;
    }
    const closure = new Set<string>([f]);
    let frontier = [f];
    if (!onDisk.has(f)) {
      frontier = Array.from(graph.danglingImporters.get(stemOf(f)) ?? []);
      for (const imp of frontier) closure.add(imp);
    }
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const importer of graph.importersOf.get(node) ?? []) {
          if (!closure.has(importer)) {
            closure.add(importer);
            next.push(importer);
          }
        }
      }
      if (next.length === 0) break;
      frontier = next;
    }
    let covered = false;
    for (const node of closure) {
      affected.add(node);
      if (isTestFile(node) && onDisk.has(node)) {
        blast.add(node);
        covered = true;
      }
    }
    for (const c of candidateTestPaths(f)) {
      if (onDisk.has(c)) {
        blast.add(c);
        covered = true;
      }
    }
    if (!covered) unmappable.push(f);
  }
  if (unmappable.length > 0) {
    return full('low', `no test covers ${unmappable.join(', ')} — selection confidence too low`, totalTests, graphFiles);
  }

  // Smoke set.
  const smokeWanted = opts.smoke ?? loadSmokeConfig(cwd) ?? autoSmoke(cwd, graph, smokeLimit);
  const smoke = smokeWanted
    .map(normalizeRel)
    .filter((f) => isTestFile(f) && onDisk.has(f) && !blast.has(f) && !changedTests.includes(f))
    .slice(0, Math.max(smokeLimit, smokeWanted.length));

  // History: known-flaky/quarantined tests in the diff's area.
  const history: string[] = [];
  const reg = opts.flakyRegistry;
  if (reg) {
    const areas = new Set(files.map(areaPrefix));
    for (const entry of Object.values(reg.entries)) {
      if (entry.score < KNOWN_FLAKE_SCORE) continue;
      const f = flakeFileOf(entry.id);
      if (!f) continue;
      const nf = normalizeRel(f);
      if (!isTestFile(nf) || !onDisk.has(nf)) continue;
      if (blast.has(nf) || changedTests.includes(nf) || smoke.includes(nf)) continue;
      if (affected.has(nf) || areas.has(areaPrefix(nf))) history.push(nf);
    }
    history.sort();
  }

  const tests = Array.from(new Set([...blast, ...smoke, ...history, ...changedTests])).sort();
  if (tests.length === 0) {
    return full('low', 'selection produced an empty set', totalTests, graphFiles);
  }
  // NOTE: a selection covering most (even all) of the suite is NOT a
  // confidence problem — it IS the suite, correctly mapped. Whether running
  // it as a "subset" buys anything is an economics question for the
  // substitution consumer (the planner's verify-tool path), not a mapping
  // question; the fail-fast consumers use the subset as an ordering device
  // and must receive it regardless of coverage.
  const breakdown: SelectionBreakdown = {
    blast: Array.from(blast).sort(),
    smoke,
    history,
    changedTests: changedTests.sort(),
  };
  const reasons = [
    `blast radius: ${breakdown.blast.length} test(s) in the reverse-import closure of ${files.length} changed file(s)`,
    ...(breakdown.smoke.length ? [`smoke set: ${breakdown.smoke.length} always-run test(s)`] : []),
    ...(breakdown.history.length ? [`history: ${breakdown.history.length} known-flaky test(s) in the changed area (flaky registry)`] : []),
    ...(breakdown.changedTests.length ? [`changed test files: ${breakdown.changedTests.length}`] : []),
  ];
  return { fullRun: false, confidence: 'high', tests, breakdown, reasons, totalTests, graphFiles };
}

// ─── Cadence state ──────────────────────────────────────────────────────────

export interface SelectionState {
  version: 1;
  targetedSinceFull: number;
  lastFullAt: number | null;
  lastTargetedAt: number | null;
  updatedAt: number;
}

export function selectionStatePath(cwd: string): string {
  return resolve(mochiStateDir(cwd), 'state', 'test-selection.json');
}

export function loadSelectionState(cwd: string): SelectionState {
  const base: SelectionState = { version: 1, targetedSinceFull: 0, lastFullAt: null, lastTargetedAt: null, updatedAt: 0 };
  try {
    const raw = JSON.parse(readFileSync(selectionStatePath(cwd), 'utf8'));
    if (raw && typeof raw === 'object' && typeof raw.targetedSinceFull === 'number') {
      return { ...base, ...raw, version: 1 };
    }
  } catch {
    /* no state yet */
  }
  return base;
}

/** Record that a run happened: targeted runs advance the cadence counter,
 *  full runs reset it. Best-effort — state I/O never breaks verification. */
export function recordSelectionRun(cwd: string, scope: 'targeted' | 'full', now = Date.now()): SelectionState {
  const state = loadSelectionState(cwd);
  if (scope === 'full') {
    state.targetedSinceFull = 0;
    state.lastFullAt = now;
  } else {
    state.targetedSinceFull += 1;
    state.lastTargetedAt = now;
  }
  state.updatedAt = now;
  try {
    mkdirSync(dirname(selectionStatePath(cwd)), { recursive: true });
    writeFileSync(selectionStatePath(cwd), JSON.stringify(state, null, 2));
  } catch {
    /* best effort */
  }
  return state;
}

// ─── Planner ────────────────────────────────────────────────────────────────

export interface VerificationPlan {
  scope: 'targeted' | 'full';
  /** The evidence label recorded wherever this plan's result is recorded. */
  label: 'PARTIAL' | 'FULL';
  /** true ONLY for a full-suite plan. A targeted plan can never certify:
   *  promotion, gate baselines, release checks, and the verifier's final
   *  PASS must all demand `certifying === true` evidence. */
  certifying: boolean;
  command?: string;
  files: string[];
  reason: string;
  selection?: BlastSelection;
}

export interface PlanOptions extends BlastOptions {
  /** Override the changed-file list (tests / measurement / explicit diffs). */
  changedFiles?: string[];
  /** Override the diff size in lines (else measured from git). */
  diffLines?: number;
  maxDiffLines?: number;
  /** Consult the cadence state (default true). Gate paths that always run
   *  the full suite right after pass false — cadence governs the agent's
   *  iterative verify-tool calls, not the authoritative gate. */
  cadence?: boolean;
  cadenceFullEvery?: number;
  /** Explicit user intent (verify scope:"related"): bypass cadence and
   *  diff-size guards, never the safety mapping. */
  forceTargeted?: boolean;
  now?: number;
}

function fullPlan(reason: string, selection?: BlastSelection): VerificationPlan {
  return { scope: 'full', label: 'FULL', certifying: true, files: [], reason, ...(selection ? { selection } : {}) };
}

/** Changed lines vs HEAD (tracked, via numstat) + untracked file sizes. */
export async function gitDiffLines(cwd: string, changed: string[]): Promise<number> {
  let lines = 0;
  try {
    const out = await execArgvText('git', ['diff', 'HEAD', '--numstat'], { cwd, maxBuffer: 1024 * 1024 });
    for (const line of out.split('\n')) {
      const m = /^(\d+)\t(\d+)\t/.exec(line);
      if (m) lines += Number(m[1]) + Number(m[2]);
    }
  } catch {
    /* not a git repo — caller treats unknown size as 0 and relies on file count */
  }
  // Untracked files don't appear in `git diff HEAD`; count their lines.
  try {
    const status = await execArgvText('git', ['status', '--porcelain'], { cwd, maxBuffer: 1024 * 1024 });
    const untracked = new Set(
      status
        .split('\n')
        .filter((l) => l.startsWith('?? '))
        .map((l) => normalizeRel(l.slice(3).replace(/^"(.*)"$/, '$1'))),
    );
    for (const f of changed) {
      if (!untracked.has(f)) continue;
      try {
        const content = readFileSync(resolve(cwd, f), 'utf8');
        lines += Math.min(content.split('\n').length, 500);
      } catch { /* raced deletion */ }
    }
  } catch { /* best effort */ }
  return lines;
}

/**
 * End-to-end policy: decide targeted vs full for one verification pass.
 * `scope: 'full'` (with `command: undefined`) means "run the repo's full
 * test command" — the only certifying outcome.
 */
export async function planVerificationTests(
  cwd: string,
  repo: RepoInfo,
  testCommand?: string,
  opts: PlanOptions = {},
): Promise<VerificationPlan> {
  const maxDiffLines = opts.maxDiffLines ?? 1000;
  const changed = opts.changedFiles ?? (await gitChangedFiles(cwd));

  if (!opts.forceTargeted) {
    if (changed.length > (opts.maxChangedFiles ?? 30)) {
      return fullPlan(`${changed.length} changed files exceeds the ${opts.maxChangedFiles ?? 30}-file selection limit`);
    }
    const diffLines = opts.diffLines ?? (await gitDiffLines(cwd, changed));
    if (diffLines > maxDiffLines) {
      return fullPlan(`diff is ${diffLines} lines (> ${maxDiffLines}) — too large to narrow safely`);
    }
    if (opts.cadence !== false) {
      const every = opts.cadenceFullEvery ?? 5;
      const state = loadSelectionState(cwd);
      if (state.targetedSinceFull >= every) {
        return fullPlan(`cadence: ${state.targetedSinceFull} targeted runs since the last full run (every ${every}) — periodic full run`);
      }
    }
  }

  let flakyRegistry = opts.flakyRegistry;
  if (flakyRegistry === undefined) {
    try {
      const raw = JSON.parse(readFileSync(resolve(mochiStateDir(cwd), 'state', 'flaky-tests.json'), 'utf8'));
      if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') {
        flakyRegistry = raw as Pick<FlakyRegistry, 'entries'>;
      }
    } catch {
      flakyRegistry = null;
    }
  }

  const selection = selectBlastRadiusTests(cwd, changed, { ...opts, flakyRegistry: flakyRegistry ?? null });
  if (selection.fullRun) {
    return fullPlan(selection.reasons[0] ?? 'selection declined to narrow', selection);
  }
  // Substitution economics (verify-tool path only — the cadence-enabled
  // consumer): when the subset is most of the suite, run the suite's own
  // command instead of a lookalike. Fail-fast consumers (cadence: false)
  // skip this: for them the subset is an ordering device, not a substitute.
  if (!opts.forceTargeted && opts.cadence !== false && selection.totalTests > 0) {
    const maxFraction = opts.maxSelectedFraction ?? 0.6;
    if (selection.tests.length / selection.totalTests > maxFraction) {
      return fullPlan(
        `blast radius covers ${selection.tests.length}/${selection.totalTests} test files (> ${Math.round(maxFraction * 100)}%) — narrowing buys nothing`,
        selection,
      );
    }
  }
  const runner = detectRunner(cwd, repo, testCommand);
  const command = buildTargetedTestCommand(repo, selection.tests, runner);
  if (!command) {
    return fullPlan(`${selection.tests.length} related test(s); runner "${runner}" cannot target files`, selection);
  }
  return {
    scope: 'targeted',
    label: 'PARTIAL',
    certifying: false,
    command,
    files: selection.tests,
    reason: `PARTIAL (targeted subset, ${selection.tests.length}/${selection.totalTests} test files): ${selection.reasons.join('; ')}`,
    selection,
  };
}
