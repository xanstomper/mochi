// Run trace recorder: a durable, redacted log of what an agent actually did,
// written as JSONL to <workspace>/.mochi/traces/<runId>.jsonl. This is the
// observability layer modern harnesses ship by default (LangSmith-style
// traces): you can replay a run, diff two runs, and audit tool calls/costs
// without live streams.
//
// The recorder subscribes to the EventBus and appends one JSON object per
// entry: {t: <unix ms>, kind, agentId, ...payload}. All payload strings pass
// through security.redact() so secrets never land in a trace file.
import { mkdirSync, appendFileSync, readFileSync, existsSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { EventBus } from '../events.js';
import type { MochiEvent } from '../types.js';
import { redact, redactObject } from '../security/security.js';

export interface TraceEntry {
  t: number;
  kind: string;
  agentId?: string;
  [key: string]: unknown;
}

export class TraceRecorder {
  private file: string;
  private disposed = false;
  private handlers: (() => void)[] = [];

  constructor(workspaceDir: string, runId: string) {
    const dir = resolve(workspaceDir, 'traces');
    mkdirSync(dir, { recursive: true });
    this.file = resolve(dir, `${runId}.jsonl`);
    try { appendFileSync(this.file, ''); } catch { /* best effort */ }
    // Retention janitor: each new run reaps oldest traces past the cap, so
    // the directory can never grow without bound (was 3.6M+ unchecked).
    try { pruneTraces(workspaceDir); } catch { /* best effort */ }
  }

  /** Subscribe to an EventBus; returns this for chaining. Disposes on close. */
  attach(events: EventBus): this {
    this.handlers.push(events.onAll((e: MochiEvent) => this.write(e)));
    return this;
  }

  attachAgent(events: EventBus, agentId: string): this {
    this.handlers.push(events.onAll((e) => this.write(e, agentId)));
    return this;
  }

  private write(event: MochiEvent, forcedAgent?: string): void {
    if (this.disposed) return;
    const entry: TraceEntry = { t: Date.now(), kind: event.type, agentId: (event as { agentId?: string }).agentId ?? forcedAgent };
    const e = event as Record<string, unknown>;
    for (const [k, v] of Object.entries(e)) {
      if (k === 'type' || k === 'agentId') continue;
      // Deep-redact nested strings (tool args carry secrets under command).
      entry[k] = typeof v === 'string' ? redact(v) : redactObject(v);
    }
    try {
      appendFileSync(this.file, JSON.stringify(entry) + '\n', 'utf8');
    } catch {
      // A trace must never break the agent: writes are best-effort.
    }
  }

  /** Write an out-of-band entry (e.g. run summary at completion). */
  log(entry: TraceEntry): void {
    if (!this.disposed) {
      try { appendFileSync(this.file, JSON.stringify({ ...entry, t: entry.t ?? Date.now() }) + '\n', 'utf8'); } catch { /* best effort */ }
    }
  }

  close(): void {
    this.disposed = true;
    for (const off of this.handlers) off();
    this.handlers = [];
  }
}

/** Replay a trace file into JSON entries (for `mochi trace`). */
export function readTrace(workspaceDir: string, runId: string): TraceEntry[] {
  const p = resolve(workspaceDir, 'traces', `${runId}.jsonl`);
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as TraceEntry);
  } catch {
    return [];
  }
}

/** Render a trace as a compact log for the CLI/dashboard. */
export function formatTrace(entries: TraceEntry[]): string {
  const lines: string[] = [];
  for (const e of entries) {
    switch (e.kind) {
      case 'task:started': lines.push(`▸ started: ${String((e.task as { title?: unknown } | undefined)?.title ?? '')}`); break;
      case 'task:completed': lines.push(`[OK] done (${e.stopReason ?? 'completed'})`); break;
      case 'task:failed': lines.push(`[ERR] failed: ${String(e.reason ?? '').slice(0, 120)}`); break;
      case 'tool:called': lines.push(`  tool ${e.tool} ${JSON.stringify(e.args ?? {}).slice(0, 120)}`); break;
      case 'tool:completed': lines.push(`  tool ${e.tool} → ${String((e.result as { output?: unknown } | undefined)?.output ?? '').slice(0, 100)}`); break;
      case 'tool:failed': lines.push(`  tool ${e.tool} [ERR] ${String(e.error).slice(0, 100)}`); break;
      case 'agent:log': lines.push(`  [log] ${String(e.message).slice(0, 120)}`); break;
      default: break;
    }
  }
  return lines.join('\n');
}

