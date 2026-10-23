// Task-class scorecard (`mochi bench classes`) — ONE honest table for every
// kind of work Mochi claims to be good at: short tasks, medium coding,
// complex/long-horizon, SWE-style, security/red-team, automation, browser.
//
// Design rules (the project's measured-over-claimed discipline, applied to
// the harness itself):
//   - Every cell is traceable to recorded trial outcomes or an ingested
//     result file. Nothing is interpolated, ever.
//   - A class with no measurements reports UNMEASURED — never 0%, never a
//     guess, never a sibling class's numbers.
//   - Dry-run / stub numbers (turns, tokens fabricated by the plumbing
//     runner; costs estimated from the offline price table) are labelled
//     SYNTHETIC wherever they appear.
//   - Fixture classes must be DISJOINT from the frozen gate set, from each
//     other, and from every public eval on the blocklist. The guard runs
//     before any measurement and refuses the run on overlap — a scorecard
//     that quietly rewards memorised gate tasks would be worse than none.
//
// Fixture sets reuse the frozen-set on-disk format (bench/frozen/README.md)
// so there is exactly ONE task format across the bench: a directory with
// manifest.json + tasks/<id>/{prompt.txt, files/, solution/, verify.mjs}.
// Classes whose dedicated fixture waves are still in flight (endurance,
// browser, SWE pack, red-team pack) plug in either by adding such a set
// directory or by dropping a result file into bench/classes/inbox/<class>/
// — see bench/classes/README.md for the full integration contract.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { estimateCostUsd } from '../pricing.js';
import {
  aggregate, assertNoBlocklistOverlap, createSubprocessRunner, executeRun,
  loadFrozenSet, loadManifest, passAt1,
  type FrozenSet, type FrozenTask, type RunResults, type TaskRunner,
} from './regression-gate.js';

export class ClassError extends Error {
  /** Process exit code the CLI should use for this failure class. */
  readonly exitCode = 3;
  constructor(message: string) {
    super(message);
    this.name = 'ClassError';
  }
}

// ---------------------------------------------------------------------------
// Class registry
// ---------------------------------------------------------------------------

export type ClassSourceKind = 'fixtures' | 'frozen' | 'inbox';

export interface ClassDef {
  id: string;
  label: string;
  kind: ClassSourceKind;
  /** Set directory relative to repo root (fixtures/frozen kinds). */
  setDir?: string;
  /** What the table's Source column shows. */
  sourceLabel: string;
  /** How future fixture waves plug into this class (bench/classes/README.md). */
  contractNote: string;
}

export const CLASS_DEFS: ClassDef[] = [
  {
    id: 'short', label: 'Short tasks', kind: 'fixtures', setDir: 'bench/classes/short',
    sourceLabel: 'bench/classes/short fixtures',
    contractNote: 'In-tree fixture set (12 tasks).',
  },
  {
    id: 'medium', label: 'Medium coding', kind: 'fixtures', setDir: 'bench/classes/medium',
    sourceLabel: 'bench/classes/medium fixtures',
    contractNote: 'In-tree fixture set (8 tasks).',
  },
  {
    id: 'complex', label: 'Complex / long-horizon', kind: 'frozen', setDir: 'bench/frozen',
    sourceLabel: 'frozen gate set (interim adapter)',
    contractNote: 'Interim source: the frozen regression gate set is the most demanding in-tree coding set today. Wave N endurance fixtures supersede this adapter by adding a set directory and repointing this class (see bench/classes/README.md).',
  },
  {
    id: 'swe', label: 'SWE-style', kind: 'inbox',
    sourceLabel: 'results inbox (SWE-bench Pro V2, eval-only)',
    contractNote: 'Eval-only: instances live in bench/external and are never copied into fixtures. Scored runs (bench/external/targets.mjs) drop a result file into bench/classes/inbox/swe/.',
  },
  {
    id: 'redteam', label: 'Security / red-team', kind: 'inbox',
    sourceLabel: 'results inbox (red-team pack)',
    contractNote: 'The red-team fixture pack plugs in via bench/classes/inbox/redteam/ result files, or as a fixture set directory once it lands.',
  },
  {
    id: 'automation', label: 'Automation (terminal)', kind: 'inbox',
    sourceLabel: 'results inbox (Terminal-Bench 4.0, eval-only)',
    contractNote: 'Eval-only: Terminal-Bench runs (bench/external/targets.mjs) drop a result file into bench/classes/inbox/automation/.',
  },
  {
    id: 'browser', label: 'Browser', kind: 'inbox',
    sourceLabel: 'results inbox (browser fixtures)',
    contractNote: 'Wave M browser fixtures plug in via bench/classes/inbox/browser/ result files, or as a fixture set directory once they land.',
  },
];

