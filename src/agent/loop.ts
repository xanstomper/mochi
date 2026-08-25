import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { sortableId, truncateMiddle } from '../util.js';
import type { Attempt, ChatMessage, MochiConfig, ModelProfile, Task, ToolDefinition, ToolCall, ToolResult } from '../types.js';
import type { EventBus } from '../events.js';
import type { Workspace } from '../workspace.js';
import { ContextEngine } from '../context.js';
import { createProvider } from '../model/router.js';
import { isMode, modeInstruction } from '../modes.js';
import { kvCache } from '../kv-cache.js';
import { executeTool, buildTools, TOOL_ALIASES, normalizeToolArgs } from '../tools/index.js';
import type { ToolContext, ReadCache } from '../tools/types.js';
import { detectRepo, languageHint } from '../repo.js';
import { classifyTaskKind } from '../taskkind.js';
import { matchesBaseline, type VerificationBaseline } from '../verification.js';
import { diagnoseFile, renderDiagnostics } from '../diagnostics.js';
import type { AgentProfile } from '../types.js';
import { AgentProfileService } from '../agents/profile.js';
import { BudgetEngine, estimateCostUsd } from '../budget.js';
import { LearningStore } from '../learning.js';
import { classifyFailure as classifyErrorPattern } from '../learning.js';
import {
  classifyFailure,
  formInitialHypotheses,
  rankHypotheses,
  evaluateProbe,
  diagnosisToPrompt,
  type FailureKind,
  type Hypothesis,
  type DiagnosisResult,
} from '../diagnosis.js';
import {
  loadOrCreateAutopsy,
  appendAttempt,
  finalizeAutopsy,
  autopsyOneLine,
  type Autopsy,
} from '../autopsy.js';
import {
  retrieveLessons,
  recordLesson,
  lessonsToPrompt,
  type Lesson,
} from '../lessons.js';
import { HookManager } from '../hooks.js';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';
import { autoTestCommand, isWeakVerification, cwdForScope, withCwd } from '../testdetect.js';
import { classifyOneShot } from '../one-shot.js';
import { classifyContentOnly } from '../one-shot.js';
import { buildMcpTools } from '../mcp/tools.js';
import { preEditSnapshot as gitPreEditSnapshot, rollbackToSnapshot as gitRollback, type CheckpointResult } from '../git.js';
import { applyToolOutputPolicy } from '../core/tool-output.js';
import { nativeStripThinkTags } from '../native/core.js';
import { LoopStateMachine } from './loop-state.js';
import { scanDiffForHygiene, renderHygieneFindings, type HygieneFinding } from '../core/diff-hygiene.js';
import { parseCompilerDiagnostics, renderCompilerAdvisory } from './error-diagnostics.js';

export function stripThinkTags(text: string): string {
  if (!text) return '';
  const nat = nativeStripThinkTags(text);
  if (nat !== null) return nat;
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/^<think>[\s\S]*$/gi, '')
    .replace(/^<thought>[\s\S]*$/gi, '')
    .trim();
}

/** True if the leading binary of a shell command exists on PATH (or as a
 *  relative ./ wrapper). Used to skip optional repo checks (lint/typecheck/
 *  build) whose tool isn't installed, rather than failing a run for reasons
 *  that have nothing to do with the task's code. */
function commandAvailable(command: string, cwd: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // "npx X", "python3 -m Y", "./gradlew", "cd /x && cmd" — extract the actual
  // program name to probe for.
  const first = trimmed.split(/\s+/)[0] ?? '';
  let bin = first;
  if (bin === 'npx') bin = 'npm'; // npx comes with npm
  if (bin === 'cd') {
    const m = trimmed.match(/cd\s+(\S+)\s*&&\s*(\S+)/);
    bin = m?.[2] ?? '';
  }
  if (!bin) return false;
  if (bin.startsWith('./') || bin.startsWith('/')) {
    try {
      const path = resolve(cwd, bin);
      const st = statSync(path);
      return st.isFile();
    } catch {
      return false;
    }
  }
  const dirs = (process.env.PATH ?? '').split(':');
  return dirs.some((d) => {
    try {
      const st = statSync(resolve(d, bin));
      return st.isFile();
    } catch {
      return false;
    }
  });
}

/** Replace unfilled template hints in a verification command. Models writing
 *  `cd <project_root> && cargo test` persist the placeholder literally; the
 *  `<...>` is shell-redirect syntax that breaks sh -c. Strip the placeholder
 *  cd and replace remaining tokens with '.' since the shell already runs in
 *  the project root. */
export function sanitizeVerifyCommand(cmd: string): string {
  const c = cmd.trim();
  // "cd <project_root> && cargo test" -> "cargo test" (cwd is project root).
  // Linear scan (no nested quantifiers) so hostile verify strings stay O(n).
  const amp = c.indexOf('&&');
  const prefix = amp === -1 ? c : c.slice(0, amp).trim();
  const m = /^cd\s+<[^>]+>$/.exec(prefix);
  if (m && amp !== -1) return c.slice(amp + 2).trim();
  return c.replace(/<project_root>|<root>|__PROJECT_ROOT__/g, '.');
}

/**
 * Decide whether a model reply is an actual plan versus a preamble like
 * "I'll research the codebase first...". Plan mode's deliverable is the plan
 * text itself, so a non-tool reply must LOOK like a plan (numbered steps,
 * bullets, or explicitly structured plan language) before the loop accepts it
 * as done. Without this, a model that answers with delay-preamble text would
 * "succeed" without ever producing a plan.
 *
 * Signals, strongest first:
 *   - an explicit numbered list (1. / 1) / (1))
 *   - two or more bullet items
 *   - generous prose with plan vocabulary (steps, files, verify...) plus
 *     structure headers, so a one-liner keeps the model on task.
 */
export function isPlanShaped(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Numbered list: "1." / "1)" / "1." at a line start (optionally after a header).
  if (/(?:^|\n)\s*\d+[.)]/.test(t)) return true;
  // Two or more bullet / checked items.
  const bullets = (t.match(/(?:^|\n)\s*(?:[-*•]|\d{1,2}\.)\s+/g) ?? []).length;
  if (bullets >= 2) return true;
  // No explicit list: require substantial content, plan vocabulary, AND a
  // structure header so a one-liner preamble stays a nudge, not a success.
  return (
    t.length >= 120 &&
    /(^|\n)\s*(steps|plan|approach|files? to change|risks?|verification|how to verify|outline|summary|tasks?|deliverables)\s*[:.]/i.test(t)
  );
}

export interface AgentOptions {
  id?: string;
  role: string;
  modelProfile?: ModelProfile;
  profile?: AgentProfile;
  config: MochiConfig;
  workspace: Workspace;
  events: EventBus;
  cwd: string;
  context: ContextEngine;
  budget?: BudgetEngine;
  abortSignal?: AbortSignal;
  readCache?: ReadCache;
  /** Extra tools registered externally (e.g. MCP server tools). */
  extraTools?: Map<string, import('../tools/types.js').Tool>;
  /** When true, the agent plans then waits for approval before editing. */
  planMode?: boolean;
  /** Depth guard: children spawn with subagentDepth = parent + 1. Subagents
   *  may not delegate further (depth 1 has no spawnSubagent injected). */
  subagentDepth?: number;
  /** Repo-check failures captured before this run. A verify failure matching
   *  it is pre-existing debt and must not fail the task. */
  verifyBaseline?: VerificationBaseline | Promise<VerificationBaseline | undefined>;
}

export type AgentStopReason =
  | 'completed'          // verified + self-review clean (or answer task)
  | 'aborted'            // user interrupt / external abort
  | 'runtime_limit'      // maxRuntimeMinutes exceeded
  | 'budget'             // token/cost/model-call budget exhausted
  | 'pulse_abort'        // pulse watchdog (repeated identical failures)
  | 'max_iterations'     // safety.maxIterations hit
  | 'model_error'        // model request failed twice
  | 'tool_loop'          // too many tool calls (anti-infinite-loop)
  | 'verification_failed'; // verify kept failing past the retry budget

export interface AgentResult {
  success: boolean;
  summary: string;
  filesModified: string[];
  attempts: number;
  tokensUsed: number;
  durationMs: number;
  /** Why the run ended, mirroring modern agent SDKs (LangChain/LangGraph). */
  stopReason: AgentStopReason;
}

export class Agent {
  private id: string;
  private role: string;
  private profile: AgentProfile;
  private config: MochiConfig;
  private workspace: Workspace;
  private events: EventBus;
  private cwd: string;
  private context: ContextEngine;
  private verifyBaseline?: VerificationBaseline | Promise<VerificationBaseline | undefined>;
  /** True when the task's deliverable is file content with no behavior change
   *  (docs/config/data): repo-wide suites are vetoed for such tasks. */
  private contentOnly = false;
  private budget?: BudgetEngine;
  private abortSignal?: AbortSignal;
  private tools: Map<string, import('../tools/types.js').Tool>;
  private toolDefs: ToolDefinition[];
  private provider: ReturnType<typeof createProvider>;
  private providers = new Map<ModelProfile, ReturnType<typeof createProvider>>();
  private tokensUsed = 0;
  private startTime = 0;
  private errors: string[] = [];
  private lastStrategy?: string;
  private strategyRepeats = 0;
  private learning: LearningStore;
  private seenPatterns = new Set<string>();
  private hooks: HookManager;
  private toolCallsTotal = 0;
  private streamLoopNudges = 0;
  private triedFallbackModels = new Set<string>();
  private verifyCount = 0;
  private autopsy: Autopsy | undefined;
  private hypotheses: Hypothesis[] = [];
  private diagnosis: DiagnosisResult | undefined;
  private lastLessons: Lesson[] = [];
  private fileChanged = false;
  /** Checkpoint taken before the first file edit, restored if verification
   *  fails repeatedly so a broken agent run never leaves the tree dirty. */
  private preEditCheckpoint?: CheckpointResult;
  private checkpointFailed = false;
  private lastSig = '';
  private sigStreak = 0;
  private consecutiveToolErrors = new Map<string, { error: string; count: number }>();
  private readCache: ReadCache;
  private planMode: boolean;
  private planVetoes = 0;
  private planNudges = 0;
  private emptyResponseCount = 0;
  private selfReviewCount = 0;
  private lastCompletionAnswer = '';
  private sameAnswerStreak = 0;
  /** Phase 5 (VNext): stuck-signal counters surfaced in the volatile state
   *  prompt so the model can see its own loop pattern and break it. */
  private nudgeInjections = 0;
  /** Phase 9 (VNext): how many times the prose-runaway rewrite was requested
   *  (bounded at 1 so the guard can never itself loop). */
  private proseRunwayNudges = 0;
  /** Diff-hygiene: one bounded cleanup nudge for debug logs / TODO /
   *  suppressed-check debris the model added before we accept "done". */
  private hygieneNudges = 0;
  private lastVerifyPassed = false;
  private subagentDepth: number;
  private mcpClose?: () => void;
  /** Harness-v2 Phase 1: per-run iteration lifecycle tracker (created in run()). */
  private sm?: LoopStateMachine;