/** Run ids that already have a durable trajectory export on disk.
 *  Exports live at `<workspace>/exports/trajectory-<runId>.jsonl` (see
 *  trajectory.ts `exportTrajectory`) and survive trace pruning, so once an
 *  export exists the raw trace is redundant. This scans file *names* only
 *  (no contents) once per prune/GC pass — cheap, and with no index file to
 *  keep in sync or repair if it is lost/corrupted. */
export function exportedTrajectoryRunIds(workspaceDir: string): Set<string> {
  const ids = new Set<string>();
  try {
    const dir = resolve(workspaceDir, 'exports');
    if (!existsSync(dir)) return ids;
    for (const f of readdirSync(dir)) {
      const m = /^trajectory-(.+)\.jsonl$/.exec(f);
      if (m) ids.add(m[1]);
    }
  } catch { /* best effort: no readable exports dir => nothing is exported */ }
  return ids;
}

/** True when a trace file records a terminal outcome — a `task:completed`
 *  or `task:failed` entry, the same detection trajectory.ts uses for a
 *  run's outcome. Such a run is finished: its trace is a completed-run
 *  record (the distillation / SFT corpus), not leftover debris from a
 *  crashed or still-running process. Malformed lines are skipped; an
 *  unreadable file counts as not-completed. */
export function traceFileHasTerminalEvent(filePath: string): boolean {
  try {
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const kind = (JSON.parse(line) as TraceEntry).kind;
        if (kind === 'task:completed' || kind === 'task:failed') return true;
      } catch { /* skip malformed line */ }
    }
  } catch { /* unreadable => not completed */ }
  return false;
}

/** Corpus protection, shared by pruneTraces (below) and the retention GC
 *  (memory/retention.ts): a completed run's trace must not be deleted
 *  until its trajectory export exists, because the raw trace is the only
 *  copy of the step-level record the export is built from. Incomplete /
 *  crashed runs (no terminal event) get no protection, so disk stays
 *  bounded by the size of the unexported-completed corpus, not by all
 *  history. `exported` is the set from exportedTrajectoryRunIds(), scanned
 *  once by the caller so a pass over many files costs one readdir. */
export function isUnexportedCompletedTrace(workspaceDir: string, filePath: string, exported?: Set<string>): boolean {
  const runId = basename(filePath, '.jsonl');
  if ((exported ?? exportedTrajectoryRunIds(workspaceDir)).has(runId)) return false;
  return traceFileHasTerminalEvent(filePath);
}

/** Retention policy for `<workspace>/traces`: keep the newest `maxFiles`
 *  runs AND stay under `maxBytes` total — oldest first out. Best-effort and
 *  never throws (a janitor must never break the agent). Returns the number
 *  of files removed.
 *
 *  Exception (corpus protection): a trace whose run completed but whose
 *  trajectory has not been exported yet is never pruned, even when that
 *  leaves the directory over the file/byte caps — the caps are a disk
 *  hygiene bound, the unexported corpus is the training/eval data. Only
 *  would-be victims are content-checked for a terminal event, so the
 *  common prune pass still costs just stats plus one exports readdir. */
export function pruneTraces(workspaceDir: string, maxFiles = 100, maxBytes = 32 * 1024 * 1024): number {
  let removed = 0;
  try {
    const dir = resolve(workspaceDir, 'traces');
    if (!existsSync(dir)) return 0;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = resolve(dir, f);
        try {
          const st = statSync(p);
          return { p, mtime: st.mtimeMs, size: st.size };
        } catch {
          return null;
        }
      })
      .filter((x): x is { p: string; mtime: number; size: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);
    const victims = new Set<string>();
    for (let i = maxFiles; i < files.length; i++) victims.add(files[i].p);
    let total = files.reduce((n, f) => n + f.size, 0);
    for (const f of [...files].reverse()) {
      if (total <= maxBytes) break;
      if (!victims.has(f.p)) {
        victims.add(f.p);
        total -= f.size;
      }
    }
    // Spare unexported completed traces (see isUnexportedCompletedTrace):
    // they stay until exported, after which the export is the durable
    // record and the raw trace may be pruned like any other.
    if (victims.size) {
      const exported = exportedTrajectoryRunIds(workspaceDir);
      for (const p of [...victims]) {
        if (isUnexportedCompletedTrace(workspaceDir, p, exported)) victims.delete(p);
      }
    }
    for (const p of victims) {
      try { unlinkSync(p); removed++; } catch { /* best effort */ }
    }
  } catch { /* best effort */ }
  return removed;
}