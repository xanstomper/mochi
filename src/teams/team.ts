// Team orchestration: decompose a goal into role-diverse tasks and run them
// through the scheduler with specialist agents (coder/reviewer/tester/etc.),
// then converge on a final verified description. This gives `mochi team` a
// real multi-agent shape instead of falling through to a single-coder goal.
import type { Goal, Task, AgentRole } from '../types.js';
import { GoalEngine } from '../goals/goal.js';

// Keyword -> specialist role for implementation tasks. The model often labels
// a task by what it touches, which is a decent proxy for which specialist
// should own it.
const ROLE_HINTS: [RegExp, AgentRole][] = [
  // verify/audit before test/regress so "verify no regressions" lands on
  // reviewer, not tester (the broader test words would swallow it).
  [/review|verify|audit|check|inspect|regress/i, 'reviewer'],
  [/refactor|clean|rename|extract|dedupe/i, 'reviewer'],
  [/test|spec|cover|assert/i, 'tester'],
  [/research|investigate|explore|compare|prototype/i, 'researcher'],
  [/debug|crash|fix|error|broken|exception|stack trace/i, 'debugger'],
  [/secur|threat|vuln|payload|auth|cve/i, 'security'],
  [/architect|layout|interface|schema|api design|system design/i, 'architect'],
  [/docker|k8s|kubernetes|container|ci|cd|pipeline|deploy|terraform|github action|sre/i, 'devops'],
  [/database|postgres|mysql|sqlite|migration|query plan|index|prisma|drizzle|sql/i, 'db_admin'],
  [/e2e|playwright|cypress|selenium|visual regression|smoke test/i, 'qa_engineer'],
  [/perf|profile|latency|throughput|memory leak|bottleneck|hotspot|bench/i, 'performance'],
  [/readme|docs|markdown|guide|manual|adr|specification|documentation/i, 'tech_writer'],
  [/dataset|pandas|polars|machine learning|pytorch|tensorflow|analytics|data science/i, 'data_scientist'],
  [/frontend|ui|ux|css|tailwind|react|vue|svelte|component|html|style/i, 'frontend'],
  [/backend|endpoint|rest api|restful|graphql|grpc|server|route|handler/i, 'backend'],
];

export type TeamPlan = {
  goal: Goal;
  tasks: Task[];
  rolesUsed: AgentRole[];
};

/** Assign a specialist role to each task, rotating through fallbacks when no
 *  hint matches, and guarantee at least one reviewer-shaped task at the end. */
export function assignTeamRoles(goal: Goal, tasks: Task[]): Task[] {
  const fallback: AgentRole[] = ['coder', 'tester', 'reviewer', 'researcher'];
  let fi = 0;
  const assigned = tasks.map((t, i) => {
    const text = `${t.title} ${t.description} ${(t.acceptanceCriteria ?? []).join(' ')}`;
    const hit = ROLE_HINTS.find(([re]) => re.test(text));
    const role: AgentRole = hit ? hit[1] : fallback[fi % fallback.length];
    fi++;
    return { ...t, role, id: t.id };
  });
  // Replace the final task's role with reviewer unless it's already one.
  if (assigned.length > 1) {
    const last = assigned[assigned.length - 1];
    if (last.role !== 'reviewer' && last.role !== 'tester') {
      assigned[assigned.length - 1] = { ...last, role: 'reviewer' };
    }
  }
  return assigned;
}

/**
 * Orchestrate a full team run: decompose the goal, assign specialist roles,
 * then execute tasks through GoalEngine's scheduler (max concurrency as
 * configured) so specialists act in parallel. Returns the run summary.
 */
export async function runTeam(
  goalEngine: GoalEngine,
  goal: Goal,
  opts: { signal?: AbortSignal; extras?: string[] } = {},
): Promise<{ summary: string; status: string }> {
  const raw = await goalEngine.decompose(goal);
  const tasks = assignTeamRoles(goal, raw);
  goal.tasks = tasks.map((t) => t.id);
  // runGoal persists tasks via the scheduler and returns the summary.
  const result = await goalEngine.runGoal(goal, tasks, opts.extras ?? [], opts.signal);
  return { summary: result.summary, status: goal.status };
}