// Trajectory exporter: converts a raw per-run trace (see trace.ts) into ONE
// structured, step-level trajectory record for harness distillation / SFT.
//
// TraceRecorder writes append-only JSONL to <workspace>/traces/<runId>.jsonl
// and pruneTraces() reaps that directory (100 files / 32MB), so raw traces are
// the wrong artifact to train or eval on: they are event soup, they disappear,
// and the run outcome lives in a different event than the steps that caused
// it. A TrajectoryRecord joins it all — task, ordered tool steps (called
// paired with completed/failed), final outcome, aggregated usage, the
// skills the run loaded joined with its final verifier-gate verdict, and a
// simple evidence-only failure taxonomy — as a single JSON object.
//
// Exports land in <workspace>/exports/ (a sibling of traces/, NOT inside it),
// so pruneTraces never reaps them. Trace payloads were already redacted by
// TraceRecorder at write time; this module passes recorded values through
// untouched and never re-derives them from anywhere else.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readTrace, type TraceEntry } from './trace.js';
import { costFromTraceEntries } from './trace-cost.js';
import { argShapeOf } from '../core/tool-sequence.js';

export interface TrajectoryTask {
  title?: string;
  prompt?: string;
}

export interface TrajectoryStep {
  index: number;
  tool: string;
  /** Tool args exactly as recorded in the trace (already redacted). */
  args: unknown;
  /** D9 (v2): shape of `args` — sorted key names + value types only, never
   *  values (see core/tool-sequence argShapeOf). Lets induction compare
   *  "called the same way" across runs without persisting arg values twice.
   *  Optional in the type so v1 records / hand-built fixtures still parse;
   *  buildTrajectory (v2) and the v2 reader always populate it. */
  argShape?: string;
  ok: boolean;
  /** Tool output, capped at OUTPUT_SNIPPET_MAX chars. '' when none recorded. */
  outputSnippet: string;
  error?: string;
  /** From the completion's result.durationMs when present, else derived
   *  from the called/completed entry timestamps. Absent when neither exists. */
  durationMs?: number;
}

export interface TrajectoryOutcome {
  completed: boolean;
  stopReason?: string;
  reason?: string;
}

export interface TrajectoryUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  /** C5: price-table estimate, present only when the trace's recorded
   *  provider cost is $0/absent but its usage records carry a model id and
   *  token split (see trace-cost.ts). Kept separate from costUsd so an
   *  estimate is never mistaken for provider-reported billing. */
  estimatedCostUsd?: number;
  /** C5: 'provider' | 'estimated' | 'mixed' — provenance of the run's cost. */
  costSource?: string;
}

export interface TrajectoryFailure {
  label: string;
  count: number;
}

/** A run's verdict in skill-attribution vocabulary. 'none' = the verifier
 *  gate produced no verdict for the run (never reached / not applicable). */
export type TrajectoryVerdict = 'pass' | 'fail' | 'partial' | 'blocked' | 'none';

/** One skill loaded by the run, joined with the run's final gate verdict.
 *  This join is what lets offline tooling compute per-skill fix-rates
 *  (fraction of a skill's loaded runs ending in 'pass') without re-reading
 *  the skill registry. */
export interface TrajectorySkillUse {
  id: string;
  verdict: TrajectoryVerdict;
}

/** The run's final verifier-gate result, lifted from the skills:attributed
 *  trace entry the loop emits at finish. `status` is the gate's structured
 *  vocabulary (PASS/FAIL/PARTIAL/BLOCKED, or 'NONE' when the gate never
 *  ran); `verdict` is the same fact in attribution vocabulary. */
export interface TrajectoryVerification {
  status: string;
  verdict: TrajectoryVerdict;
}

/** D9 (v2): record-level cost rollup, derived from `usage` but shaped for
 *  induction / scorecards: reported and estimated money stay SEPARATE
 *  components (the C5 honesty rule) and only `totalUsd` sums them. */
export interface TrajectoryCost {
  totalUsd: number;
  reportedUsd: number;
  estimatedUsd: number;
  totalTokens?: number;
  /** 'provider' | 'estimated' | 'mixed' | 'unknown' (see TrajectoryUsage). */
  source: string;
}

