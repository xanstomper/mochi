// Run trace recorder: a durable, redacted log of what an agent actually did,
// written as JSONL to <workspace>/.mochi/traces/<runId>.jsonl. This is the
// observability layer modern harnesses ship by default (LangSmith-style
// traces): you can replay a run, diff two runs, and audit tool calls/costs
// without live streams.
//
// The recorder subscribes to the EventBus and appends one JSON object per
// entry: {t: <unix ms>, kind, agentId, ...payload}. All payload strings pass
// through security.redact() so secrets never land in a trace file.
import { mkdirSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EventBus } from './events.js';
import type { MochiEvent } from './types.js';
import { redact, redactObject } from './security.js';

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
      case 'task:started': lines.push(`▸ started: ${String((e.task as any)?.title ?? '')}`); break;
      case 'task:completed': lines.push(`[OK] done (${e.stopReason ?? 'completed'})`); break;
      case 'task:failed': lines.push(`[ERR] failed: ${String(e.reason ?? '').slice(0, 120)}`); break;
      case 'tool:called': lines.push(`  tool ${e.tool} ${JSON.stringify(e.args ?? {}).slice(0, 120)}`); break;
      case 'tool:completed': lines.push(`  tool ${e.tool} → ${String((e.result as any)?.output ?? '').slice(0, 100)}`); break;
      case 'tool:failed': lines.push(`  tool ${e.tool} [ERR] ${String(e.error).slice(0, 100)}`); break;
      case 'agent:log': lines.push(`  [log] ${String(e.message).slice(0, 120)}`); break;
      default: break;
    }
  }
  return lines.join('\n');
}