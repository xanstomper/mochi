// Trajectory exporter: converts a raw per-run trace (see trace.ts) into ONE
// structured, step-level trajectory record for harness distillation / SFT.
//
// TraceRecorder writes append-only JSONL to <workspace>/traces/<runId>.jsonl
// and pruneTraces() reaps that directory (100 files / 32MB), so raw traces are
// the wrong artifact to train or eval on: they are event soup, they disappear,
// and the run outcome lives in a different event than the steps that caused
// it. A TrajectoryRecord joins it all — task, ordered tool steps (called
// paired with completed/failed), final outcome, aggregated usage, and a
// simple evidence-only failure taxonomy — as a single JSON object.
//
// Exports land in <workspace>/exports/ (a sibling of traces/, NOT inside it),
// so pruneTraces never reaps them. Trace payloads were already redacted by
// TraceRecorder at write time; this module passes recorded values through
// untouched and never re-derives them from anywhere else.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readTrace, type TraceEntry } from './trace.js';

export interface TrajectoryTask {
  title?: string;
  prompt?: string;
}

export interface TrajectoryStep {
  index: number;
  tool: string;
  /** Tool args exactly as recorded in the trace (already redacted). */
  args: unknown;
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
}

export interface TrajectoryFailure {
  label: string;
  count: number;
}

export interface TrajectoryRecord {
  schemaVersion: 1;
  runId: string;
  workspaceDir?: string;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number;
  task: TrajectoryTask | null;
  steps: TrajectoryStep[];
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
const USAGE_FIELDS: Array<[canonical: keyof TrajectoryUsage, keys: string[]]> = [
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
      step = { index: steps.length, tool, args: null, ok, outputSnippet: '' };
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

  return {
    schemaVersion: 1,
    runId: meta.runId,
    ...(meta.workspaceDir ? { workspaceDir: meta.workspaceDir } : {}),
    startedAt,
    endedAt,
    durationMs,
    task,
    steps,
    outcome,
    usage: aggregateUsage(entries),
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