export interface TrajectoryRecord {
  /** 1 = original export shape; 2 = D9 (taskKind, per-step argShape, cost
   *  rollup, verified flag). The reader (upgradeTrajectoryRecord) accepts
   *  BOTH and fills v2 fields by derivation for v1 records. */
  schemaVersion: 1 | 2;
  runId: string;
  /** D9 (v2): task kind in classifyTaskKind vocabulary, lifted from the
   *  run's skills:attributed entry (the loop stamps it at finish).
   *  'unknown' when the trace carries no kind. Optional in the type for
   *  v1 compatibility; v2 exports always carry it. */
  taskKind?: string;
  /** D9 (v2): true only when the verifier gate's final status was PASS or
   *  FLAKY-PASS — the induction corpus's admission test. Optional for v1
   *  compatibility; derivable from `verification` when absent. */
  verified?: boolean;
  /** D9 (v2): cost rollup derived from `usage`; null exactly when usage is. */
  cost?: TrajectoryCost | null;
  workspaceDir?: string;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number;
  task: TrajectoryTask | null;
  steps: TrajectoryStep[];
  /** Skills loaded during the run, each joined with the run's final gate
   *  verdict. Empty when the run loaded no skills — or, for traces recorded
   *  before attribution existed, indistinguishable from it (verification is
   *  null in that case, which is the tell). */
  skills: TrajectorySkillUse[];
  /** The run's final gate verification, or null when the trace carries no
   *  attribution entry (legacy traces). Present-but-'NONE' means the run
   *  finished without the gate producing a verdict. */
  verification: TrajectoryVerification | null;
  outcome: TrajectoryOutcome;
  /** Summed usage fields actually present in the trace; null when no event
   *  carried any token/cost field (never invented). */
  usage: TrajectoryUsage | null;
  /** Labels derived ONLY from evidence in the trace (stopReason, repeated
   *  calls, tool failures) — empty when the run shows none of them. */
  failureTaxonomy: TrajectoryFailure[];
}

const OUTPUT_SNIPPET_MAX = 500;
const REPEATED_CALL_THRESHOLD = 3;

function snippet(value: unknown): string {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'string' ? value : String(value);
  return s.slice(0, OUTPUT_SNIPPET_MAX);
}

/** Output text of a tool:completed entry: its ToolResult.output when the
 *  result is the usual ToolResult object, the string itself when legacy
 *  traces recorded the result as a bare string, '' otherwise. */
function completedOutput(entry: TraceEntry): string {
  const result = entry.result as { output?: unknown } | string | undefined;
  if (typeof result === 'string') return snippet(result);
  if (result && typeof result === 'object') return snippet(result.output);
  return snippet(entry.output);
}

function resultDurationMs(entry: TraceEntry): number | undefined {
  const result = entry.result as { durationMs?: unknown } | undefined;
  if (result && typeof result === 'object' && typeof result.durationMs === 'number' && Number.isFinite(result.durationMs)) {
    return result.durationMs;
  }
  return undefined;
}

/** Canonical usage fields read from a record, under either naming scheme:
 *  nested provider usage (promptTokens/completionTokens/cachedTokens, as on
 *  StreamChunk/ModelResponse usage objects) or the flat usage:updated event
 *  fields (inputTokens/outputTokens/cacheTokens). */
type NumericUsageField = 'inputTokens' | 'outputTokens' | 'cacheTokens' | 'totalTokens' | 'costUsd';
const USAGE_FIELDS: Array<[canonical: NumericUsageField, keys: string[]]> = [
  ['inputTokens', ['inputTokens', 'promptTokens']],
  ['outputTokens', ['outputTokens', 'completionTokens']],
  ['cacheTokens', ['cacheTokens', 'cachedTokens']],
  ['totalTokens', ['totalTokens']],
  ['costUsd', ['costUsd']],
];

function addUsage(acc: TrajectoryUsage, source: Record<string, unknown>): void {
  for (const [canonical, keys] of USAGE_FIELDS) {
    for (const key of keys) {
      const v = source[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        acc[canonical] = (acc[canonical] ?? 0) + v;
        break; // one naming scheme per source record
      }
    }
  }
}

function aggregateUsage(entries: TraceEntry[]): TrajectoryUsage | null {
  const acc: TrajectoryUsage = {};
  for (const entry of entries) {
    const nested = entry.usage;
    if (nested && typeof nested === 'object') addUsage(acc, nested as Record<string, unknown>);
    if (entry.kind === 'usage:updated') addUsage(acc, entry);
  }
  return Object.keys(acc).length ? acc : null;
}

function stableKey(tool: string, args: unknown): string {
  try {
    return `${tool}\u0000${JSON.stringify(args ?? null) ?? ''}`;
  } catch {
    return `${tool}\u0000${String(args)}`;
  }
}

