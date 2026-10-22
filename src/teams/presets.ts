// Spawn presets for multi-agent fanout (spawn_agent / review_fleet).
//
// A preset is the unit a parent agent actually delegates with: it pins a
// role profile, an ACCESS level, and a HARD tool allowlist. The allowlist is
// enforced at the tool layer (executeTool rejects anything outside it — see
// ToolContext.toolAllowlist), not merely by omitting tools from the prompt:
// a read-only preset child cannot write even if its model hallucinates a
// `write` call, and `load_tools` cannot widen the set mid-run.
//
// Access levels:
//  - 'read-only': the child shares the parent's cwd and may only observe.
//    No write/edit/delete/shell/git-mutation tools, period.
//  - 'worktree':  the child gets its own git worktree + branch; it may
//    mutate freely INSIDE that worktree. Its changes reach the parent's
//    tree only when the parent explicitly applies them (collect_agent
//    with apply=true) — never silently.
import type { AgentRole } from '../types.js';

export type SpawnAccess = 'read-only' | 'worktree';

export interface SpawnPreset {
  /** Canonical preset name as the model writes it ('pr-reviewer'). */
  name: string;
  /** Role profile the child agent runs with. */
  role: AgentRole;
  access: SpawnAccess;
  /** Hard tool allowlist — the child's complete executable toolset. */
  tools: string[];
  /** Extra system guidance appended to the child's context at spawn. */
  systemAddendum: string;
  /** Short human description for tool schemas / logs. */
  description: string;
}

/** Tools that can mutate the workspace or the outside world. A read-only
 *  preset must never contain any of these; the preset test enforces it. */
export const MUTATING_TOOL_NAMES = new Set([
  'write', 'edit', 'delete', 'patch', 'create_directory', 'move_file',
  'copy_file', 'replace_symbol', 'rename_symbol', 'regex_replace',
  'search_replace_multi', 'notebook', 'shell', 'repl', 'bg_task', 'git',
  'create_pr', 'skill_manage', 'tool_factory', 'mcp_manage', 'memory',
  'clipboard', 'session_collab',
]);

const READ_ONLY_BASE = [
  'read', 'search', 'glob', 'outline', 'ast_slice', 'inspect', 'tree', 'diff',
  'think', 'codebase_map', 'get_function', 'find_callers', 'find_definitions',
  'find_references', 'type_hierarchy', 'get_diagnostics', 'blast_radius',
];

export const SPAWN_PRESETS: Record<string, SpawnPreset> = {
  researcher: {
    name: 'researcher',
    role: 'researcher',
    access: 'read-only',
    tools: [
      ...READ_ONLY_BASE,
      'fetch', 'web_search', 'web_crawl', 'browser', 'deepwiki', 'explain',
      'git_blame', 'git_history', 'analyze_code', 'code_similarity',
      'security_audit',
    ],
    systemAddendum:
      'You are a RESEARCH subagent: investigate the assigned question and report evidence. You are read-only — do not attempt to modify files or run commands. Prefer primary sources (the code itself, official docs via fetch/web_search) and cite file paths / URLs for every claim.',
    description: 'Read-only investigation: codebase + web research, evidence report.',
  },
  'pr-reviewer': {
    name: 'pr-reviewer',
    role: 'pr_reviewer',
    access: 'read-only',
    tools: [
      ...READ_ONLY_BASE,
      'git_blame', 'git_history', 'analyze_code', 'code_similarity',
      'security_audit',
    ],
    systemAddendum:
      'You are a PR-REVIEW subagent: review ONLY the change described/diffed in your task. You are read-only. Your structured result MUST include a verdict ("approve", "request-changes", or "comment") and one finding per issue with severity, file, and line.',
    description: 'Read-only diff review with a structured verdict.',
  },
  explorer: {
    name: 'explorer',
    role: 'explorer',
    access: 'read-only',
    tools: [...READ_ONLY_BASE, 'explain'],
    systemAddendum:
      'You are an EXPLORER subagent: answer the assigned question about this codebase with exact file paths, symbol names, and line ranges. Read-only — do not modify anything.',
    description: 'Read-only codebase navigation: where is X, how does Y flow.',
  },
  tester: {
    name: 'tester',
    role: 'tester',
    access: 'worktree',
    tools: [
      ...READ_ONLY_BASE,
      'write', 'edit', 'patch', 'shell', 'verify', 'lint', 'format',
      'git_blame', 'git_history', 'analyze_code', 'code_similarity',
    ],
    systemAddendum:
      'You are a TESTER subagent working in your OWN git worktree: write and run tests there. Run the suite before reporting; report exact pass/fail counts and failing test names in your structured result.',
    description: 'Writes + runs tests inside its own worktree.',
  },
  coder: {
    name: 'coder',
    role: 'coder',
    access: 'worktree',
    tools: [
      ...READ_ONLY_BASE,
      'write', 'edit', 'patch', 'delete', 'replace_symbol', 'shell', 'verify',
      'lint', 'format', 'create_directory', 'move_file', 'copy_file',
      'git_blame', 'git_history', 'analyze_code', 'code_similarity',
      'fetch', 'web_search',
    ],
    systemAddendum:
      'You are a CODER subagent working in your OWN git worktree: implement the assigned subtask completely there. The parent will review your diff before applying it — keep the change focused and report exactly what you changed.',
    description: 'Full implementation inside its own worktree.',
  },
};

/** Resolve a preset by name ('pr-reviewer' and 'pr_reviewer' both work).
 *  A bare role name with no preset (e.g. 'debugger') resolves to a worktree
 *  preset built from that role's profile tools — the historical spawn
 *  behavior — so `preset` is strictly an upgrade, never a requirement. */
export function resolvePreset(name: string | undefined): SpawnPreset | undefined {
  if (!name) return undefined;
  const key = name.trim().toLowerCase();
  return SPAWN_PRESETS[key] ?? SPAWN_PRESETS[key.replace(/_/g, '-')];
}

export function listPresetNames(): string[] {
  return Object.keys(SPAWN_PRESETS);
}
