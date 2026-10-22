// Frozen regression gate — the independent check that stops self-improvement
// (and any harness change) from silently regressing capability.
//
// Design: mochi-distillation/niche-features-and-self-improvement.md §A.3 +
// distillation-pipeline.md §5.3. The motivating number is AHE's ablation:
// a self-evolver's regression foresight is near-blind (precision 11.8%,
// recall 11.1% — distillation-pipeline.md §1.5). So the gate is deliberately
// NOT the evolver: it executes a frozen, hash-pinned task set, compares
// incumbent vs challenger under fixed thresholds, and adds an independent
// analyser (separate prompt, never shown the change's rationale or commit
// messages) whose objections block promotion.
//
// Verdicts: PASS / PASS-WITH-OBJECTIONS / BLOCKED.
// Promotion criteria (pipeline §5.3, ALL must hold):
//   - held-out pass@1 Δ ≥ +1.0pp with bootstrap CI excluding 0, OR equal
//     pass@1 (Δ ≥ −1.0pp with CI straddling 0) at ≥10% lower cost-per-solve;
//   - no task category regresses >3pp;
//   - broken-task count ≤ fixed-task count;
//   - no new F7 (loop_no_progress) / F12 (timeout_step_exhaustion) spike.
// Plus: any analyser objection downgrades PASS to PASS-WITH-OBJECTIONS.
//
// The frozen set is a measurement instrument. It is NEVER training data:
// `freeze` emits bench/frozen/blocklist-additions.json so ingestion can
// block its ids, and every gate run first checks the set against
// bench/external/eval_blocklist.json — overlap with a real eval set is a
// hard error, because a contaminated gate measures memorisation, not skill.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execArgvText } from '../exec.js';
import { estimateCostUsd, type PriceOverrides } from '../pricing.js';

export class GateError extends Error {
  /** Process exit code the CLI should use for this failure class. */
  readonly exitCode = 3;
  constructor(message: string) {
    super(message);
    this.name = 'GateError';
  }
}

// ---------------------------------------------------------------------------
// Frozen set: manifest, hashing, integrity
// ---------------------------------------------------------------------------

export interface FrozenTaskEntry {
  id: string;
  /** Where this task came from: 'arena' | 'golden' | 'external'. Provenance
   *  is stated honestly in each entry — arena tasks are this repo's own
   *  harness-arena tasks, NOT SWE-bench/Terminal-Bench instances. */
  source: string;
  provenance: string;
  category: string;
  prompt: string;            // path relative to the frozen dir
  filesDir?: string;         // setup overlay, path relative to frozen dir
  solutionDir?: string;      // canned solution, ONLY used by --dry-run
  verifier: string;          // verify script, path relative to frozen dir
  /** Optional external identity, checked against the eval blocklist. */
  instanceId?: string;
  repo?: string;
  baseCommit?: string;
  hash: string;
}

export interface FrozenManifest {
  kind: 'mochi-frozen-gate-set';
  version: number;
  frozenAt: string;
  note?: string;
  setHash: string;
  tasks: FrozenTaskEntry[];
}

export interface FrozenTask extends FrozenTaskEntry {
  promptText: string;
  absDir: string;
  absPrompt: string;
  absFilesDir?: string;
  absSolutionDir?: string;
  absVerifier: string;
}

export interface FrozenSet {
  dir: string;
  manifest: FrozenManifest;
  tasks: FrozenTask[];
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Recursively list files under dir as sorted posix-style relative paths. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, r);
      else out.push(r);
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out.sort();
}

/** Content hash of one task: id + category + prompt + setup files + solution
 *  files + verifier, each length-framed so concatenation is unambiguous. */
export function computeTaskHash(frozenDir: string, entry: FrozenTaskEntry): string {
  const h = createHash('sha256');
  const put = (label: string, data: Buffer | string) => {
    const b = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    h.update(`${label}:${b.length}:`);
    h.update(b);
    h.update('\n');
  };
  put('id', entry.id);
  put('category', entry.category);
  put('prompt', readFileSync(join(frozenDir, entry.prompt)));
  for (const [label, dir] of [['files', entry.filesDir], ['solution', entry.solutionDir]] as const) {
    if (!dir) continue;
    const abs = join(frozenDir, dir);
    for (const rel of listFiles(abs)) put(`${label}/${rel}`, readFileSync(join(abs, rel)));
  }
  put('verifier', readFileSync(join(frozenDir, entry.verifier)));
  return h.digest('hex');
}

export function computeSetHash(entries: FrozenTaskEntry[]): string {
  return sha256(entries.map((e) => `${e.id}:${e.hash}`).sort().join('\n'));
}

export function loadManifest(frozenDir: string): FrozenManifest {
  const p = join(frozenDir, 'manifest.json');
  if (!existsSync(p)) throw new GateError(`frozen set manifest not found: ${p}`);
  let m: FrozenManifest;
  try {
    m = JSON.parse(readFileSync(p, 'utf8')) as FrozenManifest;
  } catch (e) {
    throw new GateError(`frozen set manifest is not valid JSON: ${p} (${(e as Error).message})`);
  }
  if (m.kind !== 'mochi-frozen-gate-set' || !Array.isArray(m.tasks)) {
    throw new GateError(`frozen set manifest has unexpected shape: ${p}`);
  }
  return m;
}

/** Load the frozen set and VERIFY every pinned hash. Any mismatch means the
 *  set changed after freezing — comparisons against older baselines are
 *  invalid, so this is a loud hard error, never a warning. */
