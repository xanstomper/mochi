/**
 * InterventionPolicy — one gate for the loop's soft (guidance) nudges.
 *
 * Problem: the loop injects system messages from ~84 scattered sites. Each
 * family is throttled on its own, but nothing caps the AGGREGATE: a struggling
 * turn can hit the model with a struggle summary, a complexity escalation,
 * and a commit directive at once — a wall of harness text that feeds the
 * very deliberation loops the harness is trying to break.
 *
 * Design (review item 2, slice 1):
 * - Only SOFT nudges go through the policy: 'struggle' (guidance),
 *   'commit' (decisive-action directive), and 'pulse' (periodic heartbeat
 *   / repeated-error nudge). Hard directives — task contract,
 *   finish drives, verify gates, complexity escalation (a once-only state
 *   notice) — bypass it entirely and inject directly, as today.
 * - Soft nudges are QUEUED during a turn and FLUSHED once, right before the
 *   next model call. At most one soft message reaches the model per call;
 *   when two compete, the higher-priority one wins and the loser counts as
 *   suppressed (it can re-fire on a later turn if its signal persists).
 * - A per-run budget (30) backstops pathological spam; it is deliberately
 *   generous, not a tight cap — the per-call cap does the real work.
 * - Every decision is counted so the finish telemetry log can report
 *   fired vs suppressed, which is what the later ablation (review item 7)
 *   tunes against. The policy is pure (no I/O, no events); the loop logs.
 */
export type SoftInterventionTag = 'struggle' | 'commit' | 'pulse';

export interface QueuedIntervention {
  tag: SoftInterventionTag;
  content: string;
  /** Signal count for the struggle summary (0 for commit/pulse). */
  signals: number;
}

export interface InterventionStats {
  fired: number;
  suppressed: number;
  firedByTag: Record<string, number>;
  suppressedByTag: Record<string, number>;
}

/** Higher wins when two soft nudges compete for one model call. Commit
 *  (act now) outranks struggle (guidance) because a deliberating model
 *  needs the decisive push more than the diagnosis. Pulse ranks lowest:
 *  it is generic, re-fires on its own schedule when suppressed, and must
 *  never crowd out a specific diagnosis or a decisive push. */
const PRIORITY: Record<SoftInterventionTag, number> = { commit: 70, struggle: 30, pulse: 20 };

/** Soft nudges per run — backstop against pathological spam, not a tight cap. */
export const INTERVENTION_RUN_BUDGET = 30;

export class InterventionPolicy {
  private queued: QueuedIntervention | null = null;
  private firedTotal = 0;
  private suppressedTotal = 0;
  private firedByTag: Record<string, number> = {};
  private suppressedByTag: Record<string, number> = {};

  /**
   * Buffer a soft nudge for the next model call. Returns whether it is
   * queued or suppressed. A higher-priority nudge displaces a queued
   * lower-priority one (the displaced nudge counts as suppressed).
   */
  queue(tag: SoftInterventionTag, content: string, signals = 0): 'queued' | 'suppressed' {
    if (this.firedTotal >= INTERVENTION_RUN_BUDGET) {
      this.suppressedTotal++;
      this.suppressedByTag[tag] = (this.suppressedByTag[tag] ?? 0) + 1;
      return 'suppressed';
    }
    if (!this.queued) {
      this.queued = { tag, content, signals };
      return 'queued';
    }
    if (PRIORITY[tag] > PRIORITY[this.queued.tag]) {
      const displaced = this.queued.tag;
      this.suppressedTotal++;
      this.suppressedByTag[displaced] = (this.suppressedByTag[displaced] ?? 0) + 1;
      this.queued = { tag, content, signals };
      return 'queued';
    }
    this.suppressedTotal++;
    this.suppressedByTag[tag] = (this.suppressedByTag[tag] ?? 0) + 1;
    return 'suppressed';
  }

  /**
   * Drain the queued nudge (at most one per model call). Returns the winner
   * or null when nothing was queued. Firing counts toward the run budget.
   */
  flush(): QueuedIntervention | null {
    const won = this.queued;
    this.queued = null;
    if (won) {
      this.firedTotal++;
      this.firedByTag[won.tag] = (this.firedByTag[won.tag] ?? 0) + 1;
    }
    return won;
  }

  get stats(): InterventionStats {
    return {
      fired: this.firedTotal,
      suppressed: this.suppressedTotal,
      firedByTag: { ...this.firedByTag },
      suppressedByTag: { ...this.suppressedByTag },
    };
  }
}