export function classDef(id: string): ClassDef {
  const def = CLASS_DEFS.find((d) => d.id === id);
  if (!def) throw new ClassError(`unknown class '${id}'. Known classes: ${CLASS_DEFS.map((d) => d.id).join(', ')}`);
  return def;
}

// ---------------------------------------------------------------------------
// Summaries — the scorecard's row shape
// ---------------------------------------------------------------------------

export interface TaskSummary {
  id: string;
  trials: number;
  passes: number;
  passRate: number;
  medianTurns: number | null;
  medianTokens: number | null;
}

export interface ClassSummary {
  classId: string;
  label: string;
  source: string;
  status: 'measured' | 'unmeasured';
  /** 'dry-run' | 'live' for measured rows; null when unmeasured. */
  mode: 'dry-run' | 'live' | null;
  /** Model that produced the numbers, when known (inbox results name it). */
  model: string | null;
  taskCount: number;
  trials: number;
  passes: number;
  /** pass@1 (mean per-task pass rate, the gate's convention); null when unmeasured. */
  passRate: number | null;
  medianTurns: number | null;
  medianTokens: number | null;
  /** Total tokens ÷ passed trials (the gate's costPerSolve convention). */
  costPerSolveTokens: number | null;
  /** USD per solve: real when provider-reported/estimated per call in live
   *  runs; an offline price-table estimate over synthetic tokens in
   *  dry-run mode. `costSynthetic` says which. */
  costPerSolveUsd: number | null;
  costSynthetic: boolean;
  tasks: TaskSummary[];
  note?: string;
}

export interface ScorecardRecord {
  kind: 'mochi-class-scorecard-run';
  ts: string;
  gitHead: string | null;
  mode: 'dry-run' | 'live';
  k: number;
  classes: ClassSummary[];
}

function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function unmeasured(def: ClassDef, note?: string): ClassSummary {
  return {
    classId: def.id, label: def.label, source: def.sourceLabel, status: 'unmeasured',
    mode: null, model: null, taskCount: 0, trials: 0, passes: 0, passRate: null,
    medianTurns: null, medianTokens: null, costPerSolveTokens: null, costPerSolveUsd: null,
    costSynthetic: false, tasks: [], note: note ?? def.contractNote,
  };
}

// ---------------------------------------------------------------------------
// Disjointness guard — the scorecard refuses to run on contaminated fixtures
// ---------------------------------------------------------------------------

/** Every file that defines a task's content (same coverage as the frozen
 *  set's task hash: prompt, setup files, solution files, verifier). */
function taskContentFiles(setDir: string, entry: { prompt: string; filesDir?: string; solutionDir?: string; verifier: string }): string[] {
  const out: string[] = [];
  const push = (rel: string) => out.push(join(setDir, rel));
  push(entry.prompt);
  push(entry.verifier);
  for (const dir of [entry.filesDir, entry.solutionDir]) {
    if (!dir) continue;
    const abs = join(setDir, dir);
    const walk = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(p);
      }
    };
    if (existsSync(abs)) walk(abs);
  }
  return out;
}