export function loadFrozenSet(frozenDir: string): FrozenSet {
  const manifest = loadManifest(frozenDir);
  const tasks: FrozenTask[] = [];
  for (const entry of manifest.tasks) {
    let actual: string;
    try {
      actual = computeTaskHash(frozenDir, entry);
    } catch (e) {
      throw new GateError(`frozen task ${entry.id}: cannot read pinned content (${(e as Error).message}). The frozen set is incomplete — restore it or re-freeze deliberately.`);
    }
    if (actual !== entry.hash) {
      throw new GateError(
        `frozen task ${entry.id}: content hash mismatch (pinned ${entry.hash.slice(0, 12)}…, actual ${actual.slice(0, 12)}…). ` +
        'A frozen task changed after freezing. Gate comparisons against the stored baseline are INVALID. ' +
        'If this change is deliberate, run `mochi gate freeze` and take a NEW baseline (`mochi gate baseline`).',
      );
    }
    tasks.push({
      ...entry,
      promptText: readFileSync(join(frozenDir, entry.prompt), 'utf8'),
      absDir: join(frozenDir, 'tasks', entry.id),
      absPrompt: join(frozenDir, entry.prompt),
      absFilesDir: entry.filesDir ? join(frozenDir, entry.filesDir) : undefined,
      absSolutionDir: entry.solutionDir ? join(frozenDir, entry.solutionDir) : undefined,
      absVerifier: join(frozenDir, entry.verifier),
    });
  }
  const setHash = computeSetHash(manifest.tasks);
  if (setHash !== manifest.setHash) {
    throw new GateError('frozen set hash mismatch: the manifest task list changed after freezing. Re-freeze deliberately and take a new baseline.');
  }
  return { dir: frozenDir, manifest, tasks };
}

/** Recompute all hashes in place (the deliberate un-freeze/re-freeze act) and
 *  regenerate blocklist-additions.json. Returns the updated manifest. */