  constructor(opts: AgentOptions) {
    this.id = opts.id ?? randomUUID();
    this.role = opts.role;
    this.config = opts.config;
    this.workspace = opts.workspace;
    this.events = opts.events;
    this.cwd = opts.cwd;
    this.context = opts.context;
    this.budget = opts.budget;
    this.abortSignal = opts.abortSignal;
    this.verifyBaseline = opts.verifyBaseline;
    // A shared run-wide cache is preferred so parallel agents that read the same
    // source file don't each re-read it from disk; the cache is keyed on
    // (mtime, size) so any edit automatically misses, keeping it safe to share.
    this.readCache = opts.readCache ?? new Map();
    const profileService = new AgentProfileService(this.workspace.dir);
    this.profile = opts.profile ?? profileService.get(opts.role) ?? profileService.get('coder')!;
    this.tools = buildTools(this.config, this.profile.tools);
    if (opts.extraTools) {
      for (const [name, tool] of opts.extraTools) {
        if (!this.tools.has(name)) this.tools.set(name, tool);
      }
    }
    this.planMode = opts.planMode ?? this.config.planMode ?? false;
    this.subagentDepth = opts.subagentDepth ?? 0;
    this.learning = new LearningStore(this.workspace.dir);
    this.hooks = new HookManager(this.workspace.dir);
    this.toolDefs = [...this.tools.values()].map((t) => t.def);
    this.provider = createProvider(this.config.model, opts.modelProfile ?? this.profile.defaultModel ?? 'coding');
    this.events.emit({ type: 'agent:spawned', id: this.id, role: opts.role as any, taskId: '' });
  }

