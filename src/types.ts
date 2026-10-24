import type { IterationTrace } from './agent/loop-state.js';

export type ModelProfile = 'fast' | 'coding' | 'reasoning' | 'review';

export interface ModelConfig {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** True when `model` was chosen EXPLICITLY by the user for this process
   *  (--model flag, MOCHI_MODEL env, or the model-manager's setModel) rather
   *  than inherited from config defaults. Cost-per-solve routing never
   *  overrides an explicit choice: it may still MEASURE the run, but the
   *  start model and every escalation target defer to the pin. */
  modelPinned?: boolean;
  profiles?: Record<ModelProfile, string>;
  /** Backup providers tried in order when the primary errors before producing
   *  any output. Each entry is a full ModelConfig (provider/baseUrl/apiKey/
   *  model); profiles fall back to the primary's when unset. Mid-stream
   *  failures are NOT retried on a fallback (partial output can't be replayed). */
  failover?: ModelConfig[];
  /** Speculative reasoning preflight (DeepSeek/Cline-style "think before
   *  acting"). When enabled, hard non-chat tasks run the SpeculativeEngine
   *  once before the main model call and inject its chosen approach + pitfall
   *  notes as a system hint that biases the main reasoning path. DEFAULT:
   *  enabled for structurally complex tasks at medium+ reasoning when unset;
   *  set `preflight: false` to disable outright, `true` to force it on for
   *  any non-chat task. MOCHI_SPECULATIVE_PREFLIGHT=0 also disables it. */
  speculative?: {
    /** Run the preflight on the first iteration of implementation/verify tasks.
     *  Unset = default policy (complex tasks, medium+ reasoning). */
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
  /** Desktop control (computer tool). Stricter than shell: NO default ever
   *  sets this — it requires explicit opt-in (config or MOCHI_COMPUTER=1 /
   *  MOCHI_PERMISSION_COMPUTER=1), and the approval layer never auto-allows
   *  it, so headless runs deny it by default. */
  computer?: boolean;
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
  /** Multi-agent fanout: max BACKGROUND child runs (spawn_agent with
   *  background=true / review fleets) executing at once per parent; excess
   *  spawns queue FIFO instead of failing. Default 4. */
  maxConcurrentSubagents?: number;
  /** Multi-agent fanout: deepest delegation tree. An agent at depth d may
   *  spawn children (at depth d+1) only while d < maxSubagentDepth, so the
   *  default 2 means: root -> child -> grandchild, and grandchildren cannot
   *  spawn further. Default 2. */
  maxSubagentDepth?: number;
  contextBudgetTokens: number;
  maxTokens?: number;
  maxCostUsd?: number;
  /** Offline price-table cost accounting (C5, src/pricing.ts): when a
   *  provider reports $0/no cost for a call, BudgetEngine estimates it from
   *  the built-in per-model table. `overrides` replaces/merges per-model
   *  rates (USD per 1M tokens; keys are model ids, partial rates merge over
   *  the built-in entry). `disabled: true` restores report-only accounting. */
  pricing?: {
    disabled?: boolean;
    overrides?: Record<string, { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }>;
  };
  maxToolCalls?: number;
  maxModelCalls?: number;
  /** OS-level sandbox for spawned commands: 'off' (direct exec),
   *  'auto' (best OS backend — bubblewrap, then unshare namespaces — else
   *  the labeled SOFT jail: env scrub + cwd clamp), 'bubblewrap' /
   *  'unshare' (force that backend, fail loudly if unavailable).
   *  When unset, the tier default applies: engaged ('auto') for
   *  safe/ask/auto, off for uncensored. Env: MOCHI_SANDBOX. */
  sandbox?: 'off' | 'auto' | 'bubblewrap' | 'unshare';
  /** Allow network inside the sandbox for shell commands. Default false:
   *  sandboxed shell commands are network-isolated unless the operator
   *  opts in here. Env: MOCHI_SANDBOX_NETWORK=1. */
  sandboxNetwork?: boolean;
  /** Extra writable paths inside the sandbox, beyond the workspace, the
   *  OS tmpdir, and dev-tool caches. */
  sandboxWritablePaths?: string[];
  /** Per-exec CPU-time ceiling in seconds for shell commands (RLIMIT_CPU
   *  via prlimit; Linux only, unset = no ceiling). A ceiling kill is clean
   *  (process-tree sweep) and LABELED in the tool output — never silent.
   *  See exec.ts. */
  execCpuLimitSeconds?: number;
  /** Per-exec address-space ceiling in MB for shell commands (RLIMIT_AS;
   *  same semantics as execCpuLimitSeconds, unset = none). */
  execMemoryLimitMb?: number;
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

/** Reasoning-discipline mechanisms (src/agent/discipline.ts): evidence-gated
 *  replanning, cross-turn progress forcing, drift snap-back, decisive finish,
 *  same-failure strategy switch, adaptive reasoning effort. Every mechanism
 *  defaults ON; set one to false here — or use the env kill-switches
 *  (MOCHI_DISCIPLINE=0 master, MOCHI_DISCIPLINE_<MECHANISM>=0 per mechanism) —
 *  to disable it. Only consulted when reasoning is not pinned by the user. */
/** Evidence-based skill lifecycle (src/skills/): model-authored skills are
 *  born on PROBATION and are promoted only on verifier-passed runs — the
 *  structural rubric is a lint gate, never a promotion. Set `probation:
 *  false` here — or env MOCHI_SKILLS_PROBATION=0 — to restore the legacy
 *  behavior (authored skills active at birth, no lifecycle transitions). */
export interface SkillsConfig {
  /** Master switch for probation enforcement. Default: on. */
  probation?: boolean;
}

/** Cost-per-solve routing (observability/routing-table.ts): runs start on
 *  the cheapest model with a MEASURED cost-per-solve for their task kind
 *  and escalate up the measured ladder only on failure evidence. Defaults
 *  ON; MOCHI_ROUTING=0 is the kill-switch. With no stored routing table
 *  (fresh install) every decision is a no-op — the configured default and
 *  the static tier ladder rule, exactly as before. */
export interface RoutingConfig {
  /** Master switch: false disables start routing and routing escalations. */
  enabled?: boolean;
  /** Minimum historical runs per (kind × model) cell before the cell may
   *  steer routing. Below it the cell is INSUFFICIENT-DATA. Default 5. */
  minSamples?: number;
}

/** Short-task fast lane (src/core/fastlane.ts): tasks the up-front evidence
 *  proves are short/simple run under a lean execution profile — small tool
 *  allowlist, no repo-map/prefetch/memory machinery up front, tight turn
 *  budget, targeted-only verification — and escalate to the standard profile
 *  mid-run the moment the run itself produces not-short evidence. The
 *  verifier's evidence standard is NOT relaxed in the lane. Default on;
 *  set `enabled: false` here — or env MOCHI_FASTLANE=0 — to disable. */
export interface FastLaneConfig {
  /** Master switch: false disables the fast lane for every task. */
  enabled?: boolean;
}

export interface DisciplineConfig {
  /** Master switch: false disables every discipline mechanism. */
  enabled?: boolean;
  replanGate?: boolean;
  progressForcing?: boolean;
  driftSnapback?: boolean;
  decisiveFinish?: boolean;
  sameFailureSwitch?: boolean;
  adaptiveEffort?: boolean;
}

/** Long-task strategy (src/agent/milestones.ts): complex/long tasks are
 *  decomposed into milestones with verifiable checks, per-milestone budget
 *  slices, verified checkpoints at milestone boundaries, and evidence-gated
 *  re-planning under budget pacing. Defaults ON for tasks the complexity
 *  scorer calls 'complex' (and for hosts that supply a plan); set
 *  `enabled: false` here — or env MOCHI_LONGTASK=0 — to disable the layer
 *  wholesale, MOCHI_LONGTASK_PACING=0 / `pacing: false` to keep milestones
 *  + checkpoints but disable the pacing responses (tighten/replan/escalate). */
export interface LongTaskConfig {
  /** Master switch: false disables the milestone strategy layer. */
  enabled?: boolean;
  /** Budget pacing responses (tighten → re-plan → escalate). Default on. */
  pacing?: boolean;
}

export interface MochiConfig {
  model: ModelConfig;
  safety: SafetyConfig;
  permissions: PermissionConfig;
  mcpServers?: Record<string, { command?: string; args?: string[]; url?: string; headers?: Record<string, string>; env?: Record<string, string> }>;
  /** Lazy MCP tool-schema loading (W3-3): advertise connected MCP tools as
   *  thin defs (name + description, no input schema) and inject the full
   *  schema on demand — via load_tools or when the task text names the tool.
   *  Every connected server's schemas otherwise ride EVERY prompt. Default
   *  OFF; env MOCHI_MCP_LAZY_SCHEMAS=1 overrides. See mcp/tools.ts. */
  mcpLazySchemas?: boolean;
  /** Plan-then-act: in plan mode the agent produces a plan instead of editing. */
  planMode?: boolean;
  /** Tool exposure policy (P1.3): 'measured' (default) advertises a
   *  schema-budgeted, usage-ranked subset of the built tools per run;
   *  'full' restores legacy behavior (every built tool advertised).
   *  Env MOCHI_TOOLS=full overrides. See tools/tool-exposure.ts. */
  toolExposure?: 'measured' | 'full';
  /** Total serialized schema-char budget for measured tool exposure.
   *  Env MOCHI_TOOL_SCHEMA_BUDGET overrides. Default 24,000 (≈ 6K tokens). */
  toolSchemaBudgetChars?: number;
  /** Self-repair: when the agent detects a harness-attributable failure, run an
   *  automatic repair pass after the main task. Defaults to on inside Mochi's
   *  own source repo, off elsewhere ( repairs must not surprise users). */
  selfRepair?: boolean;
  /** Active execution mode: normal | spec | security | codemod | chaos. */
  mode?: string;
  /** Active reasoning effort / compute level: low | medium | high | max. */
  reasoning?: ReasoningLevel;
  /** Durable-memory prompt injection budget, in chars, for the volatile
   *  unified-memory block (ContextEngine.loadMemory). Default 4000. Unified
   *  retrieval ranks across all four memory stores, so the budget buys
   *  ranked hits rather than a first-come slice of one store. */
  memory?: { injectionChars?: number };
  /** Reasoning-discipline mechanisms (see DisciplineConfig). All default on. */
  discipline?: DisciplineConfig;
  /** Short-task fast lane (see FastLaneConfig). Default on. */
  fastlane?: FastLaneConfig;
  /** Long-task milestone strategy (see LongTaskConfig). */
  longtask?: LongTaskConfig;
  /** Evidence-based skill lifecycle (see SkillsConfig). Probation default on. */
  skills?: SkillsConfig;
  /** Cost-per-solve routing (see RoutingConfig). Default on, data-gated. */
  routing?: RoutingConfig;
  /** Semantic code retrieval (Wave J, src/repo/semantic-index.ts). Provider
   *  embeddings are OPT-IN (W3-1 gate): set embeddingProvider/embeddingModel
   *  here (or env MOCHI_EMBEDDING_PROVIDER / MOCHI_EMBEDDING_MODEL) to embed
   *  chunks with that provider model. With no explicit embedding config the
   *  index uses a deterministic local LEXICAL-fallback embedder — never true
   *  semantics, and labelled as such everywhere; the configured CHAT
   *  provider is deliberately not reused implicitly. semanticIndex:false
   *  disables the index entirely. */
  retrieval?: { embeddingProvider?: string; embeddingModel?: string; semanticIndex?: boolean };
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

export type AgentRole = 'lead' | 'coder' | 'reviewer' | 'tester' | 'researcher' | 'debugger' | 'security' | 'redteam' | 'architect' | 'devops' | 'db_admin' | 'frontend' | 'backend' | 'performance' | 'tech_writer' | 'qa_engineer' | 'data_scientist' | 'designer' | 'integrator' | 'scout' | 'pr_reviewer' | 'explorer';

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
  permission?: 'read' | 'write' | 'shell' | 'network' | 'gitDestructive' | 'admin' | 'computer';
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
  /** B21: a mid-run steer was DELIVERED into a running subagent's context
   *  (emitted by the child at the turn boundary where it drained the
   *  steer). Carries provenance only — who steered, when, and the steer's
   *  sha256/length; the raw steer text never rides the bus into traces.
   *  The trajectory exporter lifts these into the record's steerEvents so
   *  a steered run's outcome is never credited as unsteered evidence. */
  | { type: 'subagent:steered'; agentId: string; parentId: string; from: string; at: number; hash: string; chars: number }
  | { type: 'agent:log'; agentId: string; message: string }
  /** Run-finish skill attribution: which skills the run loaded, joined with
   *  the run's final verifier-gate verdict. The trajectory exporter lifts
   *  this into the record's `skills[]`/`verification` so offline tooling can
   *  compute per-skill fix-rates. Emitted once per run by finishOnce. */
  | { type: 'skills:attributed'; agentId: string; skills: Array<{ id: string; verdict: 'pass' | 'fail' | 'partial' | 'blocked' | 'none' }>; verifyStatus?: string; taskKind?: string; steered?: boolean }
  | { type: 'agent:reasoning'; content: string; agentId: string }
  | { type: 'agent:iteration'; agentId: string; trace: IterationTrace }
  | { type: 'tool:called'; tool: string; args: unknown; agentId: string; tool_call_id?: string }
  | { type: 'tool:completed'; tool: string; result: ToolResult; agentId: string }
  | { type: 'tool:failed'; tool: string; error: string; agentId: string }
  | { type: 'file:changed'; path: string; operation: 'write' | 'edit' | 'delete'; agentId: string }
  /** Edit-application telemetry (edit tool): one event per edit call outcome,
   *  so edit reliability (strategy mix, failure kinds, integrity reverts) is
   *  measurable per run. Lifted into trajectory records as `editStats`. */
  | { type: 'edit:applied'; path: string; strategy: 'exact' | 'normalized' | 'relaxed' | 'anchored'; attempts: number; integrity: 'passed' | 'pre-existing-errors'; agentId: string }
  | { type: 'edit:reverted'; path: string; strategy: 'exact' | 'normalized' | 'relaxed' | 'anchored'; errors: string; agentId: string }
  | { type: 'edit:failed'; path: string; failureKind: 'not-found' | 'ambiguous' | 'no-change'; attempts: number; nearMisses: number; agentId: string }
  | { type: 'message:chunk'; content: string; agentId: string }
  | { type: 'usage:updated'; agentId: string; inputTokens: number; outputTokens: number; cacheTokens: number; totalTokens: number; costUsd?: number; model?: string; cacheMeasured?: boolean }
  /** Cost-per-solve routing: the run's start-model decision, emitted once
   *  per run when a routing table exists or the model is user-pinned.
   *  source 'routed' = the measured table chose `model`; 'already-optimal'
   *  = the table's cheapest proven model IS the configured default;
   *  'insufficient-data' = no proven cell, default kept; 'pinned' = the
   *  user chose the model explicitly and routing deferred. */
  | { type: 'routing:decision'; agentId: string; taskKind: string; model: string; source: 'routed' | 'already-optimal' | 'insufficient-data' | 'pinned'; fromModel?: string; costPerSolveUsd?: number; solveRate?: number; samples?: number }
  /** Cost-per-solve routing: a mid-run escalation up the MEASURED ladder.
   *  `trigger` is the evidence class that bought it — verifier failures, a
   *  repeated same-failure, or a mid-run complexity promotion. Never fired
   *  on a schedule or a hunch. The stats pass counts these per cell. */
  | { type: 'routing:escalated'; agentId: string; taskKind: string; fromModel: string; toModel: string; trigger: 'verify_failures' | 'same_failure' | 'complexity_escalation'; costPerSolveUsd?: number; solveRate?: number }
  /** Cost-per-solve routing: an escalation the evidence justified but the
   *  budget engine forbade. The run continues on its current model; the
   *  event is the note that says so, so the trajectory never implies the
   *  stronger model was tried. */
  | { type: 'routing:escalation-blocked'; agentId: string; taskKind: string; fromModel: string; toModel: string; trigger: 'verify_failures' | 'same_failure' | 'complexity_escalation'; reason: string }
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
