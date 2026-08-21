// Unified Capability Interface for Mochi VNext
// Merges Native Tools, MCP Servers, ACP Agents, Subagents, and Skills
// under a single typed execution and permission boundary.

import type { ToolDefinition } from '../types.js';
import type { EventBus } from '../events.js';
import type { Workspace } from '../workspace.js';
import type { MochiConfig } from '../types.js';
import type { AgentResult } from '../agent/loop.js';

export type CapabilityKind = 'native' | 'mcp' | 'acp' | 'subagent' | 'skill';

export type CapabilityPermissionLevel = 'ALLOW' | 'DENY' | 'ASK' | 'SANDBOX';

export interface ReadCache {
  get(path: string): string | undefined;
  set(path: string, content: string): void;
  invalidate(path?: string): void;
}

export interface CapabilityContext {
  readonly cwd: string;
  readonly workspace: Workspace;
  readonly config: MochiConfig;
  readonly events: EventBus;
  readonly agentId: string;
  readonly abortSignal?: AbortSignal;
  readonly readCache?: ReadCache;
  readonly permissionPolicy?: 'strict' | 'yolo' | 'workspace-safe';
  spawnSubagent?(prompt: string, opts?: { role?: string }): Promise<AgentResult>;
  log(message: string): void;
}

export interface CapabilityExecutionRequest {
  readonly callId: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly context: CapabilityContext;
}

export interface CapabilityExecutionResponse {
  readonly callId: string;
  readonly name: string;
  readonly output: string;
  readonly error?: string;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly rawTokensEstimate: number;
  readonly metadata?: Record<string, unknown>;
}

export interface Capability {
  readonly id: string;
  readonly name: string;
  readonly kind: CapabilityKind;
  readonly description: string;
  readonly schema: ToolDefinition;
  readonly isReadOnly: boolean;
  readonly domain?: string; // e.g. "fs", "git", "db", "web", "subagent"
  
  execute(req: CapabilityExecutionRequest): Promise<CapabilityExecutionResponse>;
  estimatedTokenCost?(args: Record<string, unknown>): number;
  cancel?(callId: string): Promise<void>;
}
