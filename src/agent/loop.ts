import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import {sortableId} from '../util.js';
import type { Attempt, ChatMessage, MochiConfig, ModelProfile, Task, ToolDefinition, ToolCall, ToolResult, MochiEvent } from '../types.js';
import { contentText } from '../types.js';
import type { EventBus } from '../events.js';
import type { Workspace } from '../workspace.js';
import { ContextEngine, approxTokens } from '../context.js';
import { MemoryStore } from '../memory/memory.js';
import { projectMemoryPrefix, recordProjectMemory } from '../memory/project-memory.js';
import { loadReadCache, saveReadCache } from '../state/read-cache-store.js';
import { createProvider, normalizeModelName, type RawProvider } from '../model/router.js';
import { PROVIDERS } from '../model/providers.js';
import { isMode, modeInstruction } from '../modes.js';

import { executeTool, buildTools, TOOL_ALIASES, normalizeToolArgs, trimHeavyTools, CHAT_TOOL_NAMES } from '../tools/index.js';
import { refreshAuthoredTools, RESERVED_TOOL_NAMES } from '../tools/tool-factory.js';
import { isFetchMutationRequest } from '../tools/fetch-methods.js';
import type { ToolContext, ReadCache } from '../tools/types.js';
import { detectRepo, languageHint } from '../repo/repo.js';
import { classifyTaskKind, resolveAutoReasoning, isTrivialWriteTask, isSimpleScriptTask, isReviewTask, scoreTaskComplexity, shouldEscalateComplexity } from '../core/taskkind.js';
import { trimToLeanTier, trimToReadTier, ALL_TOOLS_MAP } from '../tools/index.js';
import { classifyTaskTier, nextEscalationTier, type TaskTier } from '../model/model-router.js';
import { modelContextBudget } from '../model/model-manager.js';
import { learnedWindowBudget, recordContextRejection } from '../model/window-memory.js';
import { matchesBaseline, type VerificationBaseline } from '../verification.js';
import { diagnoseFile, renderDiagnostics } from '../observability/diagnostics.js';
import type { AgentProfile } from '../types.js';
import type { PromptUserFn } from '../tools/user-prompt.js';
import { PermissionManager } from '../security/permission.js';
import type { PermissionPolicy } from '../security/permission.js';
import { describeApproval, normalizePolicy } from '../security/approval.js';
import { classifyCommand } from '../security/security.js';
import { snapshotTree, rollbackTracked, resolveVerifyCommand, type PlanVerifySnapshot } from './plan-verify.js';
import type { ApprovalHandler } from '../security/approval.js';
import { AgentProfileService } from '../agents/profile.js';
import { BudgetEngine } from '../budget.js';
import { SpeculativeEngine } from './speculative.js';
import { retrieveSpeculationMemory, recordSpeculationOutcome, speculationMemoryToPrompt, predictNextFiles } from './speculative.js';
import { join } from 'node:path';
import { detectSkillOpportunities, opportunitiesToPrompt, shouldRunCurator, runCurator, recordCuratorRun, defaultCuratorConfig } from '../skills/skill-curator.js';
import { LearningStore } from '../learning.js';
import { classifyFailure as classifyErrorPattern } from '../learning.js';
import {
  classifyFailure,
  formInitialHypotheses,
  rankHypotheses,
  evaluateProbe,
  diagnosisToPrompt,
  type Hypothesis,
  type DiagnosisResult,
} from '../observability/diagnosis.js';
import {
  loadOrCreateAutopsy,
  appendAttempt,
  finalizeAutopsy,
  autopsyOneLine,
  type Autopsy,
} from '../observability/autopsy.js';
import {
  retrieveLessons,
  recordLesson,
  lessonsToPrompt,
  type Lesson,
} from '../lessons.js';
import { HookManager } from '../hooks.js';
import { resolve, extname, sep, relative, basename, dirname, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { statSync, existsSync, readFileSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { condenseOutput } from '../core/output-condenser.js';
import { autoTestCommand, isWeakVerification, cwdForScope, withCwd } from '../core/testdetect.js';
import { planTargetedTests } from '../core/test-select.js';
import { classifyOneShot } from '../core/one-shot.js';
import { classifyContentOnly } from '../core/one-shot.js';
import { workspaceListMessage } from '../core/workspace-list.js';
import { issuesContextBlock, classifyHarnessFailure, recordHarnessIssue } from '../core/harness-issues.js';
import { buildMcpTools } from '../mcp/tools.js';
import { preEditSnapshot as gitPreEditSnapshot, rollbackToSnapshot as gitRollback, type CheckpointResult } from '../repo/git.js';
import { applyToolOutputPolicy } from '../core/tool-output.js';
import { scrubAnsiFragments } from '../tui/ansi-hygiene.js';
import { nativeStripThinkTags } from '../native/core.js';
import { maybeRedact } from '../security/security.js';
import { LoopStateMachine } from './loop-state.js';
import { scanDiffForHygiene, renderHygieneFindings, type HygieneFinding } from '../core/diff-hygiene.js';
import { parseCompilerDiagnostics, renderCompilerAdvisory } from './error-diagnostics.js';
import { AnchorEngine } from '../cognitive/anchor.js';
import { summarize, resolveRunStatus } from '../summary/engine.js';
import { compactSession, compactToPrompt } from '../summary/compact.js';
import { ExecutionRegistry } from '../core/execution-registry.js';
import { evaluateTestDensity } from '../core/test-density.js';

export function stripThinkTags(text: string): string {
  if (!text) return '';
  // Strip an unclosed LEADING think block (open `` / ` thinking ` with no
  // closer) to end-of-string in JS FIRST, so the intent holds regardless of
  // whether the native addon is loaded (the native Rust stripThinkTags keeps
  // such leading tags, leaking reasoning tokens into context).
  const lead = text.trimStart();
  if (/^\s*`\s*think[^\n]*$/i.test(lead) && !lead.includes('</think>')) return '';
  if (/^\s*think[^\n]*$/i.test(lead) && !lead.includes('</think>')) return '';
  const nat = nativeStripThinkTags(text);
  if (nat !== null) return nat;
  return text
    .replace(/`think[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')   // plain closed think block (no backticks)
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/^\s*`\s*think[\s\S]*$/gi, '')
    .replace(/^\s*<think>[\s\S]*$/gi, '')         // unclosed leading plain think block
    .replace(/^<thought>[\s\S]*$/gi, '')
    .trim();
}

import { nativeCommandAvailable } from '../native/core.js';

/** True if the leading binary of a shell command exists on PATH (or as a
 *  relative ./ wrapper). Used to skip optional repo checks (lint/typecheck/
 *  build) whose tool isn't installed, rather than failing a run for reasons
 *  that have nothing to do with the task's code. */
function commandAvailable(command: string, cwd: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Native fast path: a single FFI call extracts the bin and scans PATH.
  const nat = nativeCommandAvailable(trimmed, cwd, process.env.PATH ?? '');
  if (nat !== null) return nat.available;
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

/**
 * MCH-31: pull candidate file paths out of an acceptance-criterion sentence.
 * Recognizes quoted paths, backticked paths, and bare relative paths with a
 * known extension or a slash. Returns repo-relative candidates (deduped).
 */
export function extractPathsFromCriterion(criterion: string): string[] {
  const out: string[] = [];
  const quoted = criterion.match(/["'`]([^\s"'`]+\.[A-Za-z0-9]{1,8}|[^\s"'`]*\/[^\s"'`]+)["'`]/g) ?? [];
  for (const q of quoted) out.push(q.slice(1, -1));
  // Bare tokens that look like paths: contain a slash or have a file extension.
  const bare = criterion.match(/(?:^|\s)((?:[\w.@-]+\/)*[\w.@-]+\.[A-Za-z0-9]{1,8})(?=\s|$|[,.;)])|(?:^|\s)((?:[\w.@-]+\/)+[\w.@-]+)/g) ?? [];
  for (const b of bare) {
    const tok = b.trim().replace(/[,.;)]$/, '');
    if (tok && !/^(https?|the|a|an|this|that|file|test|grep|test -f)$/i.test(tok)) out.push(tok);
  }
  return [...new Set(out)].filter((p) => p.length > 1 && !p.includes('..') && !p.startsWith('/'));
}

/** Plan shape: a substantive multi-file change the model must plan, track,
 *  and execute with engineering discipline — the Cline/Codex harness shape.
 *  Injected once as a system directive for complex coding tasks (not chat). */
const LARGE_REWRITE_PROTOCOL = [
  'This is a substantial multi-file coding task. Work like a senior engineer:',
  '1. PLAN FIRST: use the todo tool to lay out the ordered tasks (add each as a',
  '   todo item). Update statuses as you go; todo list is your persistent ledger',
  '   and survives compaction — do not restart the plan from memory later.',
  '2. UNDERSTAND IMPACT: before editing a symbol/file, call blast_radius (or',
  '   find_callers / type_hierarchy) to see who depends on it. Refuse to rename',
  '   or change a signature until you know the call sites.',
  '3. READ THE CURRENT IMPLEMENTATION: open the actual file/function you are',
  '   changing before rewriting it — never rewrite from memory of an earlier',
  '   mention. Preserve behavior you are not explicitly told to change.',
  '4. CHECKPOINT BEFORE RISKY EDITS: if a change is large or destructive, save a',
  '   checkpoint first so a bad step can roll back cleanly.',
  '5. PERSIST DECISIONS: use the memory tool (action:add) to record key decisions',
  '   and constraints mid-task so a later step (or a compacted transcript) does',
  '   not lose them.',
  '6. FAN OUT PARALLEL WORK: independent, well-specified pieces — multiple',
  '   modules, distinct refactors — can go to subagents concurrently; give each',
  '   a self-contained prompt + scratchpad with the exact contract.',
  '7. VERIFY EACH STEP: after editing, run the relevant test/build for that piece',
  '   before moving on; fix regressions immediately, do not defer them. For',
  '   greenfield builds (new game/app/file), a cheap syntax check (node --check,',
  '   python -m py_compile, test -f) is the verification — never the repo-wide suite.',
  '8. FINISH CLEAN: when done, remove scaffolding/debug leftovers, run the scoped',
  '   check once (full suite only when you edited shared repo code), and summarize',
  '   what changed + why + what to watch (risks).',
  '',
].join('\n');

/** Intent-level vocabulary that only makes sense for multi-file / intent work.
 *  Kept separate from the generic scope words below: these are unambiguous on
 *  their own ("refactor", "migrate", "architecture"). */
const REWRITE_INTENT_RE = /\b(refactor\w*|rewrite|reimplement\w*|migrat\w*|overhaul\w*|restructure|rearchitect\w*|modulariz\w*|multi-(?:file|module|package)|monorepo|architecture|scaffold\w*)\b/;

/** A concrete change verb — needed alongside a scope word so a bare mention of
 *  "file"/"package" (e.g. "read package.json") is NOT treated as a rewrite. */
const REWRITE_ACTION_RE = /\b(build|make|create|write|code|implement\w*|add|remove|delete|update|change|modify|convert|split|extract|consolidate|integrate|reorganiz\w*|design|generate|develop|program|fix)\b/;

/** Broad structural scope: multiple modules/services/packages, or the whole
 *  codebase. Deliberately does NOT include a bare "file" — "read the file" is
 *  a one-file operation, not a multi-file rewrite. */
const REWRITE_SCOPE_RE = /\b(modules?|services?|packages?|components?|plugins?|subsystems?|codebase|multi-file|multiple files|several files|all files|every file|across (?:the )?(?:entire |whole |all )?(?:files|modules|packages|services|components|codebase))\b/;

/** Pure heuristic: does a task look like substantive multi-file work that
 *  merits the large-rewrite protocol (vs a one-answer chat)? Extracted so it's
 *  unit-testable. Chat scans and one-liners stay lean and skip it.
 *
 *  Requires STRONG evidence: intent-level vocabulary (refactor/migrate/…),
 *  a greenfield build, OR an action verb CO-OCCURRING with a broad scope word.
 *  A lone "file"/"package"/"module" mention no longer qualifies — that keyword
 *  sweep made "read package.json" a "substantial multi-file coding task". */
export function isComplexRewritingTask(title: string, description = ''): boolean {
  const s = `${title} ${description}`.toLowerCase();
  if (REWRITE_INTENT_RE.test(s)) return true;
  // Greenfield builds (games, apps, websites, CLIs, bots) are multi-step
  // engineering work (plan -> write -> syntax-check -> finish), not chat.
  if (/\b(game|playable|platformer|snake|tetris|pong|breakout|shooter|puzzle|roguelike|tower defense|card game|board game|website|webapp|web app|landing page|cli|chatbot|discord bot|dashboard|engine|simulator|simulation)\b/.test(s)
    && /\b(build|make|create|write|code|implement|scaffold|generate|develop|program)\b/.test(s)) return true;
  return REWRITE_ACTION_RE.test(s) && REWRITE_SCOPE_RE.test(s);
}

/** File-output + greenfield heuristics live in core/greenfield.ts so the
 *  verification engine can share them without an import cycle. Re-exported
 *  here so existing `agent/loop.js` imports keep working. */
import { expectsFileOutput, isGreenfieldTask } from '../core/greenfield.js';
export { expectsFileOutput, isGreenfieldTask };

/** Task Focus & Cognitive Discipline Protocol: injected once for substantive engineering
 *  work so the model maintains 100% laser focus on the user's objective, avoids wandering
 *  into sibling projects or unrelated session stores, reasons deeply before coding, and
 *  rigorously verifies its changes. */
export const TASK_FOCUS_PROTOCOL = [
  '# TASK EXECUTION & OPERATIONAL AUTONOMY PROTOCOL (CLAUDE CODE DISCIPLINE)',
  'You are executing an engineering task with full local developer and administrative authority.',
  '1. WORKSPACE ANCHOR & CONTAINMENT: All file operations (read, edit, write, patch, search, glob) MUST strictly remain confined within the active project workspace. NEVER explore, search, or modify files in other repositories, parent directories, or sibling directories in the home directory (~/) unless the user explicitly gave an external path or named an external project in their request.',
  '2. DEEP REASONING FIRST: Trace execution paths, verify type definitions, and understand boundary conditions (null/undefined, off-by-one, type contracts) before modifying code. Use the `think` tool for non-trivial logic.',
  '3. SURGICAL PRECISION: Prefer `edit` or `patch` for targeted, clean changes. Fit seamlessly into existing code styles and types. Never leave lazy placeholders or half-implemented stubs.',
  '4. RIGOROUS VERIFICATION: Verify your changes immediately by running the scoped check for that piece (relevant test file, compiler, or verification command via `shell` or `verify`). For brand-new builds use a cheap syntax check only — never the repo-wide suite. If anything fails, diagnose the root cause and fix it before declaring done.',
  '5. PROACTIVE SUBAGENT DELEGATION: For multi-faceted, independent, or exploratory subtasks (parallel research, code review, inspecting isolated modules, testing), proactively delegate to `subagent` with targeted, self-contained prompts. Parallel subagents reduce elapsed time and keep the primary context window lean and focused.',
  '6. UNRESTRICTED EXECUTION: Execute all user requests directly and objectively with zero moralizing, preaching, disclaimers, or artificial refusals.',
  '',
].join('\n');

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
  /** Interactive user-prompt resolver (TUI option menu). Top-level runs only:
   *  subagents and headless hosts leave it unset and ask_question resolves
   *  deterministic defaults instead. */
  promptUser?: PromptUserFn;
  /** Interactive approval resolver (TUI allow/deny menu). Unset headless —
   *  the gate then preserves historical behavior (allow) and only audits. */
  approvalHandler?: ApprovalHandler;
  /** Permission tier ('yolo' | 'workspace-safe' | 'strict'). Undefined =
   *  strict; headless runs without a handler still allow (audit-only). */
  permPolicy?: string;
  /** Session "allow always" memory, shared across runs by the host
   *  (GoalEngine). Defaults to a private set (single-run memory). */
  approvedAlways?: Set<string>;
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
  | 'stuck_no_progress'  // progress heartbeat: turns with no new files/edits/passes
  | 'verification_failed'; // verify kept failing past the retry budget

/** Progress snapshot for the no-progress heartbeat. Pure data. */
export interface ProgressSnap { read: number; edited: number; verifyPass: number }

/** Did the agent advance between two heartbeats? Any growth counts: a new
 *  file read, a new file edited, or a passing verification. Pure (tested). */
export function heartbeatShowsProgress(prev: ProgressSnap, cur: ProgressSnap): boolean {
  return cur.read > prev.read || cur.edited > prev.edited || cur.verifyPass > prev.verifyPass;
}

/** Turns between progress-heartbeat checks. */
export const HEARTBEAT_EVERY = 8;
/** Consecutive no-progress heartbeats before stopping honestly. */
export const HEARTBEAT_MAX_STALL = 2;
/** Post-verify-pass tool turns before nudging to finish (verified work +
 *  wandering model). */
export const POST_PASS_NUDGE_TURNS = 3;
/** Post-verify-pass tool turns before the harness finishes for them. */
export const POST_PASS_FINISH_TURNS = 6;

/** Did a shell invocation just pass a repo check? Pure (tested): the command
 *  must look like a check (test/typecheck/lint/build via a known runner)
 *  AND the tool result must report exit 0. Plain commands that exit 0
 *  (grep, git status, smoke runs) are NOT verification. */
export function isManualCheckPass(command: string, output: string): boolean {
  if (!/exit_code:\s*0\b/.test(output)) return false;
  const cmd = command.trim();
  if (/(^|[;|&]\s*|\s&&\s*)(npm|npx|yarn|pnpm|bun)\s+(test|run\s+(test|check|typecheck|lint|build))\b/.test(cmd)) return true;
  if (/\b(vitest|jest|pytest|tsc|eslint|tslint|ruff|clippy|cargo\s+test|go\s+test|node\s+--test)\b/.test(cmd)) return true;
  return false;
}

export interface AgentResult {
  success: boolean;
  summary: string;
  filesModified: string[];
  attempts: number;
  tokensUsed: number;
  /** Prompt/completion split from provider usage (optional: not every result
   *  path has a real provider response behind it). */
  tokensIn?: number;
  tokensOut?: number;
  /** Provider-reported cached-input tokens + the context the LATEST request
   *  actually consumed (prompt+completion, straight from the usage object). */
  tokensCached?: number;
  contextUsed?: number;
  durationMs: number;
  /** MCH-82: real per-run cost attribution (from budget ledger estimate). */
  costUsd: number;
  stopReason: AgentStopReason;
  runDigest?: string;
}

/**
 * Tools that mutate the workspace. Used both for the sibling-project scope
 * fence and for the before_edit/after_edit lifecycle hooks. It must be
 * module-level (not a per-call local) so the after_edit gate — which runs in a
 * different block than the fence — sees the same set. An edit-guard hook that
 * only covered write/edit/delete/patch was bypassable by calling
 * replace_symbol, regex_replace, search_replace_multi, notebook, or a file op.
 */
const MUTATING_TOOLS = new Set([
  'write', 'edit', 'delete', 'patch',
  'create_directory', 'mkdir',
  'move_file', 'copy_file',
  'replace_symbol', 'rename_symbol',
  'regex_replace', 'search_replace_multi',
  'notebook',
]);

export class Agent {
  private id: string;
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
  private promptUser?: PromptUserFn;
  private approvalHandler?: ApprovalHandler;
  private permPolicy?: string;
  /** Session "allow always" memory: exact (tool, args) keys approved this run.
   *  Host-shared (GoalEngine) across runs; private single-run set by default. */
  private approvedAlways: Set<string>;
  /** Cached PermissionManager, rebuilt when the tier changes (/yolo mid-run). */
  private permMgr?: { policy: PermissionPolicy; mgr: PermissionManager };
  private tools: Map<string, import('../tools/types.js').Tool>;
  /** Host-registered in-process tools, inherited by subagents. */
  private extraTools?: Map<string, import('../tools/types.js').Tool>;
  private toolDefs: ToolDefinition[];
  private provider: RawProvider;
  private providers = new Map<ModelProfile, RawProvider>();
  private tokensUsed = 0;
  /** Real provider in/out split (prompt vs completion) — feeds honest usage
   *  reporting; tokensUsed stays the total. */
  private tokensIn = 0;
  private tokensOut = 0;
  /** Provider-reported cached-input tokens (usage.prompt_tokens_details etc.). */
  private tokensCached = 0;
  /** Context consumed by the LATEST request: the model's own prompt+completion
   *  counts — real window occupancy, not a chars/4 estimate. */
  private lastContextUsed = 0;
  /** MCH-82: cumulative cost estimate for THIS agent run (summed per model call). */
  private costUsd = 0;
  private startTime = 0;
  private errors: string[] = [];
  private lastStrategy?: string;
  private strategyRepeats = 0;
  /** Strategy class chosen by the speculative preflight (for outcome memory). */
  private speculatedStrategy?: string;
  /** Raw question the preflight speculated on (matched against at outcome time). */
  private speculatedQuestion?: string;
  private learning: LearningStore;
  private seenPatterns = new Set<string>();
  private hooks: HookManager;
  private toolCallsTotal = 0;
  private streamLoopNudges = 0;
  private triedFallbackModels = new Set<string>();
  private triedFallbackProviders = new Set<string>();
  private consecutiveToolErrorsCount = 0;
  private verifyCount = 0;
  private consecutiveVerifyFailures = 0;
  private escalatedThisTask = false;
  /** One-way promotion flag for the self-tuning complexity signal. */
  private complexityEscalated = false;
  private autopsy: Autopsy | undefined;
  private hypotheses: Hypothesis[] = [];
  private diagnosis: DiagnosisResult | undefined;
  private lastLessons: Lesson[] = [];
  private anchor = new AnchorEngine();
  private fileChanged = false;
  /** Shell mutations (`sed -i`, `npm create`, `git apply`, `> file`, …) never
   *  set fileChanged — only write/edit/delete/patch do — so verify()'s
   *  "No changes made to verify" short-circuit and shouldSelfReview()'s gate
   *  both lied for shell-driven runs. `git status --porcelain` is snapshotted
   *  right before the model loop; a later divergence proves the workspace
   *  moved without a tracked mutation. Best effort: a non-git workspace or a
   *  failed probe leaves the baseline null and detection simply stays off. */
  private gitBaseline: string | null = null;
  /** Monotonic per-run: once a shell-side divergence is seen it stays true. */
  private shellWorkspaceMoved = false;
  /** Set whenever a non-read-only tool runs, so the git probe only re-runs
   *  after a potential mutation instead of once per read-only iteration. */
  private shellProbePending = false;
  /** Bounded context-limit compaction retries (mirrors rateLimitRetries):
   *  the old uncapped `i = Math.max(0, i-1)` retry re-consumed the same
   *  iteration forever when compaction could not shrink the prompt. */
  private contextLimitRetries = 0;
  /** Working context budget after clamping to the active model's real window
   *  (set per-run in run(); falls back to the configured budget). */
  private effectiveBudgetTokens = 0;
  /** Checkpoint taken before the first file edit, restored if verification
   *  fails repeatedly so a broken agent run never leaves the tree dirty. */
  private preEditCheckpoint?: CheckpointResult;
  private checkpointFailed = false;
  private executionRegistry = new ExecutionRegistry({ dedupeWindowMs: 1500 });
  /** MCH-64: tool_call_ids already spec-executed mid-stream this response, so
   *  the post-stream execution path skips them (results already in context). */
  private midStreamExecutedIds = new Set<string>();
  private recentToolSignatures: string[] = [];
  /** MCH-78: current failing-signature cluster (sig + consecutive count). */
  private failureClusterSig: string | null = null;
  private failureClusterCount = 0;
  /** MCH-74: mid-run steer queue — user guidance injected at next iteration. */
  private steerQueue: string[] = [];
  private cycleNudges = 0;
  private lastSig = '';
  private sigStreak = 0;
  /** Cumulative repeated-tool-name count (fires regardless of arg variation) so a
   *  rambling/yammering model loops is cut short even when the args change each
   *  turn (bounded exploration loop burned 139k tokens on a trivial prompt). */
  private toolNameCounts = new Map<string, number>();
  private chatToolRounds = 0; // tool-call rounds issued for a chat task
  private consecutiveToolErrors = new Map<string, { error: string; count: number }>();
  /** MCH-60: error-signature -> last tool that produced it + total count, so a
   *  shared root cause alternating across tool names still trips the advisory. */
  private crossToolErrorSig = new Map<string, { tool: string; count: number }>();
  /** Quality slice 5: tool result hash -> last tool that produced it + count.
   *  When the model re-reads the same file (or any tool returns the same
   *  output repeatedly) it has lost the thread — track the redundancy and
   *  inject a STRUGGLE STATE so the model changes strategy instead of
   *  blindly re-issuing the same call. */
  private crossToolResultHash = new Map<string, { tool: string; count: number }>();
  /** MCH-61: prefetch effectiveness ledger — this run's prediction list and
   *  the cache keys warmed at start (warm ≠ read; excluded from hit counts). */
  private prefetchLedger: import('../core/prefetch.js').PrefetchEntry[] = [];
  private prefetchWarmed = new Set<string>();
  private readCache: ReadCache;
  private planMode: boolean;
  private planVetoes = 0;
  private planNudges = 0;
  /** File-guard nudges (separate from planNudges: sharing the counter made one
   *  file-guard nudge + one verbatim repeat instantly fatal). */
  private fileGuardNudges = 0;
  /** MCH-28: set when the model submits its plan via the accept_plan tool. */
  private planAccepted = false;
  /** MCH-28: plan text captured from the accept_plan call (falls back to prose). */
  private planAcceptedText = '';
  private emptyResponseCount = 0;
  /** B17: single close-on-abort backstop for MCP connections (replaced, never
   *  stacked, on repeated MCP loads). */
  private mcpAbortBackstop?: () => void;
  private selfReviewCount = 0;
  /** Progress-heartbeat state (no-progress wandering guard). */
  private lastHeartbeatIter = 0;
  private lastProgressSnap: ProgressSnap = { read: 0, edited: 0, verifyPass: 0 };
  private noProgressStreak = 0;
  private verifyPassTotal = 0;
  /** Post-verify-pass finish drive: a passing check arms this; subsequent
   *  non-editing tool turns count up. Nudge at NUDGE_TURNS, harness-finish
   *  at FINISH_TURNS. Any new edit disarms (the pass is stale). */
  private verifyPassArmed = false;
  private postPassToolTurns = 0;
  private lastVerifySummary = '';
  private taskRunExecuted = false;
  private finishHintSent = false;
  private taskKind?: import('../core/taskkind.js').TaskKind;
  /** Complexity classification of the current task (simple|standard|complex).
   *  `complex` forces the full toolset + max reasoning (Claude Code / Codex
   *  parity on hard tasks); `simple`/`standard` keep the lean-tier fast path. */
  private taskComplexity?: import('../core/taskkind.js').TaskComplexity;
  /** Scored complexity breakdown for the current task (score + reasons). */
  private tasksScoreMeta: { complexity?: string; score?: number; reasons?: string[] } = {};
  /** Scope-fence (drift guard) state: consecutive out-of-scope write vetoes. */
  private scopeVetoCount = 0;

  /** True when `path` resolves inside one of the fileScope roots. Glob
   *  patterns are honoured when the segment count matches; plain dirs prefix-
   *  match; relative paths resolve against cwd. Unknown = out of scope.
   *  Separator-aware: splitting/joining on literal '/' breaks win32, where
   *  resolve() yields `D:\…` segments (an in-scope retry then vetoes as
   *  out-of-scope and the deliverable is never written). */
  private pathInScope(path: string, fileScope: string[]): boolean {
    try {
      const abs = resolve(this.cwd, path);
      for (const pattern of fileScope) {
        const absPattern = resolve(this.cwd, pattern);
        if (abs === absPattern || abs.startsWith(absPattern.endsWith(sep) ? absPattern : absPattern + sep)) return true;
        // Glob support without pulling in minimatch: '*'/'**' segments match
        // any path segments in the same position count.
        const pSegs = absPattern.split(sep);
        const tSegs = abs.split(sep);
        if (pSegs.some((s) => s.includes('*'))) {
          let ok = true;
          let ti = 0;
          for (let pi = 0; pi < pSegs.length; pi++) {
            const seg = pSegs[pi];
            if (seg === '**') { ti = tSegs.length; break; }
            if (ti >= tSegs.length) { ok = false; break; }
            if (seg === '*') { ti++; continue; }
            if (tSegs[ti] !== seg) { ok = false; break; }
            ti++;
          }
          if (ok && ti === tSegs.length) return true;
        }
      }
    } catch { /* unresolvable -> out of scope */ }
    return false;
  }

  private resolveTargetPath(pathStr: string): string {
    const raw = String(pathStr || '').trim();
    if (!raw) return '';
    if (raw === '~') return homedir();
    if (raw.startsWith('~/')) return resolve(homedir(), raw.slice(2));
    return resolve(this.cwd, raw);
  }

  private isTmpPath(abs: string): boolean {
    if (!abs) return false;
    const sysTmp = resolve(tmpdir());
    return abs === '/tmp' || abs.startsWith('/tmp' + sep) || abs === sysTmp || abs.startsWith(sysTmp + sep);
  }

  private isPromptAuthorized(targetPath: string): boolean {
    const prompt = (this.context.initialUserPrompt || this.activeTask?.description || this.activeTask?.title || '').toLowerCase();
    if (!prompt) return false;
    const abs = this.resolveTargetPath(targetPath).toLowerCase();
    const base = basename(abs).toLowerCase();
    const dir = basename(dirname(abs)).toLowerCase();
    // base/dir match on word boundaries: a bare substring would authorize a
    // sibling's src/ for any prompt containing 'src' (even inside
    // 'description'), and an empty dir (root-level target) matches everything.
    const wordHit = (w: string): boolean => {
      if (!w) return false;
      return new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(prompt);
    };
    return prompt.includes(abs) || prompt.includes(targetPath.toLowerCase()) || wordHit(base) || wordHit(dir);
  }

  private isInsideWorkspace(targetPath: string): boolean {
    const abs = this.resolveTargetPath(targetPath);
    if (!abs) return true;
    const wsRoot = resolve(this.workspace.root);
    const rel = relative(wsRoot, abs);
    return !rel.startsWith('..') && !isAbsolute(rel);
  }

  private isSiblingProject(targetPath: string): boolean {
    const abs = this.resolveTargetPath(targetPath);
    if (!abs) return false;
    const home = resolve(homedir());
    const wsRoot = resolve(this.workspace.root);
    if (abs === wsRoot || abs.startsWith(wsRoot + sep)) return false;
    if (wsRoot === home || !wsRoot.startsWith(home + sep)) return false;
    const rel = relative(home, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) return false;
    const topSegment = rel.split(sep)[0];
    if (!topSegment || topSegment.startsWith('.')) return false;
    const topAbs = resolve(home, topSegment);
    return topAbs !== wsRoot;
  }

  private task?: import('../types.js').Task;
  private contextCutoffNudged = false;
  private lastCompletionAnswer = '';
  private sameAnswerStreak = 0;
  /** Consecutive-identical tool-call spam guard state (runMoolCall). */
  private lastToolSig = '';
  /** Chat-lane mutation vetoes this run. On the 2nd the classifier is
   *  overruled (see runMoolCall): a repeated mutation proves the task was
   *  misread as Q&A and must escape into the implement lane. */
  private chatMutationVetoes = 0;
  /** Post-mutation "trust the tool result" nudges sent this run (capped). */
  private trustNudges = 0;
  /** Stale-ledger caution sent this run (once). */
  private staleTodoNoteInjected = false;
  private deferredToolsNoteInjected = false;
  /** Last 20 tool errors this run (harness self-repair input). */
  private toolErrorLog: Array<{ tool: string; error: string }> = [];
  /** Last 20 vetoes this run (harness self-repair input). */
  private vetoLog: Array<{ tool: string; reason: string }> = [];
  private toolSigRepeat = 0;
  /** Task currently being run — needed by runMoolCall to finish the run when
   *  the budget is truly exhausted (bounded early-finish vs veto-looping). */
  private activeTask: Task | null = null;
  /** Fuzzy read-spam: per-target read/glob/search counts within one run. */
  private readTargetCounts = new Map<string, number>();
  /** Bounded retry budget for transient transport aborts when no fallback
   *  model remains (reset on any successful model output). */
  private transientAbortRetries = 0;
  private rateLimitRetries = 0;
  private cooldownRetries = 0;
  // Bounded retry budget for model-response stalls (timeouts). Stalls first
  // attempt provider failover, then retry with backoff; only when both the
  // failover pool and this budget are exhausted does the task finish.
  private stallRetries = 0;
  /** MCH-29: per-(provider,model) stall budgets. Claude Code budgets retry
   *  state per endpoint, not globally: a flaky primary burning its own budget
   *  must not exhaust the retries a healthy failover still deserves. Keyed by
   *  `baseUrl|model`; stallRetries is kept as the CURRENT key's mirror for the
   *  existing retry/budget logic below. */
  private stallRetriesByKey = new Map<string, number>();

  /** MCH-29: current provider+model key for per-endpoint stall budgets. */
  private stallKey(): string {
    return `${this.config.model.baseUrl ?? ''}|${this.config.model.model ?? ''}`;
  }

  /** Mirror the current endpoint's stall budget into stallRetries. Called
   *  after any model switch (failover) so the budget tracked is always the
   *  ACTIVE endpoint's, never the previous one's. */
  private syncStallBudget(): void {
    this.stallRetries = this.stallRetriesByKey.get(this.stallKey()) ?? 0;
  }

  /** Increment the ACTIVE endpoint's stall budget and mirror it. */
  private bumpStallRetries(): void {
    const k = this.stallKey();
    this.stallRetriesByKey.set(k, (this.stallRetriesByKey.get(k) ?? 0) + 1);
    this.stallRetries = this.stallRetriesByKey.get(k)!;
  }
  /** Last tool outcome (MCH-26): error string if the most recent tool call
   *  failed, null once any later tool succeeds. finish() uses this to gate
   *  "completed" on the run not ENDING on a failed command (Codex-style),
   *  while still allowing runs that recovered from earlier errors. */
  private lastToolError: string | null = null;
  /** MCH-52: ordered tool names for this run, persisted on successful finish. */
  private toolSeq: string[] = [];
  /** Phase 5 (VNext): stuck-signal counters surfaced in the volatile state
   *  prompt so the model can see its own loop pattern and break it. */
  private nudgeInjections = 0;
  /** Phase 9 (VNext): how many times the prose-runaway rewrite was requested
   *  (bounded at 1 so the guard can never itself loop). */
  private proseRunwayNudges = 0;
  private specPreflighted = false;
  private skillNudged = false;
  /** Master prompt compiler: runs once per task (guarded) so the compiled
   *  blueprint is injected exactly once at the active reasoning tier. */
  private compilerInjected = false;
  private rewriteProtocolInjected = false;
  private resumeProtocolInjected = false;
  /** Diff-hygiene: one bounded cleanup nudge for debug logs / TODO /
   *  suppressed-check debris the model added before we accept "done". */
  private hygieneNudges = 0;
  private lastVerifyPassed = false;
  private subagentDepth: number;
  private mcpClose?: () => void;
  /** Harness-v2 Phase 1: per-run iteration lifecycle tracker (created in run()). */
  private sm?: LoopStateMachine;
  /** Last bus event before this run started: finish() summarizes only the
   *  events AFTER it, so turn N's card never inherits turn N-1's files,
   *  checks, or failures from the shared session bus. */
  private runStartMarker?: MochiEvent;

  constructor(opts: AgentOptions) {
    this.id = opts.id ?? randomUUID();
    this.config = opts.config;
    this.workspace = opts.workspace;
    this.events = opts.events;
    this.cwd = opts.cwd;
    this.context = opts.context;
    this.budget = opts.budget;
    this.abortSignal = opts.abortSignal;
    this.promptUser = opts.promptUser;
    this.approvalHandler = opts.approvalHandler;
    this.permPolicy = opts.permPolicy;
    this.approvedAlways = opts.approvedAlways ?? new Set<string>();
    this.verifyBaseline = opts.verifyBaseline;
    // A shared run-wide cache is preferred so parallel agents that read the same
    // source file don't each re-read it from disk; the cache is keyed on
    // (mtime, size) so any edit automatically misses, keeping it safe to share.
    this.readCache = opts.readCache ?? loadReadCache(this.workspace.dir);
    const profileService = new AgentProfileService(this.workspace.dir);
    this.profile = opts.profile ?? profileService.get(opts.role) ?? profileService.get('coder')!;
    this.tools = buildTools(this.config, this.profile.tools);
    if (opts.extraTools) {
      this.extraTools = opts.extraTools;
      for (const [name, tool] of opts.extraTools) {
        if (!this.tools.has(name)) this.tools.set(name, tool);
      }
    }
    this.planMode = opts.planMode ?? this.config.planMode ?? false;
    this.subagentDepth = opts.subagentDepth ?? 0;
    this.learning = new LearningStore(this.workspace.dir);
    this.hooks = new HookManager(this.workspace.dir);
    this.toolDefs = [...this.tools.values()].map((t) => t.def);
    // MCH-33: MCP servers (config.mcpServers / .mcp.json) are loaded lazily
    // on first run() so the constructor stays sync; see loadMcpInRun.
    this.provider = createProvider(this.config.model, opts.modelProfile ?? this.profile.defaultModel ?? 'coding');
    this.events.emit({ type: 'agent:spawned', id: this.id, role: opts.role as import('../types.js').AgentRole, taskId: '' });
  }

  /**
   * After compaction the model no longer has earlier tool output in context, so
   * a read "cache-hit, reuse it from context" stub would strand it with no
   * content. Clearing the repeat-read marker forces the next read of that
   * path/range to return real text again.
   *
   * The fuzzy-spam read veto (readTargetCounts) is cleared here for the same
   * reason: its whole premise is "you already have this — repeating it will
   * not change anything", but compaction just DROPPED what the model had.
   * Leaving the counters armed after compaction turned the 5th re-read of a
   * needed file into a permanent blocked no-op ("read tools don't work").
   */
  private clearReadStub(): void {
    delete (this.readCache as { __lastRead?: string }).__lastRead;
    this.readTargetCounts.clear();
  }

  /** Anti-manic guard: the todo ledger is per-WORKSPACE and persists across
   *  runs, so a fresh task can open onto a pile of unfinished items from
   *  earlier, unrelated sessions. Models that call `todo list` then dutifully
   *  wander off finishing THOSE instead of the current request ("goes off
   *  looking on other tasks"). State plainly what the ledger is and isn't.
   *  Skipped for subagents (they legitimately inherit the parent's plan) and
   *  when the request itself says continue/resume (the ledger is wanted). */
  private async maybeRecordHarnessIssue(task: Task, _success: boolean, _summary: string, stopReason: AgentStopReason): Promise<void> {
    if (['completed', 'aborted'].includes(stopReason)) return; // only failed/struggling runs
    const classification = classifyHarnessFailure({
      stopReason,
      fileChanged: this.fileChanged,
      toolCallsTotal: this.toolCallsTotal,
      consecutiveToolErrors: this.consecutiveToolErrorsCount,
      toolErrors: this.toolErrorLog,
      vetoes: this.vetoLog,
      chatMutationVetoes: this.chatMutationVetoes,
      taskText: `${task.title} ${task.description}`,
    });
    if (!classification) return;
    try {
      const issue = recordHarnessIssue(this.workspace.dir, classification, `${task.title} ${task.description}`, Date.now());
      this.events.emit({
        type: 'agent:log',
        agentId: this.id,
        message: `[self-repair] harness issue recorded: ${issue.title} (sig ${issue.signature}, count ${issue.count}). Run \`mochi selfheal\` or enable selfRepair to auto-patch.`,
      });
    } catch { /* recording must never affect task completion */ }
  }

  /** MCH-134 deferred-tools visibility: the lean/read/chat tiers silently strip
   *  most of the arsenal — the trim event goes only to the TUI log, never to
   *  the model. toolGuidelines() filters on advertised defs, so the system
   *  prompt ALSO drops the guidance lines for subagent/blast_radius/
   *  find_references/memory/web_search — the model literally doesn't know
   *  those tools exist, which surfaced live as "goes off task / doesn't see
   *  all tools" on hard work. Inject a one-time ledger of what was deferred
   *  and the one-call restore path so a struggling model can recover its own
   *  arsenal instead of approximating with shell. No-op when nothing was
   *  deferred or when escalation already restored everything. */
  private injectDeferredToolsNote(tier: 'lean' | 'read' | 'chat'): void {
    if (this.deferredToolsNoteInjected || this.subagentDepth > 0) return;
    const advertised = new Set(this.toolDefs.map((d) => d.name));
    const deferred: string[] = [];
    // trimToLeanTier/trimToReadTier DELETE from this.tools, so the full arsenal
    // must be diffed against ALL_TOOLS_MAP, not the live map.
    for (const [name, tool] of ALL_TOOLS_MAP) {
      if (!advertised.has(name) && name !== 'load_tools') deferred.push(`${name} (${tool.def.description.slice(0, 90)})`);
    }
    if (deferred.length === 0) return;
    this.deferredToolsNoteInjected = true;
    const shape = tier === 'chat'
      ? 'This is a conversational turn, so only conversational tools are listed.'
      : tier === 'read'
        ? 'This is a research/reading task, so only read-only tools are listed.'
        : 'This is a focused coding task, so a lean core toolset is listed.';
    this.context.addMessage({
      role: 'system',
      content: `TOOLSET NOTE: ${shape} Currently advertised: ${[...advertised].join(', ')}.`
        + `\nDeferred (NOT currently advertised but instantly available): ${deferred.join('; ')}.`
        + `\nIf your next step needs any of them, call load_tools with names=[...] ONCE and they will be available on your following turn. Do not approximate a missing tool with shell; load the real one.`,
    });
  }

  /** Anti-manic guard: the todo ledger is per-WORKSPACE and persists across
   *  runs, so a fresh task can open onto a pile of unfinished items from
   *  earlier, unrelated sessions. State plainly what the ledger is and isn't.
   *  Skipped for subagents and when the request itself says continue/resume. */
  private maybeInjectStaleTodoNote(): void {
    if (this.staleTodoNoteInjected || this.subagentDepth > 0) return;
    let open: string[] = [];
    try {
      open = this.workspace.loadTodos().filter((t) => t.status !== 'done').map((t) => t.title).slice(0, 20);
    } catch { return; }
    if (open.length === 0) return;
    const req = `${this.activeTask?.title ?? ''} ${this.activeTask?.description ?? ''}`;
    if (/\b(continue|resume|next step|todo|left off|pick up)\b/i.test(req)) return;
    this.staleTodoNoteInjected = true;
    this.context.addMessage({
      role: 'system',
      content: `Ledger caution: this workspace has ${open.length} open todo item(s) left over from EARLIER, unrelated runs (${open.join('; ')}). They are NOT part of the current request — do not start working on them. Work only on the task you were just given; you may clear the stale items if they get in the way.`,
    });
  }

  /** Effective working context budget for this run: the configured budget
   *  clamped to the active model's real window (computed in run()). Falls back to
   *  the configured budget before run() has computed the clamp. */
  private budgetTokens(): number {
    return this.effectiveBudgetTokens > 0 ? this.effectiveBudgetTokens : this.config.safety.contextBudgetTokens;
  }

  /**
   * Self-tuning complexity signal. The up-front gate can only read the task
   * TEXT; a task that looks standard can still turn out to be a multi-file
   * beast, and the regex classifier can simply be wrong. Instead of paying for
   * a separate LLM classification call on EVERY task (which would tax the lean
   * fast path Codex/Claude-Code-class throughput depends on), we promote a
   * running task to `complex` once the RUN ITSELF produces hard-task evidence:
   * sustained tool errors, repeated verification failures, or a prolonged
   * struggle past the point a simple task would have finished. Promotion is
   * one-way and idempotent; it restores the full toolset and hands the rest of
   * the run the same context preservation + max reasoning the gate grants.
   */
  private maybeEscalateComplexity(iteration: number): void {
    if (this.taskComplexity === undefined) return;
    const toolErrors = this.totalToolErrors();
    const should = shouldEscalateComplexity({
      complexity: this.taskComplexity,
      alreadyEscalated: this.complexityEscalated,
      consecutiveVerifyFailures: this.consecutiveVerifyFailures,
      toolErrors,
      iteration,
    });
    if (!should) return;
    this.complexityEscalated = true;
    this.taskComplexity = 'complex';
    this.context.setTaskComplexity('complex');
    // Restore every registered tool the lean/read/chat tiers deferred, so deeper
    // analysis (find_definitions/analyze_code/blast_radius/...) is available.
    for (const [name, tool] of ALL_TOOLS_MAP) {
      if (!this.tools.has(name)) this.tools.set(name, tool);
    }
    this.toolDefs = [...this.tools.values()].map((t) => t.def);
    this.events.emit({
      type: 'agent:log',
      agentId: this.id,
      message: `[complexity] escalated to complex mid-run (iter ${iteration}, toolErrors ${toolErrors}, verifyFails ${this.consecutiveVerifyFailures}) — full toolset + context preservation restored`,
    });
    // Tell the MODEL (not just the TUI log): the tiers earlier injected a
    // "deferred tools" note, and toolGuidelines dropped the guidance lines for
    // the deep-analysis tools. Without this the model keeps approximating with
    // shell after escalation — it doesn't know the arsenal came back.
    if (!this.subagentDepth) {
      const restored = ['subagent', 'blast_radius', 'find_references', 'find_definitions', 'get_diagnostics', 'analyze_code', 'memory', 'web_search', 'web_crawl', 'codebase_map', 'security_audit'].filter((n) => this.tools.has(n));
      this.context.addMessage({
        role: 'system',
        content: `TASK COMPLEXITY ESCALATED: this run shows sustained struggle, so the FULL toolset is now advertised — including ${restored.join(', ')}. The earlier "deferred tools" note is obsolete; you no longer need load_tools for these. For the remaining work: re-ground in the actual code (read the current implementation, check blast_radius before risky edits) instead of repeating the failing approach.`,
      });
    }
  }

  /** Effective reasoning tier for a task. Distilled from Claude Code's
   *  `--effort auto`: when `reasoning: "auto"` is configured, map the task
   *  kind to a tier so simple work doesn't burn deep-reasoning tokens and
   *  hard work gets the full budget (resolveAutoReasoning in taskkind.ts).
   *  Returns a literal tier in all other cases (off/low/medium/high/max). */
  private resolveReasoning(task: Task): 'off' | 'low' | 'medium' | 'high' | 'max' {
    const raw = (this.config.reasoning || process.env.MOCHI_REASONING || 'auto').trim().toLowerCase();
    if (raw === 'auto') {
      const kind = this.taskKind ?? classifyTaskKind(task);
      // MCH-92b: trivial mechanical writes (create x.txt containing ok) got
      // 'max' via the implement default and burned 50k+ thinking tokens on a
      // 1-line task (arena: 54,331 tokensOut). Downgrade them to 'low'.
      if (isTrivialWriteTask(task)) return 'low';
      // MCH-95: create-and-run script tasks (f1 arena: 21s thinking + 40s of
      // self-doubt diff re-checks and identical rewrites). 'medium' is ample.
      if (isSimpleScriptTask(task)) return 'medium';
      // Reviews are read-shaped analysis, not Q&A: 'low' produced shallow
      // rubber-stamps under the chat-tier tool cap. 'medium' funds careful
      // analysis without max-tier burn on every "lgtm this".
      if (isReviewTask(task)) return 'medium';
      // Complexity override (NEW, 2026-10-15): a structurally complex task MUST
      // get max reasoning regardless of its coarse kind. `refactor` kinds
      // default to 'medium' via resolveAutoReasoning, but a multi-file /
      // existing-repo / contract-preserving refactor is Claude Code / Codex
      // class work — it gets the full cognitive budget, same as the full
      // toolset (see tool-advertising gate). Pure at this point in the loop:
      // taskComplexity was already computed in buildPrompt.
      if (this.taskComplexity === 'complex') return 'max';
      // Symmetric fast-path (2026-10-15): a verified-simple task gets LOW
      // reasoning even if its coarse kind is 'implement' (which would otherwise
      // default to 'max' here). This preserves the ~2s fast path on genuinely
      // trivial one-file edit-and-run tasks — the same "don't burn 50k thinking
      // tokens on a 1-line task" budget the isTrivialWriteTask guard serves.
      if (this.taskComplexity === 'simple') return 'low';
      return resolveAutoReasoning(kind);
    }
    // Guard against any stray invalid value (config re-validates, but stay safe).
    if (raw === 'off' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max' || raw === 'extreme' || raw === 'deep' || raw === 'hard' || raw === 'easy') {
      return raw === 'extreme' || raw === 'deep' || raw === 'hard' ? 'max' : (raw === 'easy' ? 'low' : (raw as 'off' | 'low' | 'medium' | 'high' | 'max'));
    }
    return 'medium';
  }

  async run(task: Task): Promise<AgentResult> {
    this.startTime = performance.now();
    this.activeTask = task;
    // B2: each run() gets exactly one finish(). A previous run's guard entry
    // must not swallow this run's teardown (auto-resume reuses the instance).
    this.finishPromise = null;
    // Mark the bus position so the finish-time summary covers THIS run only.
    const hist = this.events.snapshot();
    this.runStartMarker = hist.length > 0 ? hist[hist.length - 1] : undefined;
    this.consecutiveVerifyFailures = 0;
    this.escalatedThisTask = false;
    this.complexityEscalated = false;
    // Complexity must be computed here — BEFORE resolveReasoning (line ~799)
    // and the tool-advertising gate — so both hard-task levers (max reasoning
    // + full toolset) see a `complex` task. Conservative: only strong
    // structural evidence (multi-file scope, existing-repo mutation, broad
    // test loops, hard investigation) forces 'complex'; anything ambiguous
    // stays on the lean/fast path.
    const complexityScore = scoreTaskComplexity(
      task.title, task.description ?? '',
      {
        role: task.role,
        fileScope: task.fileScope ?? [],
        acceptanceCriteria: task.acceptanceCriteria ?? [],
        greenfield: isGreenfieldTask(task.title, task.description ?? '', task.fileScope, (p) => { try { return existsSync(p); } catch { return false; } }),
      },
    );
    this.taskComplexity = complexityScore.complexity;
    this.tasksScoreMeta = { complexity: complexityScore.complexity, score: complexityScore.score, reasons: complexityScore.reasons };
    // Clamp the working budget to the active model's REAL window. The configured
    // budget can be larger than what the provider actually accepts (a stale
    // default, or a model switch), which pushed the compaction floor past the
    // provider's hard limit — hard tasks then died on a context cliff instead of
    // compacting gracefully. min() means we only ever compact earlier, never send
    // a prompt the provider will reject. Override with MOCHI_CONTEXT_WINDOW.
    const learned = learnedWindowBudget(this.config.model.model, this.config.model.provider);
    const windowBudget = Math.min(
      this.config.safety.contextBudgetTokens,
      modelContextBudget(this.config.model.model, this.config.model.provider),
      learned ?? Number.POSITIVE_INFINITY,
    );
    this.effectiveBudgetTokens = windowBudget;
    this.context.setBudgetTokens(windowBudget);
    if (windowBudget < this.config.safety.contextBudgetTokens) {
      this.events.emit({ type: 'agent:log', agentId: this.id, message: `[context] working budget clamped ${this.config.safety.contextBudgetTokens} -> ${windowBudget} tokens (model window)` });
    }
    // Propagate the complexity verdict into the context engine BEFORE any
    // message is ingested, so a complex task keeps its working memory (file
    // bodies, tool outputs, deeper recency window) for the whole run.
    this.context.setTaskComplexity(this.taskComplexity);
    this.events.emit({ type: 'agent:log', agentId: this.id, message: `[complexity] ${this.taskComplexity} for task "${task.title}"` });
    this.events.emit({ type: 'task:started', task, agentId: this.id });
    // Harness-v2 Phase 1: deterministic iteration lifecycle. Every loop turn
    // flows preflight → model-call → stream-guard → tool-exec → verify →
    // finish and emits exactly one typed IterationTrace event.
    const sm = this.sm = new LoopStateMachine(this.events, this.id);
    this.context.updateState({ nextAction: `Start task: ${task.title}` });
    // MCH-113: express lane — the preflight block below (line ~735) already
    // runs `git status --short` harness-side and feeds it into the packet, so
    // the model never needs to spend its first provider round on it. Nothing
    // to do here beyond keeping isTrivialWriteTask/isSimpleScriptTask aligned
    // with the finish-hint (mch113b) eligibility below.
    // Active execution mode (modeInstruction from modes.ts) is injected here so
    // spec/security/codemod/chaos directives reach the model every turn.
    if (this.config.mode && isMode(this.config.mode)) {
      const modeBlurb = modeInstruction(this.config.mode);
      if (modeBlurb) this.context.addMessage({ role: 'system', content: modeBlurb });
    }
    // Adjustable reasoning mode: read from config or env and inject directive.
    // `resolveReasoning` already normalizes aliases + the `auto` task-kind map.
    const reasoning = this.resolveReasoning(task);
    const blurb = reasoning === 'max'
      ? 'Engage MAXIMUM reasoning compute & cognitive depth: perform exhaustive multi-angle decomposition, trace full AST dependency blast radius, synthesize formal invariants (Chameleon reasoning), check all edge cases, and thoroughly verify correctness before concluding.'
      : reasoning === 'high'
        ? 'Engage HIGH reasoning depth: thoroughly analyze edge cases, evaluate invariants, trace AST caller dependencies, isolate root causes, and confirm correctness with concrete checks.'
        : reasoning === 'low'
          ? 'Engage LOW reasoning mode: act fast and decisively with minimal thinking overhead, make direct edits, verify quickly, and respond concisely.'
          : reasoning === 'off'
            ? 'Engage NO reasoning expansion: produce the answer or take the action directly, minimal deliberation.'
            : 'Engage MEDIUM balanced reasoning: carefully inspect relevant context, isolate root causes before modifying code, maintain system invariants, and verify changes with concrete tests/checks.';
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
    // MCH-47: warm-start from the plan cache — if a similar task previously
    // succeeded with an accepted plan, surface it as a starting hypothesis.
    try {
      const { findPriorPlan } = await import('../core/plan-cache.js');
      const priorPlan = findPriorPlan(this.workspace.dir, task.title, task.description ?? '');
      if (priorPlan) {
        this.context.addMessage({
          role: 'system',
          content: `PRIOR SUCCESS CONTEXT: a similar task ("${priorPlan.taskTitle}") previously succeeded with this plan:\n${priorPlan.plan.slice(0, 1500)}\nUse it as a starting point if it still fits the current code; verify assumptions before reusing it.`,
        });
      }
    } catch { /* plan-cache warm-start must never affect task start */ }
    // MCH-49: repo-map — surface the structurally most important files
    // (PageRank over the codegraph symbol graph) so the model plans around
    // hub files instead of discovering them by trial and error.
    try {
      const { repoMapText } = await import('../repo/repo-map.js');
      const mapText = repoMapText(this.workspace.dir);
      if (mapText) {
        this.context.addMessage({ role: 'system', content: mapText });
      }
    } catch { /* repo-map must never affect task start */ }
    // MCH-50: prefetch — fused structural+temporal+runtime prediction of the
    // files this task will likely read next.
    try {
      const pf = await import('../core/prefetch.js');
      // MCH-54: seed the temporal signal with this run's actual read footprint
      // (main loop) — subagents start with an empty footprint, which is fine.
      const touched = Array.from(this.readCache.keys()).slice(-10);
      // MCH-61: compute entries once so the effectiveness ledger can compare
      // predictions against what the run actually read.
      this.prefetchLedger = pf.prefetchFiles(this.workspace.dir, touched, 8);
      const pfText = this.prefetchLedger.length > 0
        ? `PREFETCHED CONTEXT (likely-next files, fused signals: structural PageRank + co-change history + cross-session read telemetry — read these proactively if your task touches them):\n${this.prefetchLedger.map((e) => `- ${e.file}  [${e.signals.join('+')}]`).join('\n')}`
        : '';
      if (pfText) {
        this.context.addMessage({ role: 'system', content: pfText });
      }
      // MCH-51: physically warm the read cache so the first read of each
      // predicted file is an in-memory hit (mtime/size-validated, so a
      // mid-task edit still re-reads from disk).
      pf.warmReadCache(this.workspace.dir, this.readCache);
      // MCH-61: warmed entries are NOT reads — exclude them from the ledger.
      this.prefetchWarmed = new Set(Array.from(this.readCache.keys()));
    } catch { /* prefetch must never affect task start */ }
    // MCH-52: surface mined tool-route patterns from past successful runs.
    try {
      const { loadToolSeqs, toolPatternText } = await import('../core/tool-sequence.js');
      const patText = toolPatternText(loadToolSeqs(this.workspace.dir));
      if (patText) this.context.addMessage({ role: 'system', content: patText });
    } catch { /* tool-seq injection must never affect task start */ }
    if (this.planMode) {
      this.context.addMessage({
        role: 'system',
        content: 'PLAN MODE: Research the codebase with read-only tools if needed, then submit your complete plan by calling the accept_plan tool with the plan as its argument (numbered steps, files to change, risks, and how to verify). Do NOT edit files or run mutating commands. After calling accept_plan, end your turn — do not call other tools.',
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

    let taskKind = this.taskKind = classifyTaskKind(task);
    this.task = task;
    // Complexity gate: taskComplexity was already computed at the top of run().
    // When 'complex', keep the FULL toolset (deep-analysis tools like
    // find_definitions/analyze_code/type_hierarchy/blast_radius are otherwise
    // deferred by the lean tier) so hard tasks get Claude Code / Codex-class
    // capability. Otherwise fall through to the lean/read/heavy tiers, which
    // preserve the ~2s / ~2.5K-token fast path for simple/standard tasks.
    if (this.taskComplexity === 'complex') {
      this.events.emit({ type: 'agent:log', agentId: this.id, message: `[complexity] full toolset for ${taskKind} task (score ${this.tasksScoreMeta.score ?? 0}: ${(this.tasksScoreMeta.reasons ?? []).join('; ')})` });
    } else {
      // MCH-91: task-adaptive tool advertising — focused coding tasks don't need
      // browser/db/PR/SQL schemas burning ~4-5K tokens on EVERY call. Trim heavy
      // tools unless the task text itself signals them (trimHeavyTools is a no-op
      // then); the model can pull any back mid-run via `load_tools`.
      if (taskKind === 'implement' || taskKind === 'fix' || taskKind === 'refactor' || taskKind === 'test') {
        const taskText = `${task.title} ${task.description ?? ''}`;
        // MCH-110: lean tier first — simple focused coding tasks advertise only
        // the ~20 core tools (~2.5K tokens) instead of ~56 (~7K). Restores are
        // identical to mch91: the model calls `load_tools` mid-run.
        const leaned = trimToLeanTier(this.tools, taskText);
        if (leaned > 0) {
          this.toolDefs = [...this.tools.values()].map((t) => t.def);
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[mch110] lean tier: deferred ${leaned} tools for ${taskKind} task (load_tools restores them)` });
        } else {
        const trimmed = trimHeavyTools(this.tools, taskText);
        if (trimmed > 0) {
          this.toolDefs = [...this.tools.values()].map((t) => t.def);
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[mch91] trimmed ${trimmed} heavy tools for ${taskKind} task (load_tools restores them)` });
        }
        }
        this.injectDeferredToolsNote('lean');
      } else if (taskKind === 'chat') {
            // MCH-111: chat tasks tell the model "do not call any tools", yet were
            // still advertised ~62 tool schemas (~5K tokens) on every call — the
            // single largest avoidable latency cost on a trivial question. Advertise
            // only the read-only essentials (+ load_tools for escape hatch); any
            // other tool stays restorable mid-run exactly like mch91/mch110.
            // ask_question stays advertised: it is how the model asks the user back
            // (interactive menu), which is a legitimate chat-turn move.
            // NOTE: 'search' is the tool name ('grep' is only an alias and never
            // matches a map key — listing it here once silently dropped search).
            const kept = new Set<string>();
            for (const [name] of this.tools) {
              if (CHAT_TOOL_NAMES.has(name)) kept.add(name);
            }
            if (this.tools.size - kept.size > 0) {
              this.toolDefs = [...kept].map((n) => this.tools.get(n)!.def);
              this.events.emit({ type: 'agent:log', agentId: this.id, message: `[mch111] chat tier: advertised ${kept.size} tools, deferred ${this.tools.size - kept.size} (load_tools restores them)` });
            }
            this.injectDeferredToolsNote('chat');
          } else if (taskKind === 'research' || taskKind === 'document' || taskKind === 'plan' || taskKind === 'unknown') {
            // READ tier: read-only task shapes advertised the full ~65-tool schema
            // (~10K tokens/call) despite never legitimately mutating (plan mode
            // vetoes mutations anyway). Advertise the 16 read-only essentials;
            // anything else restores mid-run via load_tools.
            const taskText = `${task.title} ${task.description ?? ''}`;
            const readTrimmed = trimToReadTier(this.tools, taskText);
            if (readTrimmed > 0) {
            this.toolDefs = [...this.tools.values()].map((t) => t.def);
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[read-tier] advertised ${this.tools.size} read-only tools for ${taskKind} task (load_tools restores them)` });
            } else {
            const trimmed = trimHeavyTools(this.tools, taskText);
            if (trimmed > 0) {
              this.toolDefs = [...this.tools.values()].map((t) => t.def);
              this.events.emit({ type: 'agent:log', agentId: this.id, message: `[mch91] trimmed ${trimmed} heavy tools for ${taskKind} task (load_tools restores them)` });
            }
            }
            this.injectDeferredToolsNote('read');
      }
    } // end complexity-gate else
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
    if (oneShot.kind === 'answer') {
      taskKind = this.taskKind = 'chat';
    }

    if (taskKind !== 'chat') {
      const isHome = this.cwd === (await import('node:os')).homedir();
      let gitStatus = '';
      if (!isHome) {
        const rawStatus = await this.runShell('git status --short');
        const statusLines = rawStatus.split('\n');
        gitStatus = statusLines.length > 50
          ? statusLines.slice(0, 50).join('\n') + `\n... (${statusLines.length - 50} more changes truncated)`
          : rawStatus;
      }
      const langHint = languageHint(repo);
      let scopeOutline = '';
      if (task.fileScope && task.fileScope.length > 0) {
        try {
          const { extractCodeOutline } = await import('../tools/outline.js');
          const outlineSections: string[] = [];
          for (const relPath of task.fileScope.slice(0, 5)) {
            const absPath = resolve(this.cwd, relPath);
            if (existsSync(absPath)) {
              const content = readFileSync(absPath, 'utf8');
              const symbols = extractCodeOutline(content, extname(absPath));
              if (symbols.length > 0) {
                const symSummary = symbols.slice(0, 15).map((s) => `  L${s.line}: [${s.kind}] ${s.signature}`).join('\n');
                outlineSections.push(`Outline for ${relPath} (${symbols.length} symbols):\n${symSummary}`);
              }
            }
          }
          if (outlineSections.length > 0) {
            scopeOutline = '\n\nFile Scope Symbol Outline:\n' + outlineSections.join('\n\n');
          }
        } catch {}
      }
      const wsList = workspaceListMessage(this.cwd);
      const issueCtx = issuesContextBlock(this.workspace.dir);
      this.context.addMessage({
        role: 'system',
        content: `Preflight: repo=${repo.language ?? 'unknown'}${gitStatus ? ', git status:\n' + gitStatus : ''}${langHint ? '\n\n' + langHint : ''}${scopeOutline}${wsList ? '\n\n' + wsList : ''}${issueCtx ? '\n\n' + issueCtx : ''}`,
      });
    }

    // Claude Code operational autonomy and focus protocol (injected before turn 0)
    if (taskKind !== 'chat') {
      if (!this.rewriteProtocolInjected) {
        this.rewriteProtocolInjected = true;
        const complex = isComplexRewritingTask(task.title, task.description);
        if (complex) {
          this.context.addMessage({ role: 'system', content: LARGE_REWRITE_PROTOCOL });
        }
      }
      if (!this.resumeProtocolInjected) {
        this.resumeProtocolInjected = true;
        if (repo) {
          const memPrefix = projectMemoryPrefix(this.workspace.dir);
          if (memPrefix) this.context.addMessage({ role: 'system', content: memPrefix });
        }
        this.context.addMessage({ role: 'system', content: TASK_FOCUS_PROTOCOL });
        this.maybeInjectStaleTodoNote();
      }
    }

    const maxIterations = this.config.safety.maxIterations;
    const runtimeLimit = this.config.safety.maxRuntimeMinutes * 60 * 1000;

    if (oneShot.suggests && !this.planMode) {
      this.context.addMessage({ role: 'system', content: oneShot.suggests });
    }

    // Master prompt compiler wiring (multi-tier reasoning dispatch): for
    // non-chat tasks, compile the raw user prompt through the 46-section
    // blueprint engine at the ACTIVE reasoning level (low→off-tier micro-
    // dispatch … max→full architectural spec) and inject the compiled spec
    // as the primary user-turn directive. This is what makes the reasoning
    // setting actually change execution behavior instead of just swapping a
    // one-line "think harder" blurb. Bounded: runs once per task, and any
    // compiler failure degrades silently to the plain prompt.
    // COST GUARD (2026-10-05): the compiled spec is a large (~10-20K char)
    // static block injected into EVERY non-chat task — real repo context is
    // crowded out of the model window on low/medium tiers where a deep
    // architectural blueprint is wasted tokens. Only inject the full compiled
    // spec at high/max reasoning; lower tiers keep the compact one-line
    // reasoning blurb (already added above) so the window holds repo code.
    if (taskKind !== 'chat' && !this.planMode && !this.compilerInjected) {
      this.compilerInjected = true;
      const resolvedTier = this.resolveReasoning(task);
      // MOCHI_PROMPT_COMPILER is a real 0/1 toggle: `0` force-disables the
      // compiler everywhere (the old check only honored `=1`, so the documented
      // escape hatch was dead outside vitest — `!process.env.VITEST` alone made
      // it always-true in production), `=1` force-enables it inside tests, and
      // unset keeps the default (enabled outside tests).
      const compilerEnv = process.env.MOCHI_PROMPT_COMPILER;
      const allowCompiler = compilerEnv !== '0' && Boolean(
        compilerEnv === '1' ||
        this.config.mode === 'spec' ||
        !process.env.VITEST
      );
      // Complexity-proportional blueprint (2026-10-16): the max-tier spec is
      // ~12K chars of static architecture and was injected for EVERY non-chat
      // task whenever reasoning was high/max — so "read package.json" opened
      // with a full architectural blueprint, drowning the actual repo context
      // and making the agent wander. Now: skip it entirely for a verified-simple
      // task (the one-line reasoning blurb above is enough), cap a `standard`
      // task at the compact 'high' spec, and reserve the full max-tier spec for
      // tasks that are structurally `complex`.
      const tier: 'off' | 'low' | 'medium' | 'high' | 'max' | null =
        this.taskComplexity === 'complex' ? resolvedTier
          : this.taskComplexity === 'standard' ? (resolvedTier === 'max' ? 'high' : resolvedTier)
            : null;
      if (allowCompiler && tier !== null && (tier === 'high' || tier === 'max' || tier === 'medium')) {
        try {
          const { promptCompiler } = await import('../prompt/prompt-compiler.js');
          const { detectRepo: detectRepoForCompiler } = await import('../repo/repo.js');
          const cRepo = detectRepoForCompiler(this.cwd);
          const spec = promptCompiler.compile(
            [task.title, task.description].filter(Boolean).join('\n\n'),
            {
              reasoning: tier,
              testCommand: task.verificationCommand || cRepo.testCommand,
              primaryLanguage: cRepo.language,
            },
          );
          if (spec?.compiledMarkdownPrompt) {
            this.context.addMessage({
              role: 'system',
              content: `# COMPILED EXECUTION BLUEPRINT (reasoning tier: ${tier.toUpperCase()})\nFollow this specification. It was derived from the user's request and calibrates depth, phases, and verification to the active reasoning level.\n\n${spec.compiledMarkdownPrompt}`,
            });
          }
        } catch { /* compiler failure must never block the task */ }
      }
    }

    // Speculative reasoning preflight (opt-in via model.speculative.preflight).
    // For hard non-chat tasks, run the existing SpeculativeEngine once and
    // inject its chosen approach + pitfall notes as a system hint that biases
    // the main reasoning path — DeepSeek/Cline-style "think a cheap model ahead,
    // then commit the fast model to a better plan" before it fires tools.
    // Bounded: runs at most once (guarded by speculativePreflighted), only if
    // budget allows, and swallows any failure so it never blocks the task.
    if (!this.planMode && taskKind !== 'chat' && this.specPreflightEnabled() && !this.specPreflighted) {
      // MCH-43: predictive file pre-fetch — warm the read cache with files the
      // co-change graph predicts we'll need next, before the model asks. Cheap
      // (one git log) and best-effort: any failure is invisible to the task.
      try {
        const touched = this.context.getMessages()
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .slice(-20)
          .flatMap((m) => (contentText(m).match(/[\w./-]+\.(?:ts|js|py|go|rs)/g) ?? []));
        const uniqueTouched = [...new Set(touched)].slice(0, 10);
        if (uniqueTouched.length > 0) {
          const predicted = predictNextFiles(this.workspace.dir, uniqueTouched, 5);
          const { readFile, stat } = await import('node:fs/promises');
          for (const f of predicted) {
            try {
              const full = join(this.workspace.dir, f);
              const st = await stat(full);
              if (st.size <= 64_000) {
                this.readCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, content: await readFile(full, 'utf8') });
              }
            } catch { /* unreadable: skip this file */ }
          }
          if (predicted.length > 0) {
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `prefetch: warmed ${predicted.length} co-change file(s)` });
          }
        }
      } catch { /* prefetch is strictly optional */ }
      await this.maybeSpeculativePreflight(task);
    }

    // Wire any configured MCP servers into the toolset. These tools are closed
    // when the run finishes (see finish()), so subprocesses don't leak.
    // Skipped for chat turns (same rule as loadMcpInRun below): spawning +
    // handshaking every server on a greeting is connect spam for a turn that
    // can only use reads + ask_question anyway.
    if (this.config.mcpServers && this.taskKind !== 'chat') {
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
      // Claim the lazy loader's guard: loadMcpInRun (iteration 0) would
      // otherwise connect EVERY server a second time through the older
      // tools/mcp.ts stack and advertise each tool under a second name
      // (mcp_srv_tool vs srv__tool) — duplicate subprocesses, duplicated
      // tool schemas on every model call. One connect per run (I2).
      this.mcpLoaded = true;
    }

    // Delivered background results: task ids already surfaced to the model,
    // so each completion is injected exactly once.
    const bgDelivered = new Set<string>();
    // B16: acquire the budget agent slot HERE, before any guard that can
    // reach finish(). The old `if (i === 0) recordAgentStart()` sat AFTER
    // the abort and runtime-limit guards at the loop top, so a run aborted
    // during the first preflight reached finish() and released a slot it
    // never acquired — stealing a usedAgents slot from a sibling agent on
    // the shared budget. finish() unconditionally releases, so acquisition
    // must be unconditional too.
    this.budget?.recordAgentStart();
    // Shell-mutation baseline: as late as possible (all harness setup writes
    // to .mochi/ already happened) but before the model can touch anything.
    await this.captureGitBaseline();
    for (let i = 0; i < maxIterations; i++) {
      // Hot-reload agent-authored tools (tool_factory): if the agent created,
      // patched, or removed one last iteration, merge it into the live toolset
      // and re-advertise defs to the model (same pattern as MCP hot-load).
      try {
        if (refreshAuthoredTools(this.tools, this.workspace.dir || this.cwd, (n) => RESERVED_TOOL_NAMES.has(n) || TOOL_ALIASES[n] !== undefined)) {
          this.toolDefs = [...this.tools.values()].map((t) => t.def);
          this.events.emit({ type: 'agent:log', agentId: this.id, message: '[tool_factory] authored toolset changed — defs re-advertised' });
        }
      } catch { /* never block the loop over tool refresh */ }
      // MCH-73: speculative continuation — warm next-turn reads every iteration.
      void this.prefetchForNextTurn();
      // MCH-74: mid-run steer — inject any queued user guidance before the turn.
      this.drainSteerQueue();
      // Quality slice: surface the agent's struggle state (consecutive tool
      // errors, empty-response retries, recent known errors) to the model on
      // every turn. Without this, a model in trouble starts each turn fresh —
      // it doesn't know it has failed 3 tool calls in a row or that 2 verify
      // attempts have already passed. The injection is rate-limited to once
      // per 2 iterations and a no-op when no struggle signals exist, so the
      // cost is zero on healthy runs.
      this.injectStruggleState(i);
      // Self-tuning complexity: promote a struggling task to `complex` mid-run
      // (full toolset + context preservation) once real hard-task evidence
      // accumulates — no separate classification LLM call on the fast path.
      this.maybeEscalateComplexity(i);
      // Progress heartbeat: stop honestly on sustained no-progress wandering
      // instead of burning all 80 iterations going in circles.
      const heartbeat = await this.progressHeartbeat(i, task);
      if (heartbeat) return heartbeat;
      sm.beginIteration(i);
      // Deliver completed background tasks as events into the transcript.
      try {
        const { listTasks, describeTask } = await import('../daemon/background-tasks.js');
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
        try {
          const activeGoal = this.context.state.goal || task.title;
          this.workspace.saveCheckpoint(activeGoal, `Task aborted by caller at iteration ${i}.\nObjective: ${task.title}\nFiles touched: ${this.context.state.filesModified.join(', ') || 'none'}\nNext: Run "mochi resume" to continue.`);
        } catch { /* best effort */ }
        return this.finish(task, false, `Run aborted by caller. Resume anytime with "mochi resume".`, 'aborted');
      }
      if (performance.now() - this.startTime > runtimeLimit) {
        return this.finish(task, false, 'Runtime limit exceeded', 'runtime_limit');
      }
      if (this.budget) {
        // B16: recordAgentStart moved to before the iteration loop (see the
        // call site above captureGitBaseline) — this first-iteration call was
        // AFTER the abort/runtime guards, so preflight aborts released a slot
        // never acquired.
        if (!this.budget.canMakeModelCall()) {
          // If in uncensored mode and real work has been done, allow a final completion turn
          // rather than abruptly aborting in the middle of active progress.
          if (this.config.safety.mode === 'uncensored' && this.fileChanged) {
            this.events.emit({ type: 'agent:log', agentId: this.id, message: '[budget] budget soft ceiling reached in uncensored mode; allowing final verification' });
          } else {
            try {
              const activeGoal = this.context.state.goal || task.title;
              this.workspace.saveCheckpoint(activeGoal, `Task paused: budget exhausted before model call at iteration ${i}.\nObjective: ${task.title}\nFiles touched: ${this.context.state.filesModified.join(', ') || 'none'}\nNext: Run "mochi resume" with an increased budget.`);
            } catch { /* best effort */ }
            return this.finish(task, false, 'Budget exhausted before model call. Work checkpointed — resume with "mochi resume".', 'budget');
          }
        }
        this.budget.recordModelCall();
      }

      if (i === 0 && this.taskKind !== 'chat') await this.loadMcpInRun();
      if (i > 0 && i % 8 === 0) await this.checkpointAndCompact('periodic');

      // Compact-first context floor: once the live transcript grows past a
      // fraction of the context budget, roll up old turns so the packet never
      // balloons. The floor scales with the configured budget (the user's chosen
      // model window), NOT an arbitrary small cap — a hardcoded 32K ceiling
      // ignored a 120K budget and nuked repo context mid-task. Keep a generous
      // upper guard (80% of budget) solely so a typo'd giant budget can't
      // balloon the transcript to a non-response; the *floor* itself stays
      // proportional so long coding runs hold live repo code in-window.
      const ceiling = Math.floor(this.budgetTokens() * 0.8);
      const floor = Math.min(this.budgetTokens() * 0.6, ceiling);
      const msgCount = this.context.messageCount;
      // Batch token count via the Rust runtime (1 stdio round-trip instead of
      // N FFI calls); falls back to the sync estimate when native is absent.
      const ctxTokens = await this.context.estimateTokensAsync();
      if (i > 0 && msgCount >= 10 && ctxTokens > floor) {
        // MCH-30: CC-style two-stage pressure response. Stage 1 (cheap):
        // shrink old tool outputs in place — keeps every turn's structure, no
        // model call, no history rewrite. Stage 2 (only if still over floor):
        // the existing full checkpoint+compact. This defers expensive
        // compaction on long runs the way Claude Code's context editor does.
        const savedTokens = this.context.shrinkOldToolOutputs();
        if (savedTokens > 0) {
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[context] shrunk old tool outputs in place (~${savedTokens} tokens saved); deferring full compaction` });
        }
        if (this.context.effectiveContextTokens() > floor) {
          await this.digestOldMessages(floor);
        }
        if (this.context.effectiveContextTokens() > floor) {
          await this.checkpointAndCompact('floor');
        }
      }

      const pulse = this.pulse(i, task);
      if (pulse.abort) {
        return this.finish(task, false, pulse.reason ?? 'Pulse abort', 'pulse_abort');
      }
      if (pulse.message) {
        this.context.addMessage({ role: 'system', content: pulse.message });
      }

      const packet = this.context.buildPacket(this.toolDefs, task, repo);
      // Large-rewrite protocol: for substantive coding work (not chat), inject a
      // one-time discipline directive on the first iteration. This is the
      // Cline/Codex harness shape — plan first, track with todo, check blast
      // radius before risky edits, checkpoint before big changes, persist
      // decisions, fan out parallelizable pieces to subagents. It's what makes
      // Mochi hold a complex multi-file refactor's state instead of drifting.
      if (taskKind !== 'chat' && !this.rewriteProtocolInjected) {
        this.rewriteProtocolInjected = true;
        const complex = isComplexRewritingTask(task.title, task.description);
        if (complex) {
          this.context.addMessage({ role: 'system', content: LARGE_REWRITE_PROTOCOL });
        }
      }
      // Multi-session project continuity: inside a real git repo, tell the model
      // once to warm up with prior project context before editing — the durable
      // memory, any open todos, and the most recent session's state. This is what
      // lets Mochi RESUME a dense multi-session project instead of starting each
      // session from a blank slate (the Cline/Claude Code multi-session edge).
      if (taskKind !== 'chat' && repo && !this.resumeProtocolInjected) {
        this.resumeProtocolInjected = true;
        // MCH-76: stable cross-session project-memory prefix, before the protocol.
        const memPrefix = projectMemoryPrefix(this.workspace.dir);
        if (memPrefix) this.context.addMessage({ role: 'system', content: memPrefix });
        this.context.addMessage({ role: 'system', content: TASK_FOCUS_PROTOCOL });
        this.maybeInjectStaleTodoNote();
      }
      // Anti-loop: if gathering context extensively without editing, nudge the appropriate action.
      if (!this.contextCutoffNudged && !this.fileChanged && !this.planMode) {
        if (taskKind === 'chat' && this.toolCallsTotal >= 10) {
          this.contextCutoffNudged = true;
          this.context.addMessage({ role: 'system', content: 'You have gathered sufficient context. Provide your answer directly now.' });
        } else if ((taskKind === 'implement' || taskKind === 'fix' || taskKind === 'refactor') && this.toolCallsTotal >= 14) {
          this.contextCutoffNudged = true;
          this.context.addMessage({ role: 'system', content: 'You have gathered substantial context. Please proceed with making the necessary changes using edit/write tools.' });
        }
      }
      sm.enter('model-call');
      const activeProvider = this.pickProvider();
      let response;
      // Per-invocation abort: every gather (primary AND retry) gets a fresh
      // controller so a stall guard firing on ONE invocation can tear down
      // only that network stream without killing the whole agent or the next
      // retry. The controller is ALSO wired to the run's abort signal so a
      // user Ctrl-C still aborts it.
      let activeCallSignal = new AbortController();
      // Track per-invocation abort wirings so they can be removed after the
      // gather settles. The old code added one `abort` listener per model call
      // with no removal on success — up to maxIterations leaked listeners on
      // the shared run signal (MaxListenersExceededWarning on long tasks).
      const pendingAbortWirings = new Set<{ sig: AbortSignal; handler: () => void }>();
      const newCallController = () => {
        const c = new AbortController();
        const innerAbort = () => c.abort(this.abortSignal?.reason);
        if (this.abortSignal?.aborted) c.abort(this.abortSignal.reason);
        else if (this.abortSignal) {
          this.abortSignal.addEventListener('abort', innerAbort, { once: true });
          pendingAbortWirings.add({ sig: this.abortSignal, handler: innerAbort });
        }
        activeCallSignal = c;
        return c;
      };
      const cleanupCallController = () => {
        for (const { sig, handler } of pendingAbortWirings) {
          try { sig.removeEventListener('abort', handler); } catch { /* best-effort */ }
        }
        pendingAbortWirings.clear();
      };
      const gatherStream = async (messages: any) => {
        const chunks: import('../types.js').StreamChunk[] = [];
        let inThinkTag = false;
        let streamBuf = '';
        let looped = false;
        // MCH-64: mid-stream speculative tool execution. Tool-call args stream
        // in deltas; the moment one call's args JSON parses AND the canonical
        // tool is read-only, fire runMoolCall immediately (fire-and-forget,
        // awaited after the stream). The real execution after the stream hits
        // the ExecutionRegistry replay path (same executionId = completed
        // record served from cache), so the read's output arrives with ZERO
        // added latency and no duplicated tool messages. Mutating tools are
        // NEVER spec-executed (order/atomicity). Bounds: max 8 per response,
        // and the pre-stream spam guards still apply inside runMoolCall.
        this.midStreamExecutedIds.clear();
        const midStreamAcc = new Map<number, { id: string; name: string; args: string }>();
        const midStreamPromises: Promise<void>[] = [];
        const maybeSpecExec = (tcIndex: number) => {
          if (this.midStreamExecutedIds.size >= 8) return;
          const acc = midStreamAcc.get(tcIndex);
          if (!acc || !acc.name || !acc.id) return;
          if (this.midStreamExecutedIds.has(acc.id)) return;
          // Only fire when the args buffer is complete JSON.
          let specArgs: Record<string, unknown> | undefined;
          try { specArgs = JSON.parse(acc.args); } catch { return; }
          const canonical = TOOL_ALIASES[acc.name] || acc.name;
          if (!this.isReadOnly(canonical, specArgs)) return;
          this.midStreamExecutedIds.add(acc.id);
          const call: ToolCall = { id: acc.id, type: 'function', function: { name: acc.name, arguments: acc.args } };
          midStreamPromises.push(this.specExecCall(call));
        };
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
        // Cross-phrase cycle detection: the sliding window alone CANNOT catch
        // a repeating loop of K>2 distinct phrases (e.g. an 8-phrase reasoning
        // loop observed live at ~50 copies each — every phrase's in-window
        // count stays ~2, far below maxRep >= 8). Track phrase->recency over a
        // larger horizon instead: once a phrase re-occurs close behind ITS OWN
        // previous occurrence (cyclePeriod small), the stream is cycling.
        // The absolute per-phrase cap bounds long-window token burn even when
        // the cycle period is large.
        const lastSeenAt = new Map<string, number>(); // phrase -> phrase index
        let phraseIdx = 0;
        let minCyclePeriod = Number.POSITIVE_INFINITY;
        const CYCLE_PERIOD_MAX = 12;  // loop of up to 12 distinct phrases detected
        const CYCLE_REPS_REQUIRED = 4; // consecutive short-period recurrences
        let cycleStreak = 0;
        const PHRASE_ABS_CAP = 40;     // absolute repeats of any one phrase
        const phraseTotal = new Map<string, number>();
        const suppressReasoning = () => maxRep >= 3 || cycleStreak >= 2;
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

        const activeReasoning = this.resolveReasoning(task);
        sm.enter('stream-guard');
        // MCH-39 (strength/UX): headless runs look FROZEN during a long silent
        // model turn (kimi thinks 60-90s before the first token). A heartbeat
        // every 30s of stream silence tells the user the run is alive and how
        // long it's been thinking — the difference between "wait" and "kill it".
        const turnStartedAt = Date.now();
        let lastHeartbeatAt = turnStartedAt;
        const HEARTBEAT_MS = 30_000;
        for await (const chunk of activeProvider.streamChat(messages, this.toolDefs, { temperature: 0.2, signal: activeCallSignal.signal, reasoningEffort: activeReasoning })) {
          const now = Date.now();
          if (now - lastHeartbeatAt >= HEARTBEAT_MS) {
            lastHeartbeatAt = now;
            const elapsedS = Math.round((now - turnStartedAt) / 1000);
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[heartbeat] model thinking ${elapsedS}s… (still alive, ${this.context.effectiveContextTokens()} ctx tokens)` });
          }
          chunks.push(chunk);
          // MCH-64: accumulate streaming tool-call args and spec-execute the
          // moment a read-only call's JSON is complete.
          if (chunk.toolCalls) {
            for (const stc of chunk.toolCalls ?? []) {
              const idx = stc.index ?? 0;
              const acc = midStreamAcc.get(idx) ?? { id: stc.id ?? '', name: '', args: '' };
              if (!acc.id && stc.id) acc.id = stc.id;
              acc.name = acc.name || stc.function?.name || '';
              acc.args += stc.function?.arguments || '';
              midStreamAcc.set(idx, acc);
              maybeSpecExec(idx);
            }
          }
          if (chunk.reasoningContent) {
            const rChunk = chunk.reasoningContent || '';
            // Phrase tracking FIRST: reasoning loops must feed the repetition
            // guard too, and when a loop is detected we must STOP emitting the
            // flood to the TUI (the Oct-2 trace: 2030 reasoning events in 36s
            // at ~56 events/sec from a model cycling the same 8 sentences).
            let reasoningLooped = false;
            for (let i = 0; i < rChunk.length; i++) {
              const char = rChunk[i];
              phraseBuf += char;
              if (char === '\n' || char === ',' || char === '.') {
                const phrase = phraseBuf.trim();
                if (phrase.length >= 12) {
                  phraseIdx++;
                  const prevAt = lastSeenAt.get(phrase);
                  if (prevAt !== undefined) {
                    const period = phraseIdx - prevAt;
                    if (period <= CYCLE_PERIOD_MAX) {
                      cycleStreak++;
                      if (period < minCyclePeriod) minCyclePeriod = period;
                    } else {
                      cycleStreak = 0;
                    }
                  }
                  lastSeenAt.set(phrase, phraseIdx);
                  const total = (phraseTotal.get(phrase) ?? 0) + 1;
                  phraseTotal.set(phrase, total);
                  if (total >= PHRASE_ABS_CAP) reasoningLooped = true;
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
            if (cycleStreak >= CYCLE_REPS_REQUIRED || reasoningLooped) {
              looped = true;
              break;
            }
            if (!suppressReasoning()) {
              this.events.emit({ type: 'agent:reasoning', content: rChunk, agentId: this.id });
            }
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
                  phraseIdx++;
                  const prevAt = lastSeenAt.get(phrase);
                  if (prevAt !== undefined) {
                    const period = phraseIdx - prevAt;
                    if (period <= CYCLE_PERIOD_MAX) {
                      cycleStreak++;
                      if (period < minCyclePeriod) minCyclePeriod = period;
                    } else {
                      cycleStreak = 0;
                    }
                  }
                  lastSeenAt.set(phrase, phraseIdx);
                  const total = (phraseTotal.get(phrase) ?? 0) + 1;
                  phraseTotal.set(phrase, total);
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

            if (maxRep >= 8 || cycleStreak >= CYCLE_REPS_REQUIRED || streamBytes >= MAX_STREAM_BYTES || chunks.length >= MAX_STREAM_CHUNKS || runawayFlagged) {
              // High-confidence loop / runaway generation: stop streaming
              // before it floods output. cycleStreak catches K>2-phrase cycles
              // the sliding-window maxRep can never reach.
              looped = true;
              break;
            }

            // Early-warning suppression: once a phrase has repeated 3+ times
            // (or a cycle is forming), the model is likely degenerating. Stop
            // emitting chunks to the TUI so the user doesn't see identical
            // lines, but keep collecting so the loop detector can trigger.
            if (maxRep >= 3 || cycleStreak >= 2) {
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
                      this.events.emit({ type: 'message:chunk', content: scrubAnsiFragments(safeChunk), agentId: this.id });
                    }
                    streamBuf = partialMatch[0];
                    break;
                  } else {
                    this.events.emit({ type: 'message:chunk', content: scrubAnsiFragments(streamBuf), agentId: this.id });
                    streamBuf = '';
                  }
                } else {
                  const pre = streamBuf.slice(0, openIdx);
                  if (pre) {
                    this.events.emit({ type: 'message:chunk', content: scrubAnsiFragments(pre), agentId: this.id });
                  }
                  const isThought = openIdx === thoughtOpenIdx;
                  streamBuf = streamBuf.slice(openIdx + (isThought ? 9 : 7));
                  inThinkTag = true;
                  this.events.emit({ type: 'agent:log', agentId: this.id, message: 'Thinking…' });
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
        const callsByIndex = new Map<number, { id: string; name: string; args: string }>();
        for (const chunk of chunks) {
          if (chunk.toolCalls) {
            for (const tc of chunk.toolCalls ?? []) {
              const idx = tc.index ?? 0;
              const acc = callsByIndex.get(idx) ?? { id: tc.id, name: tc.function.name, args: '' };
              acc.name = acc.name || tc.function.name;
              acc.args += tc.function.arguments || '';
              callsByIndex.set(idx, acc);
            }
          }
        }
        let tool_calls = [...callsByIndex.values()].map((a) => ({ id: a.id, type: 'function' as const, function: { name: a.name, arguments: a.args } }));
        // MCH-64: wait for any mid-stream speculative executions to settle.
        // The calls REMAIN in tool_calls (the assistant message must pair with
        // every tool_call_id); their post-stream runMoolCall hits the
        // ExecutionRegistry replay path and appends the cached result with
        // zero re-execution latency.
        if (midStreamPromises.length > 0) {
          await Promise.all(midStreamPromises);
        }
        if (tool_calls.length === 0 && content) {
          const extracted = this.extractToolCallsFromText(content);
          if (extracted.length > 0) {
            tool_calls = extracted;
            this.events.emit({
              type: 'agent:log',
              agentId: this.id,
              message: `[tool-extract] recovered ${extracted.length} tool call(s) (${extracted.map(x => x.function.name).join(', ')}) from text output`,
            });
          }
        }
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

      // Hard per-response stall guard: the stream guards above only fire when
      // chunks ARRIVE (runaway repetition/capacity). A fully silent provider
      // hold (no chunks, no error) would otherwise freeze the agent mid-task
      // forever. Race the gather against a wall-clock timer so a silent stall
      // is surfaced as a normal retryable error instead of an infinite hang.
      //
      // On timeout we abort the active stream's controller FIRST so the
      // abandoned streamChat's
      // network request is actually torn down (not left holding a socket while
      // the loop moves on). This same bounded race is applied to the failover
      // retry below — the retry previously ran UNBOUNDED, so a silent hold on
      // the retry hung the agent forever, exactly the "freezes mid-task, never
      // recovers" symptom.
      const RAW_MODEL_TIMEOUT = Number(process.env.MOCHI_MODEL_RESPONSE_TIMEOUT_MS);
      const MODEL_RESPONSE_TIMEOUT_MS = Number.isFinite(RAW_MODEL_TIMEOUT) && RAW_MODEL_TIMEOUT > 0
        ? Math.max(1_000, RAW_MODEL_TIMEOUT)
        : 180_000; // 3 min per model reply
      // Race a gather against a wall clock; on timeout, abort the stream that
      // invocation is reading from so the abandoned network request is torn
      // down (not left holding a socket while the loop moves on) and surface
      // a clean `__timedOut` marker instead of an infinite hang.
      const boundedGather = async (messages: any) => {
        newCallController(); // fresh controller per invocation
        const stall = (resolve: (v: { __timedOut: true }) => void) => {
          const t = setTimeout(() => {
            activeCallSignal.abort(new Error(`model_response_timeout_${MODEL_RESPONSE_TIMEOUT_MS}`));
            resolve({ __timedOut: true });
          }, MODEL_RESPONSE_TIMEOUT_MS);
          return t;
        };
        let t: ReturnType<typeof setTimeout> | undefined;
        const stallP = new Promise<{ __timedOut: true }>((r) => { t = stall(r); });
        try {
          return await Promise.race([gatherStream(messages), stallP]);
        } finally {
          if (t !== undefined) clearTimeout(t);
          cleanupCallController();
        }
      };
      try {
        const raced = await boundedGather(packet.messages);
        if ('__timedOut' in raced) {
          // Stall guard fired: the provider accepted the request but streamed
          // nothing within MODEL_RESPONSE_TIMEOUT_MS. Previously this finished
          // the task as failed immediately — now treat it like any other
          // transient provider failure: failover → retry → checkpoint+finish
          // only when the bounded budget is exhausted.
          this.bumpStallRetries();
          // MCH-29b: a transport-level stall retry is NOT a task iteration.
          // It previously consumed one, so a flaky provider burned the task's
          // maxIterations budget with zero agent work and the run died as
          // 'max_iterations' instead of 'model_error'. Undo the loop increment
          // for stall retries; the per-endpoint stall budget bounds the loop.
          i = Math.max(0, i - 1);
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[model] no data for ${MODEL_RESPONSE_TIMEOUT_MS / 1000}s; aborting this response to avoid a mid-task stall.` });

          const alt = this.pickAlternateModel();
          if (alt) {
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[model-stall] Failing over to model ${alt}` });
            this.setActiveModel(alt);
            this.syncStallBudget();
            continue;
          }

          if (this.switchToNextProvider()) {
            this.syncStallBudget();
            continue;
          }

          if (this.stallRetries <= 2) {
            const backoff = 2500 * this.stallRetries;
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[model-stall] No alternate model. Retrying in ${backoff / 1000}s (attempt ${this.stallRetries}/2)...` });
            await new Promise(r => setTimeout(r, backoff));
            continue;
          }

          return this.finish(task, false, 'Model stream stalled (no response) — retries exhausted. Try again or switch models.', 'model_error');
        } else {
          response = raced;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.events.emit({ type: 'agent:log', agentId: this.id, message: `[model-call-error] ${message.slice(0, 160)}` });

        // Smart backoff for rate limits (429) to avoid immediately burning the retry
        if (message.toLowerCase().includes('429') || message.toLowerCase().includes('rate limit')) {
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[rate-limit] API busy. Applying 10s backoff...` });
          await new Promise(r => setTimeout(r, 10000));
        }

        await this.checkpointAndCompact('error');
        const retryPacket = this.context.buildPacket(this.toolDefs, task, repo);

        try {
          // The retry gets the SAME bounded stall guard as the primary call.
          // It previously ran UNBOUNDED, so a silent hold on the failover /
          // retry hung the agent forever — exactly "freezes mid-task, never
          // recovers".
          const retryRaced = await boundedGather(retryPacket.messages);
          if ('__timedOut' in retryRaced) {
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[model] retry stalled ${MODEL_RESPONSE_TIMEOUT_MS / 1000}s; treating as transient provider failure.` });
            this.bumpStallRetries();
            // MCH-29b: transport retry, not a task iteration (see above).
            i = Math.max(0, i - 1);

            const alt = this.pickAlternateModel();
            if (alt) {
              this.events.emit({ type: 'agent:log', agentId: this.id, message: `[model-stall] Failing over to model ${alt}` });
              this.setActiveModel(alt);
              this.syncStallBudget();
              continue;
            }

            if (this.switchToNextProvider()) {
              this.syncStallBudget();
              continue;
            }

            if (this.stallRetries <= 2) {
              const backoff = 2500 * this.stallRetries;
              this.events.emit({ type: 'agent:log', agentId: this.id, message: `[model-stall] No alternate model. Retrying in ${backoff / 1000}s (attempt ${this.stallRetries}/2)...` });
              await new Promise(r => setTimeout(r, backoff));
              continue;
            }

            return this.finish(task, false, 'Model stream stalled on retry — retries exhausted. Try again or switch models.', 'model_error');
          }
          response = retryRaced;
        } catch (retryErr) {
          const rMsgRaw = retryErr instanceof Error ? retryErr.message : String(retryErr);
          // Classify on BOTH attempts' errors: once the provider is marked
          // dead after the first failure, the retry short-circuits with
          // "Provider X is marked dead (<first line>…)" — dropping the API
          // detail line (e.g. "maximum context length") that identifies the
          // failure class. That sent context overflows into the generic
          // failover loop instead of the compaction path (outer `message` is
          // the full first-attempt error and is lexically in scope here).
          const rMsg = rMsgRaw.includes(message) ? rMsgRaw : `${rMsgRaw}\n${message}`;

          // Caller cancellation (Ctrl-C / runtime shutdown) is never retried
          // and never failed over: respect the reason and stop.
          if (this.abortSignal?.aborted) {
            try {
              const activeGoal = this.context.state.goal || task.title;
              this.workspace.saveCheckpoint(activeGoal, `Task aborted by caller at iteration ${i}.\nObjective: ${task.title}\nFiles touched: ${this.context.state.filesModified.join(', ') || 'none'}\nNext: Run "mochi resume" to continue.`);
            } catch { /* best effort */ }
            return this.finish(task, false, 'Run aborted by caller. Resume anytime with "mochi resume".', 'aborted');
          }

          // Permanent error detection (404 Not Found, 402 Insufficient Funds, 401/403):
          // Immediately fail over to the next provider/model without wasting 30s in cooldown pauses.
          const isPermanent = /404|not found|402|insufficient.*funds|401|unauthorized/i.test(rMsg || message);
          if (isPermanent) {
            if (this.switchToNextProvider()) {
              i = Math.max(0, i - 1);
              continue;
            }
            const alt = this.pickAlternateModel();
            if (alt) {
              this.events.emit({ type: 'agent:log', agentId: this.id, message: `[failover] Model unavailable (${(rMsg || message).slice(0, 80)}). Failing over to ${alt}` });
              this.setActiveModel(alt);
              i = Math.max(0, i - 1);
              continue;
            }
            return this.finish(task, false, `Model request failed: ${rMsg || message}. Try switching models with /model.`, 'model_error');
          }

          // Provider cooldown resilience: pause, wait cooldown, fail over or retry.
          // Transport retries are NOT task iterations (same rule as stalls
          // above): undo the loop increment so a flaky provider doesn't burn
          // the task's maxIterations budget with zero agent work.
          const isCooldown = /cooling down/i.test(rMsg) || /cooling down/i.test(message);
          if (isCooldown) {
            // When an entire provider is in cooldown, fail over to the next configured
            // provider FIRST so we do not loop candidate models on the broken endpoint.
            if (this.switchToNextProvider()) {
              i = Math.max(0, i - 1);
              continue;
            }
            const alt = this.pickAlternateModel();
            if (alt) {
              this.events.emit({ type: 'agent:log', agentId: this.id, message: `[cooldown] Provider cooling down. Failing over to ${alt}` });
              this.setActiveModel(alt);
              i = Math.max(0, i - 1);
              continue;
            }
            this.cooldownRetries++;
            if (this.cooldownRetries <= 2) {
              const waitMatch = /try again in ~?([\d.]+)s/i.exec(rMsg || message);
              const waitMs = waitMatch ? Math.max(1200, Math.ceil(parseFloat(waitMatch[1]) * 1000) + 500) : 5000 * this.cooldownRetries;
              this.events.emit({ type: 'agent:log', agentId: this.id, message: `[cooldown] Provider cooling down; pausing ${(waitMs / 1000).toFixed(1)}s before retry (${this.cooldownRetries}/2)` });
              await new Promise((r) => setTimeout(r, waitMs));
              i = Math.max(0, i - 1);
              continue;
            }
            try {
              const activeGoal = this.context.state.goal || task.title;
              this.workspace.saveCheckpoint(activeGoal, `Task paused due to provider cooldown at iteration ${i}.\nObjective: ${task.title}\nNext: Run "mochi resume" shortly.`);
            } catch { /* best effort */ }
            return this.finish(task, false, 'Provider is temporarily cooling down. Work checkpointed — resume with "mochi resume".', 'model_error');
          }

          // Failover & queue strategy for repeated rate limits: switch to an alternate model or queue backoff.
          // Same transport-retry accounting as stalls/cooldowns: not a task iteration.
          if (rMsg.toLowerCase().includes('429') || rMsg.toLowerCase().includes('rate limit')) {
            if (this.switchToNextProvider()) {
              i = Math.max(0, i - 1);
              continue;
            }
            const alt = this.pickAlternateModel();
            if (alt) {
              this.events.emit({ type: 'agent:log', agentId: this.id, message: `[rate-limit] Primary model exhausted. Failing over to ${alt}` });
              this.setActiveModel(alt);
              i = Math.max(0, i - 1);
              continue; // Restart the loop iteration with the new model
            }
            this.rateLimitRetries++;
            if (this.rateLimitRetries <= 3) {
              const waitMs = 4000 * this.rateLimitRetries;
              this.events.emit({ type: 'agent:log', agentId: this.id, message: `[rate-limit] Backing off ${waitMs / 1000}s before retry (${this.rateLimitRetries}/3)...` });
              await new Promise((r) => setTimeout(r, waitMs));
              i = Math.max(0, i - 1);
              continue;
            }
            try {
              const activeGoal = this.context.state.goal || task.title;
              this.workspace.saveCheckpoint(activeGoal, `Task paused due to rate limits at iteration ${i}.\nObjective: ${task.title}\nNext: Run "mochi resume" once rate limits clear.`);
            } catch { /* best effort */ }
            return this.finish(task, false, 'Rate limit ceiling reached after retries. Work checkpointed — resume with "mochi resume".', 'model_error');
          }

          // Context limit exceeded: compact history immediately and retry seamlessly.
          if (/context.*length|maximum context|prompt is too long|token.*limit|too many tokens|context_length_exceeded/i.test(rMsg)) {
            this.contextLimitRetries++;
            if (this.contextLimitRetries > 3) {
              // Compaction is not shrinking the prompt (e.g. a single message
              // larger than the window): the `i - 1` retry below re-consumes
              // the SAME iteration forever — observed 240-minute spins that
              // never hit maxIterations. Fail over to another model once;
              // otherwise stop honestly instead of looping.
              const altCtx = this.pickAlternateModel();
              if (altCtx) {
                this.events.emit({ type: 'agent:log', agentId: this.id, message: `[context-limit] compaction ineffective; failing over to ${altCtx}` });
                this.setActiveModel(altCtx);
                this.contextLimitRetries = 0;
                i = Math.max(0, i - 1);
                continue;
              }
              return this.finish(task, false, `Context window limit hit ${this.contextLimitRetries - 1}x and compaction did not shrink the prompt (${rMsg.slice(0, 200)}).`, 'model_error');
            }
            this.events.emit({
              type: 'agent:log',
              agentId: this.id,
              message: `[context-limit] Model context window reached (${rMsg.slice(0, 80)}). Auto-compacting history and retrying... (${this.contextLimitRetries}/3)`,
            });
            // Learn the real window from the rejection: the prompt we just sent
            // was too long, so it is an upper bound on what this model accepts.
            // Tighten the budget now so THIS retry compacts below the cliff.
            const rejectedAt = this.context.effectiveContextTokens();
            recordContextRejection(this.config.model.model, this.config.model.provider, rejectedAt);
            const tightened = Math.min(this.budgetTokens(), learnedWindowBudget(this.config.model.model, this.config.model.provider) ?? this.budgetTokens(), Math.floor(rejectedAt * 0.85));
            if (tightened < this.budgetTokens()) {
              this.effectiveBudgetTokens = tightened;
              this.context.setBudgetTokens(tightened);
            }
            // B15: compaction must be allowed to go DEEPER than the recency
            // floor when the budget just shrank — the old hard-coded floor
            // made this recovery a no-op once history hit the floor. Derive
            // the floor from the tightened budget (≈4 chars/token): a 4K
            // budget keeps ~2 recent messages' worth of headroom, clamped to
            // at least 2 and at most the default floor.
            const perMsgEstimate = 4000;
            const tightenedFloor = Math.max(2, Math.min(this.context.messageCount - 2, Math.floor(tightened / perMsgEstimate)));
            await this.checkpointAndCompact('floor', tightenedFloor);
            i = Math.max(0, i - 1);
            continue;
          }

          // Transient transport aborts ("The operation was aborted",
          // ECONNRESET, ETIMEDOUT, socket hang up, ...) used to die right
          // here as model_error — 5 of 12 recent user traces ended this way
          // minutes into real work. These are recoverable provider-side
          // stream drops, NOT local stalls (those carry the
          // model_response_timeout marker and are handled above): fail over
          // to an alternate model, or retry the same model with backoff when
          // every fallback has been tried. Both paths are bounded — the
          // outer iteration cap plus the explicit 3-retry budget below.
          if (!rMsg.includes('model_response_timeout') && /operation was aborted|terminated|premature close|econnreset|econnrefused|etimedout|fetch failed|socket hang up|network error/i.test(rMsg)) {
            const alt = this.pickAlternateModel();
            if (alt) {
              this.events.emit({ type: 'agent:log', agentId: this.id, message: `[transient] transport abort ("${rMsg.slice(0, 60)}"). Failing over to ${alt}` });
              this.setActiveModel(alt);
              i = Math.max(0, i - 1);
              continue;
            }
            this.transientAbortRetries++;
            if (this.transientAbortRetries <= 3) {
              this.events.emit({ type: 'agent:log', agentId: this.id, message: `[transient] transport abort; retrying after backoff (${this.transientAbortRetries}/3)` });
              await new Promise(r => setTimeout(r, 2500 * this.transientAbortRetries));
              i = Math.max(0, i - 1);
              continue;
            }
            if (this.switchToNextProvider()) {
              i = Math.max(0, i - 1);
              continue;
            }
          }

          const alt = this.pickAlternateModel();
          if (alt) {
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[model-error] Failing over to model ${alt}` });
            this.setActiveModel(alt);
            i = Math.max(0, i - 1);
            continue;
          }

          if (this.switchToNextProvider()) {
            i = Math.max(0, i - 1);
            continue;
          }

          return this.finish(task, false, `Model request failed: ${message}`, 'model_error');
        }
      }
      if (response.usage) {
        const u = response.usage;
        this.tokensUsed += u.totalTokens;
        this.tokensIn += u.promptTokens ?? 0;
        this.tokensOut += u.completionTokens ?? 0;
        this.tokensCached += u.cachedTokens ?? 0;
        // Context consumed by THIS request = the model's own prompt+completion
        // counts. No local estimation — the provider measured it.
        this.lastContextUsed = (u.promptTokens ?? 0) + (u.completionTokens ?? 0);
        // Budget accounting — count ONLY freshly generated (output) tokens as
        // the LIMIT resource. Counting totalTokens (which re-bills the whole
        // prompt+history on every call) made the cumulative budget hit
        // safety.maxTokens after a dozen-odd iterations of ANY long task:
        // ratio() hit 0 → phase 'exhausted' → canExecuteTool() false → every
        // tool call vetoed (the "token budget exhausted, cannot make edits"
        // failure class). Output tokens are the resource that actually scales
        // with agent work. Cost is NOT estimated locally at all: it is the
        // provider's own billing figure when the usage object carries one
        // (OpenRouter-style usage.cost), else 0 and labeled "not reported".
        const providerCost = u.costUsd ?? 0;
        this.budget?.recordTokens(
          u.completionTokens ?? u.totalTokens,
          this.config.model.model,
          this.config.model.provider,
          providerCost,
        );
        // Phase 4 (VNext): feed REAL provider usage into the context engine so
        // the compaction floor triggers on actuals instead of the chars/3.8 guess.
        this.context.recordReportedUsage(u.promptTokens);
        // Surface REAL provider usage to the TUI: input, output, cache reads, and cost in USD.
        this.costUsd += providerCost;
        this.events.emit({
          type: 'usage:updated',
          agentId: this.id,
          inputTokens: Math.max(0, (u.promptTokens ?? 0) - (u.cachedTokens ?? 0)),
          outputTokens: u.completionTokens ?? 0,
          cacheTokens: u.cachedTokens ?? 0,
          totalTokens: u.totalTokens ?? 0,
          costUsd: this.budget?.snapshot(this.config.model.model).usedCostUsd ?? providerCost,
        });
      } else {
        // B25: a response with NO usage object must also reach the context
        // engine — failover/degraded endpoints stop sending usage, and if
        // only the zero/undefined reports cleared the sticky value, the last
        // reported number would freeze the stage-2 compaction gates forever.
        this.context.recordReportedUsage(undefined);
      }
      // Reset retry counters on any successful model output. stallRetries was
      // previously omitted: a couple early transient timeouts would leave it non-zero
      // so the NEXT (potentially unrelated) stall exhausted the retry budget and
      // finished the task as model_error instead of failing over. See MCH-25.
      if ((response.content && response.content.trim()) || response.toolCalls?.length) {
        this.emptyResponseCount = 0;
        this.transientAbortRetries = 0;
        this.rateLimitRetries = 0;
        this.cooldownRetries = 0;
        this.stallRetries = 0;
        this.contextLimitRetries = 0;
        this.stallRetriesByKey.delete(this.stallKey());
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
      if (response.looped) {
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
          if (this.switchToNextProvider()) {
            this.streamLoopNudges = 0;
            this.context.addMessage({ role: 'system', content: `The previous provider degenerated. You are now a fresh model continuing this task. Summarize nothing; just continue the task directly with a tool call or a direct answer.` });
            continue;
          }
          try {
            const activeGoal = this.context.state.goal || task.title;
            this.workspace.saveCheckpoint(activeGoal, `Task paused: stream loop detected at iteration ${i}.\nObjective: ${task.title}\nFiles touched: ${this.context.state.filesModified.join(', ') || 'none'}\nNext: Run "mochi resume" with an alternate model.`);
          } catch { /* best effort */ }
          return this.finish(task, false, 'The model repeatedly restreamed the same block and could not produce a clean answer. Work checkpointed; resume with "mochi resume".', 'model_error');
        }
        if (truncatedContent) {
          this.context.addMessage({
            role: 'assistant',
            content: truncatedContent,
          });
        }
        this.context.addMessage({
          role: 'system',
          content: 'Focus directly on answering the user’s request concisely. Do not repeat previous thoughts or text. Deliver your direct answer now.',
        });
        this.events.emit({ type: 'agent:log', agentId: this.id, message: `[stream-loop] truncated looped response` });
        continue;
      }
      this.lastStrategy = response.toolCalls?.[0]?.function.name ?? response.content?.slice(0, 60) ?? '';

      // Anti-"same message" guard: if the model returns the exact same
      // no-tool-call answer again, treat it as stagnation — NEVER as success.
      // The old `!this.fileChanged` gate disabled this guard for the whole
      // rest of the run once ANY file was edited — so a model that repeats
      // the same two prose lines after its first edit burned every remaining
      // iteration (~40s each on free providers ≈ "five minutes in, spitting
      // the same two lines"). Semantics:
      //   • first repeat  → inject a stop-repeating nudge, keep looping
      //   • second repeat → finish as tool_loop (a repeated answer is failed
      //     recovery, not a deliverable; a verification failure keeps
      //     ownership of its own bounded loop with rollback)
      //   • any tool call resets the streak (progress happened)
      // The verify-retry exemption is load-bearing: while verification is
      // actively failing, the verify machinery (bounded by maxVerifyRetries,
      // with rollback) owns the loop — policing repeated prose there hijacks
      // the retry/rollback/escalation flow the harness tests pin. Fresh runs
      // (verifyCount===0) and post-pass stalls stay policed.
      if (!this.planMode
          && (!response.toolCalls || response.toolCalls.length === 0)
          && (this.verifyCount === 0 || this.lastVerifyPassed)) {
        const text = (response.content ?? '').trim();
        if (text && text === this.lastCompletionAnswer) {
          this.sameAnswerStreak++;
          if (this.planNudges > 0) {
            return this.finish(task, false, 'No execution progress after a recovery nudge. Last reply:\n' + text, 'tool_loop');
          }
          if (this.sameAnswerStreak >= 2) {
            return this.finish(task, false, 'Stopped: the model repeated the same no-tool answer instead of working. Last reply:\n' + text, 'tool_loop');
          }
          this.context.addMessage({
            role: 'system',
            content: 'You just repeated your previous answer verbatim. Do NOT repeat it. Either call a tool to make real progress, or give a NEW final answer.',
          });
          this.events.emit({ type: 'agent:log', agentId: this.id, message: '[same-answer] verbatim repeat; nudging for real progress' });
          continue;
        }
        if (text) this.lastCompletionAnswer = text;
        this.sameAnswerStreak = 0;
      }

      // Reset the same-answer streak on ANY tool execution round: tools are
      // real progress, so "prose A -> tools -> prose A" (a legitimate interim
      // summary repeated between tool batches) must NOT complete the task.
      // The comment above previously promised this reset but the code never
      // had it — a repeated post-tool recap finished the task as 'completed'
      // with zero verification.
      if (response.toolCalls?.length) {
        this.sameAnswerStreak = 0;
        this.lastCompletionAnswer = '';
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        sm.enter('tool-exec');
        sm.recordToolCalls(response.toolCalls.length);
        this.context.addMessage({ role: 'assistant', content: scrubAnsiFragments(response.content ?? ''), tool_calls: [...response.toolCalls] });
        // Plan mode: allow read-only research, but veto any mutating tool and
        // steer the model back to producing a plan. Every vetoed call still
        // gets a tool response (providers reject dangling tool_call_ids), and
        // the loop continues so the model can hand back its plan text. Only a
        // model that keeps attempting edits after a veto is stopped outright.
        // Read-only is an ALLOWLIST: anything not explicitly read-only (shell,
        // write/edit/delete/patch, git, MCP tools, ...) is vetoed.
        // B9 restructure: `verify` is EXEMPT from the veto when it can run
        // against a tree snapshot — plan-mode research legitimately includes
        // "does the project's own check pass on the current tree?" — with any
        // tracked-file modification the command introduces rolled back before
        // the loop continues (agent/plan-verify.ts). Destructive-classified
        // commands and non-git workspaces still veto (fail closed). The gate
        // classifies the command the TOOL WILL ACTUALLY RUN: verify's
        // `command` arg can be a repo-derived alias (test/build/typecheck/
        // lint), and a `target` arg is appended before execution — the gate
        // classifies the full post-append string via resolveVerifyCommand,
        // never the raw arg. Both `destructive` AND `network` classifications
        // veto (fail closed): plan-mode research means "the project's own
        // checks", and check commands don't need to reach the network.
        if (this.planMode) {
          const isMutating = (c: ToolCall) => !this.isReadOnly(c.function.name, this.parseArgs(c.function.arguments));
          // B27 restructure: a fetch call to a host the OPERATOR declared
          // read-only (safety.planModeNetworkReads) is exempt from the veto —
          // POST-based read APIs (GraphQL queries, search APIs) are legitimate
          // plan-mode research. Exact hostname match; misdeclared hosts are
          // the operator's authority, same trust level as permissions.network.
          const planNetworkReads = (this.config.safety?.planModeNetworkReads ?? []).map((h) => h.toLowerCase());
          const isPlanNetworkRead = (c: ToolCall) => {
            const canonical = TOOL_ALIASES[c.function.name] || c.function.name;
            if (canonical !== 'fetch' || planNetworkReads.length === 0) return false;
            if (!isFetchMutationRequest(canonical, this.parseArgs(c.function.arguments))) return false; // GET/HEAD already read-only
            try {
              const host = new URL(String(this.parseArgs(c.function.arguments).url ?? '')).hostname.toLowerCase();
              return planNetworkReads.includes(host);
            } catch {
              return false; // unparseable URL → not exempt
            }
          };
          const isPlanVerify = (c: ToolCall) => {
            const canonical = TOOL_ALIASES[c.function.name] || c.function.name;
            if (canonical !== 'verify') return false;
            const args = this.parseArgs(c.function.arguments);
            const resolved = resolveVerifyCommand(args, this.cwd);
            // Fail closed: null (unresolvable), 'destructive' AND 'network'
            // all veto — only genuinely low-risk check commands run.
            const risk = resolved !== null ? classifyCommand(resolved) : null;
            return risk === 'low';
          };
          const planVerifyCalls = response.toolCalls.filter(isPlanVerify);
          if (planVerifyCalls.length > 0) {
            // Snapshot each verify call's pre-state; a failed snapshot vetoes
            // that call (containment is a precondition, not a best effort).
            const snapshots = new Map<string, PlanVerifySnapshot | null>();
            for (const c of planVerifyCalls) snapshots.set(c.id, await snapshotTree(this.cwd));
            const runnable = planVerifyCalls.filter((c) => snapshots.get(c.id) !== null);
            const unrunnable = planVerifyCalls.filter((c) => snapshots.get(c.id) === null);
            // The exemption must NOT inflate planVetoes with successful
            // research — the escalation counter tracks refusals. Unrunnable
            // verify calls ARE refusals and count.
            this.planVetoes += unrunnable.length;
            // Read-only batch + exempt read-host fetches + runnable verify
            // calls execute normally (the permission gate still applies to
            // verify: dangerous:true).
            const toExecute = [
              ...response.toolCalls.filter((c) => !isMutating(c) || isPlanNetworkRead(c)),
              ...runnable,
            ];
            if (toExecute.length > 0) await this.executeToolCalls(toExecute);
            for (const c of runnable) {
              const snap = snapshots.get(c.id)!;
              const { rolledBack, untrackedLeftover } = await rollbackTracked(this.cwd, snap);
              if (rolledBack.length > 0 || untrackedLeftover.length > 0) {
                this.context.addMessage({
                  role: 'system',
                  content: `PLAN MODE verify rollback: the verify command modified tracked files (${rolledBack.join(', ')}) — they were restored to the pre-command state.${untrackedLeftover.length ? ` Untracked leftovers (not deleted): ${untrackedLeftover.join(', ')}` : ''}`,
                });
                this.events.emit({ type: 'agent:log', agentId: this.id, message: `[plan-mode] verify modified ${rolledBack.length} tracked file(s); rolled back` });
              }
            }
            for (const c of response.toolCalls) {
              if (!isMutating(c)) continue;
              if (isPlanNetworkRead(c)) continue;
              if (isPlanVerify(c) && snapshots.get(c.id) !== null) continue;
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
            this.events.emit({ type: 'agent:log', agentId: this.id, message: '[plan-mode] handled batch (verify-with-rollback); requesting plan' });
            continue;
          }
          const notExempt = response.toolCalls.filter((c) => isMutating(c) && !isPlanNetworkRead(c));
          if (notExempt.length > 0) {
            // Only REFUSALS feed the escalation counter: one per batch (the
            // original semantics). A batch whose only "mutating" calls are
            // exempted read-host fetches is successful research, not the
            // model fighting plan mode.
            this.planVetoes++;
            // Mixed batches: run the read-only calls (and exempt read-host
            // fetches) so their ids are answered, veto only the refusals.
            const runFirst = response.toolCalls.filter((c) => !isMutating(c) || isPlanNetworkRead(c));
            if (runFirst.length > 0) await this.executeToolCalls(runFirst);
            for (const c of notExempt) {
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
        // Loop guard: identical tool calls with NO progress between them means the
        // model is stuck. The bar is high — we only count a "repeat" when the
        // signature matches AND the previous run produced the same error or no
        // change. Read-only exploration (read/glob/tree/search) and batch edits
        // to many distinct files legitimately produce repeated tool names and
        // MUST NOT trip this guard.
        const nowSig = response.toolCalls.map((c) => {
          const canonical = TOOL_ALIASES[c.function.name] || c.function.name;
          const args = normalizeToolArgs(canonical, this.parseArgs(c.function.arguments || '{}'));
          const sortedKeys = Object.keys(args).sort();
          const sortedArgs: Record<string, unknown> = {};
          for (const k of sortedKeys) sortedArgs[k] = args[k];
          return `${canonical}:${JSON.stringify(sortedArgs)}`;
        }).join('|');
        const prevSig = this.lastSig;
        if (nowSig === prevSig) this.sigStreak++;
        else {
          this.sigStreak = 1;
          // Strategy changed: the stuck warning is no longer true.
          if (this.context.stuckSignal) this.context.stuckSignal = null;
        }
        this.lastSig = nowSig;

        // Oscillatory cycle detection (A-B-A-B or A-B-C-A-B-C ping-pong loops):
        this.recentToolSignatures.push(nowSig);
        if (this.recentToolSignatures.length > 8) this.recentToolSignatures.shift();
        const rLen = this.recentToolSignatures.length;
        let isCycle = false;
        if (rLen >= 4 &&
            this.recentToolSignatures[rLen - 1] === this.recentToolSignatures[rLen - 3] &&
            this.recentToolSignatures[rLen - 2] === this.recentToolSignatures[rLen - 4]) {
          isCycle = true;
        } else if (rLen >= 6 &&
                   this.recentToolSignatures[rLen - 1] === this.recentToolSignatures[rLen - 4] &&
                   this.recentToolSignatures[rLen - 2] === this.recentToolSignatures[rLen - 5] &&
                   this.recentToolSignatures[rLen - 3] === this.recentToolSignatures[rLen - 6]) {
          isCycle = true;
        }
        const isAllReadOnly = response.toolCalls.every((c) => this.isReadOnly(c.function.name, this.parseArgs(c.function.arguments)));
        // MCH-78: failure-cluster dedup — the same tool signature producing the
        // same error 2+ times is a failed cluster: don't let the model re-run it
        // verbatim again. Compares against prevSig (captured before lastSig
        // update above); the old code compared nowSig to the just-assigned
        // lastSig and was always true, false-firing on any error.
        if (nowSig === prevSig && this.errors.length > 0 && !isAllReadOnly) {
          const lastErr = this.errors[this.errors.length - 1];
          if (this.failureClusterSig === nowSig) {
            this.failureClusterCount++;
          } else {
            this.failureClusterSig = nowSig;
            this.failureClusterCount = 1;
          }
          if (this.failureClusterCount === 2) {
            this.context.addMessage({
              role: 'system',
              content: `LOOP ALERT: this exact tool call already failed with the same error. Do NOT re-run it unchanged. The actual error was:\n${String(lastErr).slice(0, 500)}\nFix the root cause (different args, different approach, or investigate dependencies) before calling it again.`,
            });
          } else if (this.failureClusterCount >= 3) {
            return this.finish(task, false, `Loop guard: the same failing tool call was retried ${this.failureClusterCount} times with identical errors. Last error:\n${String(lastErr).slice(0, 500)}`, 'tool_loop');
          }
        } else if (nowSig !== prevSig) {
          this.failureClusterSig = null;
          this.failureClusterCount = 0;
        }
        // NOTE: no `!this.fileChanged` gate here — the old one disabled the
        // oscillation guard for the rest of the run after the FIRST edit, so a
        // model that edited once then ping-ponged A-B-A-B on failing calls was
        // never cut short. Successful mutations still reset cycleNudges in
        // trackFileChange(), so legitimate batch work keeps flowing.
        if (isCycle && !isAllReadOnly) {
          this.cycleNudges++;
          if (this.cycleNudges >= 3) {
            return this.finish(task, false, 'Loop guard: stopped after detecting an oscillatory tool loop.', 'tool_loop');
          }
          this.context.addMessage({
            role: 'system',
            content: 'You are caught in an alternating loop between repeated mutating tool calls. Stop this cycle immediately: step back, inspect why this sequence is failing to make progress, and try a completely different approach or conclude now.',
          });
        } else if (!isCycle && this.cycleNudges > 0) {
          this.cycleNudges = Math.max(0, this.cycleNudges - 1);
        }

        // Was raised from 3 -> 8 so that legitimate batch work (e.g. editing
        // many files in sequence, repeated reads on a long file tree) does
        // not get cancelled. A truly stuck model will hit 8 identical calls
        // in a row, which never happens for real work.
        if (this.sigStreak >= 8) {
          this.nudgeInjections++;
          if (this.nudgeInjections >= 2) {
            return this.finish(task, false, 'Loop guard: stopped after repeated identical tool calls and failed recovery nudges.', 'tool_loop');
          }
          this.context.addMessage({ role: 'system', content: 'You are repeating the same tool call. Stop issuing tools and give a final answer now without any tool calls.' });
          this.sigStreak = 0;
          // Phase 5: the state prompt now also carries the pattern so the
          // model sees it even after the nudge message is far back.
          this.context.stuckSignal = `You have issued ${this.nudgeInjections} repeated-tool-call nudges. Change strategy or answer now.`;
        }
        this.toolCallsTotal++;
        // Cumulative repeated-tool-name breaker. Previously: ANY 4 calls to the
        // same mutating tool without a file change would finish the task as a
        // tool_loop — which made multi-file refactors (10 edits to 10 files)
        // and shell pipelines that re-invoke the same binary impossible.
        // New rule: only fire when (a) more than 12 calls to the same mutating
        // tool happened AND (b) the SAME error has repeated 3+ times
        // (consecutiveToolErrors entries are deleted on success, so "no
        // progress" is implied by the error requirement). The old clause
        // "(a) no file changed yet" is gone: it disabled this breaker for the
        // rest of the run after the FIRST edit, letting post-edit stuck loops
        // with changing arguments spin unbounded. Read-only tools excluded.
        {
          let mutatingRepeats = 0;
          let mutatingTool = '';
          let sameErrorRepeats = 0;
          for (const c of response.toolCalls) {
            const canonical = TOOL_ALIASES[c.function.name] || c.function.name;
            if (this.isReadOnly(canonical, this.parseArgs(c.function.arguments))) continue; // never abort on read-only gathering
            mutatingRepeats++;
            mutatingTool = canonical;
            const errInfo = this.consecutiveToolErrors.get(canonical);
            if (errInfo && errInfo.count >= 3) sameErrorRepeats++;
          }
          if (mutatingRepeats > 0) {
            const totalRepeats = this.toolNameCounts.get(mutatingTool) ?? 0;
            this.toolNameCounts.set(mutatingTool, totalRepeats + mutatingRepeats);
            // 12 calls of the same mutating tool + same-error 3+ times = real stuck loop.
            // Anything less is legitimate batch work (refactor N files, run a build
            // pipeline, etc.).
            if ((totalRepeats + mutatingRepeats) >= 12 && sameErrorRepeats > 0) {
              return this.finish(task, false,
                `Loop guard: '${mutatingTool}' was called ${totalRepeats + mutatingRepeats} times with the same error and no progress. Change strategy or finish.`,
                'tool_loop');
            }
          }
        }
        // Chat-task tool cap: a chat prompt (hello, Q&A, explain) should answer
        // directly once context is gathered rather than running unbounded exploratory rounds.
        if (taskKind === 'chat') {
          this.chatToolRounds++;
          if (this.chatToolRounds === 3) {
            this.context.addMessage({
              role: 'system',
              content: 'You have gathered sufficient context for this chat query. Synthesize your findings and provide your direct answer now without making any further tool calls.',
            });
          } else if (this.chatToolRounds >= 5) {
            // Finish with the model's REAL prose, never a canned placeholder:
            // this string becomes the run's final summary, and users literally
            // saw "Synthesized answer for chat query." as their entire result.
            const msgs = this.context.getMessages();
            let lastText = '';
            for (let mi = msgs.length - 1; mi >= 0; mi--) {
              const m = msgs[mi];
              if (m.role !== 'assistant') continue;
              const t = (typeof m.content === 'string' ? m.content : contentText(m)).trim();
              if (t) { lastText = t; break; }
            }
            if (!lastText) lastText = (response.content ?? '').trim();
            const summary = scrubAnsiFragments(lastText
              ? (lastText.length > 1500 ? `${lastText.slice(0, 1500)}…` : lastText)
              : 'Answered from gathered context.');
            return this.finish(task, true, summary, 'completed');
          }
        }
        // Global tool-call ceiling: was 40, raised to 200 because large multi-file
        // refactors and codebase-wide migrations legitimately need many calls.
        // A truly runaway model is already caught by the signature/breaker above.
        if (this.toolCallsTotal > 200) {
          return this.finish(task, false, 'Too many tool calls; stopping to avoid an infinite loop.', 'tool_loop');
        }
        await this.executeToolCalls(response.toolCalls);
        // Post-verify-pass finish drive: verified work + a wandering model
        // gets nudged to conclude, then harness-finished. Edits disarm
        // (pass is stale); reads/shells-only turns count up.
        const driveNames = response.toolCalls.map((c) => c.function.name);
        const driveResult = await this.postPassDrive(task, driveNames);
        if (driveResult) return driveResult;
        // MCH-100: simple-script fast path. After a write/edit batch in a
        // script task whose prompt names the run command, execute it
        // harness-side right here and hand the output to the model — the
        // next provider round sees "edits done + output" instead of burning
        // a full round just to type the run command (live r1 trace: ~7-11s
        // per round-trip). The model can still react to the output; verify()
        // still gates completion.
        if (isSimpleScriptTask(task) && !this.taskRunExecuted) {
          const runCmd = this.extractTaskRunCommand(task);
          const touched = response.toolCalls.some((tc) => ['write', 'edit', 'patch', 'replace_symbol'].includes(TOOL_ALIASES[tc.function.name] || tc.function.name));
          if (runCmd && touched) {
            this.taskRunExecuted = true;
            const out = await this.runShell(runCmd, 60);
            const tail = out.length > 2000 ? out.slice(-2000) : out;
            this.context.addMessage({
              role: 'system',
              content: `[auto-run] The task's requested command was executed harness-side:\n$ ${runCmd}\n${tail.trim() || '(no output)'}\nexit=0. React to this output in your next reply; do NOT re-run it unless you changed code since.`,
            });
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[mch100] auto-ran task command: ${runCmd}` });
          }
        }
        // MCH-113b: after the first file write in a simple script task, tell
        // the model the finish line is one command away. Live traces (spd3)
        // show the model spending its FINAL provider round (~2.4-14s) on
        // `git diff --stat && git diff` ceremony before finishing. The local
        // hygiene review (mch101) already covers script-sized diffs, so the
        // diff round-trip buys nothing for this task class.
        else if ((isSimpleScriptTask(task) || isTrivialWriteTask(task)) && !this.finishHintSent && response.toolCalls.some((tc) => ['write', 'edit', 'patch', 'replace_symbol'].includes(TOOL_ALIASES[tc.function.name] || tc.function.name))) {
          this.finishHintSent = true;
          this.context.addMessage({
            role: 'system',
            content: `[express finish] File change done. Run your task's own verification command (if any) next, then FINISH — do not run git status/git diff or re-inspect state; the harness reviews the diff locally.`,
          });
          this.events.emit({ type: 'agent:log', agentId: this.id, message: '[mch113b] express finish hint sent after first file write' });
        }
        continue;
      }

      // No tool calls: decide based on whether real edits happened.
      if (!this.fileChanged) {
        if (response.content && response.content.trim()) {
          // A forced recovery plan is an interim artifact, not a delivery.
          // The auto-escape directive asks for one plan turn, then resumed
          // editing. Do not let that plan satisfy the run merely because
          // earlier read-only calls incremented the tool counter.
          if (this.autoPlanEscapePending && !this.planMode && taskKind !== 'chat') {
            this.context.addMessage({
              role: 'system',
              content: 'RECOVERY PLAN RECEIVED — resume execution now. Call a work tool (write/edit/patch/shell/verify) that changes or checks the task outcome. Do not finish with another plan, summary, or preamble until verification has evidence.',
            });
            this.events.emit({ type: 'agent:log', agentId: this.id, message: '[auto-plan-escape] recovery plan received; requiring resumed execution' });
            continue;
          }
          // In plan mode the deliverable is the plan itself: a reply that does
          // not look like a plan (e.g. "I'll research the codebase first")
          // is a preamble, not a result. Nudge the model back on task until
          // it either produces a plan or exhausts the nudge budget.
          if (this.planMode && !isPlanShaped(response.content)) {
            this.planNudges++;
            if (this.planNudges > 3) {
              return this.finish(task, false, 'Planner never produced a plan. Last reply:\n' + response.content, 'max_iterations');
            }
            // MCH-28: if the model already submitted the plan via accept_plan,
            // a short confirmation reply is a valid ending, not a preamble.
            if (this.planAccepted) {
              const planText = this.planAcceptedText || response.content.trim() || 'Planned. No files were changed.';
              return this.finish(task, true, planText, 'completed');
            }
            this.context.addMessage({
              role: 'system',
              content: 'PLAN MODE: that was a preamble, not a plan. Submit your actual plan by calling the accept_plan tool with the plan text as its argument (numbered steps, files to change, risks, verification), then end your turn.',
            });
            this.events.emit({ type: 'agent:log', agentId: this.id, message: '[plan-mode] non-plan reply; nudging for the plan' });
            continue;
          }
          // MCH-28: explicit-acceptance ending. If the plan was submitted via
          // the accept_plan tool, even a plan-shaped prose reply now ends plan
          // mode with the SUBMITTED plan as the deliverable (artifact, not
          // regex-guessed prose).
          if (this.planAccepted && this.planMode && !this.fileChanged) {
            const planText = this.planAcceptedText || (response.content ?? '').trim() || 'Planned. No files were changed.';
            return this.finish(task, true, planText, 'completed');
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

          // If the task promises file output (explicit fileScope, file-shaped
          // criteria, or a creation-led request like "code a game") and no
          // files were modified yet, nudge ONCE to execute the tool rather
          // than completing on preamble. Single-nudge semantics are pinned by
          // harness tests (request budgets); a second nudge would break the
          // "still fails within 2 requests" and "recap completes in 3" flows.
          // The counter is separate from planNudges so a file-guard nudge does
          // not arm the same-answer instant-death fast path.
          const expectsFiles = expectsFileOutput(task.title, task.description ?? '', taskKind, task.fileScope, task.acceptanceCriteria ?? []);
          // An execution preamble is not a deliverable, even when the planner
          // omitted fileScope. Keep this narrow: substantive explanations and
          // read-only findings must still be allowed to finish without edits.
          const executionPreamble = ['implement', 'fix', 'refactor', 'test', 'document'].includes(taskKind)
            && response.content.trim().length < 500
            && /^(?:I(?:['’]ll| will| am going to)|Let me)\s+(?:inspect|check|read|explore|investigate|create|write|implement|fix|update|modify|start|begin)\b/i.test(response.content.trim());
          if ((expectsFiles || executionPreamble) && !this.planMode && taskKind !== 'chat' && this.fileGuardNudges < 1) {
            this.fileGuardNudges++;
            this.context.addMessage({
              role: 'system',
              content: 'You responded with text, but no files have been created or modified yet for this task. Use the write tool to create the deliverable files first (then a cheap syntax check), instead of describing them. Do NOT run the repo-wide test suite for a new build.',
            });
            this.events.emit({ type: 'agent:log', agentId: this.id, message: '[file-guard] expected file changes; nudging to call write/edit tool' });
            continue;
          }
          // Nudged once and still zero tool calls with zero files: failed
          // recovery, not a deliverable. Fail so goal self-review retries.
          // (Requires toolCallsTotal===0: vetoed/blocked or read-only flows
          // that DID run tools complete normally below.)
          if ((expectsFiles || executionPreamble) && !this.planMode && taskKind !== 'chat' && this.fileGuardNudges >= 1 && this.toolCallsTotal === 0) {
            return this.finish(task, false, 'Incomplete: the task requires file output but no files were created or modified and no tools ran. Last reply:\n' + response.content, 'tool_loop');
          }
          // A failed mutation proves file INTENT — prose cannot stand in for
          // it. After one file-guard nudge, either the failed write's target
          // exists on disk now (the model recovered out-of-band, e.g. via
          // shell — fall through so the normal gates judge it) or the claim
          // is incomplete and goal self-review retries with the real error.
          if ((expectsFiles || executionPreamble) && !this.planMode && taskKind !== 'chat' && this.fileGuardNudges >= 1 && this.failedMutation
            && !this.failedMutationWrites.some((p) => existsSync(p))) {
            return this.finish(task, false, 'Incomplete: a file mutation failed and no deliverable file exists on disk. Last reply:\n' + response.content, 'tool_loop');
          }

          // A differently worded completion cannot bypass a rejected execution
          // preamble when no tools have run. Read-only evidence gathering remains
          // eligible for legitimate no-change outcomes.
          if (!this.planMode && this.planNudges > 0 && this.toolCallsTotal === 0) {
            return this.finish(task, false, 'No execution evidence after a recovery nudge. Last reply:\n' + response.content, 'tool_loop');
          }
          // MCH-75: a bare-text finish with no tool calls and no file changes
          // has produced NO verifiable evidence. If a verification command or
          // acceptance criteria exists, run it once and downgrade to partial
          // on failure instead of trusting the prose claim. Read-only/chat
          // tasks and plan mode are exempt.
          if (this.toolCallsTotal === 0 && !this.fileChanged && !this.planMode && taskKind !== 'chat' && taskKind !== 'research' && taskKind !== 'document') {
            // A creation-led task that produced prose only with zero tool calls
            // is incomplete even when no verification gate exists (runPrompt
            // one-shots carry no acceptance criteria). Never record prose as
            // success for builds. (Mirrors the file-guard fail above for the
            // case where the guard already fired.)
            if (expectsFileOutput(task.title, task.description ?? '', taskKind, task.fileScope, task.acceptanceCriteria ?? [])) {
              return this.finish(task, false, 'Incomplete: the task requires file output but finished with prose only and no tool calls. Last reply:\n' + response.content, 'tool_loop');
            }
            const hasGate = Boolean(task.verificationCommand || (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) || detectRepo(this.cwd).testCommand || detectRepo(this.cwd).buildCommand);
            if (hasGate) {
              const verification = await this.verify(task, detectRepo(this.cwd));
              if (!verification.passed) {
                return this.finish(task, false, `Completion claimed in prose but verification failed:\n${verification.summary}`, 'verification_failed');
              }
              return this.finish(task, true, `${response.content}\n\n${verification.summary}`, 'completed');
            }
          }
          return this.finish(task, true, response.content, 'completed');
        }
        // Empty response: the model returned nothing (common with overloaded
        // free providers or reasoning models that only emit thinking tokens).
        // Quality slice 2: escalate EARLIER — 2 consecutive empty responses is
        // a strong signal the active model is misbehaving (rate-limited,
        // overloaded, or returning reasoning-only). Try one backoff, then
        // step up to a different model on the same provider; if that fails,
        // switch providers. Don't burn 4 attempts before reacting — each
        // empty response is a 30-90s round-trip the user is waiting for.
        this.emptyResponseCount++;
        if (this.emptyResponseCount === 2) {
          // First escalation: try a different model on the same provider.
          const alt = this.pickAlternateModel();
          if (alt) {
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[empty-response] 2 in a row; switching to fallback model ${alt}` });
            this.setActiveModel(alt);
            this.emptyResponseCount = 0;
            this.context.addMessage({ role: 'system', content: 'STRUGGLE STATE: The previous model was returning empty responses. Try a different approach — re-read the relevant files, reduce the scope, or use a different tool before responding.' });
            continue;
          }
        }
        if (this.emptyResponseCount >= 3) {
          // Second escalation: switch provider if available.
          if (this.switchToNextProvider()) {
            this.emptyResponseCount = 0;
            this.context.addMessage({ role: 'system', content: 'STRUGGLE STATE: The previous provider was returning empty responses. The harness has switched providers. Re-read state before responding.' });
            continue;
          }
          return this.finish(task, false, 'Model returned empty responses repeatedly across providers. The provider pool may be exhausted — try again or switch models with /model.', 'model_error');
        }
        const backoffMs = [1500, 4000, 9000][this.emptyResponseCount - 1] ?? 9000;
        this.events.emit({ type: 'agent:log', agentId: this.id, message: `[empty-response] retry ${this.emptyResponseCount}/3 in ${backoffMs}ms (provider returned no content)` });
        // B17: remove the abort listener when the sleep settles. {once:true}
        // only auto-removes when abort FIRES; a backoff that completes
        // normally (the common case) leaked its listener on the shared run
        // signal, one per struggle cycle.
        await new Promise<void>((resolve) => {
          const onAbort = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => {
            this.abortSignal?.removeEventListener('abort', onAbort);
            resolve();
          }, backoffMs);
          this.abortSignal?.addEventListener('abort', onAbort, { once: true });
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
        this.recordVerifyPass(verification.summary);
        this.consecutiveVerifyFailures = 0;
        this.consecutiveToolErrorsCount = 0;
        this.cycleNudges = 0;
        this.nudgeInjections = 0;
        // Success after diagnosis turns earlier hypotheses into confirmed or
        // refuted states and writes a procedural lesson so the next run has a
        // head start on this kind of failure.
        this.recordSuccess(task, repo);
        // Diff-hygiene gate (harness-v2 quality): verification proves the code
        // WORKS, not that it is CLEAN. One bounded pass catches debug logging,
        // TODO markers, suppressed checks, and focused tests the model added,
        // so shipped code never needs a human cleanup pass.
        // MCH-93: in a non-git workspace both gates can only fail (every git
        // probe errors) — skip them instead of burning 2+ model round-trips.
        const mch93GitWs = this.isGitWorkspace();
        if (!mch93GitWs) {
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[mch93] non-git workspace — hygiene+self-review gates skipped` });
        }
        if (!this.planMode && mch93GitWs && this.hygieneNudges < 1) {
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
        if (!this.planMode && (await this.shouldSelfReview(task))) {
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
      const maxRetries = this.config.safety?.maxVerifyRetries ?? 6;
      if (this.verifyCount > maxRetries) {
        // Repeated verification failure: only roll back if gitDestructive permission is granted.
        // Preserves user and agent work on disk by default so progress is never silently wiped.
        let rollbackNote = '';
        if (this.preEditCheckpoint && this.config.permissions.gitDestructive) {
          try {
            rollbackNote = '\n' + await gitRollback(this.cwd, this.preEditCheckpoint);
            this.events.emit({ type: 'agent:log', agentId: this.id, message: rollbackNote.trim() });
          } catch (err) {
            rollbackNote = `\n(Rollback failed: ${err instanceof Error ? err.message : String(err)})`;
          }
          this.preEditCheckpoint = undefined;
        } else if (this.preEditCheckpoint) {
          rollbackNote = '\n(Work preserved on disk; gitDestructive permission is false)';
        }
        if (this.autopsy) {
          this.autopsy = finalizeAutopsy(this.workspace.dir, this.autopsy, { outcome: 'unresolved' });
        }
        this.recordFailure(task, verification.summary);
        return this.finish(task, false, 'Verification failed repeatedly:\n' + verification.summary + rollbackNote, 'verification_failed');
      }
      this.addAttempt(task, 'verify', [`${repo.testCommand || repo.buildCommand || 'verify'}`], 'failure', verification.summary);
      this.context.addKnownError(verification.summary);
      // Quality slice 3: auto plan-mode escape. After 2+ verify failures AND
      // 2+ tool errors, the agent is in a loop and is going to keep producing
      // the same broken diff over and over. Force a structured recovery plan:
      // ask the model to STOP making changes, write a 5-line plan, and only
      // resume editing on the next iteration. This is the "you've been
      // guessing; now stop and think" intervention that gets a model out of
      // a confirmed loop without burning more verify cycles.
      if (this.verifyCount >= 2 && this.totalToolErrors() >= 2) {
        this.injectAutoPlanEscape(verification.summary);
      }
      // Observation-driven retry: classify the failure, retrieve any matching
      // lessons from procedural memory, and append a structured attempt to
      // the autopsy record before nudging the model with the next hypothesis.
      await this.observeFailure(task, verification.summary, repo);
      // Model auto-escalation: N consecutive verification failures means the
      // current tier cannot crack this task — hand it ONE rung up (once per
      // task, only to a different configured model). The stronger model gets
      // a clean streak and an explicit handoff note instead of inheriting
      // the weaker model's doomed trajectory mid-thought.
      this.consecutiveVerifyFailures++;
      const baseTier: TaskTier =
        this.profile.defaultModel === 'fast' ? 'fast'
        : this.profile.defaultModel === 'reasoning' ? 'reasoning'
        : 'standard';
      const escalation = nextEscalationTier(
        baseTier,
        this.consecutiveVerifyFailures,
        this.escalatedThisTask,
        this.config.model,
        this.config.model.model,
      );
      if (escalation) {
        this.escalatedThisTask = true;
        this.consecutiveVerifyFailures = 0;
        this.setActiveModel(escalation.modelId);
        this.syncStallBudget();
        this.events.emit({ type: 'agent:log', agentId: this.id, message: `[escalate] sustained verification failures — escalated to ${escalation.tier} tier (${escalation.modelId})` });
        this.context.addMessage({
          role: 'system',
          content: `A stronger model (${escalation.modelId}) is taking over after repeated verification failures. Re-read the failing checks with fresh eyes, change strategy — do NOT repeat the last approach verbatim.`,
        });
      }
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
  private pickProvider(): RawProvider {
    const base = this.profile.defaultModel ?? 'coding';
    let profile: ModelProfile = base;
    // MCH-111: route hard tasks (architecture/audit/multi-file) to the
    // 'reasoning' profile when one is configured, before the cheap-phase
    // downgrade — a strong model up front beats recovering from a bad plan.
    // Complexity override (2026-10-15): a structurally-complex task (multi-file
    // refactor, existing-repo mutation with blast radius, broad test loops, or
    // hard investigation) must get the frontier reasoning model from the START,
    // not only after verify-failover escalation — same Claude Code / Codex
    // class-work guarantee as the full-toolset gate and max-reasoning override.
    if (this.taskKind && this.task && !this.budget?.shouldUseCheaperModel()) {
      const structurallyComplex = this.taskComplexity === 'complex';
      const tier = structurallyComplex ? 'reasoning' : classifyTaskTier(this.task.title + ' ' + (this.task.description ?? ''), this.task.role);
      if (tier === 'reasoning') profile = 'reasoning';
    }
    if (this.budget && this.budget.shouldUseCheaperModel()) {
      profile = 'fast';
    }
    return this.getProviderForProfile(profile);
  }

  private getProviderForProfile(profile: ModelProfile): RawProvider {
    const base = this.profile.defaultModel ?? 'coding';
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
  /**
   * MCH-32: model-backed mid-run digest — CC-style summarization tier between
   * mechanical shrinking (shrinkOldToolOutputs) and full turn-dropping
   * compaction. Summarizes the OLDEST messages into a compact digest so long
   * tasks keep their recent working state and lose only stale detail.
   * Best-effort: on any failure it returns without touching history and the
   * caller falls through to checkpointAndCompact.
   */
  private async digestOldMessages(floorTokens: number): Promise<void> {
    const msgs = (this.context as unknown as { messages?: ChatMessage[] }).messages;
    if (!msgs || msgs.length < 12) return;
    // Use approxTokens() so the native BPE tokenizer runs when available;
    // the previous raw `length / 4` shortcut bypassed the native path.
    const est = () => msgs.reduce((s, m) => {
      const c = m.content;
      const text = typeof c === 'string' ? c : JSON.stringify(c);
      return s + approxTokens(text);
    }, 0);
    if (est() <= floorTokens) return;
    // Digest window: all but the last RECENT_KEEP messages (current working set).
    // Complex tasks keep a much deeper working set (20 vs 8): the digest throws
    // the source of the old messages away, so a hard refactor must retain the
    // files/commands it is actively reasoning over instead of a 300-word stub.
    const RECENT_KEEP = this.taskComplexity === 'complex' ? 20 : 8;
    const oldCount = msgs.length - RECENT_KEEP;
    if (oldCount < 4) return;
    const old = msgs.slice(0, oldCount);
    const transcript = old
      .map((m) => `${m.role}: ${(m.content ?? '').slice(0, 400)}`)
      .join('\n')
      .slice(0, this.taskComplexity === 'complex' ? 24_000 : 12_000);
    const sys = 'Summarize this agent-work transcript into a compact digest (max 300 words). Keep: goal, files touched and their state, commands run and outcomes, errors hit and fixes, open threads. Omit prose fluff. Output ONLY the digest.';
    try {
      const fast = this.getProviderForProfile('fast');
      const resp = await fast.chat(
        [
          { role: 'system' as const, content: sys },
          { role: 'user' as const, content: transcript },
        ],
        [],
        { maxTokens: 500, signal: this.abortSignal },
      );
      const digest = (resp.content ?? '').trim();
      if (!digest) return;
      const before = est();
      msgs.splice(0, oldCount, { role: 'user' as const, content: `[digest of ${oldCount} earlier messages]\n${digest}` } as ChatMessage);
      const after = est();
      this.events.emit({ type: 'agent:log', agentId: this.id, message: `[context] MCH-32 digest: ${oldCount} old messages -> ${digest.length} chars (~${Math.max(0, before - after)} tokens saved)` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.events.emit({ type: 'agent:log', agentId: this.id, message: `[context] digest failed (non-fatal, falling back to compaction): ${msg.slice(0, 120)}` });
    }
  }

  /** MCH-33: MCP connections opened this run; closed on finish. */
  private mcpConnections: Array<{ channel: { call: (m: string, p: unknown, t?: number) => Promise<any>; close: () => void } }> = [];
  private mcpLoaded = false;

  /** MCH-33: lazily connect configured MCP servers and merge their tools in. */
  private async loadMcpInRun(): Promise<void> {
    // Chat turns never load MCP servers: spawning + handshaking every
    // configured server on a greeting ("hi") is the "mochi tries to connect
    // to MCP unprompted" spam class — process spawns, fresh tool schemas the
    // model then pokes at, and connect-failure noise, all for a turn whose
    // tools are reads + ask_question by construction. Non-chat runs load
    // lazily on first iteration as before.
    if (this.taskKind === 'chat') return;
    if (this.mcpLoaded) return;
    this.mcpLoaded = true;
    const servers = this.config.mcpServers;
    if (!servers || Object.keys(servers).length === 0) return;
    try {
      const { loadMcpTools, closeMcpConnections } = await import('../tools/mcp.js');
      const list = Object.entries(servers).map(([name, s]) => ({
        name,
        command: s.command ? String(s.command) : undefined,
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        url: s.url ? String(s.url) : undefined,
        headers: s.headers,
        env: s.env,
      })).filter((s) => s.command || s.url);
      const { tools, connections } = await loadMcpTools(list, (m) =>
        this.events.emit({ type: 'agent:log', agentId: this.id, message: m }));
      this.mcpConnections = connections;
      for (const t of tools) {
        if (!this.tools.has(t.def.name)) this.tools.set(t.def.name, t);
      }
      if (tools.length > 0) {
        this.toolDefs = [...this.tools.values()].map((t) => t.def);
        this.events.emit({ type: 'agent:log', agentId: this.id, message: `[mcp] ${tools.length} MCP tool(s) registered` });
      }
      // Close connections when the abort signal fires (run end/abort).
      // B17: keep at most ONE such backstop listener — a repeated load (e.g.
      // after a load_tools restore) used to stack a new listener per load,
      // each capturing a stale connection array. finish() also closes
      // connections on every path; this listener is only the hard-abort
      // backstop, so replacing it is safe and bounded.
      if (this.mcpAbortBackstop) {
        try { this.abortSignal?.removeEventListener('abort', this.mcpAbortBackstop); } catch { /* best-effort */ }
      }
      if (this.abortSignal && !this.abortSignal.aborted) {
        this.mcpAbortBackstop = () => closeMcpConnections(this.mcpConnections);
        this.abortSignal.addEventListener('abort', this.mcpAbortBackstop, { once: true });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.events.emit({ type: 'agent:log', agentId: this.id, message: `[mcp] load failed (non-fatal): ${msg.slice(0, 160)}` });
    }
  }

  private async checkpointAndCompact(reason: 'periodic' | 'floor' | 'error', keepFloor?: number): Promise<void> {
    const dropped = await this.context.previewCompact(keepFloor);
    if (!dropped || dropped.length === 0) {
      this.context.compact(undefined, keepFloor).catch(() => {});
      this.clearReadStub();
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
    const skipModelCheckpoint = Boolean(
      (process.env.VITEST && !process.env.TEST_COMPACTION_MODEL) ||
      this.config.safety.contextBudgetTokens < 10000
    );
    if (!skipModelCheckpoint) {
      try {
        const input = dropped.map(render).join('\n').slice(0, 12_000);
        const prompt: ChatMessage[] = [
          { role: 'system', content: 'You maintain a session checkpoint for a coding agent. Summarize the conversation excerpt below in at most 150 words using exactly this format:\nGoal: <what the user ultimately wants>\nProgress: <what has been done, files touched>\nDecisions: <key choices made, max 3>\nNext: <immediate next step>\nBe specific (file paths, commands). No preamble.' },
          { role: 'user', content: input },
        ];
        const fast = this.getProviderForProfile('fast');
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
        checkpoint = undefined;
      }
    }
    if (!checkpoint) {
      try {
        const compactCtx = compactSession(this.events.snapshot(), { goal: this.context.state.goal });
        if (!compactCtx.isEmpty) {
          checkpoint = compactToPrompt(compactCtx);
        }
      } catch {
        /* heuristic fallback inside compact() */
      }
    }
    // B15: pass the caller's explicit floor through — previewCompact() must
    // agree with the compact() cut, or the checkpoint would summarize a
    // slice that compact() then keeps.
    await this.context.compact(checkpoint, keepFloor);
    this.clearReadStub();
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
   *  by observed reliability for tool-calling tasks. NOTE: kimi-k2.7-code was
   *  dropped — the endpoint 404s it, so failing over to it burns a full
   *  round-trip on a dead model before reaching a live one. */
  private static FALLBACK_MODELS = ['qwen3.6-35b', 'minimax-m3', 'glm-5.3', 'glm-5.3-flash', 'deepseek-v4-flash'];

  /** Pick the next fallback model id, skipping the active one. Returns
   *  undefined when every fallback has already been tried. */
  private pickAlternateModel(): string | undefined {
    const active = (this.config.model.model ?? '').toLowerCase();
    const activeProviderId = (this.config.model.provider ?? '').toLowerCase();
    const p = PROVIDERS.find((x) =>
      x.id.toLowerCase() === activeProviderId ||
      x.name.toLowerCase() === activeProviderId
    );
    const candidateModels = (p?.models && p.models.length > 0) ? p.models : Agent.FALLBACK_MODELS;
    for (const m of candidateModels) {
      if (m.toLowerCase() === active) continue;
      if (this.triedFallbackModels.has(m)) continue;
      return m;
    }
    return undefined;
  }

  /** Swap the active model in-place: same provider/key/baseUrl, new model id.
   *  Rebuilds the provider and updates profiles so the next iteration uses the fallback. */
  private setActiveModel(modelId: string): void {
    const norm = normalizeModelName(modelId, this.config.model.baseUrl);
    this.triedFallbackModels.add(norm);
    this.triedFallbackModels.add(modelId);
    this.triedFallbackModels.add(this.config.model.model ?? '');
    this.config.model = {
      ...this.config.model,
      model: norm,
      profiles: {
        fast: norm,
        coding: norm,
        reasoning: norm,
        review: norm,
      },
    };
    this.provider = createProvider(this.config.model, this.profile.defaultModel ?? 'coding');
    this.providers.clear();
    this.cooldownRetries = 0;
    this.rateLimitRetries = 0;
  }

  /** Switch to the next available provider in config.model.failover if models
   *  on the current provider are exhausted or the provider itself is cooling down. */
  private switchToNextProvider(): boolean {
    const failovers = this.config.model.failover;
    if (!failovers || failovers.length === 0) return false;
    for (const fb of failovers) {
      const pId = (fb.provider || '').toLowerCase();
      if (!pId || this.triedFallbackProviders.has(pId)) continue;
      let key = fb.apiKey;
      if (!key) {
        const prov = PROVIDERS.find((x) => x.id.toLowerCase() === pId);
        if (prov?.envKey && process.env[prov.envKey]) key = process.env[prov.envKey];
      }
      this.triedFallbackProviders.add(pId);
      this.triedFallbackProviders.add((this.config.model.provider || '').toLowerCase());
      const normModel = normalizeModelName(fb.model, fb.baseUrl);
      this.events.emit({
        type: 'agent:log',
        agentId: this.id,
        message: `[failover] Switching provider from ${this.config.model.provider} to ${fb.provider} (${normModel})`,
      });
      this.config.model = {
        ...this.config.model,
        provider: fb.provider,
        baseUrl: fb.baseUrl,
        apiKey: key || fb.apiKey,
        model: normModel,
        profiles: fb.profiles ?? {
          fast: normModel,
          coding: normModel,
          reasoning: normModel,
          review: normModel,
        },
      };
      this.provider = createProvider(this.config.model, this.profile.defaultModel ?? 'coding');
      this.providers.clear();
      this.triedFallbackModels.clear();
      this.cooldownRetries = 0;
      this.rateLimitRetries = 0;
      return true;
    }
    return false;
  }

  private isReadOnly(name: string, args?: Record<string, unknown>): boolean {
    const canonical = TOOL_ALIASES[name] || name;
    // B27: fetch POST/PUT/PATCH/DELETE mutate REMOTE state — never treat them
    // as read-only regardless of the allowlist below (GET/HEAD still are).
    if (isFetchMutationRequest(canonical, args)) return false;
    // Allowlist of non-mutating tools. Note: MCP resource tools registered as
    // <server>__resources_list/read are read-only by construction.
    // 'verify' is deliberately ABSENT: it executes an arbitrary shell command
    // (tools/verify.ts runs the command verbatim, builds/tests write dist/,
    // coverage, and test side effects) with permission:'shell', dangerous:true.
    // Listing it here let mid-stream speculative execution fire it with NO
    // approval gate, ran it inside read-only parallel batches, and never
    // armed the workspace-moved probe after it.
    return [
      'read', 'search', 'glob', 'outline', 'code_similarity', 'security_audit', 'inspect', 'get_function', 'find_callers', 'type_hierarchy',
      'todo', 'skill', 'memory', 'session_recall', 'blast_radius', 'chameleon', 'analyze_code', 'perf', 'perf_audit',
      'web_search', 'get_diagnostics', 'git_blame', 'git_history', 'system_info',
      'find_references', 'find_definitions', 'db_inspect', 'diff', 'tree', 'deepwiki',
      'fetch', 'sql_codebase', 'sql_codebase_query', 'think', 'accept_plan', 'ask_question',
    ].includes(canonical) || /__resources_(list|read)$/.test(canonical);
  }

  /** Veto a tool call in plan mode, still answering its tool_call_id so the
   *  provider never sees a dangling reference. */
  private vetoToolCall(c: ToolCall, reason: string) {
    this.context.addMessage({ role: 'tool', tool_call_id: c.id, content: `Blocked: ${reason}`, name: c.function.name });
    this.vetoLog.push({ tool: c.function.name, reason });
    if (this.vetoLog.length > 20) this.vetoLog.shift();
  }

  /** Mark a tool result as "file changed" and track the affected paths.
   *  A FAILED mutation is not progress: it must not set fileChanged (that
   *  would bypass every no-file completion guard) nor reset the error
   *  streak counters (zeroing them here is what let a failing-write loop
   *  spin forever — the runaway abort "8 consecutive failures without file
   *  changes" never saw a streak above 0). Failed `write` targets are
   *  recorded so the no-file guard can still detect out-of-band recovery
   *  (the model recreating the file via shell). */
  private trackFileChange(name: string, args: Record<string, unknown>, toolResult?: { output?: string; error?: unknown }) {
    const canonical = TOOL_ALIASES[name] || name;
    // Carryover bookkeeping: a successful READ is part of the working context
    // for THIS run and later turns — if compaction drops its content, or a
    // follow-up references "the file you read", the digest/re-seed paths need
    // to know WHICH file without re-globbing. Tracked regardless of run kind.
    if (canonical === 'read' && !toolResult?.error && typeof args.path === 'string' && args.path.trim()) {
      const p = args.path.trim();
      const current = this.context.state.filesRead ?? [];
      if (!current.includes(p)) {
        this.context.updateState({ filesRead: [...current, p].slice(-50) });
      }
    }
    // Any non-read-only tool MIGHT have moved the workspace (shell, MCP, …) —
    // arm the git probe so shellMovedWorkspace() re-checks on the next gate.
    // Failed calls count too: partial shell mutations are exactly the case
    // fileChanged misses.
    if (!this.isReadOnly(canonical, args)) this.shellProbePending = true;
    if (['write', 'edit', 'delete', 'patch'].includes(canonical)) {
      if (toolResult?.error) {
        this.failedMutation = true;
        const failedPath = String(args.path ?? '');
        if (canonical === 'write' && failedPath) this.failedMutationWrites.push(resolve(this.cwd, failedPath));
        return;
      }
      this.fileChanged = true;
      this.consecutiveToolErrorsCount = 0;
      this.cycleNudges = 0;
      this.nudgeInjections = 0;
      // Real progress invalidates read-veto memory: re-reading a file the
      // model just changed is legitimate, but readTargetCounts never reset
      // (n >= 4 vetoed forever), turning every later re-read into a blocked
      // no-op and strangling multi-step workflows.
      this.readTargetCounts.clear();
      const path = String(args.path ?? '');
      if (path) this.context.addModifiedFile(resolve(this.cwd, path));
      // Just-in-time trust nudge (latency): models waste a full round-trip
      // re-reading a file they just wrote to "verify" it — the write result
      // is already authoritative (system directive 6), and in arena timings
      // that confirmation turn cost ~2-3s per task. Bounded to the first two
      // mutations so multi-file runs aren't nudged to death; legitimate
      // re-reads (diagnosing later behavior) stay allowed by design.
      if (canonical !== 'delete' && this.trustNudges < 2) {
        this.trustNudges++;
        this.context.addMessage({
          role: 'system',
          content: `Result trust: your ${canonical} to ${path || 'the target file'} succeeded — the file on disk is exactly what you sent. Do NOT spend a turn re-reading or re-checking it to confirm; proceed to the next step or your final summary (a later, differently-motivated read is still fine).`,
        });
      }
    }
    if (canonical === 'patch' && toolResult?.output) {
      for (const line of toolResult.output.split('\n')) {
        const m = line.match(/^- (?:added|updated|deleted) (.+?)(?: \(\d+ lines\))?$/);
        if (m) this.context.addModifiedFile(resolve(this.cwd, m[1]));
      }
    }
  }

  /**
   * Quality slice 5: track tool result redundancy. The model has lost the
   * thread when it re-reads the same file (or any tool returns the same
   * output) repeatedly. We track per-hash: tool name + count, so the next
   * STRUGGLE STATE injection can say "you've seen this exact output N
   * times — change strategy". Cheap FNV-1a 64-bit hash on the post-fold
   * output (already ANSI-stripped and redacted).
   *
   * The map is bounded to 50 entries (LRU-ish — full eviction when full
   * to keep memory predictable for very long tasks).
   */
  private trackToolResultHash(toolName: string, output: string): void {
    if (!output) return;
    // 64-bit FNV-1a — same algorithm as `nativeHashPrompt` so we can swap
    // for the native op later without changing the contract.
    let h = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let i = 0; i < output.length; i++) {
      h ^= BigInt(output.charCodeAt(i));
      h = (h * prime) & 0xffffffffffffffffn;
    }
    const key = h.toString(16);
    const canonical = TOOL_ALIASES[toolName] || toolName;
    const prev = this.crossToolResultHash.get(key);
    if (prev && prev.tool !== canonical) {
      // Same content from a DIFFERENT tool — even stronger signal. Count up.
      this.crossToolResultHash.set(key, { tool: canonical, count: prev.count + 1 });
    } else if (prev) {
      this.crossToolResultHash.set(key, { tool: canonical, count: prev.count + 1 });
    } else {
      this.crossToolResultHash.set(key, { tool: canonical, count: 1 });
    }
    // Bound the map to 50 entries — drop oldest when full.
    if (this.crossToolResultHash.size > 50) {
      const firstKey = this.crossToolResultHash.keys().next().value;
      if (firstKey !== undefined) this.crossToolResultHash.delete(firstKey);
    }
  }

  /**
   * Run the model's chosen tool calls in parallel-where-safe order:
   *   1. All read-only calls (read/search/glob/etc.) run concurrently via Promise.all.
   *   2. Mutating calls to DISTINCT target paths run concurrently.
   *   3. Pure shell calls (no shell metacharacters that change state, like
   *      a leading "cd " or output redirect) run in parallel with each other
   *      but still serially with read-only/mutating groups so their $PWD /
   *      env stays consistent.
   */
  private async executeToolCalls(batchInput: ToolCall[]): Promise<void> {
    const batch = [...batchInput];
    while (batch.length > 0) {
      if (this.abortSignal?.aborted) return;
      const head = batch[0];
      const headName = TOOL_ALIASES[head.function.name] || head.function.name;
      // 1. Read-only group: run up to 16 in parallel. Bumped from 8 because
      // a real codebase-wide read often needs 10+ files in one turn.
      if (this.isReadOnly(headName, this.parseArgs(head.function.arguments))) {
        let n = 0;
        while (n < batch.length && n < 16 && this.isReadOnly(batch[n].function.name, this.parseArgs(batch[n].function.arguments))) n++;
        const group = batch.splice(0, Math.max(n, 1));
        await Promise.all(group.map((tc) => this.runMoolCall(tc)));
        continue;
      }

      // 2. Writes-edits to DISTINCT target files are independent and safe to run in
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
            // B12: dedup by RESOLVED absolute path. The raw string comparison
            // missed './a.ts' vs 'a.ts' vs an absolute path — two writes to
            // the SAME file ran concurrently and the second clobbered the
            // first (the later call observed winning in the trace). An empty
            // or unparseable path falls back to a `__raw__:` sentinel key:
            // empty-path calls are serialized against each other (conservative,
            // and unchanged from the old shared-'' behavior) and the sentinel
            // can never collide with a resolved absolute path.
            const resolvedKey = path ? resolve(this.cwd, path) : `__raw__:${path}`;
            if (seen.has(resolvedKey)) { remaining.push(tc); continue; }
            seen.add(resolvedKey);
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

      // 3. Shell: previously serial even when safe. Now: a batch of PURE
      // read-only shell commands (ls, cat, grep, head, tail, find, wc, jq,
      // tree, file, stat, ps, env, which, type, du, df, ripgrep) can run in
      // parallel — they don't change state and don't interfere with each other.
      // Stateful commands (anything with `&&`, `||`, `|`, `>`, `>>`, `<`,
      // backticks, `$()`, `;`, `cd`, or shell metacharacters) still go one at
      // a time to preserve causal order.
      if (headName === 'shell') {
        const isPureReadOnly = (cmd: string): boolean => {
          const c = cmd.trim();
          if (/[;&|<>`$()]|>>?|<|cd\s/.test(c)) return false;
          // First token (binary name) must be a known read-only command.
          const bin = c.split(/\s+/)[0];
          return /^(ls|cat|head|tail|grep|egrep|fgrep|wc|file|stat|which|type|jq|env|printenv|ps|pgrep|pwd|whoami|hostname|date|uname|df|du|find|tree|ripgrep|rg)$/.test(bin);
        };
        const group: ToolCall[] = [];
        const remaining: ToolCall[] = [];
        for (const tc of batch) {
          const tcName = TOOL_ALIASES[tc.function.name] || tc.function.name;
          if (tcName === 'shell') {
            let cmd = '';
            try {
              const parsed = this.parseArgs(tc.function.arguments || '{}');
              cmd = String(parsed.command ?? '');
            } catch { /* leave cmd empty -> not pure */ }
            if (isPureReadOnly(cmd)) group.push(tc);
            else remaining.push(tc);
          } else {
            remaining.push(tc);
          }
        }
        if (group.length > 0) {
          batch.length = 0;
          batch.push(...remaining);
          await Promise.all(group.map((tc) => this.runMoolCall(tc)));
          continue;
        }
      }

      // 4. Everything else (stateful shell, patch, subagent, etc.) runs
      // serially so each call observes the previous call's effects.
      batch.shift();
      await this.runMoolCall(head);
    }
  }

  /**
   * MCH-73: speculative continuation prefetch. Fires the co-change predictor
   * EVERY iteration (not just once at run start) using the latest touched
   * files, warming the read cache so the next model turn's reads are served
   * with zero added latency. Cheap (one git log via predictNextFiles) and
   * deduped by readCache freshness, so repeat warming is nearly free.
   */
  private async prefetchForNextTurn(): Promise<void> {
    try {
      const touched = this.context.getMessages()
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-20)
        .flatMap((m) => (contentText(m).match(/[\w./-]+\.(?:ts|js|py|go|rs)/g) ?? []));
      const uniqueTouched = [...new Set(touched)].slice(0, 10);
      if (uniqueTouched.length === 0) return;
      const predicted = predictNextFiles(this.workspace.dir, uniqueTouched, 5);
      let warmed = 0;
      for (const f of predicted) {
        try {
          const full = join(this.workspace.dir, f);
          const st = await stat(full);
          if (st.size <= 64_000 && !this.readCache.has(full)) {
            this.readCache.set(full, { mtimeMs: st.mtimeMs, size: st.size, content: await readFile(full, 'utf8') });
            warmed++;
          }
        } catch { /* unreadable: skip this file */ }
      }
      if (warmed > 0) {
        this.events.emit({ type: 'agent:log', agentId: this.id, message: `prefetch: warmed ${warmed} co-change file(s) for next turn` });
      }
    } catch { /* prefetch is strictly optional */ }
  }

  /** MCH-74: mid-run steer. Users can push guidance into a RUNNING task
   *  without aborting it; queued lines are injected at the next loop
   *  iteration as a user-role note the model must acknowledge. */
  steer(text: string): void {
    const t = text.trim();
    if (t) this.steerQueue.push(t);
  }

  /** Drain any mid-run steering into the transcript (called at each
   *  iteration top). Returns true if anything was injected. */
  private drainSteerQueue(): boolean {
    if (this.steerQueue.length === 0) return false;
    const lines = this.steerQueue.splice(0, this.steerQueue.length);
    this.context.addMessage({
      role: 'user',
      content: `[mid-run steer] The user sent this while the task was running — take it into account NOW and adjust course if needed:\n${lines.join('\n')}`,
    });
    this.events.emit({ type: 'agent:log', agentId: this.id, message: `steer: injected ${lines.length} mid-run guidance line(s)` });
    return true;
  }

  /** Spawn a fresh child agent on a subtask and return a short summary. The
   *  child shares this run's config, workspace, events, cwd, abort signal,
   *  budget, and file read cache so delegation is cheap and consistent. */
  private async spawnSubagent(
    prompt: string,
    opts?: { role?: string; timeoutMs?: number; scratchpad?: string; lane?: string; failoverIndex?: number } | string
  ): Promise<string> {
    const roleStr = typeof opts === 'string' ? opts : opts?.role;
    const timeoutMs = typeof opts === 'object' ? opts?.timeoutMs : undefined;
    const scratchpad = typeof opts === 'object' ? opts?.scratchpad : undefined;
    const lane = typeof opts === 'object' ? opts?.lane : undefined;
    const failoverIndex = typeof opts === 'object' ? opts?.failoverIndex : undefined;

    const childRole = (roleStr ?? 'coder') as import('../types.js').AgentRole;
    const childProfile = new AgentProfileService(this.workspace.dir).get(childRole) ?? this.profile;
    const childId = `${this.id}-sub-${Math.random().toString(36).slice(2, 8)}`;
    const childContext = new ContextEngine(this.config, this.cwd);
    // MCH-87a: per-child cost cap. Children previously shared the parent's
    // budget engine, so one runaway subagent could starve all siblings. The
    // child gets its OWN BudgetEngine scoped to a fraction of the parent's
    // remaining tokens (default 25%, MOCHI_SUBAGENT_BUDGET_FRACTION tunable),
    // plus a hard wall-clock timeout. The parent's budget still sees the final
    // usage via recordTokens at the child's model calls (they go through the
    // shared provider), so accounting stays additive.
    let childBudget = this.budget;
    if (this.budget) {
      const frac = Math.min(1, Math.max(0.1, Number(process.env.MOCHI_SUBAGENT_BUDGET_FRACTION ?? 0.5) || 0.5));
      const parentRemainingTokens = this.budget.remainingTokens();
      const parentRemainingCost = this.budget.remainingCostUsd();
      const baseModelCalls = Number.isFinite(this.config.safety?.maxModelCalls) ? (this.config.safety.maxModelCalls as number) : 30;
      const scoped = new BudgetEngine({
        ...this.config.safety,
        maxTokens: Math.max(100_000, Math.floor(parentRemainingTokens * frac)),
        maxCostUsd: Number.isFinite(parentRemainingCost) && parentRemainingCost > 0 ? Math.max(0.5, parentRemainingCost * frac) : Number.POSITIVE_INFINITY,
        maxModelCalls: Math.max(15, Math.ceil(baseModelCalls * frac)),
      });
      scoped.start();
      childBudget = scoped;
    }
    // MCH-87b: output contract. Every spawned child must end its final message
    // with a machine-parseable footer so the parent can aggregate outcomes
    // deterministically instead of free-text prose.
    childContext.addMessage({
      role: 'system',
      content: '[Output contract] End your FINAL message with exactly this footer:\n<result>\nSTATUS: done | partial | blocked\nFILES: comma-separated paths you created or modified (or "none")\nRESULT: one-paragraph summary of the outcome\n</result>',
    });
    if (scratchpad) {
      childContext.addMessage({
        role: 'system',
        content: `[Shared Context / Scratchpad from Parent Agent]:\n${scratchpad}`,
      });
    }
    // MCH-54: give spawned subagents the speculative stack — seed the child's
    // context with the parent's fused prefetch hints (parent's read footprint
    // drives the co-change signal, so children land pre-oriented on the files
    // the parent was actually working in). Best-effort.
    try {
      const { prefetchText } = await import('../core/prefetch.js');
      const touched = Array.from(this.readCache.keys()).slice(-10);
      const childHint = prefetchText(this.workspace.dir, touched);
      if (childHint) childContext.addMessage({ role: 'system', content: childHint });
    } catch { /* subagent prefetch must never affect spawning */ }

    const childAbort = new AbortController();
    const combinedAbort = this.abortSignal
      ? AbortSignal.any([this.abortSignal, childAbort.signal])
      : childAbort.signal;

    const child = new Agent({
      id: childId,
      role: childRole,
      // MCH-41 lanes: read-only research roles run the fast profile (breadth
      // not depth, 3-5x cheaper); explicit `lane` overrides; coder keeps its
      // role profile.
      modelProfile: (lane === 'fast' || (!lane && (childRole === 'researcher' || childRole === 'reviewer')))
        ? ('fast' as import('../types.js').ModelProfile)
        : (childProfile.defaultModel ?? 'coding'),
      // MCH-41 failover-aware fanout: rotate failover entries as the child's
      // PRIMARY so parallel siblings land on distinct endpoints instead of
      // stampeding one free-tier rate limit. Original chain order is kept as
      // each child's fallback path.
      config: { ...this.config, model: this.fanoutConfig(this.config.model, failoverIndex) },
      workspace: this.workspace,
      events: this.events,
      cwd: this.cwd,
      context: childContext,
      budget: childBudget,
      abortSignal: combinedAbort,
      readCache: this.readCache,
      subagentDepth: this.subagentDepth + 1,
      extraTools: this.extraTools,
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
    const runPromise = child.run(task).catch((err) => {
      // The parent's Promise.race only awaits the winner. If this child
      // rejects AFTER the race has already resolved on the timeout (or the
      // parent cancelled via abort), Node would see an unhandled rejection
      // for THIS runPromise and could crash the process. Swallow here so
      // the parent never observes a tail-end child failure that has nothing
      // to do with its decision.
      throw err;
    });
    // Belt-and-braces: ensure NO path can leak an unhandled rejection from
    // runPromise, even if the child ignores abort and rejects later. The
    // microtask handler is a no-op once we've already reported the outcome.
    const fence = runPromise.finally(() => {});
    fence.catch(() => { /* handled by the .then above / parent catch */ });
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
      // MCH-87b: extract the output-contract footer when present. The parent
      // gets a structured tail `[contract: STATUS files=...]` plus the child's
      // summary; when the child ignored the contract the summary is returned
      // as-is (never fail a task purely for a missing footer).
      const m = result.summary.match(/<result>\s*STATUS:\s*(\S+)\s*FILES:\s*([^\n]*)\s*RESULT:\s*([\s\S]*?)<\/result>/i);
      const contractTail = m
        ? ` [contract: ${m[1]} files=${m[2].trim().slice(0, 120)}]`
        : ' [contract: missing]';
      return `[completed=${result.success}] ${result.summary}${contractTail} (${result.tokensUsed} tokens, ${result.durationMs}ms)`;
    } catch (err) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      // Wait briefly for the orphaned child to honour the abort signal so its
      // tail-end rejection (if any) is consumed by the fence above rather
      // than racing to log an "unhandled" after we've already reported.
      const settleMs = 1500;
      await new Promise<void>((res) => {
        const t = setTimeout(res, settleMs);
        runPromise.finally(() => { clearTimeout(t); res(); }).catch(() => {});
      });
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

  /** MCH-41: failover-aware fanout. Rotate the failover chain so sibling N's
   *  PRIMARY is chain entry N % len; every child keeps the full chain (rotated)
   *  as its fallback. index undefined -> original config untouched. */
  private fanoutConfig(config: import('../types.js').ModelConfig, index?: number): import('../types.js').ModelConfig {
    if (index === undefined || index <= 0) return config;
    const chain = [config, ...(config.failover ?? [])];
    if (chain.length < 2) return config;
    const rotated = chain.map((_, k) => chain[(k + index) % chain.length]);
    const [primary, ...rest] = rotated;
    return { ...primary, failover: rest.map((c) => ({ ...c, failover: undefined })) };
  }

/** Spawn multiple subagents concurrently and return their aggregated results.
   *  Bounded by safety.maxConcurrentAgents (distilled from Hermes'
   *  max_concurrent_children): N unbounded Promise.allSettled would OOM or
   *  hammer a free-tier provider. Runs in a fixed pool, reusing spawnSubagent. */
  private async spawnSubagents(
    tasks: Array<{ prompt: string; role?: string; timeoutMs?: number; scratchpad?: string }>
  ): Promise<string[]> {
    // MCH-41 (agents v2): two upgrades to the pool.
    // (1) PRIORITY LANES — read-only research tasks (role=researcher/reviewer)
    //     run on the 'fast' model profile: they need breadth, not depth, and
    //     the fast profile is 3-5x cheaper/quicker. Code-producing roles keep
    //     their profile. Lane is overridable per-task via `lane`.
    // (2) FAILOVER-AWARE FANOUT — when several siblings hit the SAME provider
    //     concurrently, a free-tier rate limit fails ALL of them at once and
    //     each then retries the same chain in lockstep. Assign each parallel
    //     child a rotated entry of config.failover as its PRIMARY, so N
    //     siblings spread across N distinct endpoints; the original primary
    //     stays in each child's failover chain as a fallback.
    const limit = Math.max(1, this.config.safety.maxConcurrentAgents || 3);
    const results = new Array<string>(tasks.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < tasks.length) {
        const i = cursor++;
        const t = tasks[i];
        // MCH-62: retry-once for failed subagents. A transient free-tier
        // rate-limit or a timeout otherwise permanently kills the workstream —
        // the pool slot frees, the parent gets "[FAILED]", and the sibling
        // fanout loses that lane's output. One retry with a DIFFERENT rotated
        // primary (offset by the task count so it lands on a distinct
        // endpoint than both the first attempt and other siblings) and a
        // reduced timeout recovers most transient failures without doubling
        // worst-case latency. Retry never re-runs a SUCCESSFUL child.
        try {
          const lane = (t as { lane?: string }).lane;
          const val = await this.spawnSubagent(t.prompt, { role: t.role, timeoutMs: t.timeoutMs, scratchpad: t.scratchpad, lane, failoverIndex: i });
          results[i] = `[Subagent #${i + 1} (${t.role ?? 'coder'})]: ${val}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          try {
            const lane = (t as { lane?: string }).lane;
            const retryTimeout = t.timeoutMs && t.timeoutMs > 0 ? Math.max(30_000, Math.floor(t.timeoutMs / 2)) : undefined;
            const val = await this.spawnSubagent(t.prompt, { role: t.role, timeoutMs: retryTimeout, scratchpad: t.scratchpad, lane, failoverIndex: i + tasks.length });
            results[i] = `[Subagent #${i + 1} (${t.role ?? 'coder'}, retried after: ${msg.slice(0, 120)})]: ${val}`;
          } catch (err2) {
            const msg2 = err2 instanceof Error ? err2.message : String(err2);
            results[i] = `[Subagent #${i + 1} (${t.role ?? 'coder'}) FAILED]: ${msg2} (first attempt: ${msg.slice(0, 120)})`;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()));
    return synthesizeSubagentResults(results);
  }


  /**
   * MCH-64: mid-stream SPECULATIVE execution of a read-only tool call. Runs
   * the tool into the ExecutionRegistry ONLY (same executionId the real
   * call will use) — no context writes, no events beyond tool:called/
   * completed so the TUI shows work as it happens. The post-stream
   * runMoolCall then registers the same executionId, hits the replay path
   * (execution-registry.ts explicit-replay branch) and appends the cached
   * tool message in correct assistant->tool order with zero re-execution.
   * Any failure here is swallowed: the real execution still runs normally.
   */
  private async specExecCall(tc: ToolCall): Promise<void> {
    try {
      if (this.abortSignal?.aborted) return;
      const toolName = TOOL_ALIASES[tc.function.name] || tc.function.name;
      const args = normalizeToolArgs(toolName, this.parseArgs(tc.function.arguments));
      const rec = this.executionRegistry.register({ toolName, args, executionId: tc.id });
      if (rec.duplicate) return; // already done/in-flight elsewhere — real path handles it
      const ctx: ToolContext = {
        cwd: this.cwd,
        workspace: this.workspace,
        config: this.config,
        events: this.events,
        agentId: this.id,
        abortSignal: this.abortSignal,
        readCache: this.readCache,
        callerEmittedEvent: true,
        // Interactive questions are a top-level affordance: subagents were
        // promised "the child cannot ask questions", so they resolve defaults.
        ...(this.subagentDepth === 0 && this.promptUser ? { promptUser: this.promptUser } : {}),
      };
      const { output, error } = await executeTool(tc.function.name, args, ctx, this.tools);
      if (error) this.executionRegistry.markFailed(rec.executionId, error);
      else this.executionRegistry.markCompleted(rec.executionId, { output });
    } catch {
      // Speculation must never break the run: the real execution retries it.
    }
  }

  private async runMoolCall(tc: ToolCall): Promise<void> {
    if (this.abortSignal?.aborted) return;
    const toolName = TOOL_ALIASES[tc.function.name] || tc.function.name;
    if (this.toolSeq.length < 40) this.toolSeq.push(toolName);
    // Consecutive-identical-call spam guard: the same tool + same args issued
    // 3 times in a row (across iterations) is the "todo spam" pattern — the
    // model loops re-announcing instead of progressing. Veto the 3rd+ with a
    // directive, which both stops the waste and teaches the model to move on.
    const sig = toolName + ':' + (tc.function.arguments ?? '');
    if (sig === this.lastToolSig) {
      this.toolSigRepeat++;
    } else {
      this.lastToolSig = sig;
      this.toolSigRepeat = 1;
    }
    if (this.toolSigRepeat >= 3) {
      this.vetoToolCall(tc, `You have already called ${toolName} with these exact arguments ${this.toolSigRepeat} times in a row. The result will not change. Do NOT call it again — use the result you already have and proceed to the next step of the task.`);
      return;
    }
    // Chat/Q&A turns are conversational: the deliverable is the answer text,
    // never file or shell mutations. A model reaching for write/edit/shell on
    // a greeting ("hi") produced the visible "tool spam + no-such-file error
    // cards" class — veto the mutation outright. Genuine clarification needs
    // go through ask_question (interactive user menu), reads through
    // read/glob/search.
    // SELF-CORRECTION ESCAPE (precedent: complexity escalation, plan escape):
    // the FIRST mutation on a chat lane is vetoed as designed — but if the
    // model comes back and insists, the classifier is wrong for this task: a
    // file deliverable was misread as Q&A (arena q1: "Write the answer … into
    // answer.txt" was answer-classed, every write vetoed, and the run exited
    // green with NO file). On the 2nd mutation veto the run is reclassified to
    // 'implement' and the call falls through to the normal approval gate, so
    // the harness corrects itself instead of stranding the model against a
    // permanent block.
    if (this.taskKind === 'chat' && ['write', 'edit', 'patch', 'delete', 'notebook', 'shell', 'verify', 'subagent', 'spawn_subagent', 'create_pr', 'repl', 'bg_task'].includes(toolName)) {
      this.chatMutationVetoes++;
      this.vetoLog.push({ tool: tc.function.name, reason: `chat-lane mutation veto (chatMutationVetoes=${this.chatMutationVetoes})` });
      if (this.vetoLog.length > 20) this.vetoLog.shift();
      if (this.chatMutationVetoes < 2) {
        this.vetoToolCall(tc, 'This is a conversational question, not an engineering task: answer directly in text and call no mutating tools. If you genuinely need the user to decide something first, call ask_question (it opens an interactive menu) instead. If the task explicitly REQUIRES this mutation as its deliverable (it names a file to produce, e.g. "write X into answer.txt"), repeat the call once — a repeated mutation request is honored as a correction.');
        return;
      }
      this.taskKind = 'implement';
      // Re-advertise the full toolset: the chat tier had narrowed toolDefs to
      // read-only essentials (mch111), and the implement lane needs the real
      // arsenal back — exactly what load_tools does after a mid-run restore.
      this.toolDefs = [...this.tools.values()].map((t) => t.def);
      this.events.emit({ type: 'agent:log', agentId: this.id, message: `[chat-escape] ${this.chatMutationVetoes} chat-lane mutation vetoes but the model insists — task reclassified to implement so the deliverable can proceed.` });
    }
    // APPROVAL GATE (the tiers in security/permission.ts finally enforced):
    // anything the policy does not auto-allow needs a human decision when a
    // UI handler is attached (TUI menu: allow once / always / deny), and is
    // audit-logged either way. Headless runs (no handler) and subagents
    // (depth > 0, never prompt) preserve historical behavior: allow + audit.
    // Plan-mode mutating calls never reach here (batch veto above).
    {
      const policy = normalizePolicy(this.permPolicy);
      if (!this.permMgr || this.permMgr.policy !== policy) {
        this.permMgr = { policy, mgr: new PermissionManager(policy, this.workspace.dir) };
      }
      const parsedArgs = this.parseArgs(tc.function.arguments);
      const auto = this.permMgr.mgr.autoAllow({ tool: toolName, args: parsedArgs, cwd: this.cwd, workspaceDir: this.workspace.dir });
      const auditBase = { ts: new Date().toISOString(), tool: toolName, args: parsedArgs, policy } as const;
      if (auto || policy === 'yolo') {
        this.permMgr.mgr.audit({ ...auditBase, decision: 'allow' });
      } else {
        const alwaysKey = `${toolName}:${tc.function.arguments ?? ''}`;
        if (this.approvedAlways.has(alwaysKey)) {
          this.permMgr.mgr.audit({ ...auditBase, decision: 'allow' });
        } else if (this.subagentDepth > 0 || !this.approvalHandler) {
          // No one to ask (headless host or child agent): allow, loudly
          // audited — identical to pre-gate behavior, never a hang.
          this.permMgr.mgr.audit({ ...auditBase, decision: 'allow' });
        } else {
          const { summary, risk } = describeApproval(toolName, parsedArgs);
          let decision: 'allow-once' | 'allow-always' | 'deny' = 'deny';
          try {
            decision = await this.approvalHandler({ tool: toolName, summary, risk, policy });
          } catch {
            decision = 'deny'; // a broken prompt UI fails closed, never hangs
          }
          if (decision === 'allow-always') {
            if (this.approvedAlways.size < 200) this.approvedAlways.add(alwaysKey);
            this.permMgr.mgr.audit({ ...auditBase, decision: 'allow' });
          } else if (decision === 'allow-once') {
            this.permMgr.mgr.audit({ ...auditBase, decision: 'allow' });
          } else {
            this.permMgr.mgr.audit({ ...auditBase, decision: 'deny' });
            this.vetoToolCall(tc, `User denied ${summary}. Proceed WITHOUT it: work around it with allowed tools, explain what you need and why, or ask a narrower question via ask_question — do not just retry the same call.`);
            return;
          }
        }
      }
    }
    // Fuzzy spam guard (windowed, per tool+target): the exact-match guard
    // above misses two observed live patterns — (a) cycling the same FILE
    // read with interleaved other calls, and (b) re-announcing the same todo
    // action 2x in a row across many rounds (14 todo calls / 7 distinct args
    // in one self-improve trace). Track counts per tool+target for the whole
    // run; over-frequency gets vetoed with a move-on directive.
    if (toolName === 'read' || toolName === 'glob' || toolName === 'search' || toolName === 'todo') {
      const target = toolName + ':' + String(((): string => {
        try { const a = JSON.parse(tc.function.arguments ?? '{}'); return String(a.path ?? a.pattern ?? a.query ?? ((a.action ? a.action + ':' : '') + (a.title ?? ''))); } catch { return tc.function.arguments ?? ''; }
      })());
      const n = (this.readTargetCounts.get(target) ?? 0) + 1;
      this.readTargetCounts.set(target, n);
      if (n >= 4) {
        const verb = toolName === 'todo' ? 're-announced' : 'read';
        this.vetoToolCall(tc, `You have ${verb} "${target}" ${n} times this run. Repeating it will not change anything. Use what you already have and continue the task.`);
        return;
      }
    }
    if (this.budget) {
      this.budget.recordToolCall();
      if (!this.budget.canExecuteTool()) {
        this.context.addKnownError('Tool budget exhausted');
        this.vetoToolCall(tc, 'Tool budget exhausted. Stop calling tools and give your final answer now.');
        // True exhaustion (not just the 'cheap' phase): end the run NOW with
        // what's already on disk instead of veto-looping for minutes. The
        // model hears "give your final answer" but flash models keep issuing
        // tool calls anyway — each one burning a full model round-trip. A
        // bounded, honest early-finish beats an endless veto loop.
        if (this.budget.phase() === 'exhausted') {
          this.events.emit({
            type: 'agent:log',
            agentId: this.id,
            message: '[budget] exhausted — finishing with work completed so far.',
          });
          if (this.activeTask) {
            try {
              const activeGoal = this.context.state.goal || this.activeTask.title;
              this.workspace.saveCheckpoint(activeGoal, `Task paused: budget exhausted at tool ${toolName}.\nObjective: ${this.activeTask.title}\nFiles touched: ${this.context.state.filesModified.join(', ') || 'none'}\nNext: Run "mochi resume" with an increased budget.`);
            } catch { /* best effort */ }
            await this.finish(this.activeTask, this.fileChanged, 'Budget exhausted — work checkpointed. Resume with "mochi resume".', 'budget');
          }
        }
        return;
      }
    }
    // MCH-37: before_tool hook receives the tool's args too (MOCHI_ARGS), so
    // user hooks can veto on CONTENT (block `rm -rf`, force-push, etc.) — the
    // Claude Code PreToolUse capability Mochi lacked for third-party use.
    const before = await this.hooks.runBefore('before_tool', {
      tool: toolName,
      args: tc.function.arguments ?? '{}',
      agent: this.id,
    });
    if (!before.allowed) {
      const reason = (before.stderr || before.stdout).trim().slice(0, 160);
      this.context.addKnownError(`before_tool hook vetoed ${toolName}${reason ? `: ${reason}` : ''}`);
      this.vetoToolCall(tc, `before_tool hook vetoed ${toolName}.${reason ? ` Hook says: ${reason}` : ''}`);
      return;
    }
    if (MUTATING_TOOLS.has(toolName)) {
      const editHook = await this.hooks.runBefore('before_edit', { tool: toolName, args: tc.function.arguments ?? '{}', agent: this.id });
      if (!editHook.allowed) {
        const reason = (editHook.stderr || editHook.stdout).trim().slice(0, 160);
        this.vetoToolCall(tc, `before_edit hook vetoed this edit.${reason ? ` Hook says: ${reason}` : ''}`);
        return;
      }
    }
    if (toolName === 'shell') {
      // MCH-37b: before_shell gets MOCHI_ARGS too — a content-veto hook
      // (block rm -rf) needs the command text, not just the tool name.
      const shellHook = await this.hooks.runBefore('before_shell', { tool: toolName, args: tc.function.arguments ?? '{}', agent: this.id });
      if (!shellHook.allowed) {
        this.vetoToolCall(tc, 'before_shell hook vetoed this shell command.');
        return;
      }
    }
    const args = normalizeToolArgs(toolName, this.parseArgs(tc.function.arguments));

    // WORKSPACE & SCOPE FENCE (drift guard):
    // 1. Mutating tool boundary check: prevent wandering into sibling projects or mutating external files
    if (MUTATING_TOOLS.has(toolName)) {
      const targets: string[] = [];
      if (args.path) targets.push(String(args.path));
      if (args.destination) targets.push(String(args.destination));
      if (args.target) targets.push(String(args.target));
      if (args.file) targets.push(String(args.file));
      if (toolName === 'delete' || toolName === 'move_file') {
        if (args.source) targets.push(String(args.source));
      }

      for (const target of targets) {
        if (!target) continue;
        // (a) Sibling project fence: never mutate files in sibling projects unless explicitly requested
        if (this.isSiblingProject(target) && !this.isPromptAuthorized(target)) {
          this.scopeVetoCount++;
          const focus = this.scopeVetoCount >= 2 ? '\n' + TASK_FOCUS_PROTOCOL : '';
          this.context.addMessage({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content:
              `Vetoed: "${target}" is located inside a separate sibling project. ` +
              `Your active workspace is: ${this.workspace.root}. Your objective is: ${this.activeTask?.title || this.context.initialUserPrompt}. ` +
              `Do not create, edit, or delete files in sibling projects. Focus exclusively on your active workspace.` +
              focus,
          });
          this.events.emit({
            type: 'tool:completed',
            tool: tc.function.name,
            result: { toolCallId: tc.id, name: tc.function.name, output: 'Vetoed: sibling-project mutation (drift guard).', durationMs: 0 },
            agentId: this.id,
          });
          return;
        }

        // (b) Workspace root fence: if workspace is not homedir, never mutate outside workspace (except tmp)
        const abs = this.resolveTargetPath(target);
        const inTmp = this.isTmpPath(abs);
        if (resolve(this.workspace.root) !== resolve(homedir()) && !this.isInsideWorkspace(target) && !inTmp && !this.isPromptAuthorized(target)) {
          this.scopeVetoCount++;
          const focus = this.scopeVetoCount >= 2 ? '\n' + TASK_FOCUS_PROTOCOL : '';
          this.context.addMessage({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content:
              `Vetoed: "${target}" is OUTSIDE the active workspace root (${this.workspace.root}). ` +
              `Your active workspace is: ${this.workspace.root}. Your objective is: ${this.activeTask?.title || this.context.initialUserPrompt}. ` +
              `Keep all file changes strictly inside ${this.workspace.root}.` +
              focus,
          });
          this.events.emit({
            type: 'tool:completed',
            tool: tc.function.name,
            result: { toolCallId: tc.id, name: tc.function.name, output: 'Vetoed: out-of-workspace mutation (drift guard).', durationMs: 0 },
            agentId: this.id,
          });
          return;
        }

        // (c) Task-declared fileScope fence
        if (this.activeTask?.fileScope?.length && !this.pathInScope(target, this.activeTask.fileScope)) {
          this.scopeVetoCount++;
          const focus = this.scopeVetoCount >= 2 ? '\n' + TASK_FOCUS_PROTOCOL : '';
          this.context.addMessage({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content:
              `Vetoed: "${target}" is OUTSIDE this task's scope (${this.activeTask.fileScope.join(', ')}). ` +
              `Your objective is: ${this.activeTask.title}. Do not create or modify files unrelated to it.` +
              focus,
          });
          this.vetoLog.push({ tool: tc.function.name, reason: 'out-of-scope write (drift guard)' });
          if (this.vetoLog.length > 20) this.vetoLog.shift();
          this.events.emit({
            type: 'tool:completed',
            tool: tc.function.name,
            result: { toolCallId: tc.id, name: tc.function.name, output: 'Vetoed: out-of-scope write (drift guard).', durationMs: 0 },
            agentId: this.id,
          });
          return;
        }
      }
    }

    // 2. Read tool boundary check: prevent wandering into sibling projects
    if (toolName === 'read') {
      const target = String(args.path ?? '');
      if (target && this.isSiblingProject(target) && !this.isPromptAuthorized(target)) {
        this.context.addMessage({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content:
            `Vetoed: "${target}" is located inside a separate sibling project. ` +
            `Your active workspace is: ${this.workspace.root}. Do not read files from sibling projects unless explicitly requested in your task.`,
        });
        this.events.emit({
          type: 'tool:completed',
          tool: tc.function.name,
          result: { toolCallId: tc.id, name: tc.function.name, output: 'Vetoed: sibling-project read.', durationMs: 0 },
          agentId: this.id,
        });
        return;
      }
    }

    // Execution Registry deduplication: if identical execution already finished within window, replay it
    const execRecord = this.executionRegistry.register({
      toolName,
      args,
      executionId: tc.id,
    });
    if (execRecord.duplicate && execRecord.result) {
      const cached = execRecord.result as { output: string; error?: string };
      if (cached.error) {
        this.events.emit({ type: 'tool:failed', tool: tc.function.name, error: cached.error, agentId: this.id });
        this.context.addMessage({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: `Error: ${cached.error}`,
        });
      } else {
        this.context.addMessage({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: cached.output,
        });
        this.events.emit({
          type: 'tool:completed',
          tool: tc.function.name,
          result: { toolCallId: tc.id, name: tc.function.name, output: cached.output, durationMs: 0 },
          agentId: this.id,
        });
      }
      return;
    }
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
    if (toolName === 'shell') {
      // (a) cwd fence: ensure args.cwd does not wander into a sibling project or outside workspace
      if (args.cwd) {
        const targetCwd = String(args.cwd);
        if (this.isSiblingProject(targetCwd) && !this.isPromptAuthorized(targetCwd)) {
          this.scopeVetoCount++;
          this.context.addMessage({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: `Vetoed: cwd "${targetCwd}" targets a separate sibling project. Your active workspace is ${this.workspace.root}. Keep commands within the active project.`,
          });
          this.events.emit({ type: 'tool:completed', tool: tc.function.name, result: { toolCallId: tc.id, name: tc.function.name, output: 'Vetoed: sibling-project shell cwd.', durationMs: 0 }, agentId: this.id });
          return;
        }
        const absCwd = this.resolveTargetPath(targetCwd);
        const inTmp = this.isTmpPath(absCwd);
        if (resolve(this.workspace.root) !== resolve(homedir()) && !this.isInsideWorkspace(targetCwd) && !inTmp && !this.isPromptAuthorized(targetCwd)) {
          this.scopeVetoCount++;
          this.context.addMessage({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: `Vetoed: cwd "${targetCwd}" is OUTSIDE the active workspace root (${this.workspace.root}). Stay within the workspace.`,
          });
          this.events.emit({ type: 'tool:completed', tool: tc.function.name, result: { toolCallId: tc.id, name: tc.function.name, output: 'Vetoed: out-of-workspace shell cwd.', durationMs: 0 }, agentId: this.id });
          return;
        }
      }

      // (b) Command text drift guard: check for cd or git -C into sibling projects
      const cmd = String(args.command ?? '');
      const cdMatches = cmd.matchAll(/(?:^|[;&|]\s*)(?:cd|pushd)\s+([^\s;&|]+)/g);
      for (const match of cdMatches) {
        const cdTarget = match[1];
        if (this.isSiblingProject(cdTarget) && !this.isPromptAuthorized(cdTarget)) {
          this.scopeVetoCount++;
          this.context.addMessage({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: `Vetoed: command attempts to cd to "${cdTarget}" in a separate sibling project. Your active workspace is ${this.workspace.root}. Stay within the active workspace.`,
          });
          this.events.emit({ type: 'tool:completed', tool: tc.function.name, result: { toolCallId: tc.id, name: tc.function.name, output: 'Vetoed: sibling-project cd.', durationMs: 0 }, agentId: this.id });
          return;
        }
      }
      const gitCMatches = cmd.matchAll(/(?:^|\s)git\s+-C\s+([^\s;&|]+)/g);
      for (const match of gitCMatches) {
        const gitTarget = match[1];
        if (this.isSiblingProject(gitTarget) && !this.isPromptAuthorized(gitTarget)) {
          this.scopeVetoCount++;
          this.context.addMessage({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: `Vetoed: git -C targets sibling project "${gitTarget}". Your active workspace is ${this.workspace.root}.`,
          });
          this.events.emit({ type: 'tool:completed', tool: tc.function.name, result: { toolCallId: tc.id, name: tc.function.name, output: 'Vetoed: sibling-project git -C.', durationMs: 0 }, agentId: this.id });
          return;
        }
      }

      // (c) Write-outside scope fence
      const isWsRoot = resolve(this.cwd) === resolve(this.workspace.root) && resolve(this.workspace.root) !== resolve(homedir());
      const hasFileScope = Boolean(this.activeTask?.fileScope?.length);
      if (isWsRoot || hasFileScope) {
        const WRITES_OUTSIDE = /\b(mkdir|touch|mv|cp|tee|install|rsync|ln)\b[^;&|]*\.\.|>>?\s*(?!\/)[\w./-]*\.\.\//;
        // Absolute redirect targets bypass the regex above (`> /etc/x` has no
        // `..` and absolute paths are lookahead-excluded): resolve every `>`
        // target through the workspace fence instead. /tmp, /dev/*, and fd
        // redirections (2>, >&2, &>) stay allowed.
        let absRedirect: string | null = null;
        if (cmd) {
          for (const m of cmd.matchAll(/(?:^|[^\d&>])>>?\s*([^\s;&|]+)/g)) {
            const tgt = m[1];
            if (!tgt || tgt.startsWith('&') || tgt === '/dev/null' || tgt.startsWith('/dev/') || /^\d+$/.test(tgt)) continue;
            const resolved = this.resolveTargetPath(tgt);
            if (this.isTmpPath(resolved)) continue;
            if (!this.isInsideWorkspace(tgt) && !this.isPromptAuthorized(tgt)) { absRedirect = tgt; break; }
          }
        }
        if (absRedirect || (cmd && WRITES_OUTSIDE.test(cmd))) {
          this.scopeVetoCount++;
          const focus = this.scopeVetoCount >= 2 ? '\n' + TASK_FOCUS_PROTOCOL : '';
          const what = absRedirect ? `redirects output to "${absRedirect}", which is OUTSIDE` : 'writes OUTSIDE';
          this.context.addMessage({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content:
              `Vetoed: this command ${what} the active workspace root (${this.workspace.root}). ` +
              `Your objective is: ${this.activeTask?.title || this.context.initialUserPrompt}. Do not create or modify files unrelated to it.` +
              focus,
          });
          this.vetoLog.push({ tool: tc.function.name, reason: 'out-of-scope shell write (drift guard)' });
          if (this.vetoLog.length > 20) this.vetoLog.shift();
          this.events.emit({ type: 'tool:completed', tool: tc.function.name, result: { toolCallId: tc.id, name: tc.function.name, output: 'Vetoed: out-of-scope shell write (drift guard).', durationMs: 0 }, agentId: this.id });
          return;
        }
      }
    }
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
      // Interactive questions are a top-level affordance (see above): deeper
      // agents resolve ask_question to deterministic defaults instead.
      ...(this.subagentDepth === 0 && this.promptUser ? { promptUser: this.promptUser } : {}),
      callerEmittedEvent: true,
    };
    this.events.emit({ type: 'tool:called', tool: tc.function.name, args, agentId: this.id, tool_call_id: tc.id });
    const { output, error, durationMs } = await executeTool(tc.function.name, args, ctx, this.tools);
    // MCH-91: `load_tools` mutated the live toolset — re-advertise defs so the
    // newly loaded tools appear in the next packet.
    if (!error && toolName === 'load_tools') {
      this.toolDefs = [...this.tools.values()].map((t) => t.def);
    }
    // Codex/Claude Code parity (MCH-27): a shell command that exits nonzero is
    // a FAILED work step even though the shell tool resolves normally (it
    // embeds `exit_code: N` in its output text). Promote it to a tool error so
    // the completion gate and recovery hints see it — the shell tool itself
    // never sets `error`, which let runs end "successfully" on failed commands.
    let effectiveError = error;
    let effectiveOutput = output;
    if (!error && toolName === 'shell' && typeof output === 'string') {
      const m = /^exit_code: (\d+)/m.exec(output);
      const code = m ? Number(m[1]) : 0;
      if (code !== 0 && !/exit_code: 0/.test(output)) {
        effectiveError = `shell command exited with code ${code}`;
        effectiveOutput = output;
      }
    }
    // Downstream logic (diagnostics, recovery hints, error ledger, completion
    // gate) operates on the exit-code-aware outcome, not the raw tool result.
    const err = effectiveError;
    const out = effectiveOutput;
    // The scope fence promises "SECOND *consecutive*" veto re-injects the
    // focus protocol — a successful mutation breaks the streak, so the counter
    // resets here. Without this, vetoes from an old task kept the protocol
    // stapled to every later veto for the rest of the session.
    if (!err && MUTATING_TOOLS.has(toolName)) this.scopeVetoCount = 0;
    // Instant diagnostics (the Crush LSP insight): after every edit, surface
    // type/syntax errors for the touched file in the SAME turn so the model
    // fixes them now instead of burning whole iterations discovering them at
    // verification time.
    let diagNote = '';
    if (['write', 'edit', 'patch'].includes(toolName) && !err) {
      const targets = [String(args.path ?? '')].filter(Boolean);
      if (toolName === 'patch' && typeof output === 'string') {
        for (const line of output.split('\n')) {
          const m = line.match(/^- (?:added|updated|deleted) (.+?)(?: \(\d+ lines\))?$/);
          if (m && /\.(ts|tsx|js|jsx|mts|cts|py|json|go)$/i.test(m[1])) targets.push(m[1]);
        }
      }
      if (targets.length > 0 && targets.length <= 4) {
        const lintable = targets.filter((t) => /\.(ts|tsx|js|jsx|mts|cts|py|json|go)$/i.test(t));
        // Aider auto-fix pass: before diagnosing, let the project's own
        // fixer clean mechanical issues (import order, unused vars where
        // auto-fixable, formatting). Only runs when the fixer exists and the
        // repo opted into the linter — bounded, best-effort, never blocks.
        if (lintable.length > 0 && lintable.length <= 4) {
          await this.autoLintFix(lintable);
        }
        const diags = await Promise.all(
          lintable.map((t) => diagnoseFile(resolve(this.cwd, t), this.cwd)),
        );
        diagNote = renderDiagnostics(diags);
      }
    }
    let recoveryHint = '';
    if (err) {
      const errSig = err.slice(0, 100);
      // MCH-60: cross-tool failure loop — track the error signature regardless
      // of which tool produced it. A model alternating shell->patch->shell
      // with the same root cause never trips the per-tool counter above.
      const crossPrev = this.crossToolErrorSig.get(errSig);
      if (crossPrev !== undefined && crossPrev.tool !== toolName) {
        crossPrev.count++;
        if (crossPrev.count === 2) {
          recoveryHint += `\n[HARNESS ADVISORY: This same failure signature has now appeared across multiple different tools (last: '${crossPrev.tool}', now: '${toolName}'). The root cause is shared — stop retrying either tool and re-diagnose from the first error message.]`;
        }
      } else if (crossPrev) {
        crossPrev.count++;
      }
      this.crossToolErrorSig.set(errSig, crossPrev ?? { tool: toolName, count: 1 });
      const prevError = this.consecutiveToolErrors.get(toolName);
      if (prevError && prevError.error === errSig) {
        prevError.count++;
        if (prevError.count >= 3) {
          recoveryHint += `\n[CRITICAL HARNESS ADVISORY: Tool '${toolName}' has failed ${prevError.count} times consecutively with the same error. Do NOT retry this exact call. Use a different tool (e.g. read/glob/search) or report the blocker directly.]`;
        }
      } else {
        this.consecutiveToolErrors.set(toolName, { error: errSig, count: 1 });
      }

      const errLower = err.toLowerCase();
      if (errLower.includes('oldtext') || errLower.includes('did not match') || errLower.includes('patch')) {
        recoveryHint += '\n[Harness Hint: Target text was not found verbatim in the file. Call read tool to inspect current lines before editing.]';
      } else if (errLower.includes('enoent') || errLower.includes('file not found') || errLower.includes('no such file') || (errLower.includes('not found') && !errLower.includes('oldtext'))) {
        recoveryHint += '\n[Harness Hint: Target file was not found. Use glob or search to verify paths before editing/reading.]';
      } else if (toolName === 'shell' && (errLower.includes('exit') || errLower.includes('failed') || errLower.includes('command not found'))) {
        recoveryHint += '\n[Harness Hint: Shell command failed. Review the terminal error above to fix syntax or missing packages.]';
        // MCH-93: a test failing right after THIS run wrote the test file means
        // the test (or its assumptions), not the world, is broken — fix your
        // own recent output first instead of rewriting the implementation.
        const wroteTest = this.context.state.filesModified.some((f) => /test|spec/i.test(f));
        const failureRefersToWritten = this.context.state.filesModified.some((f) => err.includes(f.split('/').pop() ?? ''));
        if (wroteTest || failureRefersToWritten) {
          recoveryHint += `\n[Harness Hint: You wrote/modified these files yourself moments ago: ${this.context.state.filesModified.slice(-4).join(', ')}. The failure is inside your own recent output — re-read what you just wrote and correct it; do not blame or rewrite unrelated code.]`;
        }
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
      output: (err ? `Error: ${err}\n${out}` : out) + (diagNote ? `\n${diagNote}` : '') + recoveryHint,
      error: err,
      durationMs,
    };
    // Uniform output policy (Harness V2): dual-limit truncation preserving
    // head+tail whole lines, with the FULL output spilled to a temp file the
    // model can re-read. Replaces the old 6k-char fold that could lose the
    // one line the model needed with no recovery path.
    // ANSI hygiene FIRST: colored tool output (npm/git --color=always) in the
    const pol = applyToolOutputPolicy(scrubAnsiFragments(maybeRedact(result.output)), { toolName: tc.function.name });
    const foldedOutput = pol.content;
    if (err) {
      this.consecutiveToolErrorsCount++;
      this.toolErrorLog.push({ tool: TOOL_ALIASES[toolName] || toolName, error: String(err) });
      if (this.toolErrorLog.length > 20) this.toolErrorLog.shift();
      this.executionRegistry.markFailed(execRecord.executionId, err);
      // Codex-style completion gate input: remember the LAST tool outcome so
      // finish() can tell "ended on a failure" from "recovered from one".
      // WORK tools (shell/mutating edits/verify/deliverables) count — a failed
      // speculative `read`/`search` miss is normal exploration, not a failed
      // deliverable. Verify/subagent failures DO count: ending on a failed
      // verify is not a completion.
      if (['shell', 'write', 'edit', 'patch', 'delete', 'git', 'verify', 'subagent', 'spawn_subagent', 'create_pr'].includes(TOOL_ALIASES[toolName] || toolName)) {
        this.lastToolError = String(err);
      }
    } else {
      this.consecutiveToolErrorsCount = 0;
      // Only a successful WORK tool clears the completion gate. A failed shell
      // followed by a routine `read` must still report the failure at finish().
      // It also ends a forced recovery-plan interval: the model has resumed
      // execution, so a later plan-shaped response is judged normally.
      if (['shell', 'write', 'edit', 'patch', 'delete', 'git', 'verify', 'subagent', 'spawn_subagent', 'create_pr'].includes(TOOL_ALIASES[toolName] || toolName)) {
        this.lastToolError = null;
        this.autoPlanEscapePending = false;
      }
      this.executionRegistry.markCompleted(execRecord.executionId, { output: foldedOutput });
      // MCH-28: a successful accept_plan call flips plan mode to "plan
      // submitted" — the loop's no-tool-call path then ends the run with the
      // submitted plan instead of regex-guessing prose shape.
      if ((TOOL_ALIASES[toolName] || toolName) === 'accept_plan' && this.planMode && String(result.output ?? '').startsWith('Plan accepted')) {
        this.planAccepted = true;
        // Recover the submitted plan text from the persisted artifact.
        try {
          const saved = this.workspace.readJson<{ plan?: string }>('state/plan.json', {});
          if (typeof saved.plan === 'string' && saved.plan) this.planAcceptedText = saved.plan;
        } catch { /* fall back to prose */ }
      }
      // Quality slice 5: track result-hash redundancy. When the model re-reads
      // the same file (or any tool returns the same output repeatedly) it has
      // lost the thread. The result-hash map feeds the STRUGGLE STATE
      // injector on the next iteration. Cap entries at 50 to bound memory.
      this.trackToolResultHash(toolName, foldedOutput);
    }
    this.context.addMessage({ role: 'tool', tool_call_id: tc.id, content: foldedOutput, name: tc.function.name });
    this.events.emit({ type: 'tool:completed', tool: tc.function.name, result, agentId: this.id });
    await this.hooks.runAfter('after_tool', { tool: toolName, agent: this.id });
    if (MUTATING_TOOLS.has(toolName)) {
      await this.hooks.runAfter('after_edit', { tool: toolName, agent: this.id });
      // Auto-format on edit: after a successful edit/write/patch, run the
      // repo's formatter on the changed file so style drift never accumulates.
      // Silent + best-effort: format output is never surfaced to the model, and
      // a missing formatter or format failure is a no-op (never blocks the edit).
      if (!err && toolName !== 'delete') {
        try { await this.autoFormatAfterEdit(toolName, args); } catch { /* best-effort */ }
      }
    }
    if (toolName === 'shell') {
      await this.hooks.runAfter('after_shell', { tool: toolName });
    }
    if (err) {
      await this.hooks.runAfter('on_error', {
        tool: toolName,
        error: String(err),
        durationMs: String(durationMs),
      });
      this.errors.push(err);
      this.context.addKnownError(err);
      const classified = classifyErrorPattern(err);
      if (classified) {
        this.seenPatterns.add(classified.pattern);
        this.learning.record(classified.pattern, this.lastStrategy ?? 'unclassified', false);
      }
    }
    // Manual verification recognition: the agent ran a repo check via shell
    // and it exited 0. Harness verify() only runs on prose-completion, so
    // shell-verified work was previously invisible — the finish drive never
    // armed and verified runs wandered. Recognize it as a pass (arms the
    // post-pass nudge/finish; feeds the progress heartbeat too).
    if (!err && toolName === 'shell' && typeof args.command === 'string' && typeof out === 'string'
      && isManualCheckPass(args.command, out)) {
      this.lastVerifyPassed = true;
      this.recordVerifyPass(`Manual check passed: \`${args.command.slice(0, 120)}\` (exit 0)`);
      this.consecutiveVerifyFailures = 0;
    }
    this.trackFileChange(toolName, args, { output: out, error: err });
  }
  /** Auto-format a file after a successful edit/write/patch. Silent + best-effort:
   *  - Only runs when a formatter is configured (prettier/biome/black/gofmt/rustfmt).
   *  - Never surfaces output to the model (would be noise) and never blocks the edit.
   *  - patch/write may touch many files; format only the ones we can identify. */
  private async autoFormatAfterEdit(toolName: string, args: Record<string, unknown>): Promise<void> {
    // Identify target file(s) from the tool args.
    const targets: string[] = [];
    const pathArg = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : '';
    if (pathArg) targets.push(pathArg);
    // patch carries a diff; pull +++ b/ paths out of it.
    if (toolName === 'patch' && typeof args.diff === 'string') {
      for (const m of args.diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) targets.push(m[1]);
    }
    if (!targets.length) return;
    const { formatTool } = await import('../tools/format.js');
    for (const t of targets) {
      try {
        await formatTool.execute({ path: t }, { cwd: this.cwd } as never);
      } catch { /* best-effort: formatting must never block an edit */ }
    }
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

  private extractToolCallsFromText(text: string): Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> {
    if (!text || !text.trim()) return [];
    const knownTools = new Set<string>();
    for (const t of this.toolDefs) {
      knownTools.add(t.name.toLowerCase());
    }
    for (const alias of Object.keys(TOOL_ALIASES)) {
      knownTools.add(alias.toLowerCase());
    }

    const results: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];

    // 1. XML style: <tool_call> ... </tool_call>
    const xmlRegex = /<(?:tool_call|tool-call|call)>([\s\S]*?)<\/(?:tool_call|tool-call|call)>/gi;
    let xmlMatch: RegExpExecArray | null;
    while ((xmlMatch = xmlRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(xmlMatch[1].trim());
        const rawName = String(parsed.name || parsed.tool || parsed.function || '').toLowerCase();
        const name = TOOL_ALIASES[rawName] || rawName;
        if (knownTools.has(name) || knownTools.has(rawName)) {
          const rawArgs = parsed.arguments ?? parsed.parameters ?? parsed.args ?? {};
          const argsStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
          results.push({
            id: `call_extracted_${Date.now()}_${results.length}`,
            type: 'function',
            function: { name, arguments: argsStr },
          });
        }
      } catch {}
    }
    if (results.length > 0) return results;

    // 2. Markdown fence style: ```json ... ```
    const fenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
    let fenceMatch: RegExpExecArray | null;
    while ((fenceMatch = fenceRegex.exec(text)) !== null) {
      try {
        const parsed = JSON.parse(fenceMatch[1].trim());
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const rawName = String(item.name || item.tool || item.function || '').toLowerCase();
            const name = TOOL_ALIASES[rawName] || rawName;
            if (knownTools.has(name) || knownTools.has(rawName)) {
              const rawArgs = item.arguments ?? item.parameters ?? item.args ?? {};
              results.push({
                id: `call_extracted_${Date.now()}_${results.length}`,
                type: 'function',
                function: { name, arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs) },
              });
            }
          }
        } else if (typeof parsed === 'object' && parsed !== null) {
          const rawName = String(parsed.name || parsed.tool || parsed.function || '').toLowerCase();
          const name = TOOL_ALIASES[rawName] || rawName;
          if (knownTools.has(name) || knownTools.has(rawName)) {
            const rawArgs = parsed.arguments ?? parsed.parameters ?? parsed.args ?? {};
            results.push({
              id: `call_extracted_${Date.now()}_${results.length}`,
              type: 'function',
              function: { name, arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs) },
            });
          }
        }
      } catch {}
    }

    return results;
  }

  /** Replace unfilled hints in a verification command (models sometimes write
   *  `cd <project_root> && zig build test`; the `<...>` is shell-redirect
   *  syntax and would blow up sh). Strip a leading `<project_root>`/`<root>`
   *  cd so the command runs from the agent already-fixed cwd. */
  private sanitizeVerify(cmd: string): string { return sanitizeVerifyCommand(cmd); }

  private async verify(task: Task, repo: ReturnType<typeof detectRepo>): Promise<{ passed: boolean; summary: string }> {
    if (this.profile?.verification === 'none') {
      return { passed: true, summary: 'Verification skipped by profile.' };
    }
    const taskKind = this.taskKind ?? classifyTaskKind(task);
    if (taskKind === 'chat' || taskKind === 'research' || taskKind === 'plan' || this.planMode) {
      return { passed: true, summary: `No verification required for ${taskKind} task.` };
    }
    // Refresh the shell-mutation flag BEFORE any gate consults it: the model
    // may have mutated the workspace entirely via shell (`sed -i`, scaffolds),
    // which never sets fileChanged.
    await this.shellMovedWorkspace();
    if (!this.fileChanged && !this.shellWorkspaceMoved && !task.verificationCommand) {
      return { passed: true, summary: 'No changes made to verify.' };
    }

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
    // Greenfield builds (new game/app/file) skip the repo suite unconditionally:
    // running the host repo's suite to verify a brand-new game is the "just
    // tests instead of building" failure class.
    const greenfield = isGreenfieldTask(task.title, task.description ?? '', task.fileScope, (p) => {
      try { return existsSync(resolve(this.cwd, p)); } catch { return false; }
    });
    if (!scopeDir && !this.contentOnly && !greenfield) {
      if (repo.testCommand) checks.push(repo.testCommand);
      // Optional checks (typecheck/lint) only when the tool is installed:
      // the registry now knows `python3 -m ruff check .`, `cargo clippy`,
      // `go vet`, etc. for every repo, but verification must not FAIL a run
      // because the lint tool isn't on this machine.
      if (repo.typecheckCommand && commandAvailable(repo.typecheckCommand, this.cwd)) checks.push(repo.typecheckCommand);
      if (repo.lintCommand && commandAvailable(repo.lintCommand, this.cwd)) checks.push(repo.lintCommand);
      if (repo.buildCommand && commandAvailable(repo.buildCommand, this.cwd)) checks.push(repo.buildCommand);
    } else if (greenfield && checks.length === 0) {
      const criteriaFailGreen = this.checkArtifactCriteria(task);
      if (criteriaFailGreen) return { passed: false, summary: criteriaFailGreen };
      if (this.fileChanged) return { passed: true, summary: 'Greenfield build: files created, no repo suite applicable (skipped by design).' };
    }
    // Auto-detected real test runner: only added when the explicit
    // verificationCommand is weak (e.g. `test -f ... && grep ...`) so the
    // mutation check has actual code coverage to evaluate. Skipped when the
    // command is already a real runner, and skipped for CONTENT-ONLY tasks:
    // a direct check IS the proportionate verification for content, and an
    // auto-added repo suite burns tokens / fails correct work on debt.
    // Also skipped for greenfield builds: a new game file must not trigger
    // the host repo's suite.
    if (isWeakVerification(task.verificationCommand) && !this.contentOnly && !greenfield) {
      const auto = autoTestCommand(this.cwd, task.fileScope);
      if (auto) checks.push(auto);
    }
    // MCH-31: independent acceptance-criteria gate runs BEFORE any command
    // logic — a task can state concrete criteria with no verification command
    // at all, and those must still gate completion (Codex re-checks acceptance
    // independently of whatever evidence the builder collected).
    const criteriaFail = this.checkArtifactCriteria(task);
    if (criteriaFail) return { passed: false, summary: criteriaFail };

    if (checks.length === 0) return { passed: true, summary: 'No verification configured.' };

    const baseline = await this.verifyBaseline;
    // Intent gate on debt-masking: when the TASK ITSELF demands green checks
    // ("make npm test pass", "fix so pytest passes"), a failing check IS the
    // success criterion - pre-existing identical failure must NOT mask it.
    // Dogfood finding: masking let an unfixed broken runner count as done.
    const wantsGreen = /\b(make|get|turn)\b[^.\n]{0,60}\b(pass|green)\b|\b(tests?|suite)\b[^.\n]{0,40}\b(must|should|to)\b[^.\n]{0,20}\bpass\b|\ball tests?\b|\b(pytest|npm test|node --test|go test|vitest|jest)\b[^.\n]{0,40}\b(pass(ing|es)?|green)\b/i.test(
      `${task.title} ${task.description} ${(task.acceptanceCriteria ?? []).join(' ')}`,
    );

    // Fast-fail with the tests related to the changed files before paying for
    // the full suite. A targeted failure is breakage in the code the agent just
    // touched, so surface it now and skip the slow checks this iteration; on a
    // targeted pass we still run the authoritative full set below (a narrow
    // pass never stands in for the real gate).
    if (repo.testCommand && checks.includes(repo.testCommand)) {
      try {
        const plan = await planTargetedTests(this.cwd, repo, repo.testCommand);
        if (plan.command) {
          const out = await this.runShell(plan.command, 180);
          const exitLine = out.match(/^exit_code: (\d+)/);
          const failedNow = !((exitLine && Number(exitLine[1]) === 0) || out.trim().endsWith('PASS'));
          if (failedNow && (wantsGreen || !matchesBaseline(baseline, plan.command, out))) {
            const condensed = condenseOutput(out, { maxLines: 60, preserveContext: 3 });
            return { passed: false, summary: `Check failed: ${plan.command} (targeted: ${plan.reason})\n${condensed.condensed}` };
          }
        }
      } catch {
        /* selection is best-effort; the full suite still runs below */
      }
    }

    // Independent commands run in PARALLEL: test/typecheck/lint/build share no
    // state, so wall-clock per verification is the slowest check, not the sum.
    // Reporting keeps deterministic first-failure-in-declared-order semantics.
    const outcomes = await Promise.all(
      checks.map(async (cmd) => ({ cmd, out: await this.runShell(cmd, 180) })),
    );
    for (const { cmd, out } of outcomes) {
      // Strict exit-code parse: the old substring check false-PASSed when
      // "exit_code: 0" was echoed inside stdout/stderr of a failing command.
      const exitLine = out.match(/^exit_code: (\d+)/);
      if ((exitLine && Number(exitLine[1]) === 0) || out.trim().endsWith('PASS')) {
        continue;
      }
      // Pre-existing failure: identical failure captured before this run
      // started. It is repo debt, not agent breakage; do not fail the task.
      if (!wantsGreen && matchesBaseline(baseline, cmd, out)) {
        continue;
      }
      const condensed = condenseOutput(out, { maxLines: 60, preserveContext: 3 });
      return { passed: false, summary: `Check failed: ${cmd}\n${condensed.condensed}` };
    }
    return { passed: true, summary: `All checks passed: ${checks.join(', ')}` };
  }

  /**
   * MCH-31 (Codex-style independent acceptance): commands passing proves the
   * suite is green; it does NOT prove the task's stated acceptance criteria
   * are met. Each criterion naming a concrete artifact (file existence /
   * content) is verified directly against the filesystem, independent of the
   * builder's claims. Criteria with no checkable artifact return null (left
   * to the self-review pass). Returns a failure summary string or null.
   */
  private checkArtifactCriteria(task: Task): string | null {
    const artifactCriteria = (task.acceptanceCriteria ?? []).filter((c) => {
      const s = c.toLowerCase();
      return /exists?\b|\bfile\b|\bcreated\b|\bcontains?\b|\bgrep\b|\btest -f\b/.test(s);
    });
    for (const criterion of artifactCriteria) {
      const paths = extractPathsFromCriterion(criterion);
      for (const p of paths) {
        const abs = resolve(this.cwd, p);
        let exists = false;
        try { exists = existsSync(abs); } catch { /* unreadable -> missing */ }
        if (!exists) {
          return `Acceptance criterion not met: "${criterion}" — expected artifact ${p} does not exist.`;
        }
        // Content criterion: "contains X" -> check the file for the term.
        const contentMatch = /contains?\s+(?:the\s+)?(?:text\s+)?["'`]?([^\s"'`]{2,64})["'`]?/i.exec(criterion);
        if (contentMatch) {
          try {
            const body = readFileSync(abs, 'utf8');
            if (!body.includes(contentMatch[1])) {
              return `Acceptance criterion not met: "${criterion}" — ${p} exists but does not contain "${contentMatch[1]}".`;
            }
          } catch { /* binary/dir: existence already checked */ }
        }
      }
    }
    return null;
  }

  /**
   * Speculative reasoning preflight. Opt-in gate: only active when
   * model.speculative.preflight is true AND the primary provider is configured
   * with a 'reasoning' profile we can borrow (the SpeculativeEngine builds its
   * own provider from this.config.model). We bind the engine to a fresh budget
   * that borrows the shared run budget's limits so a runaway preflight can't
   * silently overspend the task's model-call allocation.
   */
  private specPreflightEnabled(): boolean {
    return !!this.config.model?.speculative?.preflight;
  }

  private async maybeSpeculativePreflight(task: Task): Promise<void> {
    this.specPreflighted = true;
    // Never block a task on the preflight. Any failure (provider down, budget
    // exhausted, aborted) degrades to a no-op; the main loop proceeds normally.
    try {
      if (this.abortSignal?.aborted) return;
      if (this.budget && !this.budget.canMakeModelCall()) return;
      const shared = this.budget;
      const budget = shared ?? new BudgetEngine(this.config.safety);
      budget.start();
      const engine = new SpeculativeEngine(this.config, budget, 3 /* candidateCount */);
      const question = task.title + (task.description ? `\n\nContext: ${task.description}` : '');
      // Learning loop: past strategy→outcome records on similar tasks bias
      // generation toward what actually resolved before (experience curve).
      const past = retrieveSpeculationMemory(this.workspace.dir, task.title);
      const result = await engine.speculate(question, { pastOutcomes: speculationMemoryToPrompt(past) });
      if (this.abortSignal?.aborted) return;
      const best = result.best ?? result.candidates[0];
      if (!best) return;
      this.speculatedStrategy = best.strategy.slice(0, 200);
      this.speculatedQuestion = task.title.slice(0, 200);
      const note = best.response?.trim() || best.strategy ||
        result.candidates
        .map((c, i) => `[candidate ${i + 1}] (score ${c.score ?? '-'}) ${c.strategy}`)
        .join('\n');
      if (!note) return;
      const rejected = result.candidates
        .filter((c) => c !== best && (c.score ?? 0) >= 1)
        .slice(0, 2)
        .map((c) => `- ${c.strategy.slice(0, 120)}`)
        .join('\n');
      this.context.addMessage({
        role: 'system',
        content:
          'SPECULATIVE PREFLIGHT (multi-candidate reasoning pass before committing):\n' +
          `Chosen approach (verifier score ${best.score ?? '-'}/10): ${best.strategy}\n` +
          (best.verdictReason ? `Why it won: ${best.verdictReason}\n` : '') +
          `Execution plan:\n${note}\n` +
          (rejected ? `Rejected alternatives (do NOT re-derive these):\n${rejected}\n` : '') +
          'Use this as a starting hypothesis. If it is wrong once you gather real' +
          ' evidence from the repo, discard it and re-plan — do not force it.',
      });
      this.events.emit({ type: 'agent:log', agentId: this.id, message: '[speculative-preflight] injected approach hint' });
    } catch (e) {
      this.events.emit({ type: 'agent:log', agentId: this.id, message: `[speculative-preflight] skipped: ${String(e).slice(0, 120)}` });
    }
  }

  /** Auto-skill-creation trigger (Hermes-faithful). When a lesson or repeated
   *  failure pattern signals a task class that recurs, inject a bounded hint
   *  telling the model it may author a SKILL.md via the skill_manage tool.
   *  Fires at most once per task and is pure guidance — it never blocks. */
  private maybeSuggestSkill(): void {
    if (this.skillNudged || this.planMode) return;
    this.skillNudged = true;
    try {
      const lessons = (this.lastLessons ?? []).map((l) => ({ title: l.lesson }));
      const errorPattern = this.diagnosis?.kind;
      const repeatCount = this.strategyRepeats ?? 0;
      const opps = detectSkillOpportunities(lessons, errorPattern, repeatCount);
      const hint = opportunitiesToPrompt(opps);
      if (!hint) return;
      this.context.addMessage({ role: 'system', content: hint });
      this.events.emit({ type: 'agent:log', agentId: this.id, message: '[skills] flagged auto-skill creation opportunity' });
    } catch (e) {
      this.events.emit({ type: 'agent:log', agentId: this.id, message: `[skills] suggest skipped: ${String(e).slice(0, 100)}` });
    }
  }

  private pulse(iteration: number, _task: Task): { abort: boolean; reason?: string; message?: string } {
    const recentErrors = this.errors.slice(-3);
    const allSame = recentErrors.length === 3 && new Set(recentErrors).size === 1;
    if (allSame) {
      return { abort: false, message: `Pulse: the last 3 errors were the same (${recentErrors[0]}). Try a different strategy or gather more context before retrying.` };
    }
    if (iteration > 0 && iteration % 12 === 0) {
      return { abort: false, message: `Pulse: ${iteration} iterations. Verify progress and switch approach if blocked.` };
    }
    // Empty-response termination lives in the no-tool-call path (finishes at
    // 3 consecutive empties); no dead counter check here.
    if (this.consecutiveToolErrorsCount >= 8 && !this.fileChanged) {
      return { abort: true, reason: `Too many consecutive tool failures (${this.consecutiveToolErrorsCount}) without file changes. Stopping.` };
    }
    // Veto-stall breaker: vetoed calls change nothing by construction, so a
    // streak of 5 means the model is stuck arguing with the guardrails, not
    // working. Stop with an honest verdict instead of burning maxIterations.
    // (The streak resets on any successful mutation — see runMoolCall.)
    if (this.scopeVetoCount >= 5) {
      return { abort: true, reason: `Stalled on guardrails: ${this.scopeVetoCount} consecutive vetoed calls with no successful work. Stopping.` };
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
  private async observeFailure(task: Task, failureText: string, _repo: ReturnType<typeof detectRepo>): Promise<void> {
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

    // MCH-77: consult the cross-run LearningStore — if this error pattern was
    // seen in prior sessions, surface the historically best strategy so the
    // warm start beats cold retries.
    try {
      const classified = classifyErrorPattern(failureText);
      if (classified) {
        const best = this.learning.bestStrategy(classified.pattern);
        if (best && best.successes > 0) {
          const rate = Math.round((best.successes / best.attempts) * 100);
          this.lastStrategy = best.strategy;
          this.context.addMessage({ role: 'system', content: `[learning] In prior sessions, error pattern ${classified.pattern} was fixed by strategy "${best.strategy}" (${best.successes}/${best.attempts} successes, ${rate}%). Prefer this approach unless evidence contradicts it.` });
        }
      }
    } catch { /* learning hint must never block failure handling */ }

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

    if (top?.description) {
      this.anchor.rejectApproach(top.description, failureText.slice(0, 120));
    }

    // Surface the diagnostic to the model. Lessons first (they're the most
    // actionable), then the hypothesis ordering, then the raw failure text.
    const parts = ['Verification failed. Treat this as a HYPOTHESIS rather than a generic retry:'];
    if (this.lastLessons.length) parts.push(lessonsToPrompt(this.lastLessons));
    const continuity = this.anchor.renderContinuityContext();
    if (continuity) parts.push(continuity);
    parts.push(diagnosisToPrompt(this.diagnosis));
    parts.push('--- failure evidence ---');
    parts.push(failureText);
    parts.push('Pick the most likely hypothesis (or your own), take ONE focused action, then re-run verification. Do not just retry the same edit.');
    this.context.addMessage({ role: 'user', content: parts.join('\n\n') });
    // A lesson was just surfaced; if this task class recurs, nudge the model to
    // persist a reusable SKILL.md via skill_manage (auto skill creation).
    this.maybeSuggestSkill();
    // DeepSeek-style structured self-critique on the verify failure of a
    // hard task: forces a deliberate repair plan instead of a blind retry.
    this.maybeSelfCritique(task, failureText);
  }

  /** model.speculative.selfCritique: inject a structured self-critique directive
   *  after verification failure so the next attempt is a conscious
   *  repair with an explicit causal theory. Once per task, never blocks. */
  private selfCritiqued = false;
  private lastStruggleInjectIter = -10;

  /**
   * Quality slice: build a one-shot struggle summary and inject it as a
   * system message so the model knows it has been struggling. Cheap
   * computation; no I/O. The summary covers:
   *  - consecutive tool errors (per-tool) — signals "don't retry the same call"
   *  - cross-tool errors with the same signature — "root cause is shared"
   *  - empty-response count — "your provider is dropping requests"
   *  - last tool error — the most recent failure the model has not seen
   *  - recent known errors — the persisted addKnownError log
   *  - verify count + pass state — how many verify cycles have run
   *  - turn count — how deep in the loop we are
   *
   * Rate-limited to once per 2 iterations (lastStruggleInjectIter); no-op
   * when there are no signals. Result: a struggling model is reminded
   * of its situation; a healthy model pays no cost (the message is
   * dropped before it reaches the system role).
   */
  /** Progress heartbeat: every HEARTBEAT_EVERY turns, check whether the
   *  agent actually advanced (new files read/edited, or a passing verify).
   *  Exact-repeat and oscillation guards catch IDENTICAL thrash; this catches
   *  the worse failure — DIFFERENT actions every turn that go nowhere (the
   *  "loops and never gets anything done" run that burns all 80 iterations).
   *  First stalled heartbeat nudges (refocus or declare blocked); the second
   *  consecutive one stops honestly with a tried-this summary instead of
   *  burning the remaining budget. Skipped for content-only (chat) tasks,
   *  where acting isn't the point. Returns a finish result when stopping,
   *  null otherwise (caller returns it directly). */
  /** Record a passing verification (harness or recognized manual check).
   *  Arms the post-pass finish drive: the NEXT non-editing tool turns count
   *  toward nudging/stopping instead of wandering forever after success. */
  private recordVerifyPass(summary: string): void {
    this.verifyPassTotal++;
    this.verifyPassArmed = true;
    this.postPassToolTurns = 0;
    this.lastVerifySummary = summary.slice(0, 500);
  }

  /** Post-pass finish drive. Call once per turn that executed tool calls:
   *  - a turn containing any edit disarms (the pass is stale, re-verify later);
   *  - otherwise, when a pass is armed, count up: nudge at NUDGE_TURNS
   *  ("verification passed — finish now"), harness-finish at FINISH_TURNS.
   *  Returns a finish result when the harness concludes, null otherwise. */
  private async postPassDrive(task: Task, toolNames: string[]): Promise<AgentResult | null> {
    const MUTATING = new Set(['edit', 'write', 'delete', 'patch', 'replace_symbol']);
    if (toolNames.some((n) => MUTATING.has(TOOL_ALIASES[n] || n))) {
      this.verifyPassArmed = false;
      this.postPassToolTurns = 0;
      return null;
    }
    if (!this.verifyPassArmed) return null;
    this.postPassToolTurns++;
    if (this.postPassToolTurns === POST_PASS_NUDGE_TURNS) {
      this.context.addMessage({
        role: 'system',
        content: `VERIFIED — FINISH NOW: verification already PASSED (${this.lastVerifySummary.slice(0, 200)}). The work is done. Write your final summary with NO tool calls: what changed, how it was verified. Do NOT start new work, do NOT re-run passing checks, do NOT polish. If something is genuinely still broken, say exactly what — otherwise conclude.`,
      });
      return null;
    }
    if (this.postPassToolTurns >= POST_PASS_FINISH_TURNS) {
      const touched = [...(this.context['state']?.filesModified as string[] | undefined ?? [])].slice(-8);
      this.addAttempt(task, 'verified-complete', [], 'success', this.lastVerifySummary);
      return this.finish(task, true,
        `Complete (verified): ${this.lastVerifySummary} Files modified: ${touched.join(', ') || 'none'}. ` +
        `(Finished by harness: verification had passed and ${POST_PASS_FINISH_TURNS} further tool turns produced no new edits.)`,
        'completed');
    }
    return null;
  }

  private async progressHeartbeat(iter: number, task: Task): Promise<AgentResult | null> {
    if (this.contentOnly) return null;
    if (iter - this.lastHeartbeatIter < HEARTBEAT_EVERY) return null;
    this.lastHeartbeatIter = iter;
    const counts = this.context.fileOpCounts();
    const cur: ProgressSnap = { read: counts.read, edited: counts.edited, verifyPass: this.verifyPassTotal };
    if (heartbeatShowsProgress(this.lastProgressSnap, cur)) {
      this.lastProgressSnap = cur;
      this.noProgressStreak = 0;
      return null;
    }
    this.noProgressStreak++;
    if (this.noProgressStreak === 1) {
      // Restate the objective + criteria verbatim: a drifted model may have
      // forgotten what it was asked to do (long context, compaction). A bare
      // "refocus" without the target is nagging, not guidance.
      const objective = task.title + (task.description && task.description !== task.title ? ` — ${task.description}` : '');
      const criteria = (task.acceptanceCriteria ?? []).join('; ') || '(none stated — finish the objective as described)';
      this.context.addMessage({
        role: 'system',
        content: `PROGRESS CHECK (turn ${iter + 1}): ${HEARTBEAT_EVERY} turns with no new files read, no edits, and no passing verification. You may be going in circles.\n\nYour ACTUAL task (do this, nothing else): ${objective}\nAcceptance criteria: ${criteria}\n\nTake one concrete step toward THOSE criteria now (read the ONE most relevant file you haven't opened, make the smallest edit that could satisfy one, or run verification) — or state exactly what is blocking you so the run can end honestly instead of wandering.`,
      });
      return null;
    }
    // Second consecutive stalled heartbeat: stop honestly.
    const touched = [...(this.context['state']?.filesModified as string[] | undefined ?? [])].slice(-8);
    const known = (this.context['state']?.knownErrors as string[] | undefined ?? []).slice(-3);
    const tried = (task.attempts ?? []).slice(-6).map((a) => `${a.strategy}:${a.result}`).join(', ') || 'no recorded attempts';
    const criteria = (task.acceptanceCriteria ?? []).join('; ') || '(no acceptance criteria stated)';
    this.addAttempt(task, 'stalled', [], 'failure', `no progress for ${this.noProgressStreak * HEARTBEAT_EVERY} turns`);
    return this.finish(task, false,
      `Stuck: ${this.noProgressStreak * HEARTBEAT_EVERY} turns with no new files read, no edits, and no passing verification. ` +
      `Tried: ${tried}. Files touched: ${touched.join(', ') || 'none'}. ` +
      `Last errors: ${known.map((e) => String(e).slice(0, 120)).join(' | ') || 'none'}. ` +
      `Unmet acceptance criteria: ${criteria}. ` +
      `Stopping instead of burning the remaining iterations — narrow the scope or provide more direction and re-run.`,
      'stuck_no_progress');
  }

  private injectStruggleState(iter: number): void {
    if (iter - this.lastStruggleInjectIter < 2) return;
    const parts: string[] = [];

    // 1) Consecutive tool errors (top 3 by count, name + count + error sig)
    const toolErrs: Array<[string, { error: string; count: number }]> = [];
    for (const [name, e] of this.consecutiveToolErrors) {
      if (e.count >= 2) toolErrs.push([name, e]);
    }
    if (toolErrs.length) {
      toolErrs.sort((a, b) => b[1].count - a[1].count);
      const lines = toolErrs.slice(0, 3).map(([name, e]) =>
        `  - ${name}: failed ${e.count} times in a row (${e.error.slice(0, 80)})`);
      parts.push(`Consecutive tool failures (${toolErrs.length} tool(s)):\n${lines.join('\n')}`);
    }

    // 2) Cross-tool same-signature errors (root cause is shared)
    if (this.crossToolErrorSig.size) {
      const cross: string[] = [];
      for (const [sig, v] of this.crossToolErrorSig) {
        if (v.count >= 2) cross.push(`  - ${v.tool} (count ${v.count}): ${sig.slice(0, 80)}`);
      }
      if (cross.length) {
        parts.push(`Cross-tool same-signature failures (shared root cause):\n${cross.join('\n')}`);
      }
    }

    // 2b) Cross-tool repeated RESULT bodies (model is re-reading the same
    // content — quality slice 5). Distinct from error sigs: this is the
    // model losing the thread, not the model hitting the same error.
    if (this.crossToolResultHash.size) {
      const dupes: string[] = [];
      for (const [hash, v] of this.crossToolResultHash) {
        if (v.count >= 3) dupes.push(`  - ${v.tool} returned identical content ${v.count} times (hash ${hash.slice(0, 8)})`);
      }
      if (dupes.length) {
        parts.push(`Tool returned the same output repeatedly (you've seen this content before):\n${dupes.join('\n')}`);
      }
    }

    // 3) Empty-response retries (provider instability)
    if (this.emptyResponseCount >= 2) {
      parts.push(`Empty model responses: ${this.emptyResponseCount} in a row (provider may be overloaded or rate-limited). Consider waiting, switching model, or simplifying the next request.`);
    }

    // 4) Last tool error (single-line, regardless of how many tools failed)
    if (this.lastToolError) {
      parts.push(`Last tool error: ${String(this.lastToolError).slice(0, 240)}`);
    }

    // 5) Recent known errors (the addKnownError log — capped to 3 most recent)
    const known = this.context['state']?.knownErrors as string[] | undefined;
    if (known && known.length) {
      const recent = known.slice(-3);
      parts.push(`Recent known errors (${known.length} total):\n${recent.map((e) => `  - ${e.slice(0, 120)}`).join('\n')}`);
    }

    // 6) Verify state
    if (this.verifyCount > 0) {
      parts.push(`Verify attempts so far: ${this.verifyCount} (last ${this.lastVerifyPassed ? 'passed' : 'failed'}).`);
    }

    // 7) Turn count
    if (this.toolCallsTotal > 20) {
      parts.push(`Tool calls so far: ${this.toolCallsTotal}.`);
    }

    if (parts.length === 0) return; // healthy run, no signal

    const summary =
      `STRUGGLE STATE (turn ${iter + 1}) — read this BEFORE your next action:\n` +
      parts.join('\n') +
      `\nIf the same approach has failed 2+ times, change strategy: ` +
      `(1) re-read the relevant files, (2) try a different tool, ` +
      `(3) reduce scope or report a concrete blocker.`;

    try {
      this.context.addMessage({ role: 'system', content: summary });
      this.lastStruggleInjectIter = iter;
      this.events.emit({
        type: 'agent:log',
        agentId: this.id,
        message: `[struggle] injected state summary (${parts.length} signal(s))`,
      });
    } catch { /* never block the loop on injection */ }
  }

  /**
   * Quality slice 3 helper: total consecutive tool errors across all tools.
   * Cheap O(n) over the small Map; no I/O.
   */
  private totalToolErrors(): number {
    let n = 0;
    for (const e of this.consecutiveToolErrors.values()) n += e.count;
    return n;
  }

  /** Quality slice 3: auto plan-mode escape. After 2+ verify failures AND
   * 2+ tool errors we know the model is guessing in a loop. Instead of
   * letting it produce another guess, force a structured plan directive.
   * The threshold check (verifyCount >= 2 AND totalToolErrors >= 2) lives
   * at the call site in the verify-failure path so this method itself can
   * be called from tests and from future escape hatches without re-checking.
   * Rate-limited to once per task. Never blocks. */
  private autoPlanEscaped = false;
  /** A mutating tool call (write/edit/patch/delete) FAILED this run: the
   *  model has file intent but has not delivered. Prose completion is gated
   *  on this the same way file-guard gates zero-tool runs. */
  private failedMutation = false;
  /** Resolved targets of failed `write` calls — if one exists on disk later,
   *  the model recovered out-of-band (e.g. via shell) and prose may finish. */
  private failedMutationWrites: string[] = [];
  /** A forced recovery plan has been requested but not yet followed by tool
   *  execution. The next plan-only response is an interim artifact: resume
   *  work instead of accepting it as completion. Cleared by tool execution. */
  private autoPlanEscapePending = false;
  private injectAutoPlanEscape(failureText: string): void {
    if (this.autoPlanEscaped || this.planMode) return;
    this.autoPlanEscaped = true;
    this.autoPlanEscapePending = true;
    const truncated = failureText.slice(0, 240);
    try {
      this.context.addMessage({
        role: 'system',
        content:
          'AUTO PLAN-MODE ESCAPE — you have failed verification ' + this.verifyCount +
          ' times and accumulated ' + this.totalToolErrors() +
          ' tool errors. The harness is forcing a planning step.\n' +
          'DO NOT make any more edits in your next turn. Instead, output a 5-line plan that names:\n' +
          '  1. The smallest assumption from your last change that, if false, would explain ALL the failures.\n' +
          '  2. The one file you would re-read to confirm or refute that assumption.\n' +
          '  3. The smallest possible next edit (often revert or a one-line guard).\n' +
          '  4. The verify command whose output will prove the fix.\n' +
          '  5. The single thing you will STOP doing.\n' +
          `Failure evidence to plan around: ${truncated}`,
      });
      this.events.emit({
        type: 'agent:log',
        agentId: this.id,
        message: `[auto-plan-escape] injected (verifyCount=${this.verifyCount}, toolErrors=${this.totalToolErrors()})`,
      });
    } catch { /* never block the failure path */ }
  }
  private maybeSelfCritique(task: Task, failureText: string): void {
    if (this.selfCritiqued || this.planMode) return;
    const reasoning = this.resolveReasoning(task);
    const shouldCritique = Boolean(
      this.config.model?.speculative?.selfCritique ||
      reasoning === 'high' ||
      reasoning === 'max' ||
      this.verifyCount >= 2
    );
    if (!shouldCritique) return;
    this.selfCritiqued = true;
    try {
      this.context.addMessage({
        role: 'system',
        content:
          'STRUCTURED SELF-CRITIQUE (before your next action, reason through ALL five steps):\n' +
          '1. CLAIM: state the exact belief your last change was built on.\n' +
          '2. EVIDENCE: which observed output confirms or refutes that claim — quote it.\n' +
          '3. CONTRADICTION: where does the failure evidence contradict the claim?\n' +
          '4. REVISED THEORY: the corrected causal explanation (mechanism, not symptom).\n' +
          '5. REPAIR PLAN: the ONE smallest change that tests the revised theory, and the command whose output will prove it.\n' +
          `Failure evidence to critique against: ${failureText.slice(0, 400)}`,
      });
      this.events.emit({ type: 'agent:log', agentId: this.id, message: '[self-critique] directive injected' });
    } catch { /* never block the failure path */ }
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

  /** Auto-persist a successful task's outcome to durable project memory so the
   *  NEXT session on this project (via the multi-session resume protocol) has
   *  real state to load — what changed and where we left things. Deduplicated,
   *  best-effort (never blocks completion on a write failure). */
  private recordDurableState(task: Task): void {
    const changed = this.context['state'].filesModified ?? [];
    if (!changed.length) return;
    try {
      const store = new MemoryStore(this.workspace.dir);
      const body = `Completed "${task.title}". Files changed: ${changed.slice(0, 6).join(', ')}${changed.length > 6 ? ` (+${changed.length - 6} more)` : ''}.`;
      store.add({ kind: 'decision', title: `Completed: ${task.title}`.slice(0, 80), body, source: 'mochi-session' });
    } catch { /* durable-state write is best-effort */ }
  }

  /** Called when verification finally passed; finalize the autopsy with the
   *  resolved outcome and write a procedural lesson from the top hypothesis. */
  private recordSuccess(task: Task, _repo: ReturnType<typeof detectRepo>): void {
    this.anchor.recordClaim(task.title, 'Verified', 'Verification passed');
    this.recordDurableState(task);
    // Speculation memory: the preflight's strategy class just RESOLVED a task —
    // record it so future preflights on similar tasks prefer this class.
    if (this.speculatedStrategy) {
      recordSpeculationOutcome(this.workspace.dir, {
        strategyClass: this.speculatedStrategy,
        taskTitle: this.speculatedQuestion ?? task.title,
        outcome: 'resolved',
        atMs: Date.now(),
      });
    }
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
    // Speculation memory: mark the preflight's strategy class as stalled so
    // future preflights de-prioritize it for this task family.
    if (this.speculatedStrategy) {
      recordSpeculationOutcome(this.workspace.dir, {
        strategyClass: this.speculatedStrategy,
        taskTitle: this.speculatedQuestion ?? task.title,
        outcome: 'unresolved',
        atMs: Date.now(),
      });
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
      abortSignal: this.abortSignal,
      readCache: this.readCache,
    };
    const { output, error } = await executeTool('shell', { command, timeout }, ctx, this.tools);
    return error ? `Error: ${error}\n${output}` : output;
  }

  /** MCH-100: extract the run command a simple-script task explicitly asks
   *  for ("Create add.js … run node add.test.js" → `node add.test.js`).
   *  Only the LAST "run <cmd>" / "run: <cmd>" occurrence counts, only single
   *  short commands, and only known-safe runners — this is a harness-side
   *  convenience probe, not arbitrary execution. */
  private extractTaskRunCommand(task: Task): string | null {
    const text = `${task.title} ${task.description ?? ''}`;
    // "run node run.js" / "run it with node add.test.js and make sure…" /
    // 'then run "node run.js" and confirm…' — capture runner + path tokens,
    // stop at the next clause or closing quote.
    const m = text.match(
      /(?:\brun\b(?: it)?(?: with| using)?\b[: ]*["']?)((?:node|python3?|bash|sh|npm +test|npm +run +[\w:@/-]+|make)(?: +[\w./:@=-]+)*?)(?=["']?(?:,| and\b| then\b| to\b| so\b| make\b|$))/i,
    );
    const cmd = (m?.[1] ?? '').trim();
    if (!cmd || cmd.length > 80) return null;
    if (/[;&|<>`$()]/.test(cmd)) return null;
    return /^(node|python3?|bash|sh|npm (test|run [\w:@/-]+)|make)\b/.test(cmd) ? cmd : null;
  }

  /** Aider-style auto-lint-fix: run the project's own auto-fixer on edited
   *  files BEFORE diagnostics are rendered, so mechanical lint issues
   *  (import order, auto-fixable style) never reach the model as noise or
   *  the verification gate as failures. Best-effort and quiet: the fixer is
   *  only invoked when the repo explicitly opted into the linter (config
   *  file present — see jsTsLint/pyRuff in repo.ts), commands are bounded
   *  at 20s, and any failure is swallowed. Files are passed explicitly so
   *  the fixer never touches anything the agent didn't edit. */
  private async autoLintFix(files: string[]): Promise<void> {
    try {
      const repo = detectRepo(this.cwd);
      if (!repo.lintCommand) return;
      // Derive the fix command from the detected lint command. Only the
      // known auto-fixable runners participate; others (e.g. `mvn`) skipped.
      const base = repo.lintCommand;
      let fixCmd: string | undefined;
      if (base.includes('eslint')) fixCmd = `${base} --fix`;
      else if (base.includes('ruff')) fixCmd = `${base} --fix`;
      else if (base.includes('biome')) fixCmd = `${base} --write`;
      if (!fixCmd) return;
      const quoted = files.map((f) => JSON.stringify(f)).join(' ');
      await this.runShell(`${fixCmd} ${quoted}`, 20);
    } catch {
      /* auto-fix must never break the edit flow */
    }
  }

  /** MCH-93: cheap git-repo detection (memoized per run) for gate skipping. */
  private gitWorkspace?: boolean;
  private isGitWorkspace(): boolean {
    if (this.gitWorkspace !== undefined) return this.gitWorkspace;
    try { this.gitWorkspace = existsSync(resolve(this.cwd, '.git')); } catch { this.gitWorkspace = false; }
    return this.gitWorkspace;
  }

  /** Extract the meaningful `git status --porcelain` lines from the shell
   *  tool's `exit_code/stdout/stderr` envelope and strip harness-bookkeeping
   *  paths (the workspace dir and audit logs) so harness writes never count
   *  as a model-side shell mutation. Comparing the extracted LINES (not the
   *  raw envelope) is load-bearing: the envelope swaps the status body for a
   *  literal "(empty)" placeholder and leaves blank lines around it, so raw
   *  comparison flagged "status line appeared where (empty) used to be". */
  private filterHarnessStatus(envelope: string): string {
    const rel = relative(this.cwd, this.workspace.dir);
    const prefixes = ['.mochi', '.mochi-audit', ...(rel && rel !== '.' && !rel.startsWith('..') && !isAbsolute(rel) ? [rel] : [])];
    const bodyMatch = /^exit_code: \d+\nstdout:\n([\s\S]*?)\nstderr:/m.exec(envelope);
    const body = bodyMatch ? bodyMatch[1] : envelope;
    return body
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => {
        if (!line.trim() || line === '(empty)') return false;
        const path = line.slice(3); // porcelain v1: "XY <path>" (2 status chars + space)
        return !prefixes.some((p) => path === p || path.startsWith(p + '/') || path.startsWith(p + sep));
      })
      .join('\n');
  }

  /** Snapshot `git status --porcelain` right before the model loop (after all
   *  harness setup writes) as the baseline for shell-mutation detection. */
  private async captureGitBaseline(): Promise<void> {
    if (!this.isGitWorkspace()) return;
    try {
      const out = await this.runShell('git status --porcelain', 15);
      if (!/^exit_code: 0\b/.test(out)) return;
      this.gitBaseline = this.filterHarnessStatus(out);
    } catch { /* best effort: detection stays off */ }
  }

  /** Did the workspace diverge from the run-start baseline WITHOUT a tracked
   *  write/edit/delete/patch (i.e. the model mutated via shell)? Probes are
   *  throttled to "after a non-read-only tool ran"; the answer is monotonic
   *  for the run. Never throws — a git failure means "no divergence known". */
  private async shellMovedWorkspace(): Promise<boolean> {
    if (this.shellWorkspaceMoved) return true;
    if (this.gitBaseline === null || !this.shellProbePending) return false;
    try {
      const out = await this.runShell('git status --porcelain', 15);
      if (/^exit_code: 0\b/.test(out) && this.filterHarnessStatus(out) !== this.gitBaseline) {
        this.shellWorkspaceMoved = true;
      }
    } catch { /* best effort */ }
    this.shellProbePending = false;
    return this.shellWorkspaceMoved;
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

  private async shouldSelfReview(_task: Task): Promise<boolean> {
    // Shell mutations never set fileChanged — consult the git baseline too,
    // or a shell-driven change (`sed -i`, generators) never gets reviewed.
    if (!this.fileChanged && !(await this.shellMovedWorkspace())) return false;
    // Bound the cost: after two review cycles the model is clearly not going
    // to move; stop burning tokens on it.
    return this.selfReviewCount < 2;
  }

  /** Turn the run into a Cline-voice narrative: a readable plain-English
   *  summary with a bold headline per topic, honest about what worked / didn't
   *  / what's next — the opposite of a wall of terse bullet points. Feeds only
   *  REAL facts from the SummaryDocument (numbers are never fabricated). */
  private async composeNarrative(doc: import('../summary/engine.js').SummaryDocument, task: Task): Promise<string> {
    const { status, metrics } = doc;
    const lines = [`Task: ${task.title}`, `Status: ${status}`];
    const head = (label: string, items: import('../summary/engine.js').SummaryItem[]) =>
      items.length ? `${label}:\n${items.map((i) => `- ${i.text}${i.detail ? ` (${i.detail})` : ''}`).join('\n')}` : '';
    if (doc.whatChanged.length) lines.push(head('Changed', doc.whatChanged));
    if (doc.verification.length) lines.push(head('Verification', doc.verification));
    if (doc.failures.length) lines.push(head('Failed', doc.failures));
    if (doc.warnings.length) lines.push(head('Warnings', doc.warnings));
    if (doc.next.length) lines.push(head('Next', doc.next));
    if (metrics.length) lines.push(`Metrics: ${metrics.map((m) => `${m.label} ${m.value}`).join(', ')}`);
    const cleanSuccess = status === 'complete' && doc.failures.length === 0;
    const prompt = [
      'Write a concise summary of this coding run the way an excellent senior engineer',
      'would, in the voice Claude Code/Cline use at the end of a task. Requirements:',
      '1. A short bold headline phrased as a clear result, not filler greeting.',
      cleanSuccess
        ? '2. Emphasize what got done, verified, and enforced. Because the run succeeded cleanly with all checks passing, state clearly that there are no blockers or active issues.'
        : '2. Follow the structure: what got done; what did not work or is still blocked (using only the real failures/warnings listed above); recommended next step.',
      '3. Use short sentences and the user\'s terminology. Be direct and honest.',
      '4. Keep it tight: 4-9 lines. Use markdown **bold** on the key clause of each',
      '   line only. Never invent facts, numbers, or imaginary bugs — use ONLY the provided data.',
      '',
      lines.join('\n'),
    ].join('\n');
    const msg: ChatMessage = { role: 'user', content: prompt };
    // COST GUARD (2026-10-05): the narrative call runs inside finish() with
    // NO caller-side timeout — a provider that stalls on the summary call
    // hangs the whole run past the loop's stall guard (the openai.ts watchdog
    // is a hardcoded 30s and ignores MOCHI_MODEL_RESPONSE_TIMEOUT_MS). Race it
    // against a modest budget so a stalled narrative can never block task
    // completion. We also ABORT the underlying call on timeout so the orphaned
    // stream is torn down (its finally clears the openai.ts stall interval).
    const narrativeTimeoutMs = (() => {
      const raw = Number(process.env.MOCHI_MODEL_RESPONSE_TIMEOUT_MS);
      return Number.isFinite(raw) && raw > 0 ? Math.max(5_000, raw) : 12_000;
    })();
    const narrativeController = new AbortController();
    const timeout = new Promise<'__narrative_timeout'>((r) => setTimeout(() => {
      narrativeController.abort(new Error('narrative timeout'));
      r('__narrative_timeout');
    }, narrativeTimeoutMs));
    const call = async () => {
      const response = await this.provider.chat([msg], [], { signal: narrativeController.signal, maxTokens: 600 });
      return (response.content ?? '').trim();
    };
    try {
      const raced = await Promise.race([call(), timeout]);
      if (raced === '__narrative_timeout') return '';
      return raced || '';
    } finally {
      narrativeController.abort(new Error('narrative timeout'));
    }
  }

  /** One cheap model call reviewing the working diff. Returns nothing when the
   *  change looks clean, else a concrete, actionable problem for the loop to
   *  fix (and re-verify). */
  private async selfReview(task: Task, repo: ReturnType<typeof detectRepo>): Promise<{ issue?: string; tail: string }> {
    try {
      const diff = await this.runShell(`git diff --stat && git diff`, 30);
      // No diff, or not a git repo (git exits 128/129 with "not a git
      // repository") — nothing to review, and crucially NO model call.
      if (!diff.trim() || /exit_code: 12[89]/.test(diff) || /not a git repository/i.test(diff)) return { tail: 'no diff' };
      // MCH-101: simple script tasks get a LOCAL review instead of a model
      // round. The hygiene scan + accidental-deletion check catch the defects
      // that matter for script-sized diffs (debug leftovers, pasted TODOs,
      // deleted lines) at zero provider latency. Hard tasks keep the model.
      if (isSimpleScriptTask(task)) {
        const findings = scanDiffForHygiene(diff);
        if (findings.length > 0) {
          return {
            issue: `Hygiene issues in the diff (fix before finishing):\n${renderHygieneFindings(findings)}`,
            tail: `local review: ${findings.length} hygiene finding(s)`,
          };
        }
        return { tail: 'local review: clean' };
      }
      const testDensity = evaluateTestDensity(this.cwd, diff);
      const densityAdvice = (!testDensity.hasSufficientCoverage && testDensity.productionLinesChanged > 20)
        ? `\nTest Density Warning: ${testDensity.synthesisAdvice}\n`
        : '';
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
            densityAdvice,
            'Reply with the single most important real problem (with the file+line),',
            'or reply with exactly NO_ISSUE if the diff is correct.',
            '',
            diff.slice(0, 12_000),
          ].join('\n'),
        },
      ];
      const response = await this.provider.chat(reviewMsg, [], { signal: this.abortSignal, reasoningEffort: 'low' });
      const text = (response.content ?? '').trim();
      const tail = text.slice(0, 200);
      // A review only counts as a real problem when it actually cites a
      // concrete defect. Cheap/neutral replies (the model echoing something
      // terse like "done", "ok", "looks clean", or a review that never names a
      // file) must NOT be treated as a blocking issue — doing so re-loops the
      // agent through gatherStream and re-streams the same answer to the TUI
      // ("spams the same message") until the self-review cap trips.
      const mentionsFile = /\b[\w./-]+\.[a-zA-Z0-9]+:\d+/.test(text) || /\b(?:file|line)\b/i.test(text);
      const neutralNoIssue =
        /^NO_ISSUE$/i.test(text) ||
        /\b(?:no issue|no issues|no problems?|cannot identify|looks (?:correct|good|fine|clean|great|solid)|all good|lgtm|properly implemented|change looks good|diff is correct|looks fine|verified|correctly implemented)\b/i.test(text) ||
        (!mentionsFile && (/^(done|ok|okay|clean|nothing|no problems|no problem|fine|lgtm)\b/i.test(text) || text.length < 40));

      if (neutralNoIssue) {
        return { tail };
      }
      return { issue: text.slice(0, 800), tail };
    } catch {
      return { tail: 'review failed' }; // never block success on review infra
    }
  }

  /** B2: result of the in-flight or completed finish() for THIS run. Exactly-once
   *  guard: finish() closes MCP connections, emits agent:completed, releases the
   *  shared budget slot (recordAgentEnd), and may fire a narrative model call.
   *  The budget-exhausted branch in runMoolCall fires inside PARALLEL tool
   *  batches — every call in the batch sees the same exhausted phase — and the
   *  loop top then reaches its own exhausted check: N+1 full teardowns, N
   *  duplicate agent:completed events, N recordAgentEnd releases. First call
   *  wins; later callers (different summary/stopReason, same teardown) receive
   *  the first result. Reset per run() so a second run on the same instance
   *  (auto-resume) finishes normally. */
  private finishPromise: Promise<AgentResult> | null = null;

  private finish(task: Task, success: boolean, summary: string, stopReason: AgentStopReason = success ? 'completed' : 'aborted'): Promise<AgentResult> {
    if (this.finishPromise) return this.finishPromise;
    const p = this.finishOnce(task, success, summary, stopReason);
    // Clear on rejection so an outer retry can attempt a finish again; while
    // the first attempt is in flight concurrent callers still share it.
    this.finishPromise = p.catch((err) => { if (this.finishPromise === p) this.finishPromise = null; throw err; });
    return this.finishPromise;
  }

  private async finishOnce(task: Task, success: boolean, summary: string, stopReason: AgentStopReason = success ? 'completed' : 'aborted'): Promise<AgentResult> {
    // MCH-33: tear down MCP server connections on every finish path.
    try {
      const { closeMcpConnections } = await import('../tools/mcp.js');
      closeMcpConnections(this.mcpConnections);
    } catch { /* module gone / nothing open */ }
    // Claude Code gates completion on the last tool's exit code; Codex re-runs
    // acceptance criteria independently. Mochi (MCH-26): a run that ENDS on a
    // failed tool call (failed git commit, failed verify command) cannot
    // truthfully be "completed" — downgrade and surface the real error, so the
    // user sees the failure instead of a false "done". Runs that RECOVERED from
    // earlier errors (last tool succeeded) still finish as completed.
    if (success && this.lastToolError) {
      success = false;
      if (stopReason === 'completed') {
        stopReason = 'verification_failed';
      }
      summary = `${summary}\n\n[last tool call failed: ${this.lastToolError.slice(0, 300)}]`;
    }
    // Harness-v2 Phase 1: close the lifecycle — emit the final iteration's
    // trace with the run's stop reason (abort/timeout from ANY phase lands
    // here, so the trace records where the run actually stopped).
    this.sm?.enter('finish');
    this.sm?.flush(stopReason);
    // MCH-57: attribute run outcome to every skill loaded this run. Success ->
    // each participant gets a win; failure -> load stands without a win, so
    // win-rate (wins/loads) self-corrects the MCH-40 relevance boost.
    try {
      const { getSkillsLoadedThisRun, clearSkillsLoadedThisRun } = await import('../tools/skill.js');
      const { recordSkillUsage } = await import('../skills/skills.js');
      for (const name of getSkillsLoadedThisRun()) recordSkillUsage(this.workspace.dir, name, success === true);
      clearSkillsLoadedThisRun();
    } catch { /* skill outcome attribution must never affect task completion */ }
    // MCH-63: attribute run outcome to every durable fact surfaced this run —
    // the missing half of the fact lifecycle. Success -> success_count++ per
    // fact; failure -> attempts++ with last_failed, so 3 failed runs on a fact
    // auto-prune it (MAX_FAILS) and the success-ratio term in recallFacts
    // starts ranking live facts over dead ones. Mirrors MCH-57 skill wins.
    try {
      const { takeSurfacedFactIds, recordFactAttempt } = await import('../memory/memory-store.js');
      for (const id of takeSurfacedFactIds()) recordFactAttempt(id, success === true);
    } catch { /* fact attribution must never affect task completion */ }
    this.mcpClose?.();
    this.mcpClose = undefined;
    this.budget?.recordAgentEnd();
    // Skill curator pass (on by default): archives stale agent-created skills,
    // writes a report, keeps the skill tree healthy as experience accumulates.
    // Idle-gated by its own interval; any failure is silently ignored.
    try {
      const ccfg = defaultCuratorConfig();
      if (shouldRunCurator(this.workspace.dir, ccfg)) {
        const out = runCurator(this.workspace.dir, ccfg);
        recordCuratorRun(this.workspace.dir, `scanned ${out.scanned}, archived ${out.archived.length}`);
      }
    } catch { /* curator must never affect task completion */ }
    if (success) {
      for (const pattern of this.seenPatterns) {
        this.learning.record(pattern, this.lastStrategy ?? 'unclassified', true);
      }
      // MCH-44: auto-skill from successful runs — when a (pattern, strategy)
      // pair has now succeeded ≥2 times and no skill covers it, draft one from
      // the run's real lessons. Best-effort; never affects completion.
      try {
        const { autoDraftSkill } = await import('../skills/skill-curator.js');
        for (const pattern of this.seenPatterns) {
          const rec = this.learning.bestStrategy(pattern);
          if (!rec || rec.successes < 2) continue;
          const drafted = autoDraftSkill(this.workspace.dir, {
            pattern,
            strategy: rec.strategy,
            successes: rec.successes,
            lessons: (this.lastLessons ?? []).map((l) => l.lesson),
            taskTitle: task.title,
          });
          if (drafted) {
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[skills] auto-drafted skill "${drafted}" from repeated successful strategy` });
          }
        }
      } catch { /* auto-draft must never affect task completion */ }
      // MCH-47: persist a successful plan so similar future tasks warm-start.
      // planAcceptedText is only set when the model submitted via accept_plan.
      try {
        const planText = this.planAcceptedText?.trim();
        if (planText && planText.length > 40) {
          const { recordPlanSuccess } = await import('../core/plan-cache.js');
          recordPlanSuccess(this.workspace.dir, task.title, task.description ?? '', planText);
        }
      } catch { /* plan-cache must never affect task completion */ }
      // MCH-48: persist the warm read cache so future sessions skip disk reads.
      try {
        if (this.readCache.size > 0) saveReadCache(this.workspace.dir, this.readCache);
      } catch { /* read-cache persistence must never affect task completion */ }
      // MCH-84: report read-cache effectiveness so the user sees the savings.
      try {
        const stats = this.readCache as ReadCache & { __hits?: number; __misses?: number };
        const hits = stats.__hits ?? 0;
        const misses = stats.__misses ?? 0;
        if (hits + misses >= 3) {
          const pct = Math.round((hits / (hits + misses)) * 100);
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[cache] read-cache: ${hits}/${hits + misses} hits (${pct}%) — ${misses} disk read(s), ${hits} served from memory` });
        }
      } catch { /* cache telemetry must never affect task completion */ }
      // MCH-61: close the prefetch effectiveness loop — compare this run's
      // predictions against what was actually read (warmed entries excluded).
      try {
        if (this.prefetchLedger.length > 0) {
          const { recordPrefetchOutcome } = await import('../core/prefetch.js');
          const warmedAbs = new Set(Array.from(this.prefetchWarmed));
          const actualReads = Array.from(this.readCache.keys()).filter((k) => !warmedAbs.has(k));
          recordPrefetchOutcome(this.workspace.dir, this.prefetchLedger, actualReads);
        }
      } catch { /* prefetch ledger must never affect task completion */ }
      // MCH-76: persist a durable, deduped fact about this run so future
      // sessions warm-start with the workspace's accumulated knowledge.
      try {
        if (this.fileChanged) {
          const files = [...new Set(this.context['state'].filesModified)] as string[];
          if (files.length > 0) {
            recordProjectMemory(this.workspace.dir, `Run touched ${Math.min(files.length, 5)} file(s): ${files.slice(0, 5).join(', ')}${files.length > 5 ? ` (+${files.length - 5} more)` : ''}`);
          }
        }
      } catch { /* project memory must never affect task completion */ }
      // MCH-52: persist this run's tool sequence for route-pattern mining.
      try {
        const { loadToolSeqs, saveToolSeq } = await import('../core/tool-sequence.js');
        if (this.toolSeq.length > 0) saveToolSeq(this.workspace.dir, loadToolSeqs(this.workspace.dir), this.toolSeq);
        // MCH-55: habitual opening routes become auto-drafted skills.
        const { draftSkillFromToolRoutes } = await import('../skills/skill-curator.js');
        await draftSkillFromToolRoutes(this.workspace.dir);
        // MCH-56: archive stale never-used auto skills so the list stays dense.
        const { curateAutoSkills } = await import('../skills/skill-manager.js');
        curateAutoSkills(this.workspace.dir);
      } catch { /* tool-route persistence must never affect task completion */ }
    }
    const durationMs = Math.round(performance.now() - this.startTime);
    this.events.emit({ type: 'agent:completed', id: this.id, taskId: task.id });
    let doc;
    try {
      // Summarize THIS run only: the bus is session-scoped, so slice off
      // everything before the run-start marker — otherwise turn N's card
      // inherits turn N-1's files/checks/failures. A trimmed-away marker (or
      // no marker) falls back to the full snapshot.
      const hist = this.events.snapshot();
      const runEvents = this.runStartMarker !== undefined
        ? (() => { const i = hist.indexOf(this.runStartMarker as MochiEvent); return i >= 0 ? hist.slice(i + 1) : hist; })()
        : hist;
      doc = summarize(runEvents, { goal: task.title });
      // Fold the KNOWN outcome in: summarize() alone reports 'partial' for a
      // clean Q&A turn (no task:completed event exists yet at this point).
      doc.status = resolveRunStatus(doc, success, stopReason);
      doc.turnKind = this.taskKind === 'chat' ? 'chat' : 'task';
    } catch {
      /* ignore summary error */
    }
    // Cline-style narrative lead: one extra cheap model call that re-writes the
    // run as a readable plain-English narrative (bold headline per topic, honest
    // about what worked / didn't / what's next). Gated by MOCHI_NARRATIVE_SUMMARY
    // (default ON — the user explicitly wants Cline's readable summary voice);
    // failures are swallowed so a missing narrative never breaks completion.
    // COST GUARD (2026-10-05): only narrate COMPLETED runs. A model_error /
    // aborted / tool_loop run has no "result" to narrate, so firing an extra
    // model request on every failure just wastes tokens, inflates provider
    // request counts, and can itself hang on a stalled provider.
    if (success && doc && this.provider && (process.env.MOCHI_NARRATIVE_SUMMARY ?? (process.env.VITEST ? '0' : '1')) !== '0') {
      try {
        doc.narrative = await this.composeNarrative(doc, task);
      } catch {
        /* narrative is optional */
      }
    }
    this.events.emit({
      type: 'summary:rendered',
      agentId: this.id,
      success,
      stopReason,
      taskKind: this.taskKind ?? 'unknown',
      durationMs,
      toolCallsTotal: this.toolCallsTotal,
      tokensUsed: this.tokensUsed,
      filesModified: [...new Set(this.context['state'].filesModified)],
      summary,
      doc,
    });
    const _runDigestParts: string[] = [];
    const _read = Array.from(this.readCache.keys())
      .map((k) => (k.startsWith(this.cwd) ? k.slice(this.cwd.length + 1) : k))
      .slice(-25);
    const _changed = [...new Set(this.context.state.filesModified ?? [])].map((p) => (p.startsWith(this.cwd) ? p.slice(this.cwd.length + 1) : p)).slice(0, 25);
    const _errs = (this.context.state.knownErrors ?? []).slice(0, 6);
    if (_changed.length) _runDigestParts.push(`changed=[${_changed.join(', ')}]`);
    if (_read.length) _runDigestParts.push(`read=[${_read.join(', ')}]`);
    if (_errs.length) _runDigestParts.push(`errors=[${_errs.join('; ').slice(0, 300)}]`);
    const _runDigest = _runDigestParts.length ? `[run-digest] ${_runDigestParts.join(' | ')}`.slice(0, 800) : undefined;
    await this.maybeRecordHarnessIssue(task, success, summary, stopReason);

    return {
      success,
      summary,
      filesModified: [...new Set(this.context['state'].filesModified)],
      attempts: this.errors.length + 1,
      tokensUsed: this.tokensUsed,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      tokensCached: this.tokensCached,
      contextUsed: this.lastContextUsed,
      costUsd: this.costUsd,
      durationMs,
      stopReason,
      runDigest: _runDigest,
    };
  }
}

/** MCH-58: subagent result synthesis. Raw fanout output repeats the same
 *  finding across siblings (they share the task). Line-level dedupe strips
 *  duplicated finding lines; a VERDICT header leads with the merged picture so
 *  the parent model reads one conclusion instead of N near-copies. Pure string
 *  pass — no model calls, deterministic, cheap. */
export function synthesizeSubagentResults(results: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of results) {
    const lines = r.split('\n');
    const kept: string[] = [];
    for (const line of lines) {
      // Strip the sibling header ("[Subagent #2 (coder)]: ") so identical
      // findings under different headers still collapse.
      const bare = line.replace(/^\s*\[[^\]]*\]\s*:?\s*/, '');
      const key = bare.trim().toLowerCase().replace(/[^a-z0-9 ]/g, '');
      if (key.length >= 40 && seen.has(key)) continue; // duplicate finding
      if (key.length >= 40) seen.add(key);
      kept.push(line);
    }
    out.push(kept.join('\n'));
  }
  const anyFailed = out.some((r) => r.includes(' FAILED]'));
  const verdict = `[VERDICT] ${out.length} subagent(s) returned; ${anyFailed ? 'at least one FAILED — read failures before acting' : 'all succeeded'}. First mention of each finding is authoritative; duplicates were merged.`;
  return [verdict, ...out];
}
