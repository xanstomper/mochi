// Unified Capability Interface for Mochi VNext
// Merges Native Tools, MCP Servers, ACP Agents, Subagents, and Skills
// under a single typed execution and permission boundary.

import type { ToolDefinition } from '../types.js';
import type { EventBus } from '../events.js';
import type { Workspace } from '../workspace.js';
import type { MochiConfig } from '../types.js';
import type { AgentResult } from '../agent/loop.js';
import type { ReadCache } from '../tools/types.js';

export type CapabilityKind = 'native' | 'mcp' | 'acp' | 'subagent' | 'skill';


// NOTE: the read cache is the tools-layer Map (mtime/size/content entries),
// shared by reference with the agent loop — a single definition in
// tools/types.ts. Do NOT reintroduce a second shape here; the last duplicate
// hid a real context incompatibility behind `as any`.

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
  /** Arg-aware read-only refinement (B27 restructure): the static flag is
   *  arg-blind, so a tool whose hazard depends on its arguments (fetch's
   *  method, verify's command) provides this predicate. When present it
   *  WINS over the static flag: true = this specific call is read-only
   *  (eligible for the concurrent read-only batch), false = mutating.
   *  It must fail closed — when in doubt, return false. */
  readonly isReadOnlyForArgs?: (args: Record<string, unknown>) => boolean;
  
  execute(req: CapabilityExecutionRequest): Promise<CapabilityExecutionResponse>;
  estimatedTokenCost?(args: Record<string, unknown>): number;
  cancel?(callId: string): Promise<void>;
}
