import type { MochiConfig, ToolDefinition } from '../types.js';
import type { EventBus } from '../events.js';
import type { Workspace } from '../workspace.js';

export interface ToolContext {
  cwd: string;
  workspace: Workspace;
  config: MochiConfig;
  events: EventBus;
  agentId: string;
  abortSignal?: AbortSignal;
}

export interface Tool {
  def: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export type { ToolDefinition };
