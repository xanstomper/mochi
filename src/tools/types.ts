import type { MochiConfig, ToolDefinition } from '../types.js';
import type { EventBus } from '../events.js';
import type { Workspace } from '../workspace.js';

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
}

export interface Tool {
  def: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export type { ToolDefinition };
