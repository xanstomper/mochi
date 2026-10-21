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
  admin?: boolean;
  [key: string]: boolean | undefined;
}

export interface SafetyConfig {
  mode: 'safe' | 'ask' | 'auto' | 'uncensored';
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
  /** OS-level sandbox for spawned commands: 'off' (default, direct exec),
   *  'auto' (bubblewrap when available, else direct), 'bubblewrap' (fail
   *  loudly if bwrap is missing). Env: MOCHI_SANDBOX. */
  sandbox?: 'off' | 'auto' | 'bubblewrap';
  maxVerifyRetries?: number;
  /** B27 restructure: hostnames whose POST/PUT/PATCH/DELETE endpoints are
   *  OPERATOR-DECLARED read-only (GraphQL query endpoints, search APIs that
   *  take POST bodies, internal review tools). Plan mode exempts fetch calls
   *  to these hosts from its mutating-tool veto so research can use POST-based
   *  read APIs. Exact hostname match, case-insensitive; empty/absent = the
   *  default (mutating fetch is vetoed in plan mode). Declaring a host here
   *  is an authority act by the operator — same trust level as
   *  permissions.network — NOT a claim the code verifies. */
  planModeNetworkReads?: string[];
}

export type ReasoningLevel = 'low' | 'medium' | 'high' | 'max' | 'off' | 'auto';

export interface MochiConfig {
  model: ModelConfig;
  safety: SafetyConfig;
  permissions: PermissionConfig;
  mcpServers?: Record<string, { command?: string; args?: string[]; url?: string; headers?: Record<string, string>; env?: Record<string, string> }>;
  /** Plan-then-act: in plan mode the agent produces a plan instead of editing. */
  planMode?: boolean;
  /** Self-repair: when the agent detects a harness-attributable failure, run an
   *  automatic repair pass after the main task. Defaults to on inside Mochi's
   *  own source repo, off elsewhere ( repairs must not surprise users). */
  selfRepair?: boolean;
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
  /** MCH-109: image attachments (paths or data URIs) bundled with the prompt. */
  images?: string[];
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

export type AgentRole = 'lead' | 'coder' | 'reviewer' | 'tester' | 'researcher' | 'debugger' | 'security' | 'redteam' | 'architect' | 'devops' | 'db_admin' | 'frontend' | 'backend' | 'performance' | 'tech_writer' | 'qa_engineer' | 'data_scientist' | 'designer' | 'integrator' | 'scout';

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
  permission?: 'read' | 'write' | 'shell' | 'network' | 'gitDestructive' | 'admin';
}

export interface ToolCall {
  id: string;
  tool_call_id?: string;
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

/** Content part for multimodal messages (MCH-109). Text parts carry prose;
 *  image parts carry a URL or data: URI the provider can render. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

/** Text content of a message, flattening multimodal parts (images drop). */
export function contentText(m: { content?: string | ContentPart[] }): string {
  if (!m.content) return '';
  return typeof m.content === 'string' ? m.content
    : m.content.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('\n');
}

export interface SplitContent {
  /** All text parts joined (images excluded). */
  text: string;
  /** Image parts in order: inline base64 data or remote URLs. */
  images: Array<{ mime: string; data: string } | { url: string }>;
}

/** Split message content into text + images for providers with native vision
 *  parts (Anthropic image blocks, Gemini inlineData). Data URIs become inline
 *  base64 payloads; remote http(s) URLs stay URLs for providers that accept
 *  them (OpenAI/Anthropic) — callers decide the fallback. Pure. */
export function splitContent(content?: string | ContentPart[]): SplitContent {
  if (!content) return { text: '', images: [] };
  if (typeof content === 'string') return { text: content, images: [] };
  const texts: string[] = [];
  const images: SplitContent['images'] = [];
  for (const p of content) {
    if (p.type === 'text') {
      texts.push(p.text);
    } else if (p.type === 'image_url') {
      const url = p.image_url.url;
      const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
      if (m && m[3]) {
        images.push({ mime: m[1] || 'image/jpeg', data: m[3] });
      } else if (/^https?:\/\//i.test(url)) {
        images.push({ url });
      }
    }
  }
  return { text: texts.join('\n'), images };
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
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number; costUsd?: number };
}

