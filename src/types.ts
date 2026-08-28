import type { IterationTrace } from './agent/loop-state.js';

export type ModelProfile = 'fast' | 'coding' | 'reasoning' | 'review';

export interface ModelConfig {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  profiles?: Record<ModelProfile, string>;
  /** Backup providers tried in order when the primary errors before producing
   *  any output. Each entry is a full ModelConfig (provider/baseUrl/apiKey/
   *  model); profiles fall back to the primary's when unset. Mid-stream
   *  failures are NOT retried on a fallback (partial output can't be replayed). */
  failover?: ModelConfig[];
  /** Speculative reasoning preflight (DeepSeek/Cline-style "think before
   *  acting"). When enabled, hard non-chat tasks run the SpeculativeEngine
   *  once before the main model call and inject its chosen approach + pitfall
   *  notes as a system hint that biases the main reasoning path. Opt-in so the
   *  default loop stays lean for simple turns. */
  speculative?: {
    /** Run the preflight on the first iteration of implementation/verify tasks. */
    preflight?: boolean;
    /** On the first verification failure of a hard task, inject a structured
     *  self-critique + repair directive alongside the existing autopsy/lessons
     *  flow so the next attempt is a deliberate repair, not a blind retry. */
    selfCritique?: boolean;
  };
}

export interface PermissionConfig {
  read: boolean;
  write: boolean;
  shell: boolean;
  network: boolean;
  gitDestructive: boolean;
}

export interface SafetyConfig {
  mode: 'safe' | 'ask' | 'auto';
  allowedCommands?: string[];
  deniedCommands?: string[];
  commandTimeoutSeconds: number;
  maxIterations: number;
  maxRuntimeMinutes: number;
  maxConcurrentAgents: number;
  contextBudgetTokens: number;
  maxTokens?: number;
  maxCostUsd?: number;
  maxToolCalls?: number;
  maxModelCalls?: number;
}

export type ReasoningLevel = 'low' | 'medium' | 'high' | 'max' | 'off' | 'auto';

export interface MochiConfig {
  model: ModelConfig;
  safety: SafetyConfig;
  permissions: PermissionConfig;
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /** Plan-then-act: in plan mode the agent produces a plan instead of editing. */
  planMode?: boolean;
  /** Active execution mode: normal | spec | security | codemod | chaos. */
  mode?: string;
  /** Active reasoning effort / compute level: low | medium | high | max. */
  reasoning?: ReasoningLevel;
  telemetry: boolean;
  projectDir: string;
  configDir: string;
  quiet: boolean;
  verbose: boolean;
  debug: boolean;
}

export type TaskStatus = 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'cancelled' | 'blocked';

export interface Attempt {
  id: string;
  strategy: string;
  actions: string[];
  result: 'success' | 'failure' | 'partial';
  failureReason?: string;
  timestamp: number;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  role: AgentRole;
  status: TaskStatus;
  priority: number;
  dependencies: string[];
  fileScope?: string[];
  acceptanceCriteria: string[];
  verificationCommand?: string;
  attempts: Attempt[];
  output?: string;
  assignedTo?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

/** One durable item in the persistent, resumable todo list the model maintains
 *  mid-run. Kept terse so it is cheap to echo; deduped by title, ordered by
 *  `order`. Shared across parallel agents for one goal run. */
export interface TodoItem {
  title: string;
  status: 'pending' | 'in_progress' | 'done';
  order: number;
  notes?: string;
}

export interface Goal {
  id: string;
  workspace: string;
  objective: string;
  constraints: string[];
  successCriteria: string[];
  status: 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';
  tasks: string[];
  blockers: string[];
  progress: number;
  createdAt: number;
  updatedAt: number;
}

export type AgentRole = 'lead' | 'coder' | 'reviewer' | 'tester' | 'researcher' | 'debugger' | 'security' | 'architect' | 'devops' | 'db_admin' | 'frontend' | 'backend' | 'performance' | 'tech_writer' | 'qa_engineer' | 'data_scientist';

export interface AgentProfile {
  role: AgentRole;
  name: string;
  description?: string;
  systemPrompt: string;
  defaultModel?: ModelProfile;
  tools?: string[];
  verification?: 'none' | 'optional' | 'required';
  maxIterations?: number;
}

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description: string;
  required?: boolean;
  items?: { type: string };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  dangerous?: boolean;
  permission?: 'read' | 'write' | 'shell' | 'network' | 'gitDestructive';
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  output: string;
  error?: string;
  durationMs: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface StreamToolCall {
  id: string;
  index?: number;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface StreamChunk {
  content?: string;
  reasoningContent?: string;
  toolCalls?: StreamToolCall[];
  finishReason?: 'stop' | 'tool_calls' | 'length' | 'error';
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface ModelResponse {
  content?: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export interface AgentState {
  goal?: string;
  currentTask?: string;
  completedTasks: string[];
  importantDecisions: string[];
  filesModified: string[];
  knownErrors: string[];
  constraints: string[];
  nextAction?: string;
}

export interface RepoInfo {
  language?: string;
  framework?: string;
  packageManager?: string;
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  entrypoints?: string[];
  importantDirs?: string[];
}

export type MochiEvent =
  | { type: 'goal:created'; goal: Goal }
  | { type: 'task:created'; task: Task }
  | { type: 'task:ready'; task: Task }
  | { type: 'task:started'; task: Task; agentId: string }
  | { type: 'task:completed'; task: Task; agentId: string; stopReason?: string }
  | { type: 'task:failed'; task: Task; agentId: string; reason: string; stopReason?: string }
  | { type: 'agent:spawned'; id: string; role: AgentRole; taskId: string }
  | { type: 'agent:completed'; id: string; taskId: string }
  | { type: 'subagent:started'; agentId: string; parentId: string; role: AgentRole; prompt: string }
  | { type: 'subagent:completed'; agentId: string; parentId: string; role: AgentRole; success: boolean; summary: string; tokensUsed: number }
  | { type: 'agent:log'; agentId: string; message: string }
  | { type: 'agent:reasoning'; content: string; agentId: string }
  | { type: 'agent:iteration'; agentId: string; trace: IterationTrace }
  | { type: 'tool:called'; tool: string; args: unknown; agentId: string; tool_call_id?: string }
  | { type: 'tool:completed'; tool: string; result: ToolResult; agentId: string }
  | { type: 'tool:failed'; tool: string; error: string; agentId: string }
  | { type: 'file:changed'; path: string; operation: 'write' | 'edit' | 'delete'; agentId: string }
  | { type: 'message:chunk'; content: string; agentId: string }
  | { type: 'usage:updated'; agentId: string; inputTokens: number; outputTokens: number; cacheTokens: number; totalTokens: number; costUsd?: number }
  | { type: 'error'; error: string; agentId?: string }
  | { type: 'pulse'; state: AgentState }
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: string; agentId?: string };
