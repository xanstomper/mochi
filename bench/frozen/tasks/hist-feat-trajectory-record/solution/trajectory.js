// Canned solution: the trajectory-record builder from
// src/observability/trajectory.ts as of 0b225a8 (feat(trajectory): build
// structured trajectory records from run traces) — the real buildTrajectory
// implementation and its helpers, with TypeScript types stripped and the
// export converted to CommonJS for the frozen workdir. (The repo module also
// exports exportTrajectory(), the filesystem writer around readTrace(); the
// record builder exercised here is the pure core.)
//
// A trace records WHAT HAPPENED during one agent run; buildTrajectory turns
// it into a TrajectoryRecord — task, ordered tool steps (called paired with
// completed/failed), final outcome, aggregated usage, and an evidence-only
// failure taxonomy — as a single JSON object.

const OUTPUT_SNIPPET_MAX = 500;
const REPEATED_CALL_THRESHOLD = 3;

function snippet(value) {
  if (value === undefined || value === null) return '';
  const s = typeof value === 'string' ? value : String(value);
  return s.slice(0, OUTPUT_SNIPPET_MAX);
}

/** Output text of a tool:completed entry: its ToolResult.output when the
 *  result is the usual ToolResult object, the string itself when legacy
 *  traces recorded the result as a bare string, '' otherwise. */
function completedOutput(entry) {
  const result = entry.result;
  if (typeof result === 'string') return snippet(result);
  if (result && typeof result === 'object') return snippet(result.output);
  return snippet(entry.output);
}

function resultDurationMs(entry) {
  const result = entry.result;
  if (result && typeof result === 'object' && typeof result.durationMs === 'number' && Number.isFinite(result.durationMs)) {
    return result.durationMs;
  }
  return undefined;
}

/** Canonical usage fields read from a record, under either naming scheme:
 *  nested provider usage (promptTokens/completionTokens/cachedTokens) or
 *  the flat usage:updated event fields (inputTokens/outputTokens/...). */
const USAGE_FIELDS = [
  ['inputTokens', ['inputTokens', 'promptTokens']],
  ['outputTokens', ['outputTokens', 'completionTokens']],
  ['cacheTokens', ['cacheTokens', 'cachedTokens']],
  ['totalTokens', ['totalTokens']],
  ['costUsd', ['costUsd']],
];

function addUsage(acc, source) {
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

function aggregateUsage(entries) {
  const acc = {};
  for (const entry of entries) {
    const nested = entry.usage;
    if (nested && typeof nested === 'object') addUsage(acc, nested);
    if (entry.kind === 'usage:updated') addUsage(acc, entry);
  }
  return Object.keys(acc).length ? acc : null;
}

function stableKey(tool, args) {
  try {
    return `${tool}\u0000${JSON.stringify(args ?? null) ?? ''}`;
  } catch {
    return `${tool}\u0000${String(args)}`;
  }
}

function buildFailureTaxonomy(entries, steps, outcome) {
  const taxonomy = [];
  const stop = outcome.stopReason ?? '';
  if (stop === 'tool_loop' || stop.includes('tool_loop')) taxonomy.push({ label: 'tool_loop', count: 1 });
  if (stop === 'verification_failed' || stop.includes('verification_failed')) taxonomy.push({ label: 'verification_failed', count: 1 });
  if (stop === 'stuck_no_progress' || stop.includes('stuck_no_progress')) taxonomy.push({ label: 'stuck_no_progress', count: 1 });

  // Repeated identical calls: counted from tool:called entries (not steps,
  // so orphan completions never masquerade as calls).
  const calls = new Map();
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
function buildTrajectory(entries, meta) {
  const startedAt = entries.length && typeof entries[0].t === 'number' ? entries[0].t : null;
  const endedAt = entries.length && typeof entries[entries.length - 1].t === 'number' ? entries[entries.length - 1].t : null;
  const durationMs = startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : 0;

  // Task: from the first task:started event, when present.
  let task = null;
  const started = entries.find((e) => e.kind === 'task:started');
  if (started) {
    const raw = started.task;
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
  const steps = [];
  const open = [];
  const closeStep = (entry, ok) => {
    const tool = String(entry.tool ?? '');
    const idx = open.findIndex((o) => o.step.tool === tool);
    let step;
    let calledAt;
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
      const step = {
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
  let outcome = { completed: false };
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

module.exports = { buildTrajectory };
