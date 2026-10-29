import type { MochiConfig, ToolDefinition } from '../types.js';
import type { EventBus } from '../events.js';
import type { Workspace } from '../workspace.js';
import type { PromptUserFn } from './user-prompt.js';

export interface ReadCacheEntry {
  mtimeMs: number;
  size: number;
  content: string;
}
export type ReadCache = Map<string, ReadCacheEntry>;

export interface ToolContext {
  cwd: string;
  workspace: Workspace;
  config: MochiConfig;
  events: EventBus;
  agentId: string;
  abortSignal?: AbortSignal;
  /** Per-run file read cache so unchanged files are only read from disk once. */
  readCache?: ReadCache;
  /** Injected by the agent loop: spawn a child agent on a subtask and resolve
   *  to its summary. Returns a short result string (summary, success, tokens). */
  spawnSubagent?: (prompt: string, opts?: { role?: string; preset?: string; isolate?: boolean; timeoutMs?: number; scratchpad?: string }) => Promise<string>;
  /** Spawn multiple subagents concurrently and return their aggregated results. */
  spawnSubagents?: (tasks: Array<{ prompt: string; role?: string; preset?: string; timeoutMs?: number; scratchpad?: string }>) => Promise<string[]>;
  /** Multi-agent fanout: start a BACKGROUND child run and return its handle
   *  immediately — the parent keeps working and collects the result later
   *  (collectAgent). `preset` selects a scoped role preset (researcher /
   *  pr-reviewer / tester / explorer / coder); `isolate` forces a private
   *  git worktree for a mutating child. Injected under the same depth rule
   *  as spawnSubagent. */
  spawnAgentAsync?: (spec: {
    prompt: string;
    role?: string;
    preset?: string;
    scratchpad?: string;
    timeoutMs?: number;
    isolate?: boolean;
  }) => Promise<{ id: string; status: string; note: string }>;
  /** Collect a background child's structured result digest. With waitMs>0,
   *  waits up to that long for completion; apply=true squash-merges a
   *  finished worktree child's branch into the parent's tree. Falls back to
   *  the on-disk record when this process no longer holds the live run
   *  (parent restarted), so finished results survive restarts. */
  collectAgent?: (id: string, opts?: { waitMs?: number; apply?: boolean }) => Promise<string>;
  /** Cancel a running/queued background child (aborts it and discards its
   *  unapplied worktree, if any). */
  cancelAgent?: (id: string) => Promise<string>;
  /** B21: steer a running/queued background child mid-run — the message
   *  is injected into the child's context at its next turn boundary.
   *  Direction only: it cannot widen the child's role allowlist or
   *  permission posture. The steer is provenance-logged on the child's
   *  run record; undeliverable steers fail explicitly. */
  steerAgent?: (id: string, text: string) => Promise<string>;
  /** Fan out N pr-reviewer children over the same diff with different
   *  lenses and return one aggregated report (deduped findings, merged
   *  verdict). `target`: 'working' (default) or a git ref/range. */
  reviewFleet?: (spec: { target?: string; lenses?: string[]; instructions?: string }) => Promise<string>;
  /** HARD tool allowlist for role-scoped (preset) children, enforced by
   *  executeTool: any call outside this set is rejected even though the
   *  tool exists in the global registry (executeTool otherwise falls back
   *  to ALL_TOOLS_MAP, and load_tools can widen an agent's live map — the
   *  allowlist is the boundary neither can cross). Unset = unscoped. */
  toolAllowlist?: ReadonlySet<string>;
  /** Interactive user-prompt resolver (the TUI's option menu). Set on
   *  top-level runs only — subagents and headless hosts leave it unset and
   *  the ask_question tool resolves deterministic defaults instead. */
  promptUser?: PromptUserFn;
  /** Set to true when the caller already emitted tool:called on the event bus. */
  callerEmittedEvent?: boolean;
  /** Task kind of the owning run (set by the agent loop), recorded into the
   *  tool-usage ledger so exposure can be ranked per kind. Optional: other
   *  executeTool callers (TUI probes, harness helpers) leave it unset and
   *  their calls land in the ledger's global counts only. */
  taskKind?: string;
  /** MCH-lazy 14.1: free-text task hint (title+description or the user
   *  prompt) so lazy file slices can pick the region relevant to the task.
   *  Optional: callers that don't know the task leave it unset and lazy
   *  slicing falls back to the plain head window. */
  goalHint?: string;
}

export interface Tool {
  def: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export type { ToolDefinition };