/** Task-level content fingerprints across named sets. Two tasks count as
 *  THE SAME TASK (contamination) when they share the prompt AND the
 *  verifier, or when one task's entire content is contained in the other's.
 *  A single shared boilerplate file between otherwise different tasks is
 *  not contamination and is ignored — the unit of overlap is the task,
 *  because the task is what an agent could have memorised. Throws
 *  ClassError on the first offending pair (across sets, or duplicated
 *  inside one set). */
export function assertNoContentOverlap(namedSets: { setId: string; dir: string }[]): void {
  interface TaskPrint { where: string; prompt: string; verifier: string; files: Set<string> }
  const prints: TaskPrint[] = [];
  const hashFile = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
  for (const { setId, dir } of namedSets) {
    const manifest = loadManifest(dir); // shape-checked by the gate loader
    for (const entry of manifest.tasks) {
      prints.push({
        where: `${setId}:${entry.id}`,
        prompt: hashFile(join(dir, entry.prompt)),
        verifier: hashFile(join(dir, entry.verifier)),
        files: new Set(taskContentFiles(dir, entry).map(hashFile)),
      });
    }
  }
  for (let i = 0; i < prints.length; i++) {
    for (let j = i + 1; j < prints.length; j++) {
      const a = prints[i], b = prints[j];
      const sameTask = a.prompt === b.prompt && a.verifier === b.verifier;
      const smaller = a.files.size <= b.files.size ? a : b;
      const larger = smaller === a ? b : a;
      const contained = [...smaller.files].every((h) => larger.files.has(h));
      if (sameTask || contained) {
        throw new ClassError(
          `scorecard fixture overlap: task ${a.where} duplicates task ${b.where} ` +
          `(${sameTask ? 'identical prompt + verifier' : 'one task\'s content is wholly contained in the other\'s'}). ` +
          'Class fixtures must be disjoint from the frozen gate set, from each other, and from every public eval — ' +
          'a copied task would let the scorecard reward memorisation. Remove the duplicate and re-freeze the set.',
        );
      }
    }
  }
}

/** Load every in-tree set the scorecard may measure (frozen + fixture
 *  classes), verify hashes via the gate loader, check the eval blocklist,
 *  and check pairwise content disjointness. Returns the loaded sets keyed
 *  by class id (plus 'frozen' for the reference set). Sets whose directory
 *  has no manifest are reported as missing, not loaded — the caller turns
 *  those classes UNMEASURED. A manifest that exists but fails integrity is
 *  a hard error: an unmeasurable-for-tampering set is not "unmeasured". */
export async function loadScorecardSets(repoRoot: string): Promise<{ sets: Map<string, FrozenSet>; missing: Set<string> }> {
  const blocklistPath = join(repoRoot, 'bench', 'external', 'eval_blocklist.json');
  const frozenDir = join(repoRoot, 'bench', 'frozen');
  const sets = new Map<string, FrozenSet>();
  const missing = new Set<string>();

  const load = (key: string, dir: string): FrozenSet | null => {
    if (!existsSync(join(dir, 'manifest.json'))) { missing.add(key); return null; }
    const set = loadFrozenSet(dir); // throws GateError on tampering — propagates
    sets.set(key, set);
    return set;
  };

  const frozen = load('frozen', frozenDir);
  if (!frozen) throw new ClassError(`frozen gate set not found at ${frozenDir} — the scorecard needs it as the disjointness reference.`);
  await assertNoBlocklistOverlap(frozen, blocklistPath);

  const named: { setId: string; dir: string }[] = [{ setId: 'frozen', dir: frozenDir }];
  for (const def of CLASS_DEFS) {
    if (def.kind === 'inbox' || !def.setDir) continue;
    const dir = join(repoRoot, def.setDir);
    if (def.kind === 'frozen') { sets.set(def.id, frozen); continue; }
    const set = load(def.id, dir);
    if (set) {
      await assertNoBlocklistOverlap(set, blocklistPath);
      named.push({ setId: def.id, dir });
    }
  }
  assertNoContentOverlap(named);
  return { sets, missing };
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

/** Reference model for SYNTHETIC cost estimates: dry-run tokens are priced
 *  with the offline price table at this model's list rate so a plumbing
 *  run still yields a comparable (labelled synthetic) $ figure. */
export const SYNTHETIC_COST_MODEL = 'claude-sonnet-4-5';
/** Assumed input/output split for pricing total-token counts (the dry
 *  runner fabricates totals only). Declared, not hidden. */
const SYNTHETIC_INPUT_SHARE = 0.8;

function hashOf(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.codePointAt(0)!) % 9973;
  return h;
}

