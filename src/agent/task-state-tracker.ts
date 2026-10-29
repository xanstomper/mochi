/**
 * TaskStateTracker — explicit task-state observation for the agent loop
 * (MOOSE STATE-1, slice 1: observe + advise, not a run() rewrite).
 *
 * Problem: the loop has no explicit notion of what phase a run is in, so a
 * run can wander (read, deliberate, read again, forever) or retry the same
 * failing approach without anything naming the pattern. The tracker infers
 * the state from each turn's action class and flags two no-progress cycles:
 * - inspect-plan-loop: INSPECT → PLAN → INSPECT with no EXECUTE between
 *   (intervening non-EXECUTE states do not break the pattern; only an
 *   EXECUTE resets it).
 * - same-failure-retry: the same failure detail across 2+ consecutive
 *   RECOVER observations (empty details never count).
 *
 * Advisor-only: the tracker never restarts, fails, or redirects a run. The
 * loop reads checkCycle() at turn top and queues any cycle as an ordinary
 * 'struggle' nudge through InterventionPolicy, which caps, prioritises,
 * and budgets it like every other soft nudge. Exhaustion (3 reported
 * cycles) is exposed via stats/exhausted for a later slice to act on; this
 * slice does not auto-fail a run — the existing verify/finish paths own
 * failure. Pure: no I/O, no events; the loop logs.
 */
export type TaskState =
  | 'INITIALIZE'
  | 'INSPECT'
  | 'PLAN'
  | 'EXECUTE'
  | 'VERIFY'
  | 'RECOVER'
  | 'COMPLETE'
  | 'FAILED';

export type TaskAction =
  | 'read'
  | 'write'
  | 'plan'
  | 'verify'
  | 'struggle'
  | 'finish-success'
  | 'finish-failure';

export interface TaskCycle {
  kind: 'inspect-plan-loop' | 'same-failure-retry';
  message: string;
}

export interface TaskStateStats {
  state: TaskState;
  transitions: number;
  cycleCount: number;
  exhausted: boolean;
}

const ACTION_STATE: Record<TaskAction, TaskState> = {
  read: 'INSPECT',
  write: 'EXECUTE',
  plan: 'PLAN',
  verify: 'VERIFY',
  struggle: 'RECOVER',
  'finish-success': 'COMPLETE',
  'finish-failure': 'FAILED',
};

/** Reported cycles before the tracker reports exhaustion (slice 1: signal only). */
export const TASK_STATE_EXHAUSTION_CYCLES = 3;

export class TaskStateTracker {
  private state: TaskState = 'INITIALIZE';
  private transitionCount = 0;
  private sinceExecute: TaskState[] = [];
  private recoverDetail: string | null = null;
  private recoverStreak = 0;
  private reported = new Set<TaskCycle['kind']>();
  private cycleCount = 0;

  observe(action: TaskAction, detail = ''): void {
    const next = ACTION_STATE[action];
    if (next !== this.state) this.transitionCount++;
    this.state = next;
    if (next === 'EXECUTE') {
      this.sinceExecute = [];
      this.reported.clear();
      this.recoverDetail = null;
      this.recoverStreak = 0;
      return;
    }
    this.sinceExecute.push(next);
    if (next === 'RECOVER') {
      if (detail) {
        if (detail === this.recoverDetail) this.recoverStreak++;
        else {
          this.recoverDetail = detail;
          this.recoverStreak = 1;
        }
      } else {
        this.recoverDetail = null;
        this.recoverStreak = 0;
      }
    }
  }

  /**
   * Return the next unreported no-progress cycle, or null. Each kind is
   * reported once until an EXECUTE resets it, so a persistent cycle nudges
   * once per action phase instead of every turn.
   */
  checkCycle(): TaskCycle | null {
    if (!this.reported.has('inspect-plan-loop')) {
      const seq = this.sinceExecute;
      const i = seq.indexOf('INSPECT');
      const j = i >= 0 ? seq.indexOf('PLAN', i + 1) : -1;
      const k = j >= 0 ? seq.indexOf('INSPECT', j + 1) : -1;
      if (k >= 0) {
        return this.report({
          kind: 'inspect-plan-loop',
          message:
            'TASK-STATE: this run has cycled INSPECT → PLAN → INSPECT without executing anything. ' +
            'Stop exploring and deliberating: make the next edit or run the next command, or report a concrete blocker.',
        });
      }
    }
    if (!this.reported.has('same-failure-retry') && this.recoverStreak >= 2) {
      return this.report({
        kind: 'same-failure-retry',
        message:
          `TASK-STATE: the same approach has failed ${this.recoverStreak} times in a row. ` +
          'Change strategy: a different tool, reduced scope, or report a concrete blocker.',
      });
    }
    return null;
  }

  private report(cycle: TaskCycle): TaskCycle {
    this.reported.add(cycle.kind);
    this.cycleCount++;
    return cycle;
  }

  get current(): TaskState {
    return this.state;
  }

  get exhausted(): boolean {
    return this.cycleCount >= TASK_STATE_EXHAUSTION_CYCLES;
  }

  get stats(): TaskStateStats {
    return {
      state: this.state,
      transitions: this.transitionCount,
      cycleCount: this.cycleCount,
      exhausted: this.exhausted,
    };
  }
}
