import { MemoryStore } from './memory.js';
import type { GoalResult } from './goals/goal.js';
import type { Task } from './types.js';

// Persistent memory consolidation. jcode keeps a durable learnings graph so it
// does not repeat earlier mistakes across sessions. Mochi's MemoryStore could
// already *write* but nothing ever drove it: it was effectively read-only, and
// every run started from a blank slate. This consolidator closes that by
// distilling the REAL terminal outcome of a run into `.mochi/memory/failures.md`
// with zero model involvement:
//
//   - If the run failed, each failed task becomes a `failure` memory entry whose
//     body is that task's actual failure reason (its final attempt's
//     `failureReason`), capped at a hard byte budget so memory stays lean.
//   - `MemoryStore.add` dedups by title, so re-running the same failing task
//     once does not pile up duplicate lessons.
//   - Successful runs write nothing: we do not manufacture from noise.
//
// A subsequent run's context engine (`loadMemory`) reads these entries back, so
// the workspace literally gets smarter across runs. All deterministic, no model
// in the loop, unit-testable without a provider.

const MAX_BODY = 500;

/** Best-effort, bounded extraction of the concrete reason a task failed. */
function failureReason(task: Task): string {
  if (task.attempts && task.attempts.length) {
    for (let i = task.attempts.length - 1; i >= 0; i--) {
      const r = task.attempts[i]?.failureReason?.trim();
      if (r) return r;
    }
  }
  const out = task.output?.trim();
  return out ?? '';
}

export interface ConsolidationResult {
  added: number;
  failures: string[];
}

/** Distill a finished run's failures into persistent, deduped memory. */
export function consolidate(workspaceDir: string, result: GoalResult, model = 'mochi'): ConsolidationResult {
  if (!workspaceDir) return { added: 0, failures: [] };
  const out: ConsolidationResult = { added: 0, failures: [] };
  if (result.success) return out;
  const store = new MemoryStore(workspaceDir);
  const seenTitles = new Set(store.entries('failure').map((e) => e.title));
  for (const task of result.failedTasks) {
    const reason = failureReason(task).slice(0, MAX_BODY);
    if (!reason) continue;
    const title = `Failed: ${task.title}`;
    if (seenTitles.has(title)) continue; // already remembered
    try {
      if (store.addFailure(title, reason, `goal:${model}`)) {
        seenTitles.add(title);
        out.added++;
        out.failures.push(title);
      }
    } catch {
      // Memory must never break the run it is summarizing.
    }
  }
  return out;
}

/** Shared title/body normalization used by both consolidation and tests. */
export function consolidateReason(task: Pick<Task, 'attempts' | 'output'>): string {
  return failureReason(task as Task);
}