/** Dry-run runner for the scorecard: applies the canned solution overlay
 *  (same plumbing role as the gate's dry runner) and fabricates DETERMINISTIC
 *  turns/tokens from the task id + trial, so medians are stable across runs.
 *  Every number it yields is labelled synthetic downstream. */
export function createClassDryRunner(): TaskRunner {
  return async (task: FrozenTask, trial: number, workdir: string) => {
    if (task.absSolutionDir && existsSync(task.absSolutionDir)) {
      cpSync(task.absSolutionDir, workdir, { recursive: true });
    }
    const h = hashOf(`${task.id}#${trial}`);
    return {
      exitCode: 0,
      timedOut: false,
      tokens: 900 + (h % 600),
      turns: 2 + (h % 6),
      costUsd: null,
      failureClass: null,
      traceIds: [],
      detail: 'dry-run: canned solution applied, mochi not invoked',
    };
  };
}

// ---------------------------------------------------------------------------
// Summarising one executed set into a class row
// ---------------------------------------------------------------------------

function estimateUsdFromTokens(totalTokens: number): number | null {
  const est = estimateCostUsd(SYNTHETIC_COST_MODEL, {
    inputTokens: Math.round(totalTokens * SYNTHETIC_INPUT_SHARE),
    outputTokens: Math.round(totalTokens * (1 - SYNTHETIC_INPUT_SHARE)),
  });
  return est ? est.costUsd : null;
}

export function summarizeExecutedSet(
  def: ClassDef, set: FrozenSet, run: RunResults, mode: 'dry-run' | 'live',
): ClassSummary {
  const aggs = aggregate(run, set);
  const trials = run.trials;
  const passes = trials.filter((t) => t.passed).length;

  const tasks: TaskSummary[] = set.tasks.map((t) => {
    const ts = trials.filter((x) => x.taskId === t.id);
    return {
      id: t.id,
      trials: ts.length,
      passes: ts.filter((x) => x.passed).length,
      passRate: ts.length ? ts.filter((x) => x.passed).length / ts.length : 0,
      medianTurns: median(ts.map((x) => x.turns).filter((x): x is number => x != null)),
      medianTokens: median(ts.map((x) => x.tokens).filter((x): x is number => x != null)),
    };
  });

  // Cost-per-solve, gate convention: totals ÷ passed trials, only when the
  // totals are complete (a partial sum would flatter the run).
  const totalTokens = aggs.every((a) => a.tokens != null) ? aggs.reduce((s, a) => s + (a.tokens ?? 0), 0) : null;
  const costPerSolveTokens = passes > 0 && totalTokens != null ? totalTokens / passes : null;
  let costPerSolveUsd: number | null = null;
  let costSynthetic = false;
  if (passes > 0) {
    if (mode === 'live' && aggs.every((a) => a.costUsd != null)) {
      costPerSolveUsd = aggs.reduce((s, a) => s + (a.costUsd ?? 0), 0) / passes;
    } else if (totalTokens != null) {
      const est = estimateUsdFromTokens(totalTokens);
      if (est != null) { costPerSolveUsd = est / passes; costSynthetic = true; }
    }
  }
  if (mode === 'dry-run') costSynthetic = costPerSolveUsd != null;

  return {
    classId: def.id, label: def.label, source: def.sourceLabel, status: 'measured',
    mode, model: null,
    taskCount: set.tasks.length, trials: trials.length, passes,
    passRate: passAt1(aggs),
    medianTurns: median(trials.map((t) => t.turns).filter((x): x is number => x != null)),
    medianTokens: median(trials.map((t) => t.tokens).filter((x): x is number => x != null)),
    costPerSolveTokens, costPerSolveUsd, costSynthetic,
    tasks,
  };
}