function buildFailureTaxonomy(
  entries: TraceEntry[],
  steps: TrajectoryStep[],
  outcome: TrajectoryOutcome,
): TrajectoryFailure[] {
  const taxonomy: TrajectoryFailure[] = [];
  const stop = outcome.stopReason ?? '';
  if (stop === 'tool_loop' || stop.includes('tool_loop')) taxonomy.push({ label: 'tool_loop', count: 1 });
  if (stop === 'verification_failed' || stop.includes('verification_failed')) taxonomy.push({ label: 'verification_failed', count: 1 });
  if (stop === 'stuck_no_progress' || stop.includes('stuck_no_progress')) taxonomy.push({ label: 'stuck_no_progress', count: 1 });

  // Repeated identical calls: counted from tool:called entries (not steps,
  // so orphan completions never masquerade as calls).
  const calls = new Map<string, number>();
  for (const e of entries) {
    if (e.kind !== 'tool:called') continue;
    const key = stableKey(String(e.tool ?? ''), e.args);
    calls.set(key, (calls.get(key) ?? 0) + 1);
  }
  let repeatedGroups = 0;
  for (const n of calls.values()) if (n >= REPEATED_CALL_THRESHOLD) repeatedGroups++;
  if (repeatedGroups > 0) taxonomy.push({ label: 'repeated_tool_calls', count: repeatedGroups });

  const toolErrors = entries.filter((e) => e.kind === 'tool:failed').length
    || steps.filter((s) => !s.ok && s.error !== undefined).length;
  if (toolErrors > 0) taxonomy.push({ label: 'tool_errors', count: toolErrors });
  return taxonomy;
}

const TRAJECTORY_VERDICTS: ReadonlySet<string> = new Set(['pass', 'fail', 'partial', 'blocked', 'none']);

function gateStatusToVerdict(status: string): TrajectoryVerdict {
  switch (status) {
    case 'PASS': return 'pass';
    case 'FAIL': return 'fail';
    case 'PARTIAL': return 'partial';
    case 'BLOCKED': return 'blocked';
    default: return 'none';
  }
}

/** Lift the loop's run-finish attribution entry into record fields. The
 *  entry is matched to the run's OWN agent (from task:started): subagent
 *  finishes share the event bus, and a child's attribution must never
 *  overwrite the parent run's join. When the owner is unknown (no
 *  task:started), the last attribution entry wins. */
function buildSkillAttribution(entries: TraceEntry[]): { skills: TrajectorySkillUse[]; verification: TrajectoryVerification | null; taskKind?: string } {
  const ownerEntry = entries.find((e) => e.kind === 'task:started');
  const owner = typeof ownerEntry?.agentId === 'string' ? ownerEntry.agentId : undefined;
  let chosen: TraceEntry | undefined;
  for (const e of entries) {
    if (e.kind !== 'skills:attributed') continue;
    if (owner && typeof e.agentId === 'string' && e.agentId !== owner) continue;
    chosen = e;
  }
  if (!chosen) return { skills: [], verification: null };
  const taskKind = typeof chosen.taskKind === 'string' && chosen.taskKind ? chosen.taskKind : undefined;
  const status = typeof chosen.verifyStatus === 'string' && chosen.verifyStatus ? chosen.verifyStatus : 'NONE';
  const skills: TrajectorySkillUse[] = [];
  if (Array.isArray(chosen.skills)) {
    for (const raw of chosen.skills) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as { id?: unknown; verdict?: unknown };
      if (typeof r.id !== 'string' || !r.id) continue;
      const verdict = typeof r.verdict === 'string' && TRAJECTORY_VERDICTS.has(r.verdict)
        ? (r.verdict as TrajectoryVerdict)
        : gateStatusToVerdict(status);
      skills.push({ id: r.id, verdict });
    }
  }
  const verdict = skills.length > 0 ? skills[0].verdict : gateStatusToVerdict(status);
  return { skills, verification: { status, verdict }, ...(taskKind ? { taskKind } : {}) };
}

/** Gate statuses that mean the run was VERIFIED solved (mirrors
 *  cost-per-solve's SOLVED_STATUSES — kept local to avoid an import cycle). */
const VERIFIED_STATUSES: ReadonlySet<string> = new Set(['PASS', 'FLAKY-PASS']);

export function isVerifiedRecord(rec: Pick<TrajectoryRecord, 'verification' | 'verified'>): boolean {
  if (typeof rec.verified === 'boolean') return rec.verified;
  return rec.verification !== null && rec.verification !== undefined && VERIFIED_STATUSES.has(rec.verification.status);
}

