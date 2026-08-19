// Classify a task into a coarse "kind" so the loop can tailor its system
// prompt, retry strategy, and context emphasis. Heuristic-only: no model
// call. The kind is a string enum used as a key in prompt variant tables.
import type { Task } from './types.js';

export type TaskKind = 'implement' | 'fix' | 'refactor' | 'test' | 'research' | 'plan' | 'document' | 'unknown';

const FIX_RE = /\b(fix|bug|broken|crash|hang|leak|stack\s*trace|regression|panic|null\s*pointer|segfault|fail|throws|exception)\b/i;
const REFACTOR_RE = /\b(refactor|rename|move|extract|split|consolidate|simplify|clean\s*up|dedupe|reorganiz)/i;
const TEST_RE = /\b(test|spec|coverage|assert|jest|vitest|pytest|unittest)\b/i;
const RESEARCH_RE = /\b(research|investigate|explore|find\s*out|discover|learn|document|how\s*does|why\s*does)\b/i;
const PLAN_RE = /\b(plan|design|architect|sketch|outline|proposal)\b/i;
const DOC_RE = /\b(document|readme|doc|comment|jsdoc|docstring|annotate|spec\s*doc|architecture\s*doc)\b/i;

export function classifyTaskKind(task: Pick<Task, 'title' | 'description' | 'role'>): TaskKind {
  const text = `${task.title} ${task.description}`.trim();
  if (!text) return 'unknown';
  if (FIX_RE.test(text) || task.role === 'debugger') return 'fix';
  if (TEST_RE.test(text) || task.role === 'tester') return 'test';
  if (REFACTOR_RE.test(text)) return 'refactor';
  if (DOC_RE.test(text)) return 'document';
  if (PLAN_RE.test(text) || task.role === 'architect') return 'plan';
  if (RESEARCH_RE.test(text) || task.role === 'researcher') return 'research';
  if (task.role === 'coder' || task.role === 'reviewer' || task.role === 'security') return 'implement';
  return 'implement';
}

/** Tailored hint added to the system prompt per task kind. */
export function kindHint(kind: TaskKind): string {
  switch (kind) {
    case 'fix':
      return '\n# Focus: debugging\nPrioritize reproducing the failure first (smallest possible repro), then localize the bug with the symbol tools before touching code. Add or extend a test that catches the regression.\n';
    case 'refactor':
      return '\n# Focus: refactor\nPreserve behavior. Run the project test suite before AND after the change. If tests are absent, mention this in the next message rather than skipping verification.\n';
    case 'test':
      return '\n# Focus: testing\nAim for one assertion per behavior. Cover the boundary and the failure path. Use the project\'s existing test runner (npm test / vitest / jest for JS, pytest for Python, go test ./..., cargo test for Rust, mvn test or ./gradlew test for Java, dotnet test for C#, rspec for Ruby) — do not invent a new one.\n';
    case 'research':
      return '\n# Focus: research\nRead-only. Do not modify code. Surface concrete findings (paths, line ranges, code excerpts) so the next coder can act on them without re-discovering.\n';
    case 'plan':
      return '\n# Focus: planning\nReturn a written plan only — no edits. Steps, files to touch, risks, and how to verify each step. Reference concrete paths.\n';
    case 'document':
      return '\n# Focus: documentation\nMatch the project\'s existing doc style. Cover the WHY before the HOW. Keep examples concrete and runnable.\n';
    case 'implement':
    default:
      return '\n# Focus: implementation\nMatch the project\'s patterns and idioms. Make the smallest change that works. Verify with a real test runner before declaring done.\n';
  }
}
