import { performance } from 'node:perf_hooks';
import type { EventBus } from '../events.js';
import type { MochiEvent } from '../types.js';
import type { AgentStopReason } from './loop.js';

/**
 * Harness-v2 roadmap Phase 1: deterministic iteration lifecycle.
 *
 * Phases of one agent-loop iteration, in the order the roadmap spec defines
 * them: preflight → model-call → stream-guard → tool-exec → verify → finish.
 * Within a live run an iteration may skip forward (a direct answer goes
 * model-call → verify) or restart at model-call on a nudge; every exit path
 * (including abort/timeout/budget from ANY phase) lands in finish.
 */
export type LoopPhase = 'preflight' | 'model-call' | 'stream-guard' | 'tool-exec' | 'verify' | 'finish';

/** Typed per-iteration trace emitted exactly once per loop turn. */
export interface IterationTrace {
  iteration: number;
  stopReason?: AgentStopReason | string;
  toolCalls: number;
  streamBytes: number;
  durationMs: number;
  /** Phase the iteration ended in — pinpoints where a run aborted/timed out. */
  phase: LoopPhase;
}

/**
 * Legal phase transitions within one iteration. `finish` is reachable from
 * every phase (abort, runtime limit, budget exhaustion and pulse aborts must
 * be able to stop from anywhere without a hang path). Re-entering the current
 * phase is an idempotent no-op (stream retries), not a violation.
 */
const LEGAL: Record<LoopPhase, LoopPhase[]> = {
  preflight: ['model-call', 'finish'],
  'model-call': ['stream-guard', 'tool-exec', 'verify', 'finish'],
  'stream-guard': ['tool-exec', 'verify', 'model-call', 'finish'],
  'tool-exec': ['verify', 'model-call', 'finish'],
  verify: ['model-call', 'finish'],
  finish: [],
};

export interface TransitionViolation {
  from: LoopPhase;
  to: LoopPhase;
  iteration: number;
}

/**
 * Tracks the loop's phase lifecycle and produces one IterationTrace per loop
 * turn. Never throws on odd transitions — violations are recorded for tests
 * and diagnostics so an unexpected jump can never crash a live agent run.
 *
 * Trace emission contract: exactly ONE trace per iteration. A `continue`-ended
 * iteration is flushed by the NEXT beginIteration(); an iteration that exits
 * run() is flushed by finish() with its stop reason.
 */
export class LoopStateMachine {
  phase: LoopPhase = 'preflight';
  iteration = -1;
  readonly violations: TransitionViolation[] = [];

  private startedAt = 0;
  private toolCalls = 0;
  private streamBytes = 0;
  private pending = false;

  constructor(private events: EventBus, private agentId: string) {}

  /** Start iteration `i`; flushes the previous iteration's pending trace. */
  beginIteration(i: number): void {
    this.flush();
    this.iteration = i;
    // Iteration boundaries are the legal reset point: whatever phase the last
    // iteration nudged out of, the next one starts clean at preflight.
    this.phase = 'preflight';
    this.startedAt = performance.now();
    this.toolCalls = 0;
    this.streamBytes = 0;
    this.pending = true;
  }

  enter(next: LoopPhase): void {
    if (next === this.phase) return; // idempotent re-entry (e.g. stream retry)
    if (!LEGAL[this.phase].includes(next)) {
      this.violations.push({ from: this.phase, to: next, iteration: this.iteration });
    }
    this.phase = next;
  }

  recordToolCalls(n: number): void {
    if (Number.isFinite(n) && n > 0) this.toolCalls += n;
  }

  addStreamBytes(n: number): void {
    if (Number.isFinite(n) && n > 0) this.streamBytes += n;
  }

  /**
   * Emit this iteration's IterationTrace (once). Returns the trace, or
   * undefined when there is nothing pending (no active iteration / already
   * flushed).
   */
  flush(stopReason?: AgentStopReason | string): IterationTrace | undefined {
    if (!this.pending || this.iteration < 0) return undefined;
    this.pending = false;
    const trace: IterationTrace = {
      iteration: this.iteration,
      ...(stopReason !== undefined ? { stopReason } : {}),
      toolCalls: this.toolCalls,
      streamBytes: this.streamBytes,
      durationMs: Math.max(0, Math.round((performance.now() - this.startedAt) * 100) / 100),
      phase: this.phase,
    };
    const event: MochiEvent = { type: 'agent:iteration', agentId: this.agentId, trace };
    this.events.emit(event);
    return trace;
  }
}