// ---------------------------------------------------------------------------
// Inbox ingestion — result files dropped by external / in-flight-wave runners
// ---------------------------------------------------------------------------

/** The inbox result-file schema (bench/classes/README.md has the contract).
 *  One file = one scored run of one class, produced by a runner that owns
 *  its own fixtures (external eval harnesses, Wave M/N packs). */
export interface InboxResultFile {
  kind: 'mochi-class-result';
  class: string;
  source: string;
  mode: 'live' | 'dry-run';
  model?: string;
  ts: string;
  tasks: {
    id: string; trials: number; passes: number;
    medianTurns?: number | null; medianTokens?: number | null;
    costPerSolveUsd?: number | null;
  }[];
}

export function parseInboxResult(raw: unknown, file: string): InboxResultFile {
  const bad = (why: string) => new ClassError(`inbox result file ${file} is malformed: ${why}`);
  if (typeof raw !== 'object' || raw === null) throw bad('not a JSON object');
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'mochi-class-result') throw bad(`kind must be 'mochi-class-result'`);
  if (typeof r.class !== 'string' || !r.class) throw bad('missing class');
  if (typeof r.source !== 'string' || !r.source) throw bad('missing source');
  if (r.mode !== 'live' && r.mode !== 'dry-run') throw bad('mode must be live|dry-run');
  if (typeof r.ts !== 'string' || !r.ts) throw bad('missing ts');
  if (!Array.isArray(r.tasks) || r.tasks.length === 0) throw bad('tasks must be a non-empty array');
  for (const t of r.tasks as Record<string, unknown>[]) {
    if (typeof t.id !== 'string' || typeof t.trials !== 'number' || typeof t.passes !== 'number') {
      throw bad('each task needs id (string), trials (number), passes (number)');
    }
    if (t.passes > t.trials) throw bad(`task ${t.id}: passes exceeds trials`);
  }
  return r as unknown as InboxResultFile;
}

/** Summarise a class from its inbox directory: the LATEST result file (by
 *  its ts, then filename) is the current cell. No files → UNMEASURED. */
export function summarizeInbox(def: ClassDef, inboxRoot: string): ClassSummary {
  const dir = join(inboxRoot, def.id);
  if (!existsSync(dir)) return unmeasured(def);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) return unmeasured(def);
  let best: InboxResultFile | null = null;
  for (const f of files) {
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(join(dir, f), 'utf8')); }
    catch (e) { throw new ClassError(`inbox result file ${join(dir, f)} is not valid JSON (${(e as Error).message})`); }
    const result = parseInboxResult(parsed, join(dir, f));
    if (result.class !== def.id) {
      throw new ClassError(`inbox result file ${join(dir, f)} declares class '${result.class}' but sits in the '${def.id}' inbox.`);
    }
    if (!best || result.ts >= best.ts) best = result;
  }
  const r = best!;
  const tasks: TaskSummary[] = r.tasks.map((t) => ({
    id: t.id, trials: t.trials, passes: t.passes,
    passRate: t.trials ? t.passes / t.trials : 0,
    medianTurns: t.medianTurns ?? null, medianTokens: t.medianTokens ?? null,
  }));
  const trials = tasks.reduce((s, t) => s + t.trials, 0);
  const passes = tasks.reduce((s, t) => s + t.passes, 0);
  const withCost = r.tasks.filter((t) => t.costPerSolveUsd != null && t.passes > 0);
  const costPerSolveUsd = withCost.length === r.tasks.filter((t) => t.passes > 0).length && passes > 0
    ? withCost.reduce((s, t) => s + (t.costPerSolveUsd ?? 0) * t.passes, 0) / passes
    : null;
  return {
    classId: def.id, label: def.label, source: r.source, status: 'measured',
    mode: r.mode, model: r.model ?? null,
    taskCount: tasks.length, trials, passes,
    passRate: tasks.length ? tasks.reduce((s, t) => s + t.passRate, 0) / tasks.length : null,
    medianTurns: median(tasks.map((t) => t.medianTurns).filter((x): x is number => x != null)),
    medianTokens: median(tasks.map((t) => t.medianTokens).filter((x): x is number => x != null)),
    costPerSolveTokens: null, // inbox results carry $ (or nothing), not token totals
    costPerSolveUsd, costSynthetic: r.mode === 'dry-run',
    tasks,
    note: `ingested from inbox result ${r.ts}`,
  };
}