export interface ModelResponse {
  content?: string;
  reasoningContent?: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number; costUsd?: number };
  /** Set by the stream gatherer when the response tripped the degenerate-
   *  repetition guard (stream-degen rolling window). Consumers bound the
   *  transcript and fail over. Absent = clean response. */
  looped?: boolean;
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
  | { type: 'message'; role: 'user' | 'assistant' | 'system'; content: string; agentId?: string }
  // ── Phase-1 structured events (master rebuild) ──────────────────────────
  // Command lifecycle: every shell invocation is observable end-to-end.
  | ({ type: 'command:requested'; command: string; cwd?: string; executionId: string } & EventMeta)
  | ({ type: 'command:started'; command: string; executionId: string; pid?: number } & EventMeta)
  | ({ type: 'command:output'; command: string; executionId: string; stream: 'stdout' | 'stderr'; chunk: string } & EventMeta)
  | ({ type: 'command:completed'; command: string; executionId: string; exitCode: number; durationMs: number; truncated: boolean; stdoutTail?: string; stderrTail?: string } & EventMeta)
  | ({ type: 'command:failed'; command: string; executionId: string; error: string; durationMs: number } & EventMeta)
  // Plan lifecycle: structured plan state the renderer can display.
  | ({ type: 'plan:created'; planId: string; steps: PlanStep[]; agentId: string } & EventMeta)
  | ({ type: 'plan:updated'; planId: string; steps: PlanStep[]; agentId: string } & EventMeta)
  // Approval gate: mutating work waiting on the user.
  | ({ type: 'approval:required'; agentId: string; action: string; detail?: string; executionId?: string } & EventMeta)
  | ({ type: 'warning'; message: string; agentId?: string; source?: string } & EventMeta)
  // Cancellation lifecycle (Phase 5): first-class, observable, propagating.
  | ({ type: 'cancellation:requested'; agentId: string; reason?: string } & EventMeta)
  | ({ type: 'cancellation:completed'; agentId: string; canceledExecutions: number } & EventMeta)
  // Diffs + references as first-class citizens (Phases 12/13).
  | ({ type: 'diff:generated'; path: string; additions: number; deletions: number; agentId: string; truncated: boolean } & EventMeta)
  | ({ type: 'reference:created'; kind: 'file' | 'symbol' | 'url' | 'command'; value: string; agentId: string } & EventMeta)
  // Search lifecycle for observability of expensive queries.
  | ({ type: 'search:started'; query: string; tool: string; agentId: string } & EventMeta)
  | ({ type: 'search:completed'; query: string; tool: string; agentId: string; results: number; durationMs: number } & EventMeta)
  // Summary + context lifecycle (Phases 9/20/21).
  | ({ type: 'summary:started'; agentId: string; trigger: 'task-completion' | 'context-limit' | 'manual' } & EventMeta)
  | ({ type: 'summary:completed'; agentId: string; sections: string[]; durationMs: number } & EventMeta)
  | ({
      type: 'summary:rendered';
      agentId: string;
      success: boolean;
      stopReason: string;
      /** Coarse turn shape ('chat' = conversational answer, else task work).
       *  Lets renderers label a clean answer "Question Answered". */
      taskKind?: string;
      durationMs: number;
      toolCallsTotal: number;
      tokensUsed?: number;
      filesModified: string[];
      summary: string;
      doc?: unknown;
    } & EventMeta)
  | ({ type: 'context:compacted'; agentId: string; beforeTokens: number; afterTokens: number; preservedSections: string[] } & EventMeta)
  | ({ type: 'session:completed'; agentId: string; stopReason: string; durationMs: number } & EventMeta);

/**
 * Structured envelope fields shared by all Phase-1 events. `id` + `timestamp`
 * are stamped by the EventBus at emit time when absent, so emit sites stay
 * clean while every consumer can rely on identity + ordering.
 */
export interface EventMeta {
  /** Unique event id (monotonic counter + random suffix). */
  id?: string;
  /** Epoch ms. Stamped by the bus when absent. */
  timestamp?: number;
  severity?: 'debug' | 'info' | 'warning' | 'error' | 'critical';
  status?: 'queued' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'canceled' | 'skipped';
  /** Attempt number for retried executions (1-based). */
  attempt?: number;
}

/** One step inside a plan:created / plan:updated event. */
export interface PlanStep {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  detail?: string;
}