/** Derive the v2 cost rollup from a usage aggregate (null in, null out). */
export function deriveTrajectoryCost(usage: TrajectoryUsage | null): TrajectoryCost | null {
  if (!usage) return null;
  const reportedUsd = usage.costUsd ?? 0;
  const estimatedUsd = usage.estimatedCostUsd ?? 0;
  return {
    totalUsd: reportedUsd + estimatedUsd,
    reportedUsd,
    estimatedUsd,
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    source: usage.costSource ?? (reportedUsd > 0 ? 'provider' : 'unknown'),
  };
}

/** Convert raw trace entries into one structured trajectory record. Pure:
 *  no filesystem, no re-redaction (traces are already redacted). */
export function buildTrajectory(entries: TraceEntry[], meta: { runId: string; workspaceDir?: string }): TrajectoryRecord {
  const startedAt = entries.length && typeof entries[0].t === 'number' ? entries[0].t : null;
  const endedAt = entries.length && typeof entries[entries.length - 1].t === 'number' ? entries[entries.length - 1].t : null;
  const durationMs = startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : 0;

  // Task: from the first task:started event, when present.
  let task: TrajectoryTask | null = null;
  const started = entries.find((e) => e.kind === 'task:started');
  if (started) {
    const raw = started.task as { title?: unknown; description?: unknown } | string | undefined;
    if (typeof raw === 'string') {
      task = { title: raw };
    } else if (raw && typeof raw === 'object') {
      task = {};
      if (typeof raw.title === 'string' && raw.title) task.title = raw.title;
      if (typeof raw.description === 'string' && raw.description) task.prompt = raw.description;
    } else {
      task = {};
    }
  }

  // Steps: tool:called opens a step; the next tool:completed / tool:failed
  // for the same tool (in order) closes the oldest still-open one. An orphan
  // completion/failure becomes a step of its own (args unknown -> null), and
  // a call with no recorded completion stays in place, marked not-ok.
  const steps: TrajectoryStep[] = [];
  const open: Array<{ step: TrajectoryStep; calledAt?: number }> = [];
  const closeStep = (entry: TraceEntry, ok: boolean): void => {
    const tool = String(entry.tool ?? '');
    const idx = open.findIndex((o) => o.step.tool === tool);
    let step: TrajectoryStep;
    let calledAt: number | undefined;
    if (idx >= 0) {
      step = open[idx].step;
      calledAt = open[idx].calledAt;
      open.splice(idx, 1);
    } else {
      step = { index: steps.length, tool, args: null, argShape: argShapeOf(null), ok, outputSnippet: '' };
      steps.push(step);
    }
    step.ok = ok;
    if (ok) {
      step.outputSnippet = completedOutput(entry);
    } else {
      step.error = entry.error !== undefined && entry.error !== null ? String(entry.error) : undefined;
      if (step.error === undefined) delete step.error;
      step.outputSnippet = '';
    }
    const fromResult = resultDurationMs(entry);
    if (fromResult !== undefined) step.durationMs = fromResult;
    else if (calledAt !== undefined && typeof entry.t === 'number') step.durationMs = Math.max(0, entry.t - calledAt);
  };
  for (const entry of entries) {
    if (entry.kind === 'tool:called') {
      const step: TrajectoryStep = {
        index: steps.length,
        tool: String(entry.tool ?? ''),
        args: entry.args ?? null,
        argShape: argShapeOf(entry.args ?? null),
        ok: false,
        outputSnippet: '',
      };
      steps.push(step);
      open.push({ step, calledAt: typeof entry.t === 'number' ? entry.t : undefined });
    } else if (entry.kind === 'tool:completed') {
      closeStep(entry, true);
    } else if (entry.kind === 'tool:failed') {
      closeStep(entry, false);
    }
  }

  // Outcome: the LAST terminal task event wins (a run may retry a task).
  let outcome: TrajectoryOutcome = { completed: false };
  for (const entry of entries) {
    if (entry.kind === 'task:completed') {
      outcome = { completed: true };
      if (typeof entry.stopReason === 'string' && entry.stopReason) outcome.stopReason = entry.stopReason;
    } else if (entry.kind === 'task:failed') {
      outcome = { completed: false };
      if (typeof entry.stopReason === 'string' && entry.stopReason) outcome.stopReason = entry.stopReason;
      if (entry.reason !== undefined && entry.reason !== null) outcome.reason = String(entry.reason);
    }
  }

  const attribution = buildSkillAttribution(entries);
  // C5: when the trace recorded tokens but $0/no provider cost, surface the
  // price-table estimate alongside (never instead of) the recorded cost.
  const usage = aggregateUsage(entries);
  if (usage) {
    const tc = costFromTraceEntries(entries);
    if (tc.estimatedCostUsd > 0) {
      usage.estimatedCostUsd = tc.estimatedCostUsd;
      usage.costSource = tc.costSource;
    } else if ((usage.costUsd ?? 0) > 0) {
      usage.costSource = 'provider';
    }
  }
  // D9 (v2): a task:started entry may also carry the kind directly (newer
  //  traces); the attribution entry's stamp is the fallback.
  const startedKind = typeof started?.taskKind === 'string' && started.taskKind ? started.taskKind : undefined;
  return {
    schemaVersion: 2,
    runId: meta.runId,
    taskKind: startedKind ?? attribution.taskKind ?? 'unknown',
    verified: attribution.verification !== null && VERIFIED_STATUSES.has(attribution.verification.status),
    cost: deriveTrajectoryCost(usage),
    ...(meta.workspaceDir ? { workspaceDir: meta.workspaceDir } : {}),
    startedAt,
    endedAt,
    durationMs,
    task,
    steps,
    skills: attribution.skills,
    verification: attribution.verification,
    outcome,
    usage,
    failureTaxonomy: buildFailureTaxonomy(entries, steps, outcome),
  };
}