// ---------------------------------------------------------------------------
// Running the scorecard + append-only history
// ---------------------------------------------------------------------------

export interface RunScorecardOptions {
  repoRoot: string;
  k?: number;
  dryRun: boolean;
  mochiBin?: string;
  /** Restrict to these class ids (default: all). The disjointness guard
   *  always covers every in-tree set, run or not. */
  classIds?: string[];
  historyPath: string;
  inboxRoot?: string;
  now?: Date;
}

function gitHead(repoRoot: string): string | null {
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() || null : null;
  } catch { return null; }
}

export async function runScorecard(opts: RunScorecardOptions): Promise<ScorecardRecord> {
  const k = opts.k ?? 3;
  const mode: 'dry-run' | 'live' = opts.dryRun ? 'dry-run' : 'live';
  const inboxRoot = opts.inboxRoot ?? join(opts.repoRoot, 'bench', 'classes', 'inbox');
  const wanted = opts.classIds ? new Set(opts.classIds) : null;

  // Guard first: no measurement happens on a contaminated bench.
  const { sets, missing } = await loadScorecardSets(opts.repoRoot);

  let runner: TaskRunner | null = null;
  const getRunner = (): TaskRunner => {
    if (runner) return runner;
    if (opts.dryRun) { runner = createClassDryRunner(); return runner; }
    const bin = opts.mochiBin ?? join(opts.repoRoot, 'dist', 'cli.js');
    if (!existsSync(bin)) {
      throw new ClassError(`live scorecard run needs a built CLI at ${bin} — run \`npm run build\` first, or use --dry-run for a plumbing run.`);
    }
    runner = createSubprocessRunner({ mochiBin: bin });
    return runner;
  };

  const summaries: ClassSummary[] = [];
  for (const def of CLASS_DEFS) {
    if (wanted && !wanted.has(def.id)) continue;
    if (def.kind === 'inbox') { summaries.push(summarizeInbox(def, inboxRoot)); continue; }
    const set = sets.get(def.id);
    if (!set) {
      summaries.push(unmeasured(def, missing.has(def.id)
        ? `fixture set not present (${def.setDir}/ has no manifest.json) — UNMEASURED, not zero.`
        : def.contractNote));
      continue;
    }
    const run = await executeRun(set, getRunner(), { k });
    summaries.push(summarizeExecutedSet(def, set, run, mode));
  }

  const record: ScorecardRecord = {
    kind: 'mochi-class-scorecard-run',
    ts: (opts.now ?? new Date()).toISOString(),
    gitHead: gitHead(opts.repoRoot),
    mode, k, classes: summaries,
  };
  appendHistory(opts.historyPath, record);
  return record;
}

/** Current-state summaries WITHOUT executing anything: inbox classes from
 *  their result files, everything else UNMEASURED. Used by `report` when no
 *  run has been recorded yet. */
export function currentStateSummaries(repoRoot: string, inboxRoot?: string): ClassSummary[] {
  const root = inboxRoot ?? join(repoRoot, 'bench', 'classes', 'inbox');
  return CLASS_DEFS.map((def) => (def.kind === 'inbox'
    ? summarizeInbox(def, root)
    : unmeasured(def, 'no recorded scorecard run yet — run `mochi bench classes run`.')));
}