  async run(task: Task): Promise<AgentResult> {
    this.startTime = performance.now();
    this.events.emit({ type: 'task:started', task, agentId: this.id });
    // Harness-v2 Phase 1: deterministic iteration lifecycle. Every loop turn
    // flows preflight → model-call → stream-guard → tool-exec → verify →
    // finish and emits exactly one typed IterationTrace event.
    const sm = this.sm = new LoopStateMachine(this.events, this.id);
    this.context.updateState({ nextAction: `Start task: ${task.title}` });
    // Active execution mode (modeInstruction from modes.ts) is injected here so
    // spec/security/codemod/chaos directives reach the model every turn.
    if (this.config.mode && isMode(this.config.mode)) {
      const modeBlurb = modeInstruction(this.config.mode);
      if (modeBlurb) this.context.addMessage({ role: 'system', content: modeBlurb });
    }
    // Adjustable reasoning mode: read from config or env and inject directive.
    const reasoning = (this.config.reasoning || process.env.MOCHI_REASONING || 'max').trim().toLowerCase();
    const blurb = reasoning === 'max' || reasoning === 'extreme' || reasoning === 'deep'
      ? 'Engage MAXIMUM reasoning compute & cognitive depth: perform exhaustive multi-angle decomposition, analyze AST dependency blast radius, synthesize formal invariants (Chameleon reasoning), and thoroughly verify correctness before concluding.'
      : reasoning === 'high' || reasoning === 'hard'
        ? 'Engage HIGH reasoning depth: thoroughly analyze edge cases, evaluate invariants, trace AST caller dependencies, and confirm correctness with concrete checks.'
        : reasoning === 'low' || reasoning === 'easy'
          ? 'Engage LOW reasoning mode: act fast and decisively with minimal thinking overhead, make direct edits, verify quickly, and respond concisely.'
          : 'Engage MEDIUM balanced reasoning: carefully inspect relevant context, maintain system invariants, and verify changes.';
    this.context.addMessage({ role: 'system', content: `Active reasoning mode: ${reasoning.toUpperCase()}. ${blurb}` });
    // Each task gets a fresh autopsy record (idempotent on resume via
    // loadOrCreateAutopsy) so failure trajectories are durable and inspectable.
    this.autopsy = loadOrCreateAutopsy(this.workspace.dir, task.id, this.id, task.title);
    this.contentOnly = classifyContentOnly({ title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria, verificationCommand: task.verificationCommand });
    // Warm start on resume: if a previous session already attempted this task
    // and failed, surface those attempts to the model so it does NOT retry the
    // same dead-end hypotheses. The autopsy is loaded (not created) but was
    // previously write-only from the model's perspective.
    const priorAttempts = this.autopsy.attempts.filter((a) => a.outcome === 'still_failing' || a.statusAfter === 'refuted');
    if (priorAttempts.length > 0) {
      const lines = priorAttempts.slice(-6).map((a, i) => {
        const verdict = a.statusAfter === 'refuted' || a.outcome === 'still_failing' ? 'DID NOT FIX' : a.outcome;
        return `${i + 1}. Tried: ${a.hypothesisText} (${a.action}). Result: ${verdict}. Evidence: ${String(a.evidence).slice(0, 200)}`;
      });
      this.context.addMessage({
        role: 'system',
        content: `PRIOR SESSION CONTEXT (resume): ${priorAttempts.length} earlier attempt(s) on this task already failed. Do NOT repeat them:\n${lines.join('\n')}\nStart from a different hypothesis.`,
      });
    }
    if (this.planMode) {
      this.context.addMessage({
        role: 'system',
        content: 'PLAN MODE: Research the codebase with read-only tools if needed, then your VERY NEXT message must be the complete plan itself: numbered steps, files to change, risks, and how to verify. Do NOT edit files or run mutating commands. Do NOT say "I will proceed" — output the plan directly.',
      });
    }

    // Phase 7 (VNext): resume with the last durable checkpoint if one exists
    // for THIS specific goal (e.g. on resume or post-compaction restart).
    // Fresh sessions and unrelated goals do not load old checkpoints.
    try {
      const activeGoal = this.context.state.goal;
      const durable = this.workspace.loadCheckpoint(activeGoal);
      if (durable && durable.checkpoint.trim() && durable.goalId && activeGoal && durable.goalId === activeGoal) {
        this.context.addMessage({
          role: 'system',
          content: `RESUMED SESSION CHECKPOINT (from active goal, saved ${new Date(durable.savedAt).toISOString()}):
${durable.checkpoint}
Continue from 'Next:', do not redo completed progress.`,
        });
      }
    } catch { /* best-effort */ }

    const taskKind = classifyTaskKind(task);
    const repo = detectRepo(this.cwd);
    // Harness-v2 perf (FREEZE FIX 2026-08-22): warm codegraph grammars and the
    // Chameleon scaffold strictly in the BACKGROUND - fire-and-forget, never
    // awaited, never gating the first model call. Language hint comes from the
    // detected repo (+ fileScope) so warming does NOT scan the tree; and
    // primeScaffold itself refuses to warm over $HOME.
    {
      const hint: string[] = [];
      const rl = String(repo.language ?? '').toLowerCase();
      if (rl) hint.push(rl);
      for (const f of task.fileScope ?? []) {
        if (/\.tsx?$/.test(f)) hint.push('typescript');
        else if (/\.(mjs|cjs|jsx)$/.test(f)) hint.push('javascript');
        else if (/\.py$/.test(f)) hint.push('python');
        else if (/\.go$/.test(f)) hint.push('go');
        else if (/\.rs$/.test(f)) hint.push('rust');
        else if (/\.java$/.test(f)) hint.push('java');
      }
      void import('../cognitive/chameleon.js')
        .then((ch) => ch.primeScaffold(
          task.title + (task.description ? ` ${task.description}` : ''),
          this.cwd,
          undefined,
          hint.length ? [...new Set(hint)] : undefined,
        ))
        .catch(() => {});
    }
    if (taskKind !== 'chat') {
      const gitStatus = await this.runShell('git status --short');
      const langHint = languageHint(repo);
      this.context.addMessage({
        role: 'system',
        content: `Preflight: repo=${repo.language ?? 'unknown'}, git status:\n${gitStatus}${langHint ? '\n\n' + langHint : ''}`,
      });
    }

    const maxIterations = this.config.safety.maxIterations;
    const runtimeLimit = this.config.safety.maxRuntimeMinutes * 60 * 1000;

    // One-shot fast path: for high-confidence answer/summarize tasks, bias the
    // model to resolve in a single direct turn instead of spending tokens on
    // needless tool round-trips. Verification is still run before "done" is
    // accepted, so an answer is never trusted without evidence when edits happened.
    const oneShot = classifyOneShot({
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria ?? [],
      verificationCommand: task.verificationCommand,
    });
    if (oneShot.suggests && !this.planMode && taskKind !== 'chat') {
      this.context.addMessage({ role: 'system', content: oneShot.suggests });
    }

    // Wire any configured MCP servers into the toolset. These tools are closed
    // when the run finishes (see finish()), so subprocesses don't leak.
    if (this.config.mcpServers) {
      const log = (m: string): undefined => {
        this.events.emit({ type: 'agent:log', agentId: this.id, message: m });
        return undefined;
      };
      const connected = await buildMcpTools(this.config.mcpServers, log);
      for (const [name, tool] of connected.tools) {
        if (!this.tools.has(name)) this.tools.set(name, tool);
      }
      for (const err of connected.errors) log(err);
      if (connected.tools.size > 0) {
        this.toolDefs = [...this.tools.values()].map((t) => t.def);
      }
      this.mcpClose = connected.close;
    }

    // Delivered background results: task ids already surfaced to the model,
    // so each completion is injected exactly once.
    const bgDelivered = new Set<string>();
    for (let i = 0; i < maxIterations; i++) {
      sm.beginIteration(i);
      // Deliver completed background tasks as events into the transcript.
      try {
        const { listTasks, describeTask } = await import('../background-tasks.js');
        for (const t of listTasks()) {
          if (t.status !== 'running' && t.endedAt && !bgDelivered.has(t.id)) {
            bgDelivered.add(t.id);
            this.context.addMessage({
              role: 'system',
              content: `BACKGROUND TASK FINISHED:\n${describeTask(t)}`,
            });
          }
        }
      } catch { /* background registry unavailable; skip */ }
      if (this.abortSignal?.aborted) {
        return this.finish(task, false, 'Aborted by user', 'aborted');
      }
      if (performance.now() - this.startTime > runtimeLimit) {
        return this.finish(task, false, 'Runtime limit exceeded', 'runtime_limit');
      }
      if (this.budget) {
        this.budget.recordAgentStart();
        if (!this.budget.canMakeModelCall()) {
          return this.finish(task, false, 'Budget exhausted before model call', 'budget');
        }
        this.budget.recordModelCall();
      }

      if (i > 0 && i % 8 === 0) await this.checkpointAndCompact('periodic');

      // Compact-first context floor: once the live transcript grows past a
      // fraction of the context budget, roll up old turns so the packet never
      // balloons. The floor is ALSO capped by a fixed ceiling so a huge
      // configured budget (e.g. 120k+) cannot let the live transcript balloon —
      // long runs stay lean no matter what the user's safety config says.
      const ceiling = 32_000;
      const floor = Math.min(this.config.safety.contextBudgetTokens * 0.6, ceiling);
      if (i > 0 && this.context.effectiveContextTokens() > floor) {
        await this.checkpointAndCompact('floor');
      }

      const pulse = this.pulse(i, task);
      if (pulse.abort) {
        return this.finish(task, false, pulse.reason ?? 'Pulse abort', 'pulse_abort');
      }
      if (pulse.message) {
        this.context.addMessage({ role: 'system', content: pulse.message });
      }

      const packet = this.context.buildPacket(this.toolDefs, task, taskKind === 'chat' ? undefined : repo);
      // Anti-loop: if it's just gathering context (read/search) without editing, encourage an answer.
      if (this.toolCallsTotal >= 12 && !this.fileChanged && !this.planMode) {
        this.context.addMessage({ role: 'system', content: 'You have gathered sufficient context. Provide your answer directly now without further tool calls.' });
      }
      sm.enter('model-call');
      const activeProvider = this.pickProvider();
      let response;
      const gatherStream = async (messages: any) => {
        const chunks: import('../types.js').StreamChunk[] = [];
        let inThinkTag = false;
        let streamBuf = '';
        let looped = false;
        // Detect pathological streamed repetition: a free/low-tier model can
        // emit the same boilerplate block (e.g. "## Focus: implementation")
        // hundreds of times in one response, which floods the transcript and
        // looks like the agent "spamming". Count repeats of the most frequent
        // non-trivial WHOLESOME line across ALl received content (independent
        // of streamBuf, which is drained for think-tag processing) and abort
        // the gather as soon as the same line clearly repeats.
        const repCounts = new Map<string, number>();
        let maxRep = 0;
        let phraseBuf = '';
        const recentPhrases: string[] = []; // sliding window of last 20 phrases
        // A single model generation can also degenerate WITHOUT repeating an
        // identical line: e.g. a weak model streams hundreds of tiny fragments
        // of "let me explore the repo…" (lots of entropy, no progress) and
        // never issues a tool call. Put a hard budget on one response so those
        // runaway generations are truncated too.
        const MAX_STREAM_BYTES = 16_000;   // rough ~4k tokens of prose
        const MAX_STREAM_CHUNKS = 400;
        let streamBytes = 0;
        // Some degenerate streams have no newline and no long phrase: one
        // giant line like "open it, open it, open it, ..." (7-char phrase).
        // Catch those with a periodicity check on a rolling tail: if a short
        // period (2..24 chars) explains ~97% of the last 360 chars, the text
        // is a runaway loop and must be cut off, not streamed to the user.
        let recentTail = '';
        let tailCheckedAt = 0;
        let runawayFlagged = false;

        const activeReasoning = (this.config.reasoning || process.env.MOCHI_REASONING || 'max').trim().toLowerCase();
        sm.enter('stream-guard');
        for await (const chunk of activeProvider.streamChat(messages, this.toolDefs, { temperature: 0.2, signal: this.abortSignal, reasoningEffort: activeReasoning as any })) {
          chunks.push(chunk);
          if (chunk.reasoningContent) {
            this.events.emit({ type: 'agent:reasoning', content: chunk.reasoningContent, agentId: this.id });
          }
          if (chunk.content) {
            const newChunk = chunk.content;
            streamBuf += newChunk;
            streamBytes += newChunk.length;
            sm.addStreamBytes(newChunk.length);
            recentTail = (recentTail + newChunk).slice(-360);
            if (streamBytes - tailCheckedAt >= 120) {
              tailCheckedAt = streamBytes;
              const nonspace = recentTail.replace(/\s/g, '').length;
              if (recentTail.length >= 240 && nonspace >= recentTail.length * 0.5) {
                for (let p = 2; p <= 24; p++) {
                  if (recentTail.length < p * 8) break; // need >=8 reps of the unit
                  let match = 0;
                  const total = recentTail.length - p;
                  for (let i = 0; i < total; i++) if (recentTail[i] === recentTail[i + p]) match++;
                  if (match / total >= 0.97) { runawayFlagged = true; break; }
                }
              }
            }
            if (runawayFlagged) {
              looped = true;
              break;
            }
            
            for (let i = 0; i < newChunk.length; i++) {
              const char = newChunk[i];
              phraseBuf += char;
              if (char === '\n' || char === ',' || char === '.') {
                const phrase = phraseBuf.trim();
                if (phrase.length >= 12) {
                  recentPhrases.push(phrase);
                  if (recentPhrases.length > 20) {
                    const dropped = recentPhrases.shift()!;
                    repCounts.set(dropped, Math.max(0, (repCounts.get(dropped) ?? 0) - 1));
                  }
                  const c = (repCounts.get(phrase) ?? 0) + 1;
                  repCounts.set(phrase, c);
                  if (c > maxRep) maxRep = c;
                }
                phraseBuf = '';
              }
            }

            if (maxRep >= 8 || streamBytes >= MAX_STREAM_BYTES || chunks.length >= MAX_STREAM_CHUNKS || runawayFlagged) {
              // High-confidence loop / runaway generation: stop streaming
              // before it floods output.
              looped = true;
              break;
            }

            // Early-warning suppression: once a phrase has repeated 3+ times,
            // the model is likely degenerating. Stop emitting chunks to the
            // TUI so the user doesn't see identical lines, but
            // keep collecting so the loop detector (maxRep >= 8) can trigger.
            if (maxRep >= 3) {
              streamBuf = '';
              continue;
            }

            while (streamBuf.length > 0) {
              if (!inThinkTag) {
                const thinkOpenIdx = streamBuf.indexOf('<think>');
                const thoughtOpenIdx = streamBuf.indexOf('<thought>');
                const openIdx = thinkOpenIdx !== -1 && thoughtOpenIdx !== -1
                  ? Math.min(thinkOpenIdx, thoughtOpenIdx)
                  : (thinkOpenIdx !== -1 ? thinkOpenIdx : thoughtOpenIdx);

                if (openIdx === -1) {
                  const partialMatch = streamBuf.match(/<th?(?:i(?:n(?:k)?)?)?$/i);
                  if (partialMatch) {
                    const safeChunk = streamBuf.slice(0, streamBuf.length - partialMatch[0].length);
                    if (safeChunk) {
                      this.events.emit({ type: 'message:chunk', content: safeChunk, agentId: this.id } as any);
                    }
                    streamBuf = partialMatch[0];
                    break;
                  } else {
                    this.events.emit({ type: 'message:chunk', content: streamBuf, agentId: this.id } as any);
                    streamBuf = '';
                  }
                } else {
                  const pre = streamBuf.slice(0, openIdx);
                  if (pre) {
                    this.events.emit({ type: 'message:chunk', content: pre, agentId: this.id } as any);
                  }
                  const isThought = openIdx === thoughtOpenIdx;
                  streamBuf = streamBuf.slice(openIdx + (isThought ? 9 : 7));
                  inThinkTag = true;
                  this.events.emit({ type: 'agent:log', agentId: this.id, message: 'Thinking…' } as any);
                }
              } else {
                const thinkCloseIdx = streamBuf.indexOf('</think>');
                const thoughtCloseIdx = streamBuf.indexOf('</thought>');
                const closeIdx = thinkCloseIdx !== -1 && thoughtCloseIdx !== -1
                  ? Math.min(thinkCloseIdx, thoughtCloseIdx)
                  : (thinkCloseIdx !== -1 ? thinkCloseIdx : thoughtCloseIdx);

                if (closeIdx === -1) {
                  const partialClose = streamBuf.match(/<\/(?:th?(?:i(?:n(?:k)?)?)?|th?(?:o(?:u(?:g(?:h(?:t)?)?)?)?)?)?$/i);
                  if (partialClose) {
                    const safeChunk = streamBuf.slice(0, streamBuf.length - partialClose[0].length);
                    if (safeChunk) {
                      this.events.emit({ type: 'agent:reasoning', content: safeChunk, agentId: this.id });
                    }
                    streamBuf = partialClose[0];
                    break;
                  } else {
                    this.events.emit({ type: 'agent:reasoning', content: streamBuf, agentId: this.id });
                    streamBuf = '';
                  }
                } else {
                  const thinkChunk = streamBuf.slice(0, closeIdx);
                  if (thinkChunk) {
                    this.events.emit({ type: 'agent:reasoning', content: thinkChunk, agentId: this.id });
                  }
                  const isThoughtClose = closeIdx === thoughtCloseIdx;
                  streamBuf = streamBuf.slice(closeIdx + (isThoughtClose ? 10 : 8));
                  inThinkTag = false;
                }
              }
            }
          }
        }

        const rawContent = chunks.map((c) => c.content || '').join('');
        const rawReasoning = chunks.map((c) => c.reasoningContent || '').join('');
        let content = stripThinkTags(rawContent);
        const callsByIndex = new Map<number, any>();
        for (const chunk of chunks) {
          if (chunk.toolCalls) {
            for (const tc of chunk.toolCalls as any[]) {
              const idx = tc.index ?? 0;
              const acc = callsByIndex.get(idx) ?? { id: tc.id, name: tc.function.name, args: '' };
              acc.name = acc.name || tc.function.name;
              acc.args += tc.function.arguments || '';
              callsByIndex.set(idx, acc);
            }
          }
        }
        const tool_calls = [...callsByIndex.values()].map((a) => ({ id: a.id, type: 'function' as const, function: { name: a.name, arguments: a.args } }));
        // If content is empty after stripping think tags, but the model did emit reasoning (and no tools),
        // extract the thinking body so we don't treat it as a dead empty response that triggers an endless loop.
        if (!content && !tool_calls.length) {
          const thinkText = (rawReasoning || rawContent.replace(/<\/?(?:think|thought)>/gi, '')).trim();
          if (thinkText) {
            content = thinkText;
          }
        }
        return {
          content,
          toolCalls: tool_calls.length ? tool_calls : undefined,
          finishReason: chunks[chunks.length - 1]?.finishReason,
          usage: chunks[chunks.length - 1]?.usage,
          looped,
        };
      };

      try {
        response = await gatherStream(packet.messages);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        
        // Smart backoff for rate limits (429) to avoid immediately burning the retry
        if (message.toLowerCase().includes('429') || message.toLowerCase().includes('rate limit')) {
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[rate-limit] API busy. Applying 10s backoff...` });
          await new Promise(r => setTimeout(r, 10000));
        }

        await this.checkpointAndCompact('error');
        const retryPacket = this.context.buildPacket(this.toolDefs, task, repo);
        
        try {
          response = await gatherStream(retryPacket.messages);
        } catch (retryErr) {
          const rMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          
          // Failover strategy for repeated rate limits: switch to an alternate model instead of dying
          if (rMsg.toLowerCase().includes('429') || rMsg.toLowerCase().includes('rate limit')) {
            const alt = this.pickAlternateModel();
            if (alt) {
              this.events.emit({ type: 'agent:log', agentId: this.id, message: `[rate-limit] Primary model exhausted. Failing over to ${alt}` });
              this.setActiveModel(alt);
              continue; // Restart the loop iteration with the new model
            }
          }
          
          return this.finish(task, false, `Model request failed: ${message}`, 'model_error');
        }
      }
      if (response.usage) {
        this.tokensUsed += response.usage.totalTokens;
        this.budget?.recordTokens(response.usage.totalTokens, this.config.model.model);
        // Phase 4 (VNext): feed REAL provider usage into the context engine so
        // the compaction floor triggers on actuals instead of the chars/3.8 guess.
        this.context.recordReportedUsage((response.usage as { promptTokens?: number }).promptTokens);
        // Surface REAL provider usage to the TUI: input, output, cache reads, and cost in USD.
        const u = response.usage as { promptTokens?: number; completionTokens?: number; totalTokens?: number };
        const cacheRead = kvCache.totalCacheSaved || kvCache.lastCacheSaved;
        const cost = estimateCostUsd({ promptTokens: u.promptTokens, completionTokens: u.completionTokens }, this.config.model.model);
        this.events.emit({
          type: 'usage:updated' as any,
          agentId: this.id,
          inputTokens: Math.max(0, (u.promptTokens ?? 0) - cacheRead),
          outputTokens: u.completionTokens ?? 0,
          cacheTokens: cacheRead,
          totalTokens: u.totalTokens ?? 0,
          costUsd: this.budget?.snapshot(this.config.model.model).usedCostUsd ?? cost,
        });
      }
      // Reset empty-response counter on any successful model output.
      if ((response.content && response.content.trim()) || response.toolCalls?.length) {
        this.emptyResponseCount = 0;
      }
      
      // Reset stream-loop counter if the model successfully used a tool,
      // proving it recovered from the previous loop and made actual progress.
      if (response.toolCalls?.length) {
        this.streamLoopNudges = 0;
      }

      this.lastStrategy = response.toolCalls?.[0]?.function.name ?? response.content?.slice(0, 60) ?? '';

      // Stream-loop guard: the model repeated the same boilerplate block dozens
      // of times in one response (common with overloaded free-tier models). Stop
      // flooding the transcript: nudge it once to answer briefly; if it loops
      // again, FAIL OVER to an alternate model before giving up entirely.
      if ((response as any).looped) {
        this.streamLoopNudges++;
        this.events.emit({ type: 'agent:log', agentId: this.id, message: '[stream-loop] model repeated the same content; bounding' });
        // Truncate the degenerate content so it doesn't pollute the transcript
        // and cause downstream context budget issues.
        const truncatedContent = (response.content ?? '').slice(0, 200);
        if (this.streamLoopNudges >= 2) {
          // Fail over to an alternate model instead of dying. Many providers
          // host several tool-capable models; a degenerate one shouldn't kill
          // the whole task. Same provider+key, different model id.
          const alt = this.pickAlternateModel();
          if (alt) {
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[stream-loop] primary model degenerated; failing over to ${alt}` });
            this.setActiveModel(alt);
            this.streamLoopNudges = 0;
            this.context.addMessage({ role: 'system', content: `The previous model degenerated. You are now a fresh model continuing this task. Summarize nothing; just continue the task directly with a tool call or a direct answer.` });
            continue;
          }
          return this.finish(task, false, 'The model repeatedly restreamed the same block and could not produce a clean answer. Try again or switch models.', 'model_error');
        }
        // Don't add the looped content to the transcript — it's garbage.
        // Instead, add a clean system message nudging the model.
        this.context.addMessage({
          role: 'assistant',
          content: truncatedContent || '(looped output truncated)',
        });
        this.context.addMessage({
          role: 'system',
          content: 'Your previous response looped and repeated the same text. STOP repeating. Give a SHORT, DIRECT answer now. Do NOT repeat any previous text. If you need to write code, use the write or edit tool. Do NOT output the code as prose.',
        });
        this.events.emit({ type: 'agent:log', agentId: this.id, message: `[stream-loop] truncated looped response` });
        continue;
      }
      this.lastStrategy = response.toolCalls?.[0]?.function.name ?? response.content?.slice(0, 60) ?? '';

      // Anti-"same message" guard: if the model returns the exact same
      // no-tool-call answer again without making file changes, finish immediately rather than looping.
      if (!this.planMode && (!response.toolCalls || response.toolCalls.length === 0) && !this.fileChanged) {
        const text = (response.content ?? '').trim();
        if (text && text === this.lastCompletionAnswer) {
          this.sameAnswerStreak++;
          if (this.sameAnswerStreak >= 1) {
            return this.finish(task, true, text, 'completed');
          }
        } else {
          if (text) this.lastCompletionAnswer = text;
          this.sameAnswerStreak = 0;
        }
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        sm.enter('tool-exec');
        sm.recordToolCalls(response.toolCalls.length);
        this.context.addMessage({ role: 'assistant', content: response.content ?? '', tool_calls: response.toolCalls });
        // Plan mode: allow read-only research, but veto any mutating tool and
        // steer the model back to producing a plan. Every vetoed call still
        // gets a tool response (providers reject dangling tool_call_ids), and
        // the loop continues so the model can hand back its plan text. Only a
        // model that keeps attempting edits after a veto is stopped outright.
        // Read-only is an ALLOWLIST: anything not explicitly read-only (shell,
        // write/edit/delete/patch, git, MCP tools, ...) is vetoed.
        if (this.planMode) {
          const isMutating = (c: ToolCall) => !this.isReadOnly(c.function.name);
          if (response.toolCalls.some(isMutating)) {
            this.planVetoes++;
            // Mixed batches: run the read-only calls so their ids are answered,
            // and only veto the mutating ones.
            const readOnlies = response.toolCalls.filter((c) => !isMutating(c));
            if (readOnlies.length > 0) await this.executeToolCalls(readOnlies);
            for (const c of response.toolCalls) {
              if (!isMutating(c)) continue;
              this.vetoToolCall(c, 'plan mode is active. No file or command changes are permitted while planning.');
            }
            if (this.planVetoes > 2) {
              // The model will not stop reaching for tools. Finish with whatever
              // plan-shaped text exists: this turn's content, else the last
              // assistant message, else an honest placeholder.
              const lastAssistant = [...this.context['messages']].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
              const planText = (response.content ?? '').trim() || (lastAssistant?.content as string | undefined)?.trim() || '';
              return this.finish(task, true, planText || 'Planned. No files were changed.', 'completed');
            }
            this.context.addMessage({
              role: 'system',
              content: 'PLAN MODE: you are only planning right now. Do not edit files or run mutating commands. Do not call write/edit/delete/shell again. Hand back your plan (steps, files to change, risks, verification) as the final answer now.',
            });
            this.events.emit({ type: 'agent:log', agentId: this.id, message: '[plan-mode] vetoed mutating tool call; requesting plan' });
            continue;
          }
        }
        // Loop guard: repeated identical tool calls -> force the model to answer.
        const nowSig = response.toolCalls.map((c) => {
          const canonical = TOOL_ALIASES[c.function.name] || c.function.name;
          const args = normalizeToolArgs(canonical, this.parseArgs(c.function.arguments || '{}'));
          const sortedKeys = Object.keys(args).sort();
          const sortedArgs: Record<string, unknown> = {};
          for (const k of sortedKeys) sortedArgs[k] = args[k];
          return `${canonical}:${JSON.stringify(sortedArgs)}`;
        }).join('|');
        if (nowSig === this.lastSig) this.sigStreak++;
        else {
          this.sigStreak = 1;
          // Strategy changed: the stuck warning is no longer true.
          if (this.context.stuckSignal) this.context.stuckSignal = null;
        }
        this.lastSig = nowSig;
        if (this.sigStreak >= 3) {
          this.nudgeInjections++;
          if (this.nudgeInjections >= 3) {
            return this.finish(task, false, 'Loop guard: stopped after repeated identical tool calls and failed recovery nudges.', 'tool_loop');
          }
          this.context.addMessage({ role: 'system', content: 'You are repeating the same tool call. Stop issuing tools and give a final answer now without any tool calls.' });
          this.sigStreak = 0;
          // Phase 5: the state prompt now also carries the pattern so the
          // model sees it even after the nudge message is far back.
          this.context.stuckSignal = `You have issued ${this.nudgeInjections} repeated-tool-call nudges. Change strategy or answer now.`;
        }
        this.toolCallsTotal++;
        if (this.toolCallsTotal > 40) {
          return this.finish(task, false, 'Too many tool calls; stopping to avoid an infinite loop.', 'tool_loop');
        }
        await this.executeToolCalls(response.toolCalls);
        continue;
      }

      // No tool calls: decide based on whether real edits happened.
      if (!this.fileChanged) {
        if (response.content && response.content.trim()) {
          // In plan mode the deliverable is the plan itself: a reply that does
          // not look like a plan (e.g. "I'll research the codebase first")
          // is a preamble, not a result. Nudge the model back on task until
          // it either produces a plan or exhausts the nudge budget.
          if (this.planMode && !isPlanShaped(response.content)) {
            this.planNudges++;
            if (this.planNudges > 3) {
              return this.finish(task, false, 'Planner never produced a plan. Last reply:\n' + response.content, 'max_iterations');
            }
            this.context.addMessage({
              role: 'system',
              content: 'PLAN MODE: that was a preamble, not a plan. Your final message MUST be the actual plan: numbered steps, files to change, risks, and how to verify. Output the plan directly now, no tool calls, no "I will".',
            });
            this.events.emit({ type: 'agent:log', agentId: this.id, message: '[plan-mode] non-plan reply; nudging for the plan' });
            continue;
          }
          // Phase 9 (VNext): prose runaway guard. A no-tool-call answer that
          // huge is usually padding/repetition (the spam class of bug). Ask
          // ONCE for a terse rewrite; accept whatever comes back after that.
          if (response.content.length > 12_000 && this.proseRunwayNudges < 1) {
            this.proseRunwayNudges++;
            this.context.addMessage({
              role: 'system',
              content: 'Your answer was extremely long (over 12k characters). Reproduce it TERSELY: keep every concrete fact (files, commands, results) and cut all padding, restatement, and filler. One pass, no tool calls.',
            });
            this.events.emit({ type: 'agent:log', agentId: this.id, message: '[prose-guard] answer over 12k chars; requesting terse rewrite' });
            continue;
          }

          // If the task specifically expected file changes (explicit fileScope)
          // and no files were modified yet, nudge the model to execute the tool rather than
          // completing prematurely on conversational preamble.
          const expectsFiles = Boolean(task.fileScope && task.fileScope.length > 0);
          if (expectsFiles && !this.planMode && taskKind !== 'chat' && this.planNudges < 1) {
            this.planNudges++;
            this.context.addMessage({
              role: 'system',
              content: 'You responded with text, but the scoped files have not been created or modified yet for this task. Please use write, edit, or patch to make the required file changes.',
            });
            this.events.emit({ type: 'agent:log', agentId: this.id, message: '[file-guard] expected file changes; nudging to call write/edit tool' });
            continue;
          }

          return this.finish(task, true, response.content, 'completed');
        }
        // Empty response: the model returned nothing (common with overloaded
        // free providers or reasoning models that only emit thinking tokens).
        // Retry with real exponential backoff — free-tier queues routinely
        // drop one or two requests in a row and recover within seconds —
        // then give up instead of spinning to maxIterations.
        this.emptyResponseCount++;
        if (this.emptyResponseCount >= 4) {
          return this.finish(task, false, 'Model returned empty responses repeatedly. The provider may be overloaded — try again or switch models with /model.', 'model_error');
        }
        const backoffMs = [1500, 4000, 9000][this.emptyResponseCount - 1] ?? 9000;
        this.events.emit({ type: 'agent:log', agentId: this.id, message: `[empty-response] retry ${this.emptyResponseCount}/3 in ${backoffMs}ms (provider returned no content)` });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, backoffMs);
          this.abortSignal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (this.abortSignal?.aborted) {
          return this.finish(task, false, 'Aborted during empty-response backoff.', 'aborted');
        }
        this.context.addMessage({ role: 'system', content: 'Your last response was empty. Please respond with either a tool call or a direct text answer without <think> tags.' });
        continue;
      }

      sm.enter('verify');
      const verification = await this.verify(task, repo);
      this.verifyCount++;
      if (verification.passed) {
        this.lastVerifyPassed = true;
        // Success after diagnosis turns earlier hypotheses into confirmed or
        // refuted states and writes a procedural lesson so the next run has a
        // head start on this kind of failure.
        this.recordSuccess(task, repo);
        // Diff-hygiene gate (harness-v2 quality): verification proves the code
        // WORKS, not that it is CLEAN. One bounded pass catches debug logging,
        // TODO markers, suppressed checks, and focused tests the model added,
        // so shipped code never needs a human cleanup pass.
        if (!this.planMode && this.hygieneNudges < 1) {
          const findings = await this.collectHygieneFindings();
          if (findings.length > 0) {
            this.hygieneNudges++;
            this.context.addMessage({
              role: 'system',
              content: 'HYGIENE CHECK — your change works, but you left debris behind. Remove it (keep the behavior), then finish:\n' + renderHygieneFindings(findings),
            });
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[hygiene] ${findings.length} finding(s); requesting cleanup` });
            continue;
          }
        }
        // Verification passing only proves tests ran green; it does not prove
        // the DIFF is right. A cheap self-review read of the change catches
        // test-blind holes (accidental deletions, dead code, wrong constants,
        // pasted hacks) before we declare done. When it finds a real issue we
        // keep looping so the fix gets verified in the next iteration.
        if (!this.planMode && this.shouldSelfReview(task)) {
          const review = await this.selfReview(task, repo);
          if (review.issue) {
            this.selfReviewCount++;
            if (this.selfReviewCount > 2) {
              this.events.emit({ type: 'agent:log', agentId: this.id, message: `[self-review] reached 2 review passes; proceeding to complete` });
            } else {
              this.context.addMessage({
                role: 'system',
                content: 'SELF-REVIEW found a problem with the change. Fix it before finishing:\n' + review.issue,
              });
              this.events.emit({ type: 'agent:log', agentId: this.id, message: `[self-review] ${review.tail}` });
              continue;
            }
          }
        }
        const finalSummary = (response.content && response.content.trim())
          ? `${response.content.trim()}\n\n${verification.summary}`
          : verification.summary;
        return this.finish(task, true, finalSummary, 'completed');
      }
      if (this.verifyCount > 3) {
        // Repeated verification failure: roll the repo back to the state before
        // this agent's edits rather than leaving broken work on disk for the
        // next task (or the user) to inherit.
        let rollbackNote = '';
        if (this.preEditCheckpoint) {
          try {
            rollbackNote = '\n' + await gitRollback(this.cwd, this.preEditCheckpoint);
            this.events.emit({ type: 'agent:log', agentId: this.id, message: rollbackNote.trim() });
          } catch (err) {
            rollbackNote = `\n(Rollback failed: ${err instanceof Error ? err.message : String(err)})`;
          }
          this.preEditCheckpoint = undefined;
        }
        if (this.autopsy) {
          this.autopsy = finalizeAutopsy(this.workspace.dir, this.autopsy, { outcome: 'unresolved' });
        }
        this.recordFailure(task, verification.summary);
        return this.finish(task, false, 'Verification failed repeatedly:\n' + verification.summary + rollbackNote, 'verification_failed');
      }
      this.addAttempt(task, 'verify', [`${repo.testCommand || repo.buildCommand || 'verify'}`], 'failure', verification.summary);
      this.context.addKnownError(verification.summary);
      // Observation-driven retry: classify the failure, retrieve any matching
      // lessons from procedural memory, and append a structured attempt to
      // the autopsy record before nudging the model with the next hypothesis.
      await this.observeFailure(task, verification.summary, repo);
    }

    this.addAttempt(task, 'exhausted', [], 'failure', `Reached maximum iterations (${maxIterations})`);
    return this.finish(task, false, `Reached maximum iterations (${maxIterations})`, 'max_iterations');
  }

  /**
   * Budget-phase-aware model selection. When the budget drops to the "cheap"
   * or "verify" phase we fall back to the `fast` model profile for the rest of
   * the run (cheaper/lighter), which keeps critical reasoning on the full
   * profile while trimming spend on later, lower-risk iterations. Providers are
   * cached per profile so we don't rebuild them on every iteration.
   */
  private pickProvider(): ReturnType<typeof createProvider> {
    const base = this.profile.defaultModel ?? 'coding';
    let profile: ModelProfile = base;
    if (this.budget && this.budget.shouldUseCheaperModel()) {
      profile = 'fast';
    }
    if (profile === base) return this.provider;
    let p = this.providers.get(profile);
    if (!p) {
      p = createProvider(this.config.model, profile);
      this.providers.set(profile, p);
    }
    return p;
  }

  /** Pi-style structured checkpoint on compaction: before dropping the older
   *  transcript, ask the fast-profile model to distill it into Goal/Progress/
   *  Decisions/Next steps. On any failure (timeout, empty answer, weak model)
   *  fall back to the heuristic ledger so compaction NEVER blocks the loop. */
  private async checkpointAndCompact(reason: 'periodic' | 'floor' | 'error'): Promise<void> {
    const dropped = await this.context.previewCompact();
    if (!dropped || dropped.length === 0) {
      this.context.compact().catch(() => {});
      return;
    }
    // Render the to-be-dropped slice compactly. Tool outputs carry most of the
    // context mass, so aggressively cap them in the checkpoint input.
    const render = (m: ChatMessage): string => {
      if (m.role === 'tool') {
        const c = typeof m.content === 'string' ? m.content : '';
        return `[tool ${m.name ?? ''}] ${c.length > 300 ? c.slice(0, 150) + ' … ' + c.slice(-100) : c}`;
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const calls = m.tool_calls.map((t) => `${t.function.name}(${JSON.stringify(t.function.arguments).slice(0, 120)})`).join('; ');
        return `[assistant called] ${calls}`;
      }
      const c = typeof m.content === 'string' ? m.content : '';
      return `[${m.role}] ${c.slice(0, 400)}`;
    };
    let checkpoint: string | undefined;
    // Only spend a model call on real compactions (floor/error), skip the cheap
    // periodic one at i%8==0 which usually has little new to distill... actually
    // no: periodic compactions are where context drift starts. Use the model for
    // all of them, but with a hard timeout.
    try {
      const input = dropped.map(render).join('\n').slice(0, 12_000);
      const prompt: ChatMessage[] = [
        { role: 'system', content: 'You maintain a session checkpoint for a coding agent. Summarize the conversation excerpt below in at most 150 words using exactly this format:\nGoal: <what the user ultimately wants>\nProgress: <what has been done, files touched>\nDecisions: <key choices made, max 3>\nNext: <immediate next step>\nBe specific (file paths, commands). No preamble.' },
        { role: 'user', content: input },
      ];
      const fast = this.providers.get('fast') ?? this.provider;
      const parts: string[] = [];
      const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 20_000));
      const gen = (async () => {
        for await (const chunk of fast.streamChat(prompt, [], { temperature: 0, maxTokens: 400 })) {
          if (chunk.content) parts.push(chunk.content);
        }
      })();
      const raced = await Promise.race([gen, timer]);
      if (raced === 'timeout') throw new Error('checkpoint timeout');
      const text = parts.join('').trim();
      // Sanity: a usable checkpoint mentions at least Goal or Progress.
      if (text.length > 40 && /(goal|progress)/i.test(text)) checkpoint = text;
    } catch {
      checkpoint = undefined; // heuristic fallback inside compact()
    }
    await this.context.compact(checkpoint);
    // Phase 7: durable checkpoint — survives process restarts for resume.
    if (checkpoint) {
      try { this.workspace.saveCheckpoint('', checkpoint); } catch { /* best-effort */ }
    }
    if (checkpoint && this.events) {
      this.events.emit({ type: 'message', role: 'system', content: `Compacted (${reason}); checkpoint retained.`, agentId: this.id });
    }
  }

  /** Alternate model ids on the same provider to fail over to when the
   *  active model degenerates (repetition loops on weak free tiers). Ordered
   *  by observed reliability for tool-calling tasks. */
  private static FALLBACK_MODELS = ['qwen3.6-35b', 'minimax-m3', 'glm-5.3', 'glm-5.2', 'diffusiongemma', 'deepseek-v4-flash'];

  /** Pick the next fallback model id, skipping the active one. Returns
   *  undefined when every fallback has already been tried. */
  private pickAlternateModel(): string | undefined {
    const active = (this.config.model.model ?? '').toLowerCase();
    for (const m of Agent.FALLBACK_MODELS) {
      if (m.toLowerCase() === active) continue;
      if (this.triedFallbackModels.has(m)) continue;
      return m;
    }
    return undefined;
  }

  /** Swap the active model in-place: same provider/key/baseUrl, new model id.
   *  Rebuilds the provider so the next iteration uses the fallback. */
  private setActiveModel(modelId: string): void {
    this.triedFallbackModels.add(modelId);
    this.triedFallbackModels.add(this.config.model.model ?? '');
    this.config.model = { ...this.config.model, model: modelId };
    this.provider = createProvider(this.config.model, this.profile.defaultModel ?? 'coding');
    this.providers.clear();
  }

  private isReadOnly(name: string): boolean {
    const canonical = TOOL_ALIASES[name] || name;
    // Allowlist of non-mutating tools. Note: MCP resource tools registered as
    // <server>__resources_list/read are read-only by construction.
    return [
      'read', 'search', 'glob', 'outline', 'code_similarity', 'inspect', 'get_function', 'find_callers', 'type_hierarchy',
      'todo', 'skill', 'memory', 'session_recall', 'blast_radius', 'chameleon', 'analyze_code', 'perf', 'perf_audit',
      'web_search', 'get_diagnostics', 'git_blame', 'git_history', 'system_info',
      'find_references', 'find_definitions', 'db_inspect', 'diff', 'tree', 'deepwiki',
      'fetch', 'verify', 'sql_codebase', 'sql_codebase_query', 'think',
    ].includes(canonical) || /__resources_(list|read)$/.test(canonical);
  }

  /** Veto a tool call in plan mode, still answering its tool_call_id so the
   *  provider never sees a dangling reference. */
  private vetoToolCall(c: ToolCall, reason: string) {
    this.context.addMessage({ role: 'tool', tool_call_id: c.id, content: `Blocked: ${reason}`, name: c.function.name });
  }

  /** Mark a tool result as "file changed" and track the affected paths. */
  private trackFileChange(name: string, args: Record<string, unknown>, toolResult?: { output?: string }) {
    const canonical = TOOL_ALIASES[name] || name;
    if (['write', 'edit', 'delete', 'patch'].includes(canonical)) {
      this.fileChanged = true;
      const path = String(args.path ?? '');
      if (path) this.context.addModifiedFile(resolve(this.cwd, path));
    }
    if (canonical === 'patch' && toolResult?.output) {
      for (const line of toolResult.output.split('\n')) {
        const m = line.match(/^- (?:added|updated|deleted) (.+?)(?: \(\d+ lines\))?$/);
        if (m) this.context.addModifiedFile(resolve(this.cwd, m[1]));
      }
    }
  }

  /**
   * Run the model's chosen tool calls in parallel-where-safe order:
   *   1. All read-only calls (read/search/glob/etc.) run concurrently via Promise.all.
   *   2. Mutating calls to DISTINCT target paths run concurrently.
   *   3. Shell/other stateful calls run sequentially to preserve causal order.
   */
  private async executeToolCalls(batch: ToolCall[]): Promise<void> {
    while (batch.length > 0) {
      if (this.abortSignal?.aborted) return;
      const head = batch[0];
      const headName = TOOL_ALIASES[head.function.name] || head.function.name;
      if (this.isReadOnly(headName)) {
        let n = 0;
        while (n < batch.length && n < 8 && this.isReadOnly(batch[n].function.name)) n++;
        const group = batch.splice(0, Math.max(n, 1));
        await Promise.all(group.map((tc) => this.runMoolCall(tc)));
        continue;
      }

      // Writes-edits to DISTINCT target files are independent and safe to run in
      // parallel, which lets the model create/edit several files in one turn
      // instead of paying a round-trip per file — a real cut to iterations/tokens.
      if (['write', 'edit', 'delete'].includes(headName)) {
        const seen = new Set<string>();
        const group: ToolCall[] = [];
        const remaining: ToolCall[] = [];
        for (const tc of batch) {
          const tcName = TOOL_ALIASES[tc.function.name] || tc.function.name;
          if (['write', 'edit', 'delete'].includes(tcName)) {
            let path = '';
            try {
              const parsed = this.parseArgs(tc.function.arguments || '{}');
              const normalized = normalizeToolArgs(tcName, parsed);
              path = String(normalized.path ?? '');
            } catch { /* treat as independent */ }
            if (seen.has(path)) { remaining.push(tc); continue; }
            seen.add(path);
            group.push(tc);
          } else {
            remaining.push(tc);
          }
        }
        batch.length = 0;
        batch.push(...remaining);
        await Promise.all(group.map((tc) => this.runMoolCall(tc)));
        continue;
      }

      // shell may depend on prior results, so run alone unless clearly read-only.
      batch.shift();
      await this.runMoolCall(head);
    }
  }

  /** Spawn a fresh child agent on a subtask and return a short summary. The
   *  child shares this run's config, workspace, events, cwd, abort signal,
   *  budget, and file read cache so delegation is cheap and consistent. */
  private async spawnSubagent(
    prompt: string,
    opts?: { role?: string; timeoutMs?: number; scratchpad?: string } | string
  ): Promise<string> {
    const roleStr = typeof opts === 'string' ? opts : opts?.role;
    const timeoutMs = typeof opts === 'object' ? opts?.timeoutMs : undefined;
    const scratchpad = typeof opts === 'object' ? opts?.scratchpad : undefined;

    const childRole = (roleStr ?? 'coder') as import('../types.js').AgentRole;
    const childProfile = new AgentProfileService(this.workspace.dir).get(childRole) ?? this.profile;
    const childId = `${this.id}-sub-${Math.random().toString(36).slice(2, 8)}`;
    const childContext = new ContextEngine(this.config, this.cwd);
    if (scratchpad) {
      childContext.addMessage({
        role: 'system',
        content: `[Shared Context / Scratchpad from Parent Agent]:\n${scratchpad}`,
      });
    }

    const childAbort = new AbortController();
    const combinedAbort = this.abortSignal
      ? AbortSignal.any([this.abortSignal, childAbort.signal])
      : childAbort.signal;

    const child = new Agent({
      id: childId,
      role: childRole,
      modelProfile: childProfile.defaultModel ?? 'coding',
      profile: childProfile,
      config: this.config,
      workspace: this.workspace,
      events: this.events,
      cwd: this.cwd,
      context: childContext,
      budget: this.budget,
      abortSignal: combinedAbort,
      readCache: this.readCache,
      subagentDepth: this.subagentDepth + 1,
    });
    const task: Task = {
      id: `sub-${Math.random().toString(36).slice(2, 10)}`,
      title: `Subtask: ${prompt.split('\n')[0].slice(0, 60)}`,
      description: prompt,
      role: childRole,
      status: 'pending',
      priority: 1,
      dependencies: [],
      acceptanceCriteria: [],
      attempts: [],
      createdAt: Date.now(),
    };
    this.events.emit({
      type: 'subagent:started',
      agentId: childId,
      parentId: this.id,
      role: childRole,
      prompt: prompt.slice(0, 300),
    });

    let timeoutTimer: NodeJS.Timeout | undefined;
    const runPromise = child.run(task);
    const timeoutPromise = timeoutMs && timeoutMs > 0
      ? new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            childAbort.abort('Subagent execution timed out');
            reject(new Error(`Subagent timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      : null;

    try {
      const result = timeoutPromise
        ? await Promise.race([runPromise, timeoutPromise])
        : await runPromise;
      if (timeoutTimer) clearTimeout(timeoutTimer);

      this.events.emit({
        type: 'subagent:completed',
        agentId: childId,
        parentId: this.id,
        role: childRole,
        success: result.success,
        summary: result.summary,
        tokensUsed: result.tokensUsed,
      });
      return `[completed=${result.success}] ${result.summary} (${result.tokensUsed} tokens, ${result.durationMs}ms)`;
    } catch (err) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      const msg = err instanceof Error ? err.message : String(err);
      this.events.emit({
        type: 'subagent:completed',
        agentId: childId,
        parentId: this.id,
        role: childRole,
        success: false,
        summary: msg,
        tokensUsed: 0,
      });
      throw err;
    }
  }

  /** Spawn multiple subagents concurrently and return their aggregated results. */
  private async spawnSubagents(
    tasks: Array<{ prompt: string; role?: string; timeoutMs?: number; scratchpad?: string }>
  ): Promise<string[]> {
    const results = await Promise.allSettled(
      tasks.map((t) => this.spawnSubagent(t.prompt, { role: t.role, timeoutMs: t.timeoutMs, scratchpad: t.scratchpad }))
    );
    return results.map((r, i) => {
      const role = tasks[i]?.role ?? 'coder';
      if (r.status === 'fulfilled') {
        return `[Subagent #${i + 1} (${role})]: ${r.value}`;
      }
      const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
      return `[Subagent #${i + 1} (${role}) FAILED]: ${err}`;
    });
  }

  private async runMoolCall(tc: ToolCall): Promise<void> {
    if (this.abortSignal?.aborted) return;
    const toolName = TOOL_ALIASES[tc.function.name] || tc.function.name;
    if (this.budget) {
      this.budget.recordToolCall();
      if (!this.budget.canExecuteTool()) {
        this.context.addKnownError('Tool budget exhausted');
        this.vetoToolCall(tc, 'Tool budget exhausted. Stop calling tools and give your final answer now.');
        return;
      }
    }
    const before = await this.hooks.runBefore('before_tool', { tool: toolName });
    if (!before.allowed) {
      this.context.addKnownError(`before_tool hook vetoed ${toolName}`);
      this.vetoToolCall(tc, `before_tool hook vetoed ${toolName}.`);
      return;
    }
    if (['edit', 'write', 'delete', 'patch'].includes(toolName)) {
      const editHook = await this.hooks.runBefore('before_edit', { tool: toolName });
      if (!editHook.allowed) {
        this.vetoToolCall(tc, 'before_edit hook vetoed this edit.');
        return;
      }
    }
    if (toolName === 'shell') {
      const shellHook = await this.hooks.runBefore('before_shell', { tool: toolName });
      if (!shellHook.allowed) return;
    }
    const args = normalizeToolArgs(toolName, this.parseArgs(tc.function.arguments));
    // Pre-execution snapshot: take it BEFORE the first mutating tool runs so
    // the restore point predates the agent's own edits. Only on a CLEAN tree
    // (a dirty tree has user work we must never stash or reset away).
    if (['write', 'edit', 'delete', 'patch'].includes(toolName) && !this.preEditCheckpoint && !this.checkpointFailed) {
      try {
        this.preEditCheckpoint = (await gitPreEditSnapshot(this.cwd, `mochi pre-edit [${this.id}]`)) ?? undefined;
      } catch {
        this.checkpointFailed = true;
      }
    }
    // Content-only gate: a task whose deliverable is file CONTENT (docs,
    // config, data) gains nothing from repo-wide suites or builds — they
    // exercise code, not content, and pre-existing failures then burn tokens
    // and fail correct work. Veto the suite; suggest a direct check instead.
    if (toolName === 'shell' && this.contentOnly) {
      const cmd = String(args.command ?? '');
      const isRepoWide = /^(npm|pnpm|yarn)\s+(test|run\s+test)|^(npx|pnpm)\s+(vitest|jest|mocha)\s*(run)?\s*$|\bgo\s+test\s+\.\/\.\.\b|^cargo\s+(test|build)|^mvn\s+test|^\.\/gradlew\s+test|^dotnet\s+test|^python3?\s+-m\s+pytest\s*$|^bundle\s+exec\s+rspec$|^zig\s+build\s+test$/.test(cmd.trim());
      if (isRepoWide) {
        this.context.addMessage({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: 'Vetoed: this is a content-only task; repo-wide test suites and builds do not exercise file content. Verify the deliverable directly instead (e.g. test -f <path>, grep -q <expected> <path>, cat <path>) and finish.',
        });
        this.events.emit({ type: 'tool:completed', tool: tc.function.name, result: { toolCallId: tc.id, name: tc.function.name, output: 'Vetoed content-only repo-wide suite.', durationMs: 0 }, agentId: this.id });
        return;
      }
    }
    const ctx: ToolContext = {
      cwd: this.cwd,
      workspace: this.workspace,
      config: this.config,
      events: this.events,
      agentId: this.id,
      abortSignal: this.abortSignal,
      readCache: this.readCache,
      // Top-level and first-level agents (depth < 2) can delegate; bounding
      // the delegation tree to 2 levels so complex multi-agent flows work reliably.
      ...(this.subagentDepth < 2
        ? {
            spawnSubagent: (prompt: string, opts?: { role?: string; timeoutMs?: number; scratchpad?: string }) => this.spawnSubagent(prompt, opts),
            spawnSubagents: (tasks: Array<{ prompt: string; role?: string; timeoutMs?: number; scratchpad?: string }>) => this.spawnSubagents(tasks),
          }
        : {}),
    };
    this.events.emit({ type: 'tool:called', tool: tc.function.name, args, agentId: this.id });
    const { output, error, durationMs } = await executeTool(tc.function.name, args, ctx, this.tools);
    // Instant diagnostics (the Crush LSP insight): after every edit, surface
    // type/syntax errors for the touched file in the SAME turn so the model
    // fixes them now instead of burning whole iterations discovering them at
    // verification time.
    let diagNote = '';
    if (['write', 'edit', 'patch'].includes(toolName) && !error) {
      const targets = [String(args.path ?? '')].filter(Boolean);
      if (toolName === 'patch' && typeof output === 'string') {
        for (const line of output.split('\n')) {
          const m = line.match(/^- (?:added|updated|deleted) (.+?)(?: \(\d+ lines\))?$/);
          if (m && /\.(ts|tsx|js|jsx|mts|cts|py)$/.test(m[1])) targets.push(m[1]);
        }
      }
      if (targets.length > 0 && targets.length <= 4) {
        const diags = await Promise.all(
          targets.filter((t) => /\.(ts|tsx|js|jsx|mts|cts|py)$/.test(t)).map((t) => diagnoseFile(resolve(this.cwd, t), this.cwd)),
        );
        diagNote = renderDiagnostics(diags);
      }
    }
    let recoveryHint = '';
    if (error) {
      const errSig = error.slice(0, 100);
      const prevError = this.consecutiveToolErrors.get(toolName);
      if (prevError && prevError.error === errSig) {
        prevError.count++;
        if (prevError.count >= 3) {
          recoveryHint += `\n[CRITICAL HARNESS ADVISORY: Tool '${toolName}' has failed ${prevError.count} times consecutively with the same error. Do NOT retry this exact call. Use a different tool (e.g. read/glob/search) or report the blocker directly.]`;
        }
      } else {
        this.consecutiveToolErrors.set(toolName, { error: errSig, count: 1 });
      }

      const errLower = error.toLowerCase();
      if (errLower.includes('enoent') || errLower.includes('not found') || errLower.includes('no such file')) {
        recoveryHint += '\n[Harness Hint: Target file was not found. Use glob or search to verify paths before editing/reading.]';
      } else if (errLower.includes('did not match') || errLower.includes('patch')) {
        recoveryHint += '\n[Harness Hint: Target text was not found verbatim in the file. Call read tool to inspect current lines before editing.]';
      } else if (toolName === 'shell' && (errLower.includes('exit') || errLower.includes('failed') || errLower.includes('command not found'))) {
        recoveryHint += '\n[Harness Hint: Shell command failed. Review the terminal error above to fix syntax or missing packages.]';
      }
    } else {
      this.consecutiveToolErrors.delete(toolName);
    }

    // Polyglot Compiler Diagnostics: If shell or test command produced compiler/runtime errors,
    // pinpoint exact error lines with real source snippets directly to the agent.
    if (typeof output === 'string' && output.length > 0) {
      const diags = parseCompilerDiagnostics(output, this.cwd);
      if (diags.length > 0) {
        recoveryHint += renderCompilerAdvisory(diags);
      }
    }

    const result: ToolResult = {
      toolCallId: tc.id,
      name: tc.function.name,
      output: (error ? `Error: ${error}\n${output}` : output) + (diagNote ? `\n${diagNote}` : '') + recoveryHint,
      error,
      durationMs,
    };
    // Uniform output policy (Harness V2): dual-limit truncation preserving
    // head+tail whole lines, with the FULL output spilled to a temp file the
    // model can re-read. Replaces the old 6k-char fold that could lose the
    // one line the model needed with no recovery path.
    const pol = applyToolOutputPolicy(result.output, { toolName: tc.function.name });
    const foldedOutput = pol.content;
    this.context.addMessage({ role: 'tool', tool_call_id: tc.id, content: foldedOutput, name: tc.function.name });
    this.events.emit({ type: 'tool:completed', tool: tc.function.name, result, agentId: this.id });
    await this.hooks.runAfter('after_tool', { tool: toolName });
    if (['edit', 'write', 'delete', 'patch'].includes(toolName)) {
      await this.hooks.runAfter('after_edit', { tool: toolName });
    }
    if (toolName === 'shell') {
      await this.hooks.runAfter('after_shell', { tool: toolName });
    }
    if (error) {
      this.errors.push(error);
      this.context.addKnownError(error);
      const classified = classifyErrorPattern(error);
      if (classified) {
        this.seenPatterns.add(classified.pattern);
        this.learning.record(classified.pattern, this.lastStrategy ?? 'unclassified', false);
      }
    }
    this.trackFileChange(toolName, args, { output: result.output });
  }
  private parseArgs(raw: string): Record<string, unknown> {
    if (!raw || !raw.trim()) return {};
    const trimmed = raw.trim();
    // 1. Direct parse
    try {
      const res = JSON.parse(trimmed);
      if (typeof res === 'object' && res !== null && !Array.isArray(res)) return res as Record<string, unknown>;
    } catch {}

    // 2. Strip markdown code fence: ```json ... ```
    const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenceMatch) {
      try {
        const res = JSON.parse(fenceMatch[1]);
        if (typeof res === 'object' && res !== null && !Array.isArray(res)) return res as Record<string, unknown>;
      } catch {}
    }

    // 3. Extract outermost JSON object { ... }
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const slice = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        const res = JSON.parse(slice);
        if (typeof res === 'object' && res !== null && !Array.isArray(res)) return res as Record<string, unknown>;
      } catch {}

      // 4. Relaxed JSON repair: trailing commas, single quotes, Python booleans
      try {
        const relaxed = slice
          .replace(/,\s*([}\]])/g, '$1')
          .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
          .replace(/\bTrue\b/g, 'true')
          .replace(/\bFalse\b/g, 'false')
          .replace(/\bNone\b/g, 'null');
        const res = JSON.parse(relaxed);
        if (typeof res === 'object' && res !== null && !Array.isArray(res)) return res as Record<string, unknown>;
      } catch {}
    }

    // 5. Incomplete JSON stream repair (auto-close open strings and braces)
    if (firstBrace !== -1) {
      let openSlice = trimmed.slice(firstBrace);
      const quoteCount = (openSlice.match(/(?<!\\)"/g) || []).length;
      if (quoteCount % 2 !== 0) openSlice += '"';
      const openBraces = (openSlice.match(/\{/g) || []).length;
      const closedBraces = (openSlice.match(/\}/g) || []).length;
      if (openBraces > closedBraces) {
        openSlice += '}'.repeat(openBraces - closedBraces);
        try {
          const res = JSON.parse(openSlice);
          if (typeof res === 'object' && res !== null && !Array.isArray(res)) return res as Record<string, unknown>;
        } catch {}
      }
    }

    // 6. Fallback
    return { content: raw, query: raw, command: raw, path: raw };
  }

  /** Replace unfilled hints in a verification command (models sometimes write
   *  `cd <project_root> && zig build test`; the `<...>` is shell-redirect
   *  syntax and would blow up sh). Strip a leading `<project_root>`/`<root>`
   *  cd so the command runs from the agent already-fixed cwd. */
  private sanitizeVerify(cmd: string): string { return sanitizeVerifyCommand(cmd); }

  private async verify(task: Task, repo: ReturnType<typeof detectRepo>): Promise<{ passed: boolean; summary: string }> {
    const checks: string[] = [];
    // Run verification commands from the task's fileScope directory when it
    // is consistent. This lets the model write commands like `npx vitest run`
    // without having to remember the `cd <dir> &&` prefix, and fixes a class
    // of "command not found" failures where the runner lives under the
    // fileScope's package.json but the project root has no test runner.
    const scopeDir = cwdForScope(this.cwd, task.fileScope);
    if (task.verificationCommand) {
      const cmd = this.sanitizeVerify(task.verificationCommand);
      checks.push(withCwd(cmd, scopeDir));
    }
    // Repo-level commands (testCommand/typecheckCommand/lintCommand/buildCommand)
    // describe the PROJECT ROOT, not the task's fileScope directory. If the
    // task has a fileScope, those commands would run inside the scope dir
    // (e.g. cd <scope> && npm run build) but the package.json there usually
    // has no `build` script and the check fails for the wrong reason. Skip
    // them when a fileScope is set; the explicit task.verificationCommand +
    // the auto-detected runner cover the task's own verification.
    if (!scopeDir && !this.contentOnly) {
      if (repo.testCommand) checks.push(repo.testCommand);
      // Optional checks (typecheck/lint) only when the tool is installed:
      // the registry now knows `python3 -m ruff check .`, `cargo clippy`,
      // `go vet`, etc. for every repo, but verification must not FAIL a run
      // because the lint tool isn't on this machine.
      if (repo.typecheckCommand && commandAvailable(repo.typecheckCommand, this.cwd)) checks.push(repo.typecheckCommand);
      if (repo.lintCommand && commandAvailable(repo.lintCommand, this.cwd)) checks.push(repo.lintCommand);
      if (repo.buildCommand && commandAvailable(repo.buildCommand, this.cwd)) checks.push(repo.buildCommand);
    }
    // Auto-detected real test runner: only added when the explicit
    // verificationCommand is weak (e.g. `test -f ... && grep ...`) so the
    // mutation check has actual code coverage to evaluate. Skipped when the
    // command is already a real runner, and skipped for CONTENT-ONLY tasks:
    // a direct check IS the proportionate verification for content, and an
    // auto-added repo suite burns tokens / fails correct work on debt.
    if (isWeakVerification(task.verificationCommand) && !this.contentOnly) {
      const auto = autoTestCommand(this.cwd, task.fileScope);
      if (auto) checks.push(auto);
    }
    if (checks.length === 0) return { passed: true, summary: 'No verification configured.' };

    const baseline = await this.verifyBaseline;
    // Intent gate on debt-masking: when the TASK ITSELF demands green checks
    // ("make npm test pass", "fix so pytest passes"), a failing check IS the
    // success criterion - pre-existing identical failure must NOT mask it.
    // Dogfood finding: masking let an unfixed broken runner count as done.
    const wantsGreen = /\b(make|get|turn)\b[^.\n]{0,60}\b(pass|green)\b|\b(tests?|suite)\b[^.\n]{0,40}\b(must|should|to)\b[^.\n]{0,20}\bpass\b|\ball tests?\b|\b(pytest|npm test|node --test|go test|vitest|jest)\b[^.\n]{0,40}\b(pass(ing|es)?|green)\b/i.test(
      `${task.title} ${task.description} ${(task.acceptanceCriteria ?? []).join(' ')}`,
    );

    // Independent commands run in PARALLEL: test/typecheck/lint/build share no
    // state, so wall-clock per verification is the slowest check, not the sum.
    // Reporting keeps deterministic first-failure-in-declared-order semantics.
    const outcomes = await Promise.all(
      checks.map(async (cmd) => ({ cmd, out: await this.runShell(cmd, 180) })),
    );
    for (const { cmd, out } of outcomes) {
      if (out.includes('exit_code: 0') || out.trim().endsWith('PASS')) {
        continue;
      }
      // Pre-existing failure: identical failure captured before this run
      // started. It is repo debt, not agent breakage; do not fail the task.
      if (!wantsGreen && matchesBaseline(baseline, cmd, out)) {
        continue;
      }
      return { passed: false, summary: `Check failed: ${cmd}\n${truncateMiddle(out, 1200)}` };
    }
    return { passed: true, summary: `All checks passed: ${checks.join(', ')}` };
  }

  private pulse(iteration: number, task: Task): { abort: boolean; reason?: string; message?: string } {
    const recentErrors = this.errors.slice(-3);
    const allSame = recentErrors.length === 3 && new Set(recentErrors).size === 1;
    if (allSame) {
      return { abort: false, message: `Pulse: the last 3 errors were the same (${recentErrors[0]}). Try a different strategy or gather more context before retrying.` };
    }
    if (iteration > 0 && iteration % 12 === 0) {
      return { abort: false, message: `Pulse: ${iteration} iterations. Verify progress and switch approach if blocked.` };
    }
    // Abort if the model keeps producing empty responses or no-op iterations.
    if (this.emptyResponseCount >= 4) {
      return { abort: true, reason: 'Model returning empty responses repeatedly.' };
    }
    if (this.errors.length >= 6) {
      return { abort: true, reason: `Too many repeated failures (${this.errors.length}). Stopping.` };
    }
    this.events.emit({ type: 'pulse', state: this.context.state });
    return { abort: false };
  }

  private addAttempt(task: Task, strategy: string, actions: string[], result: Attempt['result'], failureReason?: string) {
    task.attempts.push({
      // Sortable ID (OpenFable Identifier): attempts in the autopsy sort by
      // when they happened without a separate timestamp column.
      id: sortableId(),
      strategy,
      actions,
      result,
      failureReason,
      timestamp: Date.now(),
    });
  }

  /** Classify the most recent failure, refresh hypotheses, persist an
   *  attempt to the autopsy, and inject a structured diagnostic prompt
   *  (including any matching procedural lessons) as the next user turn. */
  private async observeFailure(task: Task, failureText: string, repo: ReturnType<typeof detectRepo>): Promise<void> {
    const state = this.context['state'];
    const filesModified: string[] = (state?.filesModified ?? []) as string[];
    const { kind, signals } = classifyFailure(failureText);
    this.diagnosis = {
      kind,
      signals,
      hypotheses: this.hypotheses.length ? this.hypotheses : formInitialHypotheses(kind, filesModified),
      summary: failureText.slice(0, 600),
    };
    // Rank: drop any that the previous probe contradicted badly.
    this.diagnosis.hypotheses = rankHypotheses(this.diagnosis.hypotheses);

    // If the top hypothesis has a cheap probe, attempt it so the next loop turn
    // arrives already armed with confirmation (or rejection) and the autopsy
    // can show concrete evidence per attempt. The probe runs but its output is
    // only reflected in the lesson+dialogue flow; an exception here would
    // swallow into an empty probeOutput and mark the hypothesis as neutral.
    const top = this.diagnosis.hypotheses[0];
    // Bounded probe (20s timeout + abort-aware) is awaited here so its capture
    // is real and no subprocess is leaked; any failure degrades to '' and the
    // hypothesis stays neutral, keeping observeFailure non-blocking-critical.
    let probeOutput = '';
    try {
      probeOutput = top?.probeCommand ? await this.runProbe(top.probeCommand) : '';
    } catch {
      probeOutput = '';
    }

    if (top && probeOutput) {
      const updated = evaluateProbe(top, probeOutput);
      this.diagnosis.hypotheses[0] = updated;
      if (updated.status === 'confirmed') this.diagnosis.hypotheses.forEach((h, i) => { if (i !== 0) h.confidence = Math.max(0.05, h.confidence - 0.2); });
    }

    // Pull matching procedural lessons for THIS signature/kind so the prompt
    // can say "last time you saw this, X fixed it" instead of starting cold.
    this.lastLessons = retrieveLessons(this.workspace.dir, failureText, kind);

    if (this.autopsy) {
      this.autopsy.failureKind = kind;
      this.autopsy.signals = signals;
      const action = top?.probeCommand ? `probed: ${top.probeCommand.slice(0, 80)}` : 'inspection only';
      this.autopsy = appendAttempt(this.workspace.dir, this.autopsy, {
        attempt: this.verifyCount,
        hypothesisId: top?.id ?? 'unknown',
        hypothesisText: top?.description ?? '(no hypothesis)',
        confidenceBefore: top?.confidence ?? 0,
        action,
        evidence: probeOutput || failureText,
        outcome: 'still_failing',
        confidenceAfter: top?.confidence ?? 0,
        statusAfter: top?.status ?? 'pending',
        atMs: Date.now(),
      });
      this.events.emit({ type: 'agent:log', agentId: this.id, message: `[diagnosis] ${autopsyOneLine(this.autopsy)}` });
    }

    // Surface the diagnostic to the model. Lessons first (they're the most
    // actionable), then the hypothesis ordering, then the raw failure text.
    const parts = ['Verification failed. Treat this as a HYPOTHESIS rather than a generic retry:'];
    if (this.lastLessons.length) parts.push(lessonsToPrompt(this.lastLessons));
    parts.push(diagnosisToPrompt(this.diagnosis));
    parts.push('--- failure evidence ---');
    parts.push(failureText);
    parts.push('Pick the most likely hypothesis (or your own), take ONE focused action, then re-run verification. Do not just retry the same edit.');
    this.context.addMessage({ role: 'user', content: parts.join('\n\n') });
  }

  /** Fire a small read-only probe and capture its output. Now properly awaited
   *  through the shell tool with a short timeout and the run's abort signal, so
   *  it can never leak a dangling subprocess or block the loop past the bound.
   *  On any failure (tool missing, timeout, abort, hard error) it degrades to an
   *  empty capture — the next iteration's verify is still authoritative. */
  private async runProbe(command: string): Promise<string> {
    try {
      if (!this.tools.has('shell')) return '';
      const ctx: ToolContext = {
        cwd: this.cwd,
        workspace: this.workspace,
        config: this.config,
        events: this.events,
        agentId: this.id,
        abortSignal: this.abortSignal,
        readCache: this.readCache,
        ...(this.subagentDepth < 2
          ? {
              spawnSubagent: (p: string, o?: { role?: string; timeoutMs?: number; scratchpad?: string }) => this.spawnSubagent(p, o),
              spawnSubagents: (tasks: Array<{ prompt: string; role?: string; timeoutMs?: number; scratchpad?: string }>) => this.spawnSubagents(tasks),
            }
          : {}),
      };
      const { output, error } = await executeTool('shell', { command, timeout: 20 }, ctx, this.tools);
      return error ? `Error: ${error}\n${output}` : output;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Called when verification finally passed; finalize the autopsy with the
   *  resolved outcome and write a procedural lesson from the top hypothesis. */
  private recordSuccess(task: Task, repo: ReturnType<typeof detectRepo>): void {
    if (this.autopsy) {
      const confirmed = this.hypotheses.find((h) => h.status === 'confirmed');
      const fixApplied = (this.context['state']?.filesModified ?? []).slice(-1)[0];
      this.autopsy = finalizeAutopsy(this.workspace.dir, this.autopsy, {
        outcome: 'resolved',
        rootCauseHypothesis: confirmed?.id ?? this.hypotheses[this.hypotheses.length - 1]?.id,
        fixApplied,
      });
    }
    if (this.diagnosis && this.hypotheses.length) {
      const top = this.hypotheses[this.hypotheses.length - 1] ?? this.hypotheses[0];
      if (top) {
        recordLesson(this.workspace.dir, {
          id: `${this.diagnosis.kind}:${top.id}`,
          signature: (this.diagnosis.signals[0] ?? this.diagnosis.kind).slice(0, 80),
          kind: this.diagnosis.kind,
          lesson: top.description,
          sourceAutopsy: this.autopsy?.taskId,
        });
      }
    }
  }

  /** Called when verification failed after the retry budget. Capture the
   *  failure as a procedural lesson so the next run in the same workspace
   *  starts with "last time I saw this signature, this approach did not
   *  work". The lesson is the top hypothesis + a short anti-pattern marker
   *  that the model can recognize. */
  private recordFailure(task: Task, summary: string): void {
    if (this.autopsy) {
      this.autopsy = finalizeAutopsy(this.workspace.dir, this.autopsy, { outcome: 'unresolved' });
    }
    if (this.diagnosis && this.diagnosis.hypotheses.length) {
      const top = this.diagnosis.hypotheses[0];
      if (top) {
        const verdict = /PARTIAL|Mutation check: injected logic bug was NOT caught/i.test(summary)
          ? 'weak-verification (string check, not runtime) lets mutations survive; use a real runner'
          : 'verify kept failing across attempts; next time pick a different hypothesis sooner';
        recordLesson(this.workspace.dir, {
          id: `${this.diagnosis.kind}:${top.id}:fail`,
          signature: (this.diagnosis.signals[0] ?? this.diagnosis.kind).slice(0, 80),
          kind: this.diagnosis.kind,
          lesson: `AVOID: ${top.description}. ${verdict}`,
          sourceAutopsy: this.autopsy?.taskId,
        });
      }
    }
  }

  private async runShell(command: string, timeout = 60): Promise<string> {
    const ctx: ToolContext = {
      cwd: this.cwd,
      workspace: this.workspace,
      config: this.config,
      events: this.events,
      agentId: this.id,
    };
    const { output, error } = await executeTool('shell', { command, timeout }, ctx, this.tools);
    return error ? `Error: ${error}\n${output}` : output;
  }

  /** Self-review only pays off when the agent actually changed files this run.
   *  Pure answer/research tasks skip it (nothing to review). */
  /** Gather hygiene findings from tracked diff + untracked new files. Best
   *  effort: any git failure means no findings (never blocks finishing). */
  private async collectHygieneFindings(): Promise<HygieneFinding[]> {
    try {
      let diff = await this.runShell('git diff HEAD --unified=0', 30);
      if (diff.includes('exit_code:') && !diff.includes('exit_code: 0')) {
        // Brand-new repo (no HEAD yet): unstaged tracked diff still works.
        diff = await this.runShell('git diff --unified=0', 30);
      }
      // Fold untracked new files in: their entire content counts as added.
      const others = await this.runShell('git ls-files --others --exclude-standard', 15);
      if (!others.includes('exit_code:') || others.includes('exit_code: 0')) {
        for (const f of others.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 20)) {
          if (!/\.(tsx?|jsx?|mts|cts|mjs|cjs|py|rs|go|java|cs|php|rb)$/i.test(f)) continue;
          try {
            const { readFileSync } = await import('node:fs');
            const content = readFileSync(resolve(this.cwd, f), 'utf8').slice(0, 200_000);
            const nl = String.fromCharCode(10);
            diff += `\n+++ b/${f}\n` + content.split(nl).map((l) => '+' + l).join(nl);
          } catch { /* unreadable: skip file */ }
        }
      }
      return scanDiffForHygiene(diff);
    } catch {
      return []; // no git / shell failure: never block finishing on hygiene infra
    }
  }

  private shouldSelfReview(task: Task): boolean {
    if (!this.fileChanged) return false;
    // Bound the cost: after two review cycles the model is clearly not going
    // to move; stop burning tokens on it.
    return this.selfReviewCount < 2;
  }

  /** One cheap model call reviewing the working diff. Returns nothing when the
   *  change looks clean, else a concrete, actionable problem for the loop to
   *  fix (and re-verify). */
  private async selfReview(task: Task, repo: ReturnType<typeof detectRepo>): Promise<{ issue?: string; tail: string }> {
    try {
      const diff = await this.runShell(`git diff --stat && git diff`, 30);
      if (!diff.trim() || diff.includes('exit_code: 128')) return { tail: 'no diff' };
      const packet = this.context.buildPacket([], task, repo);
      const reviewMsg: ChatMessage[] = [
        ...packet.messages,
        {
          role: 'user',
          content: [
            'Review ONLY the diff below for real correctness problems — not style.',
            'Look specifically for:',
            '1. deleted lines/code that should remain (accidental removal),',
            '2. unused imports/declarations introduced, or dead code left behind,',
            '3. wrong constants / off-by-one / inverted logic vs the task,',
            '4. placeholder "TODO" or debug leftovers committed as the real fix,',
            '5. the change being larger or smaller than the task asked for.',
            'Reply with the single most important real problem (with the file+line),',
            'or reply with exactly NO_ISSUE if the diff is correct.',
            '',
            diff.slice(0, 12_000),
          ].join('\n'),
        },
      ];
      const response = await this.provider.chat(reviewMsg, [], { signal: this.abortSignal });
      const text = (response.content ?? '').trim();
      const tail = text.slice(0, 200);
      // A review only counts as a real problem when it actually cites a
      // concrete defect. Cheap/neutral replies (the model echoing something
      // terse like "done", "ok", "looks clean", or a review that never names a
      // file) must NOT be treated as a blocking issue — doing so re-loops the
      // agent through gatherStream and re-streams the same answer to the TUI
      // ("spams the same message") until the self-review cap trips.
      const mentionsFile = /\b[\w./-]+\.[a-zA-Z0-9]+:\d+/.test(text) || /\b(?:file|line|in)\b/.test(text);
      const neutralNoIssue =
        /^NO_ISSUE$/i.test(text) ||
        /\b(?:no issue|no issues|no problems?|cannot identify|looks (?:correct|good|fine|clean|great|solid)|all good|lgtm|properly implemented|change looks good|diff is correct)\b/i.test(text) ||
        (!mentionsFile && (/^(done|ok|okay|clean|nothing|no problems|no problem|fine|lgtm)\b/i.test(text) || text.length < 40));

      if (neutralNoIssue) {
        return { tail };
      }
      return { issue: text.slice(0, 800), tail };
    } catch {
      return { tail: 'review failed' }; // never block success on review infra
    }
  }

  private emitMessage(role: 'assistant' | 'user' | 'system', content: string) {
    this.events.emit({ type: 'message', role, content, agentId: this.id });
  }

  private finish(task: Task, success: boolean, summary: string, stopReason: AgentStopReason = success ? 'completed' : 'aborted'): AgentResult {
    // Harness-v2 Phase 1: close the lifecycle — emit the final iteration's
    // trace with the run's stop reason (abort/timeout from ANY phase lands
    // here, so the trace records where the run actually stopped).
    this.sm?.enter('finish');
    this.sm?.flush(stopReason);
    this.mcpClose?.();
    this.mcpClose = undefined;
    this.budget?.recordAgentEnd();
    if (success) {
      for (const pattern of this.seenPatterns) {
        this.learning.record(pattern, this.lastStrategy ?? 'unclassified', true);
      }
    }
    const durationMs = Math.round(performance.now() - this.startTime);
    this.events.emit({ type: 'agent:completed', id: this.id, taskId: task.id });
    return {
      success,
      summary,
      filesModified: [...new Set(this.context['state'].filesModified)],
      attempts: this.errors.length + 1,
      tokensUsed: this.tokensUsed,
      durationMs,
      stopReason,
    };
  }
}