/** Read a run's trace, build its trajectory, and persist it as a single JSON
 *  line under <workspace>/exports/trajectory-<runId>.jsonl — outside traces/,
 *  so pruneTraces never reaps exports. Returns null when no trace exists. */
export function exportTrajectory(
  workspaceDir: string,
  runId: string,
): { path: string; record: TrajectoryRecord } | null {
  const entries = readTrace(workspaceDir, runId);
  if (!entries.length) return null;
  const record = buildTrajectory(entries, { runId, workspaceDir });
  const dir = resolve(workspaceDir, 'exports');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `trajectory-${runId}.jsonl`);
  writeFileSync(path, JSON.stringify(record) + '\n', 'utf8');
  return { path, record };
}

// ─── Backwards-compatible record reader (D9) ─────────────────────────────
// Exports on disk may be v1 (no taskKind / argShape / cost / verified) or v2.
// The reader accepts both, preserves the record's ORIGINAL schemaVersion as
// provenance, and fills every v2 field by derivation from data the v1 record
// already carries (args -> argShape, usage -> cost, verification -> verified,
// attribution-less kind -> 'unknown'). Malformed input returns null / is
// skipped — a corrupt export must never break an offline mining pass.

export function upgradeTrajectoryRecord(raw: unknown): TrajectoryRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.runId !== 'string' || !r.runId) return null;
  if (!Array.isArray(r.steps)) return null;
  const steps: TrajectoryStep[] = [];
  for (const s of r.steps) {
    if (!s || typeof s !== 'object') return null;
    const st = s as Record<string, unknown>;
    if (typeof st.tool !== 'string') return null;
    const args = 'args' in st ? st.args : null;
    const step: TrajectoryStep = {
      index: typeof st.index === 'number' ? st.index : steps.length,
      tool: st.tool,
      args,
      argShape: typeof st.argShape === 'string' ? st.argShape : argShapeOf(args),
      ok: st.ok === true,
      outputSnippet: typeof st.outputSnippet === 'string' ? st.outputSnippet : '',
    };
    if (typeof st.error === 'string') step.error = st.error;
    if (typeof st.durationMs === 'number' && Number.isFinite(st.durationMs)) step.durationMs = st.durationMs;
    steps.push(step);
  }
  const usage = r.usage && typeof r.usage === 'object' ? (r.usage as TrajectoryUsage) : null;
  let verification: TrajectoryVerification | null = null;
  if (r.verification && typeof r.verification === 'object') {
    const v = r.verification as Record<string, unknown>;
    if (typeof v.status === 'string') {
      verification = {
        status: v.status,
        verdict: typeof v.verdict === 'string' && TRAJECTORY_VERDICTS.has(v.verdict)
          ? (v.verdict as TrajectoryVerdict)
          : gateStatusToVerdict(v.status),
      };
    }
  }
  const costRaw = r.cost && typeof r.cost === 'object' ? (r.cost as Record<string, unknown>) : null;
  const cost: TrajectoryCost | null = costRaw && typeof costRaw.totalUsd === 'number'
    ? {
        totalUsd: costRaw.totalUsd,
        reportedUsd: typeof costRaw.reportedUsd === 'number' ? costRaw.reportedUsd : 0,
        estimatedUsd: typeof costRaw.estimatedUsd === 'number' ? costRaw.estimatedUsd : 0,
        ...(typeof costRaw.totalTokens === 'number' ? { totalTokens: costRaw.totalTokens } : {}),
        source: typeof costRaw.source === 'string' ? costRaw.source : 'unknown',
      }
    : deriveTrajectoryCost(usage);
  const outcomeRaw = r.outcome && typeof r.outcome === 'object' ? (r.outcome as Record<string, unknown>) : {};
  const outcome: TrajectoryOutcome = { completed: outcomeRaw.completed === true };
  if (typeof outcomeRaw.stopReason === 'string' && outcomeRaw.stopReason) outcome.stopReason = outcomeRaw.stopReason;
  if (typeof outcomeRaw.reason === 'string' && outcomeRaw.reason) outcome.reason = outcomeRaw.reason;
  const skills: TrajectorySkillUse[] = [];
  if (Array.isArray(r.skills)) {
    for (const s of r.skills) {
      if (!s || typeof s !== 'object') continue;
      const sk = s as Record<string, unknown>;
      if (typeof sk.id !== 'string' || !sk.id) continue;
      skills.push({
        id: sk.id,
        verdict: typeof sk.verdict === 'string' && TRAJECTORY_VERDICTS.has(sk.verdict)
          ? (sk.verdict as TrajectoryVerdict)
          : 'none',
      });
    }
  }
  const failureTaxonomy: TrajectoryFailure[] = [];
  if (Array.isArray(r.failureTaxonomy)) {
    for (const f of r.failureTaxonomy) {
      if (!f || typeof f !== 'object') continue;
      const fr = f as Record<string, unknown>;
      if (typeof fr.label === 'string' && typeof fr.count === 'number') {
        failureTaxonomy.push({ label: fr.label, count: fr.count });
      }
    }
  }
  let task: TrajectoryTask | null = null;
  if (r.task && typeof r.task === 'object') {
    const t = r.task as Record<string, unknown>;
    task = {};
    if (typeof t.title === 'string' && t.title) task.title = t.title;
    if (typeof t.prompt === 'string' && t.prompt) task.prompt = t.prompt;
  }
  return {
    schemaVersion: r.schemaVersion === 2 ? 2 : 1,
    runId: r.runId,
    taskKind: typeof r.taskKind === 'string' && r.taskKind ? r.taskKind : 'unknown',
    verified: typeof r.verified === 'boolean'
      ? r.verified
      : verification !== null && VERIFIED_STATUSES.has(verification.status),
    cost,
    ...(typeof r.workspaceDir === 'string' ? { workspaceDir: r.workspaceDir } : {}),
    startedAt: typeof r.startedAt === 'number' ? r.startedAt : null,
    endedAt: typeof r.endedAt === 'number' ? r.endedAt : null,
    durationMs: typeof r.durationMs === 'number' && Number.isFinite(r.durationMs) ? r.durationMs : 0,
    task,
    steps,
    skills,
    verification,
    outcome,
    usage,
    failureTaxonomy,
  };
}

/** Parse a trajectory export file's text (one JSON record per line, though a
 *  single bare JSON object is also accepted). Bad lines are skipped. */
export function parseTrajectoryJsonl(text: string): TrajectoryRecord[] {
  const out: TrajectoryRecord[] = [];
  const trimmed = text.trim();
  if (!trimmed) return out;
  const lines = trimmed.includes('\n') ? trimmed.split('\n') : [trimmed];
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    try {
      const rec = upgradeTrajectoryRecord(JSON.parse(l));
      if (rec) out.push(rec);
    } catch { /* skip malformed line */ }
  }
  return out;
}

/** Read one run's durable export through the v2 reader; null when absent or
 *  unreadable. (Raw traces are read with readTrace in trace.ts; exports are
 *  the post-prune durable form, so mining passes should read THESE.) */
export function readTrajectoryExport(workspaceDir: string, runId: string): TrajectoryRecord | null {
  try {
    const p = resolve(workspaceDir, 'exports', `trajectory-${runId}.jsonl`);
    if (!existsSync(p)) return null;
    const recs = parseTrajectoryJsonl(readFileSync(p, 'utf8'));
    return recs[0] ?? null;
  } catch {
    return null;
  }
}