/** Append one record to the history log. Append-only by construction: the
 *  file is opened in append mode and existing lines are never rewritten,
 *  so improvement over time is a diff of records, not a memory. */
export function appendHistory(path: string, record: ScorecardRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

export function readHistory(path: string): ScorecardRecord[] {
  if (!existsSync(path)) return [];
  const out: ScorecardRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as ScorecardRecord;
      if (rec.kind === 'mochi-class-scorecard-run') out.push(rec);
    } catch { /* a torn final line is ignored, never fatal */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering — one table, honest cells
// ---------------------------------------------------------------------------

function fmtNum(n: number | null): string {
  return n == null ? '—' : Math.round(n).toLocaleString('en-US');
}

function fmtCost(s: ClassSummary): string {
  if (s.costPerSolveUsd == null) return '—';
  const v = `$${s.costPerSolveUsd.toFixed(4)}`;
  return s.costSynthetic ? `≈${v} synth` : v;
}

export function renderScorecardTable(classes: ClassSummary[]): string {
  const rows: string[][] = classes.map((s) => [
    s.label,
    s.source,
    s.status === 'measured' ? String(s.taskCount) : '—',
    s.status === 'measured' && s.passRate != null ? `${(s.passRate * 100).toFixed(1)}%` : 'UNMEASURED',
    fmtNum(s.medianTurns),
    fmtNum(s.medianTokens),
    fmtCost(s),
  ]);
  const head = ['Class', 'Source', 'Tasks', 'Pass', 'Med turns', 'Med tokens', 'Cost/solve'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  const out = [line(head), line(widths.map((w) => '-'.repeat(w)))];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

export function renderScorecardMd(record: ScorecardRecord): string {
  const lines: string[] = [];
  lines.push('# Task-class scorecard');
  lines.push('');
  lines.push(`- Ran: ${record.ts}${record.mode === 'dry-run' ? ' (DRY RUN — canned solutions, mochi not invoked; turns/tokens are deterministic plumbing values and $ costs are price-table estimates — all labelled SYNTHETIC)' : ''}`);
  lines.push(`- Git: \`${record.gitHead ?? 'unknown'}\`; k=${record.k} trials per task`);
  lines.push('');
  lines.push('```');
  lines.push(renderScorecardTable(record.classes));
  lines.push('```');
  lines.push('');
  for (const s of record.classes) {
    lines.push(`## ${s.label} — ${s.status === 'measured' ? `${((s.passRate ?? 0) * 100).toFixed(1)}% pass@1` : 'UNMEASURED'}`);
    lines.push('');
    lines.push(`- Source: ${s.source}${s.model ? `; model: ${s.model}` : ''}${s.mode ? `; mode: ${s.mode}` : ''}`);
    if (s.note) lines.push(`- Note: ${s.note}`);
    if (s.status === 'measured') {
      lines.push(`- Trials: ${s.trials}, passes: ${s.passes}; cost-per-solve: ${s.costPerSolveTokens != null ? `${Math.round(s.costPerSolveTokens).toLocaleString('en-US')} tokens` : '—'}${s.costPerSolveUsd != null ? ` / $${s.costPerSolveUsd.toFixed(4)}${s.costSynthetic ? ' (SYNTHETIC estimate)' : ''}` : ''}`);
      lines.push('');
      lines.push('| task | trials | passes | pass | med turns | med tokens |');
      lines.push('|---|---|---|---|---|---|');
      for (const t of s.tasks) {
        lines.push(`| ${t.id} | ${t.trials} | ${t.passes} | ${(t.passRate * 100).toFixed(0)}% | ${fmtNum(t.medianTurns)} | ${fmtNum(t.medianTokens)} |`);
      }
    }
    lines.push('');
  }
  lines.push('> UNMEASURED means no recorded evidence exists for that class yet — it is a statement about our measurement, not about the harness. Costs marked SYNTHETIC are price-table estimates over stub/plumbing token counts, never provider bills.');
  return lines.join('\n') + '\n';
}