export function freezeFrozenSet(frozenDir: string, now: Date = new Date()): FrozenManifest {
  const manifest = loadManifest(frozenDir);
  for (const entry of manifest.tasks) {
    entry.hash = computeTaskHash(frozenDir, entry);
  }
  manifest.setHash = computeSetHash(manifest.tasks);
  manifest.frozenAt = now.toISOString().slice(0, 10);
  writeFileSync(join(frozenDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  // The frozen set is decision-training data, never model-training data:
  // emit its ids in eval_blocklist extra_blocked shape for ingestion to merge.
  const additions = {
    kind: 'mochi-frozen-gate-blocklist-additions',
    note: 'Ids of the frozen regression-gate set. Training/curriculum ingestion must drop these exactly like eval instances (see bench/frozen/README.md). Merge into eval_blocklist.json extra_blocked.instance_ids, or check alongside it.',
    generatedAt: manifest.frozenAt,
    extra_blocked: { instance_ids: manifest.tasks.map((t) => t.id), base_commits: [], repo_commit_pairs: [] },
  };
  writeFileSync(join(frozenDir, 'blocklist-additions.json'), JSON.stringify(additions, null, 2) + '\n');
  return manifest;
}

// ---------------------------------------------------------------------------
// Eval-blocklist overlap check
// ---------------------------------------------------------------------------

interface BlocklistModule {
  loadBlocklist: (path?: string) => { isBlocked: (c: { instanceId?: string; repo?: string; baseCommit?: string }) => unknown };
}

/** Hard-error if any frozen task overlaps bench/external/eval_blocklist.json.
 *  A frozen task that IS an eval instance would let the gate reward
 *  memorisation of a reported benchmark — the exact contamination the
 *  blocklist exists to prevent. */
export async function assertNoBlocklistOverlap(set: FrozenSet, blocklistPath: string): Promise<void> {
  // blocklist.mjs (the matcher) sits beside eval_blocklist.json (the data).
  const mjs = join(resolve(blocklistPath, '..'), 'blocklist.mjs');
  const mod = (await import(pathToFileURL(mjs).href)) as BlocklistModule;
  const bl = mod.loadBlocklist(blocklistPath);
  for (const t of set.tasks) {
    const hit = bl.isBlocked({
      instanceId: t.instanceId ?? t.id,
      repo: t.repo ?? '',
      baseCommit: t.baseCommit ?? '',
    });
    if (hit) {
      throw new GateError(
        `frozen task ${t.id} overlaps the eval blocklist (${JSON.stringify(hit)}). ` +
          'A gate task drawn from a reported eval set contaminates both measurements. Remove it from the frozen set and re-freeze.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Trial execution: agent step (runner) + pinned verifier (gate core)
// ---------------------------------------------------------------------------

/** What one agent attempt produced, before verification. Pass/fail is decided
 *  ONLY by the task's pinned verifier in the gate core — a runner can never
 *  grade its own homework. */
export interface AgentStepResult {
  exitCode: number | null;
  timedOut: boolean;
  tokens: number | null;
  costUsd: number | null;
  /** Coarse failure-class hint from traces ('F7' | 'F12' | 'X'); the core
   *  refines it. Null when no signal. */
  failureClass: string | null;
  traceIds: string[];
  detail: string;
}

/** Performs the agent step inside an already-prepared workdir. */
export type TaskRunner = (task: FrozenTask, trial: number, workdir: string) => Promise<AgentStepResult>;

export interface TrialOutcome {
  taskId: string;
  category: string;
  trial: number;
  passed: boolean;
  tokens: number | null;
  costUsd: number | null;
  /** F-label (pipeline §4.2) for failed trials; null for passes. 'F3' is the
   *  coarse default when the verifier failed without a better signal. */
  failureClass: string | null;
  detail: string;
  durationMs: number;
  traceIds: string[];
}

export interface RunResults {
  k: number;
  trials: TrialOutcome[];
}

/** Scan a finished run's traces for usage + loop signals. Traces live at
 *  <workdir>/.mochi/traces/<runId>.jsonl (see observability/trace.ts);
 *  `usage:updated` events carry per-call token totals (types.ts).
 *  Cost (C5): a nonzero per-call costUsd is provider-reported and summed
 *  as-is. A $0/absent costUsd on an event that carries a model id and a
 *  token split is estimated from the offline price table (pricing.ts) and
 *  flagged via `costEstimated` — this is what makes cost-per-solve
 *  computable for providers that never report billing. An event whose cost
 *  can be neither reported nor estimated keeps costUsd null (unknown, not
 *  a flattering partial sum). */
export function scanRunTraces(workdir: string, opts: { pricing?: PriceOverrides } = {}): { tokens: number | null; costUsd: number | null; costEstimated: boolean; failureClass: string | null; traceIds: string[] } {
  const dir = join(workdir, '.mochi', 'traces');
  const traceIds: string[] = [];
  let tokens = 0;
  let sawUsage = false;
  let cost = 0;
  let costComplete = true;
  let costEstimated = false;
  const callSigs = new Map<string, number>();
  try {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort()) {
      traceIds.push(f.replace(/\.jsonl$/, ''));
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let e: Record<string, unknown>;
        try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        if (e.kind === 'usage:updated') {
          sawUsage = true;
          if (typeof e.totalTokens === 'number') tokens += e.totalTokens;
          if (typeof e.costUsd === 'number' && e.costUsd > 0) {
            cost += e.costUsd;
          } else {
            // $0 or unreported: try the price table. usage:updated input
            // tokens are the NON-cached count (loop.ts), cache bills on top.
            const est = typeof e.model === 'string'
              ? estimateCostUsd(e.model, {
                  inputTokens: typeof e.inputTokens === 'number' ? e.inputTokens : undefined,
                  outputTokens: typeof e.outputTokens === 'number' ? e.outputTokens : undefined,
                  cacheReadTokens: typeof e.cacheTokens === 'number' ? e.cacheTokens : undefined,
                  inputIncludesCache: false,
                }, opts.pricing)
              : null;
            if (est) {
              cost += est.costUsd;
              costEstimated = true;
            } else if (typeof e.costUsd === 'number') {
              cost += e.costUsd; // explicit $0 with no priceable split: $0 stands
            } else {
              costComplete = false;
            }
          }
        } else if (e.kind === 'tool:called') {
          const sig = `${String(e.tool)}:${JSON.stringify(e.args ?? {}).slice(0, 200)}`;
          callSigs.set(sig, (callSigs.get(sig) ?? 0) + 1);
        }
      }
    }
  } catch { /* no traces: usage unknown, not zero */ }
  const looped = [...callSigs.values()].some((n) => n >= 6);
  return {
    tokens: sawUsage ? tokens : null,
    costUsd: sawUsage && costComplete ? cost : null,
    costEstimated,
    failureClass: looped ? 'F7' : null,
    traceIds,
  };
}

/** Default runner: the bench/external headless pattern —
 *  `node dist/cli.js -p --yolo "<prompt>"` in the task workdir. */
export function createSubprocessRunner(opts: { mochiBin: string; timeoutMs?: number }): TaskRunner {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  return async (task, _trial, workdir) => {
    const r = spawnSync('node', [opts.mochiBin, '-p', '--yolo', task.promptText], {
      cwd: workdir, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
    });
    const timedOut = !!r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
    const scan = scanRunTraces(workdir);
    return {
      exitCode: r.status,
      timedOut,
      tokens: scan.tokens,
      costUsd: scan.costUsd,
      failureClass: timedOut ? 'F12' : scan.failureClass ?? (r.error && !timedOut ? 'X' : null),
      traceIds: scan.traceIds,
      detail: timedOut ? `agent timed out after ${timeoutMs}ms` : `agent exit ${r.status}`,
    };
  };
}

/** Dry-run runner (--dry-run): applies the task's canned `solution/` overlay
 *  instead of invoking mochi — the same role as swebench.mjs's stub patch.
 *  Exercises setup + verifier + scoring with no API key. Token counts are a
 *  deterministic function of the task id (labelled synthetic in reports). */
export function createDryRunRunner(): TaskRunner {
  return async (task, _trial, workdir) => {
    if (task.absSolutionDir && existsSync(task.absSolutionDir)) {
      cpSync(task.absSolutionDir, workdir, { recursive: true });
    }
    let hsum = 0;
    for (const c of task.id) hsum = (hsum * 31 + c.codePointAt(0)!) % 9973;
    return {
      exitCode: 0,
      timedOut: false,
      tokens: 900 + (hsum % 600),
      costUsd: null,
      failureClass: null,
      traceIds: [],
      detail: 'dry-run: canned solution applied, mochi not invoked',
    };
  };
}

function copyDirContents(src: string, dest: string): void {
  if (!existsSync(src)) return;
  cpSync(src, dest, { recursive: true });
}

/** Run the pinned verifier script in the workdir. Exit 0 = pass. */
function runVerifier(task: FrozenTask, workdir: string): { passed: boolean; detail: string } {
  const probe = join(workdir, '.gate-verify.mjs');
  cpSync(task.absVerifier, probe);
  try {
    const r = spawnSync('node', [probe], { cwd: workdir, encoding: 'utf8', timeout: 60_000 });
    const out = `${r.stdout ?? ''}`.trim().split('\n').filter(Boolean);
    return { passed: r.status === 0, detail: out[out.length - 1] ?? `verifier exit ${r.status}` };
  } finally {
    try { rmSync(probe, { force: true }); } catch { /* temp dir is discarded anyway */ }
  }
}

/** Execute k trials of every frozen task. Each trial gets a fresh temp
 *  workdir seeded with the task's pinned setup files. */
export async function executeRun(
  set: FrozenSet,
  runner: TaskRunner,
  opts: { k?: number; keepWork?: boolean } = {},
): Promise<RunResults> {
  const k = opts.k ?? 3;
  const trials: TrialOutcome[] = [];
  for (const task of set.tasks) {
    for (let trial = 0; trial < k; trial++) {
      const workdir = mkdtempSync(join(tmpdir(), `mochi-gate-${task.id}-`));
      const t0 = Date.now();
      try {
        if (task.absFilesDir) copyDirContents(task.absFilesDir, workdir);
        const step = await runner(task, trial, workdir);
        const v = runVerifier(task, workdir);
        trials.push({
          taskId: task.id,
          category: task.category,
          trial,
          passed: v.passed,
          tokens: step.tokens,
          costUsd: step.costUsd,
          failureClass: v.passed ? null : step.failureClass ?? 'F3',
          detail: v.passed ? v.detail : `${v.detail} [${step.detail}]`,
          durationMs: Date.now() - t0,
          traceIds: step.traceIds,
        });
      } finally {
        if (!opts.keepWork) {
          try { rmSync(workdir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
      }
    }
  }
  return { k, trials };
}

// ---------------------------------------------------------------------------
// Aggregation, bootstrap CI, and the §5.3 verdict
// ---------------------------------------------------------------------------

export interface TaskAgg {
  id: string;
  category: string;
  trials: number;
  passes: number;
  passRate: number;
  /** Sum of trial tokens; null if ANY trial's tokens are unknown (a partial
   *  sum would silently flatter the run). */
  tokens: number | null;
  costUsd: number | null;
  failureClasses: Record<string, number>;
}

export function aggregate(run: RunResults, set: FrozenSet): TaskAgg[] {
  return set.tasks.map((t) => {
    const ts = run.trials.filter((x) => x.taskId === t.id);
    const failureClasses: Record<string, number> = {};
    for (const x of ts) {
      if (!x.passed && x.failureClass) failureClasses[x.failureClass] = (failureClasses[x.failureClass] ?? 0) + 1;
    }
    const sum = (pick: (x: TrialOutcome) => number | null): number | null => {
      let total = 0;
      for (const x of ts) {
        const v = pick(x);
        if (v == null) return null;
        total += v;
      }
      return ts.length ? total : null;
    };
    return {
      id: t.id,
      category: t.category,
      trials: ts.length,
      passes: ts.filter((x) => x.passed).length,
      passRate: ts.length ? ts.filter((x) => x.passed).length / ts.length : 0,
      tokens: sum((x) => x.tokens),
      costUsd: sum((x) => x.costUsd),
      failureClasses,
    };
  });
}

/** pass@1: mean over tasks of the per-task resolved rate across k rollouts. */
export function passAt1(aggs: TaskAgg[]): number {
  return aggs.length ? aggs.reduce((s, a) => s + a.passRate, 0) / aggs.length : 0;
}

export function categoryPassAt1(aggs: TaskAgg[]): Record<string, number> {
  const byCat = new Map<string, TaskAgg[]>();
  for (const a of aggs) byCat.set(a.category, [...(byCat.get(a.category) ?? []), a]);
  const out: Record<string, number> = {};
  for (const [cat, list] of byCat) out[cat] = passAt1(list);
  return out;
}

/** Cost per solve: total tokens (and $, when fully known) ÷ passed trials.
 *  Null when usage is unknown or nothing was solved. */
export function costPerSolve(aggs: TaskAgg[]): { tokens: number | null; usd: number | null } {
  const passedTrials = aggs.reduce((s, a) => s + a.passes, 0);
  if (!passedTrials) return { tokens: null, usd: null };
  const tot = (pick: (a: TaskAgg) => number | null): number | null => {
    let s = 0;
    for (const a of aggs) {
      const v = pick(a);
      if (v == null) return null;
      s += v;
    }
    return s / passedTrials;
  };
  return { tokens: tot((a) => a.tokens), usd: tot((a) => a.costUsd) };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paired bootstrap CI for the pass@1 delta: tasks are resampled with
 *  replacement (same indices for incumbent and challenger), so per-task
 *  difficulty cancels. Deterministic (seeded) so gate runs are reproducible.
 *  Returns the CI in rate units (0..1). */
export function bootstrapDeltaCI(
  base: TaskAgg[], chal: TaskAgg[], iters = 2000, seed = 0x9e3779b9,
): { low: number; high: number } {
  const rnd = mulberry32(seed);
  const n = base.length;
  const deltas: number[] = [];
  for (let i = 0; i < iters; i++) {
    let b = 0;
    let c = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rnd() * n);
      b += base[idx].passRate;
      c += chal[idx].passRate;
    }
    deltas.push(c / n - b / n);
  }
  deltas.sort((x, y) => x - y);
  const q = (p: number) => deltas[Math.min(deltas.length - 1, Math.max(0, Math.floor(p * deltas.length)))];
  return { low: q(0.025), high: q(0.975) };
}

export interface CategoryDelta { category: string; base: number; chal: number; deltaPp: number }
export interface TaskFlip { id: string; category: string; baseRate: number; chalRate: number; kind: 'fixed' | 'broken' | 'changed' }
export interface SpikeFinding { failureClass: string; baseCount: number; chalCount: number; baseShare: number; chalShare: number }

export interface Comparison {
  basePassAt1: number;
  chalPassAt1: number;
  deltaPp: number;
  ci95: { low: number; high: number }; // rate units
  baseCostPerSolve: { tokens: number | null; usd: number | null };
  chalCostPerSolve: { tokens: number | null; usd: number | null };
  /** Fractional token cost reduction (positive = cheaper). Null if unknown. */
  costReduction: number | null;
  categories: CategoryDelta[];
  flips: TaskFlip[];
  fixedCount: number;
  brokenCount: number;
  spikes: SpikeFinding[];
  checks: {
    improvement: boolean;
    efficiency: boolean;
    categoriesOk: boolean;
    brokenOk: boolean;
    spikeOk: boolean;
  };
  /** Human-readable reasons for every failed check. */
  failures: string[];
}

const SPIKE_CLASSES = ['F7', 'F12'] as const;

export function compareRuns(set: FrozenSet, baseRun: RunResults, chalRun: RunResults): Comparison {
  const base = aggregate(baseRun, set);
  const chal = aggregate(chalRun, set);
  const baseP = passAt1(base);
  const chalP = passAt1(chal);
  const deltaPp = (chalP - baseP) * 100;
  const ci95 = bootstrapDeltaCI(base, chal);
  const baseCost = costPerSolve(base);
  const chalCost = costPerSolve(chal);
  const costReduction =
    baseCost.tokens != null && chalCost.tokens != null && baseCost.tokens > 0
      ? (baseCost.tokens - chalCost.tokens) / baseCost.tokens
      : null;

  const baseCats = categoryPassAt1(base);
  const chalCats = categoryPassAt1(chal);
  const categories: CategoryDelta[] = Object.keys({ ...baseCats, ...chalCats }).sort().map((category) => ({
    category,
    base: baseCats[category] ?? 0,
    chal: chalCats[category] ?? 0,
    deltaPp: ((chalCats[category] ?? 0) - (baseCats[category] ?? 0)) * 100,
  }));

  const flips: TaskFlip[] = [];
  for (let i = 0; i < base.length; i++) {
    const b = base[i];
    const c = chal[i];
    if (b.passRate === c.passRate) continue;
    const wasPassing = b.passRate >= 0.5;
    const isPassing = c.passRate >= 0.5;
    flips.push({
      id: b.id, category: b.category, baseRate: b.passRate, chalRate: c.passRate,
      kind: !wasPassing && isPassing ? 'fixed' : wasPassing && !isPassing ? 'broken' : 'changed',
    });
  }
  const fixedCount = flips.filter((f) => f.kind === 'fixed').length;
  const brokenCount = flips.filter((f) => f.kind === 'broken').length;

  // F7/F12 spike: a failure class that was absent (or rare) in the incumbent
  // and now accounts for a materially larger share of a non-trivial number
  // of failures. Counts guard tiny-n noise; shares guard scale.
  const classTotals = (run: RunResults) => {
    const counts: Record<string, number> = {};
    let failures = 0;
    for (const t of run.trials) {
      if (t.passed) continue;
      failures++;
      if (t.failureClass) counts[t.failureClass] = (counts[t.failureClass] ?? 0) + 1;
    }
    return { counts, failures };
  };
  const bt = classTotals(baseRun);
  const ct = classTotals(chalRun);
  const spikes: SpikeFinding[] = [];
  for (const cls of SPIKE_CLASSES) {
    const baseCount = bt.counts[cls] ?? 0;
    const chalCount = ct.counts[cls] ?? 0;
    const baseShare = bt.failures ? baseCount / bt.failures : 0;
    const chalShare = ct.failures ? chalCount / ct.failures : 0;
    if (chalCount >= 3 && (baseCount === 0 || chalShare - baseShare >= 0.15)) {
      spikes.push({ failureClass: cls, baseCount, chalCount, baseShare, chalShare });
    }
  }

  const checks = {
    // §5.3 path 1: real improvement, CI excluding 0.
    improvement: deltaPp >= 1.0 && ci95.low > 0,
    // §5.3 path 2: statistically-equal pass at ≥10% lower cost-per-solve
    // ("equal" = Δ no worse than −1.0pp and CI straddling 0).
    efficiency: costReduction != null && costReduction >= 0.10 && deltaPp >= -1.0 && ci95.low <= 0 && ci95.high >= 0,
    categoriesOk: categories.every((c) => c.deltaPp > -3),
    brokenOk: brokenCount <= fixedCount,
    spikeOk: spikes.length === 0,
  };
  const failures: string[] = [];
  if (!checks.improvement && !checks.efficiency) {
    failures.push(
      `overall: pass@1 Δ ${deltaPp >= 0 ? '+' : ''}${deltaPp.toFixed(1)}pp (95% CI ${(ci95.low * 100).toFixed(1)}..${(ci95.high * 100).toFixed(1)}pp)` +
      (costReduction == null
        ? '; cost-per-solve unknown (usage not reported), so the efficiency path cannot apply'
        : `; cost-per-solve Δ ${(costReduction * 100).toFixed(1)}%`) +
      ' — meets neither §5.3 path (Δ ≥ +1.0pp with CI excluding 0, or equal pass at ≥10% lower cost-per-solve)',
    );
  }
  for (const c of categories) {
    if (c.deltaPp <= -3) failures.push(`category "${c.category}" regressed ${c.deltaPp.toFixed(1)}pp (> 3pp allowed)`);
  }
  if (!checks.brokenOk) failures.push(`broken tasks (${brokenCount}) exceed fixed tasks (${fixedCount})`);
  for (const s of spikes) {
    failures.push(`failure-class spike: ${s.failureClass} went ${s.baseCount} → ${s.chalCount} failures (share ${(s.baseShare * 100).toFixed(0)}% → ${(s.chalShare * 100).toFixed(0)}% of failures)`);
  }
  return {
    basePassAt1: baseP, chalPassAt1: chalP, deltaPp, ci95,
    baseCostPerSolve: baseCost, chalCostPerSolve: chalCost, costReduction,
    categories, flips, fixedCount, brokenCount, spikes, checks, failures,
  };
}

// ---------------------------------------------------------------------------
// Independent regression analyser
// ---------------------------------------------------------------------------

export interface Objection {
  severity: 'high' | 'medium' | 'low';
  source: 'checklist' | 'model';
  claim: string;
  evidence: string;
}

/** A model the analyser can call. Deliberately a bare function so the gate
 *  core stays provider-agnostic; the CLI wires it to createProvider(). */
export type ModelCaller = (req: { system: string; user: string }) => Promise<string>;

const TEST_FILE_RE = /(^|\/)([^/]*\.(test|spec)\.[tj]sx?|test_[^/]+\.[tj]sx?|[^/]+_test\.[tj]sx?)$|\/__tests__\/|\/tests?\//;
const CRITICAL_PATHS: { re: RegExp; severity: Objection['severity']; label: string }[] = [
  { re: /^src\/security\//, severity: 'high', label: 'security path' },
  { re: /^src\/verification\.ts$/, severity: 'high', label: 'verifier' },
  { re: /^bench\//, severity: 'high', label: 'evaluation instrument (bench/)' },
  { re: /^src\/evals\//, severity: 'high', label: 'the gate itself (src/evals/)' },
  { re: /^src\/agent\/loop\.ts$/, severity: 'medium', label: 'agent loop' },
  { re: /^src\/context\.ts$/, severity: 'medium', label: 'context assembly' },
  { re: /^src\/prompt\//, severity: 'medium', label: 'prompt compiler' },
  { re: /^skills\/.*\.md$/, severity: 'medium', label: 'bundled skill (prompt-shaped)' },
];

/** Deterministic diff-risk checklist. Runs ALWAYS (it is the floor under the
 *  model analyser, and the only analyser when no model is configured). It
 *  reads only the diff text — never commit messages or rationale. */
export function diffRiskChecklist(diff: string): Objection[] {
  const objections: Objection[] = [];
  const files = new Map<string, { added: number; removed: number; deleted: boolean }>();
  let current: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = / b\/(.+)$/.exec(line);
      current = m ? m[1] : null;
      if (current && !files.has(current)) files.set(current, { added: 0, removed: 0, deleted: false });
    } else if (line.startsWith('deleted file mode')) {
      if (current) files.get(current)!.deleted = true;
    } else if (line === '+++ /dev/null') {
      if (current) files.get(current)!.deleted = true;
    } else if (current) {
      const rec = files.get(current)!;
      if (line.startsWith('+') && !line.startsWith('+++')) rec.added++;
      else if (line.startsWith('-') && !line.startsWith('---')) rec.removed++;
    }
  }

  for (const [file, rec] of files) {
    if (TEST_FILE_RE.test(file)) {
      if (rec.deleted) {
        objections.push({ severity: 'high', source: 'checklist', claim: `test file deleted: ${file}`, evidence: 'deleted file in diff — removed tests cannot fail, so a green run proves less than it did before' });
      } else if (rec.removed - rec.added >= 5) {
        objections.push({ severity: 'medium', source: 'checklist', claim: `net test-line removal in ${file} (−${rec.removed}/+${rec.added})`, evidence: 'test bodies shrank; check no assertion was weakened to make the change pass' });
      }
    }
  }
  // Critical-path touches are grouped per area — one objection with the
  // file list, not one objection per file (a 40-file change to bench/ is
  // one fact about the change, not forty).
  for (const cp of CRITICAL_PATHS) {
    const hits = [...files.keys()].filter((f) => cp.re.test(f));
    if (hits.length) {
      objections.push({
        severity: cp.severity, source: 'checklist',
        claim: `${cp.label} modified (${hits.length} file${hits.length === 1 ? '' : 's'})`,
        evidence: `${hits.slice(0, 6).join(', ')}${hits.length > 6 ? ', …' : ''} — behaviour-critical surface; the frozen gate + full suite are the minimum evidence, and a human should review these hunks`,
      });
    }
  }
  let added = 0;
  let removed = 0;
  for (const rec of files.values()) { added += rec.added; removed += rec.removed; }
  if (removed - added > 300) {
    objections.push({ severity: 'medium', source: 'checklist', claim: `large net deletion (${removed - added} more lines removed than added)`, evidence: 'bulk removals are where silent capability loss hides; confirm each removed behaviour was intentional' });
  }
  if (files.has('src/config.ts') || files.has('src/types.ts')) {
    objections.push({ severity: 'medium', source: 'checklist', claim: 'config/defaults surface modified (src/config.ts / src/types.ts)', evidence: 'default changes alter behaviour for every existing user, not just new runs' });
  }
  return objections;
}

export const ANALYSER_SYSTEM =
  'You are an independent regression analyst for a coding-agent harness. You did NOT make the change under review, ' +
  'and its rationale has deliberately not been shared with you — judge only the diff and the measured outcomes in front of you. ' +
  'Your job is to find plausible ways this change could REGRESS agent behaviour: removed safeguards, weakened checks, ' +
  'narrowed tool surfaces, changed defaults, lost edge cases. Be specific and cite files/hunks. Do not praise the change. ' +
  'Return ONLY JSON: {"objections":[{"severity":"high|medium|low","claim":"...","evidence":"..."}]} — an empty list is a valid answer.';

/** Model-backed analysis. The prompt contains the raw diff and measured
 *  per-task flips ONLY — no commit messages, no change description, no
 *  manifest rationale. That asymmetry is the independence property (§A.3):
 *  the evolver's near-blind regression foresight (11.1% recall) cannot be
 *  fixed by asking the evolver harder; the analyst must not share its story. */
export async function analyseWithModel(
  diff: string,
  comparison: Comparison,
  failedTrials: TrialOutcome[],
  caller: ModelCaller,
): Promise<Objection[]> {
  const MAX_DIFF = 60_000;
  const diffText = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n[diff truncated at ${MAX_DIFF} chars]` : diff;
  const flips = comparison.flips.map((f) => `${f.id} [${f.category}] ${(f.baseRate * 100).toFixed(0)}% → ${(f.chalRate * 100).toFixed(0)}% (${f.kind})`).join('\n') || '(no per-task flips)';
  const failures = failedTrials.slice(0, 20).map((t) => `${t.taskId} trial ${t.trial}: ${t.failureClass ?? '?'} — ${t.detail.slice(0, 160)}`).join('\n') || '(no failed trials)';
  const user = `DIFF UNDER REVIEW:\n${diffText}\n\nMEASURED PER-TASK OUTCOME CHANGES (incumbent → challenger):\n${flips}\n\nCHALLENGER FAILURES:\n${failures}\n\nFile your objections as JSON.`;
  const raw = await caller({ system: ANALYSER_SYSTEM, user });
  const cleaned = raw.replace(/```json\s*|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return [];
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { objections?: unknown };
  const out: Objection[] = [];
  for (const o of Array.isArray(parsed.objections) ? parsed.objections : []) {
    const rec = o as Record<string, unknown>;
    const sev = ['high', 'medium', 'low'].includes(String(rec.severity)) ? (rec.severity as Objection['severity']) : 'low';
    out.push({ severity: sev, source: 'model', claim: String(rec.claim ?? '').slice(0, 300), evidence: String(rec.evidence ?? '').slice(0, 300) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Baseline + reports + top-level gate runs
// ---------------------------------------------------------------------------

export interface GateBaseline {
  kind: 'mochi-gate-baseline';
  setVersion: number;
  setHash: string;
  gitHead: string | null;
  createdAt: string;
  k: number;
  dryRun: boolean;
  results: RunResults;
}

export type GateVerdict = 'PASS' | 'PASS-WITH-OBJECTIONS' | 'BLOCKED';

export interface GateReport {
  verdict: GateVerdict;
  ranAt: string;
  setVersion: number;
  setHash: string;
  taskCount: number;
  k: number;
  dryRun: boolean;
  baselineGitHead: string | null;
  comparison: Comparison;
  objections: Objection[];
  analyserNote: string;
  powerNote: string;
  reportPaths: { md: string; json: string } | null;
}

export interface GateOptions {
  repoRoot: string;
  frozenDir?: string;
  blocklistPath?: string;
  baselinePath?: string;
  reportsDir?: string;
  k?: number;
  runner?: TaskRunner;
  dryRun?: boolean;
  mochiBin?: string;
  timeoutMs?: number;
  keepWork?: boolean;
  /** Raw unified diff for the analyser. Never commit messages. */
  diffText?: string | null;
  modelCaller?: ModelCaller | null;
  writeReport?: boolean;
  now?: Date;
}

function defaultPaths(o: GateOptions) {
  const frozenDir = o.frozenDir ?? join(o.repoRoot, 'bench', 'frozen');
  return {
    frozenDir,
    blocklistPath: o.blocklistPath ?? join(o.repoRoot, 'bench', 'external', 'eval_blocklist.json'),
    baselinePath: o.baselinePath ?? join(frozenDir, 'baseline.json'),
    reportsDir: o.reportsDir ?? join(o.repoRoot, '.mochi', 'reports'),
  };
}

function pickRunner(o: GateOptions): TaskRunner {
  if (o.runner) return o.runner;
  if (o.dryRun) return createDryRunRunner();
  return createSubprocessRunner({
    mochiBin: o.mochiBin ?? join(o.repoRoot, 'dist', 'cli.js'),
    timeoutMs: o.timeoutMs,
  });
}

function powerNote(taskCount: number, k: number, ci: { low: number; high: number }): string {
  const width = ((ci.high - ci.low) * 100).toFixed(1);
  if (taskCount >= 20) {
    return `Frozen set: ${taskCount} tasks × k=${k}. Bootstrap 95% CI width on this run: ${width}pp.`;
  }
  return (
    `STATISTICAL POWER — READ BEFORE TRUSTING THIS VERDICT: the frozen set has only ${taskCount} tasks × k=${k} trials, ` +
    `and this run's bootstrap 95% CI is ${width}pp wide. At this size the gate is a TRIPWIRE: it reliably catches ` +
    'catastrophic regressions (category wipeouts, F7/F12 spikes, mass breakage) but the §5.3 improvement path ' +
    '(Δ ≥ +1.0pp with CI excluding 0) is nearly unreachable for genuine small gains, so a BLOCKED verdict here means ' +
    '"no evidence of improvement", not "evidence of harm" — read the per-check failures. Grow bench/frozen toward ' +
    '~24 golden tasks before using this gate for promotion-grade claims.'
  );
}

async function gitHead(repoRoot: string): Promise<string | null> {
  try {
    return (await execArgvText('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).trim() || null;
  } catch {
    return null;
  }
}

export function loadBaseline(path: string): GateBaseline {
  if (!existsSync(path)) {
    throw new GateError(
      `no gate baseline at ${path}. Take one explicitly with \`mochi gate baseline\` (baselines are never created or updated implicitly by a gate run).`,
    );
  }
  const b = JSON.parse(readFileSync(path, 'utf8')) as GateBaseline;
  if (b.kind !== 'mochi-gate-baseline') throw new GateError(`baseline file has unexpected shape: ${path}`);
  return b;
}

/** Run the frozen set once and store the results as the new baseline.
 *  This is the ONLY function that writes baseline.json, and it is reachable
 *  only via the explicit `mochi gate baseline` command — `runGate` never
 *  touches the baseline (test f pins this). */
export async function updateBaseline(o: GateOptions): Promise<GateBaseline> {
  const paths = defaultPaths(o);
  const set = loadFrozenSet(paths.frozenDir);
  await assertNoBlocklistOverlap(set, paths.blocklistPath);
  const results = await executeRun(set, pickRunner(o), { k: o.k ?? 3, keepWork: o.keepWork });
  const baseline: GateBaseline = {
    kind: 'mochi-gate-baseline',
    setVersion: set.manifest.version,
    setHash: set.manifest.setHash,
    gitHead: await gitHead(o.repoRoot),
    createdAt: (o.now ?? new Date()).toISOString(),
    k: o.k ?? 3,
    dryRun: !!o.dryRun,
    results,
  };
  writeFileSync(paths.baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  return baseline;
}

/** Run the gate: verify the frozen set, check the blocklist, execute the
 *  challenger, compare against the stored baseline, analyse the diff (if
 *  provided), and write an append-only report. */
export async function runGate(o: GateOptions): Promise<GateReport> {
  const paths = defaultPaths(o);
  const set = loadFrozenSet(paths.frozenDir);
  await assertNoBlocklistOverlap(set, paths.blocklistPath);
  const baseline = loadBaseline(paths.baselinePath);
  if (baseline.setHash !== set.manifest.setHash) {
    throw new GateError(
      'the stored baseline was taken against a DIFFERENT frozen set (set hash mismatch). ' +
        'Comparisons across set versions are invalid — take a new baseline with `mochi gate baseline`.',
    );
  }
  if (baseline.dryRun !== !!o.dryRun) {
    throw new GateError(
      `baseline was taken in ${baseline.dryRun ? 'dry-run' : 'live'} mode but this run is ${o.dryRun ? 'dry-run' : 'live'} — comparing them would be meaningless. Re-baseline in the matching mode.`,
    );
  }
  const k = o.k ?? baseline.k;
  const chalRun = await executeRun(set, pickRunner(o), { k, keepWork: o.keepWork });
  const comparison = compareRuns(set, baseline.results, chalRun);

  // Independent analyser: deterministic checklist always; model when wired.
  const objections: Objection[] = [];
  let analyserNote = 'no diff provided — analyser skipped (pass --diff <ref> or use runGateForChange)';
  if (o.diffText != null) {
    objections.push(...diffRiskChecklist(o.diffText));
    analyserNote = 'deterministic diff-risk checklist applied';
    if (o.modelCaller) {
      try {
        const failed = chalRun.trials.filter((t) => !t.passed);
        objections.push(...await analyseWithModel(o.diffText, comparison, failed, o.modelCaller));
        analyserNote += '; model analyser applied (rationale-free prompt)';
      } catch (e) {
        analyserNote += `; model analyser failed (${(e as Error).message}) — checklist objections stand`;
      }
    } else {
      analyserNote += '; no analyser model configured (set MOCHI_GATE_ANALYSER_MODEL=provider/model, ideally a different family than the default) — checklist only';
    }
  }

  const criteriaPass =
    (comparison.checks.improvement || comparison.checks.efficiency) &&
    comparison.checks.categoriesOk && comparison.checks.brokenOk && comparison.checks.spikeOk;
  const verdict: GateVerdict = !criteriaPass ? 'BLOCKED' : objections.length ? 'PASS-WITH-OBJECTIONS' : 'PASS';

  const report: GateReport = {
    verdict,
    ranAt: (o.now ?? new Date()).toISOString(),
    setVersion: set.manifest.version,
    setHash: set.manifest.setHash,
    taskCount: set.tasks.length,
    k,
    dryRun: !!o.dryRun,
    baselineGitHead: baseline.gitHead,
    comparison,
    objections,
    analyserNote,
    powerNote: powerNote(set.tasks.length, k, comparison.ci95),
    reportPaths: null,
  };
  if (o.writeReport !== false) {
    report.reportPaths = writeGateReport(report, baseline, chalRun, paths.reportsDir);
  }
  return report;
}

/** The B1/promotion hook: gate a change identified by a git ref. Computes
 *  `git diff <ref>` (working tree included) plus untracked file names, then
 *  runs the full gate with the analyser. The diff is the ONLY thing the
 *  analyser sees about the change — commit messages and rationale are never
 *  read, which is what makes the analysis independent. */
export async function runGateForChange(diffRef: string, o: GateOptions): Promise<GateReport> {
  let diffText = '';
  try {
    diffText = await execArgvText('git', ['diff', diffRef], { cwd: o.repoRoot, maxBuffer: 32 * 1024 * 1024 });
    const untracked = await execArgvText('git', ['ls-files', '--others', '--exclude-standard'], { cwd: o.repoRoot });
    for (const f of untracked.split('\n').filter(Boolean)) {
      diffText += `\ndiff --git a/${f} b/${f}\n+++ b/${f}\n+<untracked file>`;
    }
  } catch (e) {
    throw new GateError(`cannot compute diff against ${diffRef}: ${(e as Error).message}`);
  }
  return runGate({ ...o, diffText });
}

// ---------------------------------------------------------------------------
// Report rendering (append-only files under .mochi/reports/)
// ---------------------------------------------------------------------------

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function fmtCost(c: { tokens: number | null; usd: number | null }): string {
  const t = c.tokens == null ? 'tokens unavailable' : `${Math.round(c.tokens)} tok/solve`;
  const u = c.usd == null ? '$ unavailable (no price data reported)' : `$${c.usd.toFixed(4)}/solve`;
  return `${t}, ${u}`;
}

export function renderGateReportMd(report: GateReport, baseline: GateBaseline, chalRun: RunResults): string {
  const c = report.comparison;
  const lines: string[] = [];
  lines.push(`# Regression gate — ${report.verdict}`);
  lines.push('');
  lines.push(`- Ran: ${report.ranAt}${report.dryRun ? ' (DRY RUN — canned solutions, mochi not invoked; numbers are plumbing smoke only)' : ''}`);
  lines.push(`- Frozen set: v${report.setVersion}, hash \`${report.setHash.slice(0, 16)}…\`, ${report.taskCount} tasks × k=${report.k}`);
  lines.push(`- Baseline: taken ${baseline.createdAt} at git \`${baseline.gitHead ?? 'unknown'}\``);
  lines.push(`- Analyser: ${report.analyserNote}`);
  lines.push('');
  lines.push('## §5.3 criteria');
  lines.push('');
  lines.push(`- pass@1: ${fmtPct(c.basePassAt1)} → ${fmtPct(c.chalPassAt1)} (Δ ${c.deltaPp >= 0 ? '+' : ''}${c.deltaPp.toFixed(1)}pp, 95% CI ${(c.ci95.low * 100).toFixed(1)}..${(c.ci95.high * 100).toFixed(1)}pp)`);
  lines.push(`- cost-per-solve: incumbent ${fmtCost(c.baseCostPerSolve)} → challenger ${fmtCost(c.chalCostPerSolve)}${c.costReduction == null ? '' : ` (${(c.costReduction * 100).toFixed(1)}% cheaper)`}`);
  lines.push(`- improvement path (Δ ≥ +1.0pp, CI excludes 0): ${c.checks.improvement ? '✓' : '✗'}`);
  lines.push(`- efficiency path (equal pass, ≥10% cheaper): ${c.checks.efficiency ? '✓' : '✗'}`);
  lines.push(`- no category regresses >3pp: ${c.checks.categoriesOk ? '✓' : '✗'}`);
  lines.push(`- broken ≤ fixed: ${c.checks.brokenOk ? '✓' : '✗'} (${c.brokenCount} broken, ${c.fixedCount} fixed)`);
  lines.push(`- no F7/F12 spike: ${c.checks.spikeOk ? '✓' : '✗'}`);
  if (c.failures.length) {
    lines.push('');
    lines.push('### Failed checks');
    for (const f of c.failures) lines.push(`- ${f}`);
  }
  lines.push('');
  lines.push('## Categories');
  lines.push('');
  lines.push('| category | incumbent | challenger | Δ |');
  lines.push('|---|---|---|---|');
  for (const cat of c.categories) lines.push(`| ${cat.category} | ${fmtPct(cat.base)} | ${fmtPct(cat.chal)} | ${cat.deltaPp >= 0 ? '+' : ''}${cat.deltaPp.toFixed(1)}pp |`);
  lines.push('');
  lines.push('## Per-task deltas');
  lines.push('');
  if (!c.flips.length) lines.push('(no task changed outcome class)');
  for (const f of c.flips) lines.push(`- ${f.id} [${f.category}]: ${fmtPct(f.baseRate)} → ${fmtPct(f.chalRate)} — ${f.kind.toUpperCase()}`);
  const chalFails = chalRun.trials.filter((t) => !t.passed);
  if (chalFails.length) {
    lines.push('');
    lines.push('## Challenger failures');
    lines.push('');
    for (const t of chalFails) lines.push(`- ${t.taskId} trial ${t.trial} [${t.failureClass ?? '?'}]${t.traceIds.length ? ` trace ${t.traceIds.join(',')}` : ''}: ${t.detail}`);
  }
  if (report.objections.length) {
    lines.push('');
    lines.push('## Analyser objections (block promotion until answered)');
    lines.push('');
    for (const ob of report.objections) lines.push(`- [${ob.severity}/${ob.source}] ${ob.claim} — ${ob.evidence}`);
  }
  lines.push('');
  lines.push('## Statistical power');
  lines.push('');
  lines.push(report.powerNote);
  lines.push('');
  lines.push('> The frozen set is a measurement instrument, never training data. Its ids are emitted in bench/frozen/blocklist-additions.json for training/curriculum blocklists.');
  return lines.join('\n') + '\n';
}

function writeGateReport(
  report: GateReport, baseline: GateBaseline, chalRun: RunResults, reportsDir: string,
): { md: string; json: string } {
  mkdirSync(reportsDir, { recursive: true });
  const stamp = report.ranAt.replace(/[:.]/g, '-');
  const md = join(reportsDir, `gate-${stamp}.md`);
  const json = join(reportsDir, `gate-${stamp}.json`);
  writeFileSync(md, renderGateReportMd(report, baseline, chalRun));
  writeFileSync(json, JSON.stringify({ report, challengerTrials: chalRun.trials }, null, 2) + '\n');
  return { md, json };
}
