import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';

/** Pure read-only shell detection for the parallel batch (exported for
 *  tests). A command may ride the CONCURRENT read-only group only when it
 *  provably cannot change state:
 *  - no state-mutating metacharacters (`; & | < > \` $ ( )`) — and ANY
 *    control character (`\n \r \v \f`): `\s` splits on `\v`/`\f` too, so a
 *    second command (`cat foo\vrm -rf x`) hid behind a read-only first
 *    token unless the whole control range is rejected;
 *  - first token is a known read-only binary. `find` is deliberately ABSENT:
 *    its `-delete`/`-exec … +` forms mutate and evade the metachar class —
 *    find commands go through the serial path (safe, just not parallel).
 *  - `env` is deliberately ABSENT: `env rm -rf .git` runs arbitrary argv[2]
 *    and `env -i FOO=1 sh -c …` runs a whole shell — neither is provably
 *    read-only. `printenv` stays (it only prints). */
export function isPureReadOnlyShellCommand(cmd: string): boolean {
  const c = cmd.trim();
  if (c.length === 0) return false;
  if (/[;&|<>`$()\n\r\v\f]|[\x00-\x1f\x7f]|cd\s/.test(c)) return false;
  const bin = c.split(/\s+/)[0];
  return /^(ls|cat|head|tail|grep|egrep|fgrep|wc|file|stat|which|type|jq|printenv|ps|pgrep|pwd|whoami|hostname|date|uname|df|du|tree|ripgrep|rg)$/.test(bin);
}

import {sortableId} from '../util.js';
import type { Attempt, ChatMessage, ContentPart, MochiConfig, ModelProfile, Task, ToolDefinition, ToolCall, ToolResult, MochiEvent } from '../types.js';
import { contentText } from '../types.js';
import type { EventBus } from '../events.js';
import type { Workspace } from '../workspace.js';
import { ContextEngine, estimateMessagesTokens, shouldIdleCompact, DEFAULT_IDLE_COMPACTION_THRESHOLD_MS, type IdleCompactionConfig } from '../context.js';
import { cacheHitRatio, type PrefixStats } from '../prompt/stable-prefix.js';
import { MemoryStore } from '../memory/memory.js';
import { projectMemoryPrefix, recordProjectMemory } from '../memory/project-memory.js';
import { decisionMemoryPrefix, recordRejectedApproach } from '../memory/decision-memory.js';
import { loadReadCache, saveReadCache } from '../state/read-cache-store.js';
import { createProvider, normalizeModelName, type RawProvider } from '../model/router.js';
import { PROVIDERS } from '../model/providers.js';
import { isMode, modeInstruction } from '../modes.js';

import { executeTool, buildTools, TOOL_ALIASES, normalizeToolArgs, trimHeavyTools, CHAT_TOOL_NAMES } from '../tools/index.js';
import { parsePatch } from '../tools/patch.js';
import { refreshAuthoredTools, RESERVED_TOOL_NAMES } from '../tools/tool-factory.js';
import { isFetchMutationRequest } from '../tools/fetch-methods.js';
import type { ToolContext, ReadCache } from '../tools/types.js';
import { detectRepo, languageHint } from '../repo/repo.js';
import { classifyTaskKind, resolveAutoReasoning, isTrivialWriteTask, isSimpleScriptTask, isReviewTask, scoreTaskComplexity, shouldEscalateComplexity } from '../core/taskkind.js';
import { decideFastLane, referencedFilesFor, countRepoFiles, resolveFastLaneEnabled, fastLaneToolNames, fastLaneEscalationReason, FASTLANE_LIMITS, type FastLaneDecision, type FastLaneEscalationReason } from '../core/fastlane.js';
import { recordFastLaneEntry, recordFastLaneEscalation, recordFastLaneOutcome } from '../core/fastlane-stats.js';
import { classifyTask as classifyChameleonTask } from '../chameleon/task-classifier.js';
import { trimToLeanTier, trimToReadTier, ALL_TOOLS_MAP, LEAN_TOOL_NAMES, toolsNamedInText } from '../tools/index.js';
import { applyMeasuredExposure, loadToolUsageLedger, toolExposureMode, toolSchemaBudgetChars, toolsImplicatedBySignals, toolsSchemaChars } from '../tools/tool-exposure.js';
import { trimForgedProbationTools } from '../tools/tool-forge.js';
import { classifyTaskTier, nextEscalationTier, ESCALATE_AFTER_FAILURES, type TaskTier } from '../model/model-router.js';
import {
  chooseEscalationTarget, chooseStartModel, escalationBudgetBlock, loadRoutingTable,
  resolveRoutingSettings, MAX_ROUTING_ESCALATIONS_PER_RUN,
  type RoutingTable, type RoutingTrigger,
} from '../observability/routing-table.js';
import { modelContextBudget, modelSupportsVision } from '../model/model-manager.js';
import { takeLastComputerScreenshot } from '../tools/computer.js';
import { buildScreenshotImage, SCREENSHOT_INLINE_MAX_BYTES } from '../computer/screenshot-image.js';
import { learnedWindowBudget, recordContextRejection } from '../model/window-memory.js';
import { matchesBaseline, type FlakyTestRef, type VerificationBaseline, type VerificationStatus } from '../verification.js';
import { diagnoseFile, renderDiagnostics } from '../observability/diagnostics.js';
import { synthesizeRepro, reproSynthEnabled } from '../observability/repro-synth.js';
import { captureCorrection, promoteCorrectionToLesson } from '../observability/corrections.js';
import type { AgentProfile } from '../types.js';
import type { PromptUserFn } from '../tools/user-prompt.js';
import { PermissionManager } from '../security/permission.js';
import type { PermissionPolicy } from '../security/permission.js';
import { describeApproval, normalizePolicy, normalizeApprovalDecision } from '../security/approval.js';
import { buildEditReview, applyAcceptedHunks } from '../security/edit-review.js';
import { matchHardline } from '../security/hardline.js';
import { classifyCommand, redact } from '../security/security.js';
import { snapshotTree, rollbackTracked, resolveVerifyCommand, type PlanVerifySnapshot } from './plan-verify.js';
import type { ApprovalHandler } from '../security/approval.js';
import { AgentProfileService } from '../agents/profile.js';
import { WorktreeManager } from '../repo/worktree.js';
import { resolvePreset } from '../teams/presets.js';
import {
  ChildRunStore,
  STRUCTURED_RESULT_CONTRACT,
  parseChildResult,
  aggregateReviews,
  formatChildDigest,
  formatFleetReport,
  canSpawnAtDepth,
  resolveMaxSubagentDepth,
  resolveMaxConcurrentSubagents,
  isGitRepo,
  gitOut,
  commitWorktreeChanges,
  summarizeWorktreeDiff,
  captureReviewDiff,
  type ChildRunRecord,
  type ChildSteerEvent,
} from '../teams/subagent-runtime.js';
import { BudgetEngine } from '../budget.js';
import {
  DisciplineTracker,
  KIND_CHECKLISTS,
  resolveDisciplineFlags,
  verifySummaryEvidenced,
  type DisciplineFlags,
  type FailureVerdict,
} from './discipline.js';
import {
  MilestoneTracker,
  buildMilestonePlan,
  loadMilestoneState,
  planMilestonesWithChat,
  resolveLongtaskFlags,
  runMilestoneCheck,
  saveMilestoneState,
  type Milestone,
  type MilestoneEvent,
  type MilestoneInput,
} from './milestones.js';
import { SpeculativeEngine } from './speculative.js';
import { retrieveSpeculationMemory, recordSpeculationOutcome, speculationMemoryToPrompt, predictNextFiles } from './speculative.js';
import { join } from 'node:path';
import { detectSkillOpportunities, opportunitiesToPrompt, shouldRunCurator, runCurator, recordCuratorRun, defaultCuratorConfig } from '../skills/skill-curator.js';
import { resolveSpawnPreset, recordAgentForgeSpawn } from './agent-forge.js';
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
import { planVerificationTests } from '../core/test-selection.js';
import { planTargetedTests } from '../core/test-select.js';
import { runMutationCheck } from '../core/mutation.js';
import {
  analyzeFailure, exitCodeOfEnvelope, flakeCommandKey, formatFlakyHits,
  isKnownFlaky, knownFlakyCommandKeys, loadFlakyRegistry, partitionFlakes,
  recordCleanPass, recordFlakes, saveFlakyRegistry, type FlakyRegistry,
} from '../core/flaky.js';
import { classifyOneShot } from '../core/one-shot.js';
import { classifyContentOnly } from '../core/one-shot.js';
import { workspaceListMessage } from '../core/workspace-list.js';
import { issuesContextBlock, classifyHarnessFailure, recordHarnessIssue } from '../core/harness-issues.js';
import { buildMcpTools, inflateMcpToolSchemas, mcpLazySchemasEnabled } from '../mcp/tools.js';
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
import { buildDigestInput } from '../summary/digest-input.js';
import { buildSummaryLineage, renderSummaryLineage } from '../summary/verified-compaction.js';
import { ExecutionRegistry } from '../core/execution-registry.js';
import { RunJournal, isJournalableTool, modelTurnFingerprint } from './run-journal.js';
import { RunResultCache } from './result-cache.js';
import { buildObjection, renderObjection, renderObjectionClosed, objectionDigestLine, OBJECTION_MARKER, type VerifierObjection } from './verifier-objection.js';
import { calibratedBaseTier, recordEffortOutcome } from './effort-calibration.js';
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
  /** Depth guard: children spawn with subagentDepth = parent + 1. Spawning
   *  is injected only while depth < safety.maxSubagentDepth (default 2:
   *  root -> child -> grandchild; grandchildren cannot spawn further). */
  subagentDepth?: number;
  /** HARD tool allowlist (multi-agent presets): when set, the agent's tool
   *  map is pruned to exactly these tools and executeTool rejects any call
   *  outside the set — a read-only child cannot write even by hallucinating
   *  a tool name or via load_tools. Children never exceed the scope they
   *  were spawned with. */
  toolAllowlist?: string[];
  /** Repo-check failures captured before this run. A verify failure matching
   *  it is pre-existing debt and must not fail the task. */
  verifyBaseline?: VerificationBaseline | Promise<VerificationBaseline | undefined>;
  /** Interactive user-prompt resolver (TUI option menu). Top-level runs only:
   *  subagents and headless hosts leave it unset and ask_question resolves
   *  deterministic defaults instead. */
  promptUser?: PromptUserFn;
  /** Interactive approval resolver (TUI allow/deny menu). Unset headless —
   *  the gate then DENIES any call the policy does not auto-allow
   *  (deny-by-default), unless unattendedAllow is explicitly set. */
  approvalHandler?: ApprovalHandler;
  /** Permission tier ('yolo' | 'workspace-safe' | 'strict'). Undefined =
   *  strict. */
  permPolicy?: string;
  /** Explicit host opt-in for unattended runs (daemon/cron/SDK hosts that
   *  cannot prompt): when true, calls the policy does not auto-allow are
   *  allowed + audited even with no approval handler. NEVER default:
   *  unset/false means headless and subagent runs deny non-auto-approved
   *  calls. Also settable via env MOCHI_UNATTENDED_ALLOW=1. YOLO policy
   *  auto-allows everything and does not need this flag. */
  unattendedAllow?: boolean;
  /** Session "allow always" memory, shared across runs by the host
   *  (GoalEngine). Defaults to a private set (single-run memory). */
  approvedAlways?: Set<string>;
  /** Durable run journal (C6): stable identity of this run for step
   *  journaling/resume. Defaults to the task id — resuming the same task
   *  (same id) in a new process replays its completed steps instead of
   *  re-executing them. */
  runId?: string;
  /** Pre-opened journal (hosts/tests that manage the journal themselves).
   *  Wins over runId. */
  journal?: RunJournal;
  /** Disable step journaling for this agent (default: enabled). */
  journalEnabled?: boolean;
  /** Record + replay MODEL turns in the run journal (default: enabled).
   *  When false — or when env MOCHI_JOURNAL_MODEL_TURNS=0 — model turns
   *  are neither recorded nor served on resume; tool-step journaling is
   *  unaffected. The provider is then re-called (and re-billed) for
   *  every turn of a resumed run, exactly as before this feature. */
  journalModelTurns?: boolean;
  /** G11 idle compaction for this agent's own context (default: off).
   *  Hosts opt in here; parents set per-child windows via
   *  ChildRunSpec.autoCompactWindow instead. */
  idleCompaction?: IdleCompactionConfig;
  /** Long-task strategy (src/agent/milestones.ts): host-supplied milestone
   *  decomposition for this run. When set (or milestonePlanner is), the
   *  milestone layer activates regardless of the complexity score. */
  milestonePlan?: MilestoneInput[];
  /** Long-task strategy: host-supplied planner for the initial
   *  decomposition and for evidence-gated re-plans. On a re-plan it
   *  receives the open milestones + the evidence that justified revising
   *  them and returns replacement milestones for the REMAINING work (or
   *  null to decline — the run then tightens instead of re-planning). */
  milestonePlanner?: (req: {
    task: Task;
    current?: Milestone;
    remaining: Milestone[];
    evidence: string[];
    replan: boolean;
  }) => Promise<MilestoneInput[] | null>;
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

/**
 * Speculative-preflight enable policy. Pure (unit-tested) so the loop wiring
 * stays a one-liner. Precedence: env kill-switch (`MOCHI_SPECULATIVE_PREFLIGHT=0`)
 * > explicit config (`preflight: false` off, `preflight: true` on for any
 * kind — the historical opt-in) > default: ON only for structurally complex
 * tasks at medium-or-higher reasoning. Simple/standard tasks stay lean.
 */
export function specPreflightDefault(input: {
  configured?: boolean;
  env?: string;
  complexity?: 'simple' | 'standard' | 'complex';
  reasoning?: 'off' | 'low' | 'medium' | 'high' | 'max';
}): boolean {
  if (input.env === '0') return false;
  if (input.configured === false) return false;
  if (input.configured === true) return true;
  if (input.complexity !== 'complex') return false;
  return input.reasoning === 'medium' || input.reasoning === 'high' || input.reasoning === 'max';
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
  /** P5: cache-hit ratio over the run's MEASURED calls (cachedTokens /
   *  promptTokens where the provider reported cache figures). Null =
   *  UNMEASURED (the provider reported nothing) — never a fabricated 0. */
  cacheHitRatio?: number | null;
  cacheMeasured?: boolean;
  /** P5: stable-prefix hashes + every attributed mid-run prefix break. */
  prefixCache?: PrefixStats;
  durationMs: number;
  /** MCH-82: real per-run cost attribution (from budget ledger estimate). */
  costUsd: number;
  stopReason: AgentStopReason;
  runDigest?: string;
  /** Fast-lane record for this run (absent when the lane was not entered):
   *  whether it escalated to the standard profile mid-run, and why. */
  fastLane?: { entered: boolean; escalated: boolean; escalationReason?: string };
}

/** Spec for one child run, shared by the sync delegate path and the
 *  background (spawn_agent) runtime. */
export interface ChildRunSpec {
  prompt: string;
  /** Internal: pre-assigned run id (background registry) so the persisted
   *  record, the child agent id, and the parent's handle all match. */
  runId?: string;
  role?: string;
  /** Spawn preset name (researcher / pr-reviewer / tester / explorer /
   *  coder): pins role, enforced tool allowlist, and isolation. */
  preset?: string;
  scratchpad?: string;
  timeoutMs?: number;
  lane?: string;
  failoverIndex?: number;
  /** Force a private git worktree even without a worktree preset. */
  isolate?: boolean;
  /** G11: per-child idle-compaction window in ms. When set, this child
   *  opts into idle compaction with its OWN threshold (its own idle
   *  clock, not the parent's schedule); unset = the parent's default
   *  (off unless the host opted in). */
  autoCompactWindow?: number;
  /** Extra system guidance appended after the preset addendum (fleet lens). */
  extraSystem?: string;
}

/** A child agent that has been constructed and STARTED. `completion`
 *  resolves with the child's AgentResult and never rejects (errors are
 *  fenced so a late child failure can never crash the parent). */
interface PreparedChild {
  childId: string;
  role: import('../types.js').AgentRole;
  task: Task;
  abort: AbortController;
  cwd: string;
  worktree?: import('../teams/subagent-runtime.js').ChildWorktreeInfo;
  toolCalls: () => number;
  stopCounting: () => void;
  /** B21: hand a mid-run steer to the running child (queued into its
   *  steer queue, injected at its next turn boundary). Returns false when
   *  the child's run already finished — the caller must then surface the
   *  steer as NOT delivered, never drop it silently. The `event` object is
   *  shared with the child's run record: the child stamps its deliveredAt
   *  when the steer actually lands in its context. */
  steerChild: (text: string, event: ChildSteerEvent) => boolean;
  completion: Promise<{ result?: AgentResult; error?: string }>;
  /** Set when the child ran under a forged persona (agent-forge ledger). */
  forgedPersonaName?: string;
}

/** One queued mid-run steer line. `user` entries come from Agent.steer()
 *  (TUI / goals / runtime); `parent` entries arrive via a parent agent's
 *  steerChildRun (B21) and carry their provenance event — the same object
 *  the child's run record holds, so delivery can be stamped onto it. */
interface SteerQueueEntry {
  text: string;
  source: 'user' | 'parent';
  event?: ChildSteerEvent;
}

/** Live bookkeeping for one background child owned by this agent. */
interface LiveChildRun {
  record: ChildRunRecord;
  spec: ChildRunSpec;
  prepared?: PreparedChild;
  /** B21: steers issued while the child was queued or still launching —
   *  handed to the child in issue order the moment it is prepared. The
   *  raw text lives ONLY here in memory (and then in the child's own
   *  queue); the persisted record keeps hash + redacted preview. */
  pendingSteers: Array<{ text: string; event: ChildSteerEvent }>;
  /** Settles when the run is fully finalized (record persisted). */
  promise: Promise<void>;
  settle: () => void;
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

/** P0.5: the in-loop completion gate's verdict, in the VerifierEngine's
 *  vocabulary (src/verification.ts). `passed` stays the binary the loop's
 *  finish machinery consumes; `status` is the structured verdict — PASS /
 *  FAIL / PARTIAL (mutation survivor) / BLOCKED (no verifiable deliverable)
 *  / FLAKY-PASS (green only via flake resolution; passed=true, never
 *  silent) — and `checks` is the evidence trail of commands executed. */
export interface LoopVerification {
  passed: boolean;
  summary: string;
  status: VerificationStatus;
  checks: string[];
  /** Flakes observed during this verify (status FLAKY-PASS when the run is
   *  green only via flake resolution). Loud in the summary; never silent. */
  flaky?: FlakyTestRef[];
}

/** Task kinds whose deliverable IS a file mutation. A run of one of these
 *  kinds that changed nothing, or whose changes no check covers, cannot be
 *  verified — see the P0.5 branches in Agent.verify(). Read-only kinds
 *  (chat/research/plan, and review which classifies as research) and
 *  'document' (its deliverable is routinely prose or content checked by the
 *  content-only path) are deliberately absent. */
const MUTATION_KINDS: ReadonlySet<string> = new Set(['implement', 'fix', 'refactor', 'test']);

/** Kinds whose zero-change PROSE completions are routed through verify()
 *  instead of finishing directly (see the P0.5 routing in the no-tool-call
 *  prose path). 'test' is excluded here — unlike the gate-internal set —
 *  because for test-kind tasks the tool work itself (running the suite) is
 *  a legitimate zero-change deliverable; verify()'s internal branches
 *  still BLOCK test-kind tasks that reach the gate through a gated path
 *  with no changes and nothing checked. */
const PROSE_VERIFY_KINDS: ReadonlySet<string> = new Set(['implement', 'fix', 'refactor']);

/** S4: read-only tools whose results the run result cache must NOT serve —
 *  either the result depends on mutable harness/run state rather than the
 *  workspace (todo list, memory recall, loaded-skill text, the model's own
 *  scratch state), or it is a measurement that re-running is the point of
 *  (perf), or it is remote and time-varying (fetch / web_search). 'read'
 *  is excluded for a different reason: the read tool owns read dedup
 *  itself, with file-precise (mtime/size) invalidation and range-aware
 *  stubs — strictly better than this cache's coarse epoch for the single
 *  most-repeated call in any run. The cacheable remainder are pure
 *  functions of workspace content + args. */
const RESULT_CACHE_EXCLUDE: ReadonlySet<string> = new Set([
  'read',
  'todo', 'memory', 'session_recall', 'skill', 'think', 'accept_plan', 'ask_question',
  'chameleon', 'perf', 'perf_audit', 'system_info', 'fetch', 'web_search',
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
  /** Greenfield determination captured at run START. It must not be
   *  recomputed at verify time: isGreenfieldTask's fileScope branch checks
   *  that the scoped paths do NOT exist yet, which the run itself falsifies
   *  by creating them. */
  private greenfieldTask = false;
  /** Run-start existence probe for the paths a task names (text tokens +
   *  fileScope), populated in run() before the model loop. Lets verify()
   *  distinguish changes to pre-existing files from pure creations. */
  private namedPathsExistedAtStart = new Map<string, boolean>();
  private budget?: BudgetEngine;
  private abortSignal?: AbortSignal;
  private promptUser?: PromptUserFn;
  private approvalHandler?: ApprovalHandler;
  private permPolicy?: string;
  /** Explicit unattended opt-in (see AgentOptions.unattendedAllow). */
  private unattendedAllow: boolean;
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
  /** P5: per-call usage for the run's cache-hit ratio. cachedTokens stays
   *  undefined on calls where the provider reported no cache figure — the
   *  ratio is computed over measured calls only (never a fabricated 0). */
  private cacheCalls: Array<{ promptTokens: number; cachedTokens?: number }> = [];
  /** P5: prefix-break count last surfaced in the run log (delta logger). */
  private lastLoggedBreaks = 0;
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
  /** Cost-per-solve routing (B22): per-run ladder state. The routing table
   *  itself is loaded lazily from workspace state on first use per run —
   *  a fresh table derived between runs is picked up by the NEXT run, never
   *  swapped mid-run under a live ladder. */
  private routingTableCache: RoutingTable | null | undefined;
  private routingEscalationsThisRun = 0;
  private routingAttemptedModels = new Set<string>();
  /** Candidate models snapshotted at run start, BEFORE any routed start or
   *  escalation collapses the profiles via setActiveModel — the ladder must
   *  be computed from the configuration the user actually wrote, not from
   *  the post-switch state where every profile points at the active model. */
  private routingCandidatesSnapshot: string[] = [];
  /** verifyCount at the last routing escalation: two triggers firing on the
   *  SAME failure may not buy two ladder rungs for one piece of evidence. */
  private routingLastEscalationVerifyCount = -1;
  /** One-way promotion flag for the self-tuning complexity signal. */
  private complexityEscalated = false;
  private autopsy: Autopsy | undefined;
  private hypotheses: Hypothesis[] = [];
  private diagnosis: DiagnosisResult | undefined;
  private lastLessons: Lesson[] = [];
  /** Lesson ids injected into the prompt this run (success/failure attribution). */
  private surfacedLessonIds = new Set<string>();
  private anchor = new AnchorEngine();
  private fileChanged = false;
  /** SWE-agent action-sampler lesson (dataset #4): the run's FIRST successful
   *  mutation flips it into the high-stakes phase — errors now cost rework.
   *  One discipline hard signal (effort +1 rung, capped, decays on clean
   *  turns) fires exactly once, mirroring SWE-agent widening the sample
   *  count when an EDIT action is detected. */
  private mutationHardSignaled = false;
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
  /** S4: run-scoped read-only result cache (see result-cache.ts). Consulted
   *  before re-issuing an identical read-only call; invalidated by any
   *  non-read-only completion (epoch) and any history rewrite (generation).
   *  Kill-switch: MOCHI_RESULT_CACHE=0. */
  private resultCache = new RunResultCache();
  private resultCacheEnabled = process.env.MOCHI_RESULT_CACHE !== '0';
  /** S4: the currently-open verifier objection (structured form of the last
   *  gate rejection), pinned as ONE refreshed transcript block so every
   *  retry carries it. Null when no rejection is outstanding. */
  private openObjection: VerifierObjection | null = null;
  /** S4: the reasoning tier this run started at (pre-discipline-offset),
   *  captured on the first main-loop turn; finish() attributes the run's
   *  gate verdict to it in the effort-calibration table. */
  private runBaseReasoningTier: string | undefined;
  private effortCalibrationLogged = false;
  /** Durable run journal (C6): opened per run() — see run-journal.ts. */
  private journal?: RunJournal;
  private journalOverride?: RunJournal;
  private journalRunId?: string;
  private journalDisabled = false;
  private journalReplayed = 0;
  private journalRecorded = 0;
  /** Model-turn journaling opt-out (option journalModelTurns / env
   *  MOCHI_JOURNAL_MODEL_TURNS=0). Tool-step journaling ignores this. */
  private journalModelTurnsDisabled = false;
  /** True when this run opened a journal holding claimable model turns:
   *  resume-time prose injections (checkpoint / journal note) are then
   *  SKIPPED, because any extra context message would change the first
   *  request's fingerprint and silently disable the exact replay they
   *  exist alongside. The journaled transcript supersedes the prose. */
  private modelReplayArmed = false;
  private journalModelReplayed = 0;
  /** MCH-64: tool_call_ids already spec-executed mid-stream this response, so
   *  the post-stream execution path skips them (results already in context). */
  private midStreamExecutedIds = new Set<string>();
  private recentToolSignatures: string[] = [];
  /** MCH-78: current failing-signature cluster (sig + consecutive count). */
  private failureClusterSig: string | null = null;
  private failureClusterCount = 0;
  /** MCH-74: mid-run steer queue — guidance injected at next iteration.
   *  Entries are source-tagged (B21): 'user' lines from steer(), 'parent'
   *  lines from a parent agent's steerChildRun carrying provenance. */
  private steerQueue: SteerQueueEntry[] = [];
  /** B21: true while a run() is in flight — the window in which parent
   *  steers can be accepted. Set at run() start, cleared at finish(). */
  private runActive = false;
  /** B21: parent steers actually DELIVERED into this run's context (the
   *  provenance events, shared objects with the child's run record).
   *  Reset per run; stamped onto the skills:attributed event at finish. */
  private deliveredParentSteers: ChildSteerEvent[] = [];
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
  /** Short-task fast lane (src/core/fastlane.ts): entered at run start when
   *  the up-front evidence proves the task short/simple; exited one-way via
   *  maybeEscalateFastLane when the run itself proves otherwise. */
  private fastLane = false;
  private fastLaneEscalated = false;
  private fastLaneEscalationReason: FastLaneEscalationReason | undefined;
  private fastLaneDecision: FastLaneDecision | undefined;
  /** Struggle-gated recall (B19): memory stays gated until this flips. */
  private fastLaneMemoryReleased = false;
  private fastLaneLoadToolsCalls = 0;
  private fastLaneOutcomeRecorded = false;
  /** Effective iteration cap for this run (fast lane tightens it;
   *  escalation restores the configured cap). Set at loop start. */
  private iterationCap = 0;
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
  /** Reproduce-first gate (fix/debug kinds): set once a shell/verify/bg_task
   *  call has actually EXECUTED this run — a failing repro is the point, so
   *  execution counts regardless of the call's success. */
  private reproAttempted = false;
  /** Reproduce-first gate: the one strong veto has been spent. A further
   *  mutation without a repro is allowed (hard-blocking forever traps tasks
   *  with no runnable entrypoint) but recorded via reproGateBypassed. */
  private reproVetoFired = false;
  /** Reproduce-first gate: the model mutated after the veto without ever
   *  reproducing — telemetry only (agent:log + this flag), never a block. */
  private reproGateBypassed = false;
  /** Reproduce-first gate: `fileChanged` as it stood when run() started.
   *  The gate's already-changed-files exemption is about resume / warm
   *  start (a previous run did the changing), so it must read this
   *  snapshot — reading live `fileChanged` would let an exempt new-file
   *  creation EARLY IN THIS RUN disarm the gate for a later edit to an
   *  existing file, which is exactly the mutation the gate exists for. */
  private reproFileChangedAtRunStart = false;
  /** Reproduce-first gate: repro synthesis (observability/repro-synth.ts)
   *  has been attempted for this run — synthesis is tried at most once, at
   *  the moment the veto fires, and never blocks the gate on failure. */
  private reproSynthTried = false;
  /** Reasoning discipline (src/agent/discipline.ts): per-run tracker +
   *  resolved kill-switch flags. The tracker is created in run() for
   *  non-chat kinds; every consult is optional-chained so bare agents
   *  (unit tests that never call run()) keep legacy behavior. */
  private discipline?: DisciplineTracker;
  private disciplineFlags: DisciplineFlags = resolveDisciplineFlags(undefined);
  /** Progress snapshot for the discipline deliberation detector (distinct
   *  read/edited/verify-pass counts as of the previous model turn). */
  private disciplineSnap: ProgressSnap = { read: 0, edited: 0, verifyPass: 0 };
  /** Progress forcing fired: the next non-mutating response is treated as
   *  final (continue-nudges suppressed; read-only batches execute, then the
   *  run finishes decisively). Cleared by any mutating/progress turn. */
  private disciplineForceArmed = false;
  /** Whether the most recent model turn contained a mutating call. */
  private disciplineTurnMutating = false;
  /** Files mutated since the last verification attempt, tracked directly
   *  in trackFileChange (context.state.filesModified is DEDUPED, so a
   *  per-cycle delta computed from it is empty after the first edit of a
   *  file — useless as an approach fingerprint). Snapshot-and-cleared by
   *  the verify branch; the list is the "approach" the same-failure
   *  switch reasons over. */
  private disciplineEditedSinceVerify: string[] = [];
  /** A shell tool executed since the last verification attempt. */
  private disciplineShellRanSinceVerify = false;
  /** Adaptive effort only applies when the user left reasoning on auto. */
  private disciplineEffortAuto = false;
  private lastDisciplineEffort = '';
  /** Long-task milestone strategy (src/agent/milestones.ts): per-run
   *  tracker + host inputs, created/resumed in run() when the layer
   *  activates (host plan/planner, or a 'complex' classification). Every
   *  consult is guarded on ltTracker so other runs keep legacy behavior. */
  private ltTracker?: MilestoneTracker;
  private ltPlanInputs?: MilestoneInput[];
  private ltPlannerFn?: AgentOptions['milestonePlanner'];
  /** Spend baselines for per-milestone attribution: tokensOut and the
   *  iteration index as of the last pacing sample. */
  private ltLastTokensOut = 0;
  private ltLastIteration = 0;
  private ltPacing = true;
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
  /** The completion gate's most recent STRUCTURED verdict this run
   *  (PASS/FAIL/PARTIAL/BLOCKED), stamped by the verify() wrapper. Null
   *  when the gate never ran. This — not the run's self-reported success —
   *  is the verdict joined to skill loads at finish (skill lifecycle
   *  evidence + trajectory attribution). Reset per run(). */
  private lastVerifyStatus: VerificationStatus | null = null;
  private subagentDepth: number;
  /** Hard tool allowlist for role-scoped (preset) agents — see AgentOptions. */
  private toolAllowlist?: Set<string>;
  /** Background child runs owned by this agent (spawn_agent runtime):
   *  live map + FIFO queue under the concurrency cap. */
  private childRuns = new Map<string, LiveChildRun>();
  private childQueue: LiveChildRun[] = [];
  private childStoreInstance?: ChildRunStore;
  private worktreeManagerInstance?: WorktreeManager;
  /** One-line completion notices for finished background children, drained
   *  into context at the next iteration top (like the steer queue). */
  private childInbox: string[] = [];
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
    // G11: host opt-in for idle compaction on this agent's own context.
    if (opts.idleCompaction) this.context.setIdleCompactionConfig(opts.idleCompaction);
    this.budget = opts.budget;
    this.abortSignal = opts.abortSignal;
    this.promptUser = opts.promptUser;
    this.approvalHandler = opts.approvalHandler;
    this.permPolicy = opts.permPolicy;
    this.unattendedAllow = opts.unattendedAllow ?? process.env.MOCHI_UNATTENDED_ALLOW === '1';
    this.approvedAlways = opts.approvedAlways ?? new Set<string>();
    this.journalOverride = opts.journal;
    this.journalRunId = opts.runId;
    this.journalDisabled = opts.journalEnabled === false;
    this.journalModelTurnsDisabled = opts.journalModelTurns === false || process.env.MOCHI_JOURNAL_MODEL_TURNS === '0';
    this.ltPlanInputs = opts.milestonePlan;
    this.ltPlannerFn = opts.milestonePlanner;
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
    if (opts.toolAllowlist) {
      // Hard scope cap (multi-agent presets): prune the live tool map to the
      // allowlist. executeTool ALSO checks ctx.toolAllowlist on every call,
      // so neither a hallucinated tool name nor load_tools can widen this
      // agent beyond its preset mid-run.
      this.toolAllowlist = new Set(opts.toolAllowlist);
      for (const name of [...this.tools.keys()]) {
        if (!this.toolAllowlist.has(name)) this.tools.delete(name);
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

  /** Durable journal stats for the current/last run (C6; tests + hosts). */
  getJournalStats(): import('./run-journal.js').JournalStats | undefined {
    return this.journal?.stats();
  }

  /** Fingerprint of the model request the main loop is about to send.
   *  The temperature literal MUST match the streamChat call in
   *  gatherStream (0.2) — it is part of the request as sent. Provider
   *  identity is config.model.provider/model, the same canonical
   *  identity the budget, usage events and traces use (RawProvider
   *  exposes no finer identity). */
  private modelTurnFingerprintFor(messages: import('../types.js').ChatMessage[], reasoningEffort: string | undefined): string {
    return modelTurnFingerprint({
      provider: this.config.model.provider ?? '',
      model: this.config.model.model,
      messages,
      tools: this.toolDefs,
      temperature: 0.2,
      reasoningEffort: reasoningEffort ?? null,
    });
  }

  /** Model-turn replay: if a previous session of this run journaled a
   *  response to EXACTLY this request (same fingerprint, next in the
   *  journaled sequence), return that response instead of calling the
   *  provider. Any mismatch/rail ends replay inside the journal and this
   *  returns undefined — the caller then calls the provider live.
   *  Never throws: a journal fault must not block the real call. */
  private journalClaimModelTurn(
    messages: import('../types.js').ChatMessage[],
    reasoningEffort: string | undefined,
  ): { response: import('../types.js').ModelResponse; seq: number } | undefined {
    if (!this.journal || this.journalModelTurnsDisabled) return undefined;
    try {
      const claimed = this.journal.claimModelTurn(this.modelTurnFingerprintFor(messages, reasoningEffort));
      if (!claimed) return undefined;
      const p = claimed.payload as Partial<import('../types.js').ModelResponse>;
      if (typeof p !== 'object' || p === null || (p.content !== undefined && typeof p.content !== 'string')
        || (p.toolCalls !== undefined && !Array.isArray(p.toolCalls))) {
        // Parsed, but not a response shape this loop can consume.
        this.journal.endModelReplay();
        return undefined;
      }
      return {
        seq: claimed.entry.seq,
        response: {
          content: p.content,
          ...(p.reasoningContent !== undefined ? { reasoningContent: p.reasoningContent } : {}),
          toolCalls: p.toolCalls,
          finishReason: p.finishReason,
          usage: p.usage,
          ...(p.looped ? { looped: true } : {}),
        },
      };
    } catch { return undefined; }
  }

  /** Journal one LIVE-obtained model turn (response payload + usage +
   *  the fingerprint of the request that produced it), so a later
   *  resume can replay it. Never call this for a replayed turn: a replay
   *  re-recorded would duplicate the chain entry and shift every later
   *  position, breaking multi-resume fidelity. Never throws. */
  private journalRecordModelTurn(
    messages: import('../types.js').ChatMessage[],
    reasoningEffort: string | undefined,
    response: import('../types.js').ModelResponse,
    durationMs: number,
  ): void {
    if (!this.journal || this.journalModelTurnsDisabled) return;
    try {
      const payload = JSON.stringify({
        content: response.content,
        ...(response.reasoningContent !== undefined ? { reasoningContent: response.reasoningContent } : {}),
        toolCalls: response.toolCalls,
        finishReason: response.finishReason,
        usage: response.usage,
        looped: response.looped === true,
      });
      this.journal.recordModelTurn({
        stepId: `turn-${this.journalRecorded + 1}`,
        output: payload,
        fingerprint: this.modelTurnFingerprintFor(messages, reasoningEffort),
        durationMs: Math.round(durationMs),
        usage: response.usage
          ? {
              inputTokens: response.usage.promptTokens,
              outputTokens: response.usage.completionTokens,
              ...(response.usage.costUsd !== undefined ? { costUsd: response.usage.costUsd } : {}),
            }
          : undefined,
      });
      this.journalRecorded++;
    } catch { /* journaling must never affect the run */ }
  }

  /** Fast-lane entry decision for the current/last run (tests + hosts):
   *  the signals the classifier saw and its evidence trail, eligible or not. */
  getFastLaneDecision(): FastLaneDecision | undefined {
    return this.fastLaneDecision;
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

  /** S4: history was ACTUALLY rewritten (a digest splice or a compaction
   *  cut — NOT the periodic checkpoint's no-drop path, which also calls
   *  clearReadStub and must not void run-scoped claims about a history
   *  that is still intact). The run-scoped read stubs and the loop result
   *  cache both claim "already in your context" — after a rewrite that
   *  claim is void until re-earned; the pinned verifier-objection block
   *  may have been cut, so it is re-upserted. */
  private onHistoryRewritten(): void {
    delete (this.readCache as { __servedReads?: Map<string, string> }).__servedReads;
    this.resultCache.noteHistoryRewrite();
    if (this.openObjection) {
      this.context.upsertMarkedSystemMessage(OBJECTION_MARKER, renderObjection(this.openObjection));
    }
  }

  /** P1.3 measured exposure: fit this.tools to the total schema budget —
   *  always-on LEAN core + tools the task text names/implicates (never
   *  dropped) + this workspace's historically-used tools (this task kind
   *  first), ranked from the usage ledger (tools/tool-exposure.ts). Used
   *  for complex tasks (which previously kept the full ~45K-char schema)
   *  and as a cap ('tier-cap') when the keyword tiers defer nothing and
   *  the advertised set is still over budget. Deferred tools stay one
   *  load_tools call away. Emits the [tools] decision log — the run's
   *  record of which policy applied and the exposed schema size. */
  private applyMeasuredExposurePolicy(task: Task, taskKind: string, reason: 'complex' | 'tier-cap'): void {
    const budgetChars = toolSchemaBudgetChars(this.config);
    if (reason === 'tier-cap' && toolsSchemaChars(this.toolDefs) <= budgetChars) return;
    const taskText = `${task.title} ${task.description ?? ''}`;
    const forced = new Set<string>([...toolsNamedInText(taskText), ...toolsImplicatedBySignals(taskText)]);
    const sel = applyMeasuredExposure(this.tools, {
      builtinNames: new Set([...ALL_TOOLS_MAP.keys(), 'load_tools']),
      coreNames: LEAN_TOOL_NAMES,
      forcedNames: forced,
      ledger: loadToolUsageLedger(this.workspace),
      taskKind,
      budgetChars,
    });
    if (sel.trimmed > 0) {
      this.toolDefs = [...this.tools.values()].map((t) => t.def);
    }
    this.events.emit({
      type: 'agent:log',
      agentId: this.id,
      message: `[tools] measured exposure (${reason}) for ${taskKind} task: ${this.toolDefs.length} tools advertised, ${sel.schemaChars}/${budgetChars} schema chars (forced ${sel.forcedNames.length} core/named/signal, usage-filled ${sel.filledNames.length}, ${sel.trimmed} deferred to load_tools)`,
    });
    if (reason === 'complex') this.injectDeferredToolsNote('measured');
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
  private injectDeferredToolsNote(tier: 'lean' | 'read' | 'chat' | 'measured'): void {
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
        : tier === 'measured'
          ? 'This is a complex task, so a measured toolset is listed: an always-on core, the tools this task implicates, and the tools this workspace actually uses, fitted to a total schema budget. The rest are deferred, not disabled.'
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
    // Discipline (adaptive effort): mid-run complexity escalation is a
    // hard signal — the rest of the run thinks one rung deeper.
    this.discipline?.noteHardSignal();
    this.taskComplexity = 'complex';
    this.context.setTaskComplexity('complex');
    // Restore every registered tool the lean/read/chat tiers deferred, so deeper
    // analysis (find_definitions/analyze_code/blast_radius/...) is available.
    // A role-scoped agent (toolAllowlist) is NEVER widened by escalation.
    for (const [name, tool] of ALL_TOOLS_MAP) {
      if (this.toolAllowlist && !this.toolAllowlist.has(name)) continue;
      if (!this.tools.has(name)) this.tools.set(name, tool);
    }
    this.toolDefs = [...this.tools.values()].map((t) => t.def);
    this.events.emit({
      type: 'agent:log',
      agentId: this.id,
      message: `[complexity] escalated to complex mid-run (iter ${iteration}, toolErrors ${toolErrors}, verifyFails ${this.consecutiveVerifyFailures}) — full toolset + context preservation restored`,
    });
    // A task that outgrew its classification mid-run is routing evidence
    // too: if the measured ladder has a stronger model for this kind, the
    // rest of the run gets it. One-way, like the complexity promotion.
    this.tryRoutingEscalation('complexity_escalation');
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

  /** True while fast-lane memory gating is in force (entered, not yet
   *  released by struggle or escalation). */
  private fastLaneMemoryGated(): boolean {
    return this.fastLane && !this.fastLaneEscalated && !this.fastLaneMemoryReleased;
  }

  /** Fast lane: restrict the ADVERTISED tool set to the lane allowlist for
   *  the task kind (+ tools the task text names explicitly). Only defs
   *  change — executeTool still resolves any deferred tool from the full
   *  registry, and load_tools re-advertises mid-run. */
  private applyFastLaneToolProfile(task: Task, kind: import('../core/taskkind.js').TaskKind): void {
    const allowed = new Set<string>(fastLaneToolNames(kind));
    for (const n of toolsNamedInText(`${task.title} ${task.description ?? ''}`)) allowed.add(n);
    if (this.toolAllowlist) {
      for (const n of [...allowed]) if (!this.toolAllowlist.has(n)) allowed.delete(n);
    }
    const defs: import('../types.js').ToolDefinition[] = [];
    for (const n of allowed) {
      const t = this.tools.get(n) ?? ALL_TOOLS_MAP.get(n);
      if (t) defs.push(t.def);
    }
    this.toolDefs = defs;
    this.events.emit({
      type: 'agent:log', agentId: this.id,
      message: `[fastlane] advertised ${defs.length} tools (${toolsSchemaChars(defs)} schema chars) for ${kind} task`,
    });
  }

  /**
   * Fast-lane exit check, run every iteration beside maybeEscalateComplexity.
   * Two-stage: (1) struggle-gated recall — the FIRST hard struggle signal
   * (a verify failure, repeated tool errors) releases memory injection while
   * the run stays in the lane (B19: minimal brief first, deeper recall only
   * when the run shows it needs it); (2) full escalation — when the pure
   * predicate in core/fastlane.ts says the run has produced not-short
   * evidence, restore the standard profile wholesale: configured turn cap,
   * the standard kind tier's toolset, memory, and the repo map the lane
   * skipped. One-way: an escalated run never re-enters the lane.
   */
  private async maybeEscalateFastLane(iteration: number): Promise<void> {
    if (!this.fastLane || this.fastLaneEscalated) return;
    if (!this.fastLaneMemoryReleased && (this.consecutiveVerifyFailures >= 1 || this.totalToolErrors() >= 2)) {
      this.fastLaneMemoryReleased = true;
      this.context.setMemoryInjectionEnabled(true);
      this.events.emit({
        type: 'agent:log', agentId: this.id,
        message: '[fastlane] memory released on struggle signal — full recall available for the rest of the run',
      });
    }
    const reason = fastLaneEscalationReason({
      filesEdited: new Set(this.context.state.filesModified).size,
      filesRead: this.readCache.size,
      toolErrors: this.totalToolErrors(),
      consecutiveVerifyFailures: this.consecutiveVerifyFailures,
      loadToolsCalls: this.fastLaneLoadToolsCalls,
      iteration,
    });
    if (!reason) return;
    this.fastLaneEscalated = true;
    this.fastLaneEscalationReason = reason;
    this.iterationCap = this.config.safety.maxIterations;
    recordFastLaneEscalation(this.workspace, reason);
    this.discipline?.noteHardSignal();
    // Restore the standard tool profile: full registry first (a role-scoped
    // agent's allowlist is NEVER widened), then the same kind tier the
    // standard profile would have applied at run start.
    for (const [name, tool] of ALL_TOOLS_MAP) {
      if (this.toolAllowlist && !this.toolAllowlist.has(name)) continue;
      if (!this.tools.has(name)) this.tools.set(name, tool);
    }
    const task = this.task;
    const kind = this.taskKind ?? (task ? classifyTaskKind(task) : 'implement');
    const taskText = task ? `${task.title} ${task.description ?? ''}` : '';
    if (kind === 'implement' || kind === 'fix' || kind === 'refactor' || kind === 'test') {
      if (trimToLeanTier(this.tools, taskText) === 0) trimHeavyTools(this.tools, taskText);
      this.toolDefs = [...this.tools.values()].map((t) => t.def);
    } else if (kind === 'document' || kind === 'research' || kind === 'plan' || kind === 'unknown') {
      trimToReadTier(this.tools, taskText);
      this.toolDefs = [...this.tools.values()].map((t) => t.def);
    } else {
      // chat: the standard profile advertises only the chat tier's defs.
      this.toolDefs = [...this.tools.values()].filter((t) => CHAT_TOOL_NAMES.has(t.def.name)).map((t) => t.def);
    }
    // Memory back on (it may already be, via the struggle release above).
    this.context.setMemoryInjectionEnabled(true);
    this.fastLaneMemoryReleased = true;
    // The repo map the lane skipped: build and inject it now.
    let mapText = '';
    if (task) {
      try {
        const { taskRepoMapText } = await import('../repo/repo-map.js');
        mapText = taskRepoMapText(this.workspace.dir, {
          task: `${task.title}\n${task.description ?? ''}`,
          kind,
        }) ?? '';
      } catch { /* repo-map must never affect the run */ }
    }
    this.events.emit({
      type: 'agent:log', agentId: this.id,
      message: `[fastlane] escalated to standard profile at iteration ${iteration}: ${reason} — full toolset, repo map, memory, and turn budget restored`,
    });
    if (!this.subagentDepth) {
      this.context.addMessage({
        role: 'system',
        content: `FAST LANE EXITED (${reason}): this task is bigger than it looked, so the standard profile is restored — full toolset, memory recall, repo context, and the full turn budget. Re-ground in the actual code before continuing instead of repeating the approach that struggled.${mapText ? `\n\n${mapText}` : ''}`,
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
      // S4 effort calibration: the static per-kind tier is only a prior.
      // Verified outcome history (kind x tier -> runs/solved, recorded at
      // finish from the gate's verdict) may move the base ONE rung — down
      // when a lower tier has proven it solves this kind, up when the
      // static tier is demonstrably starved. Thresholds live in
      // effort-calibration.ts; a user-pinned tier never reaches this code.
      const staticTier = resolveAutoReasoning(kind);
      const calibrated = calibratedBaseTier(this.workspace.dir, kind, staticTier);
      if (calibrated.reason && !this.effortCalibrationLogged) {
        this.effortCalibrationLogged = true;
        this.events.emit({ type: 'agent:log', agentId: this.id, message: `[effort-calibration] kind=${kind} base ${staticTier} -> ${calibrated.tier} (${calibrated.reason})` });
      }
      return calibrated.tier;
    }
    // Guard against any stray invalid value (config re-validates, but stay safe).
    if (raw === 'off' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max' || raw === 'extreme' || raw === 'deep' || raw === 'hard' || raw === 'easy') {
      return raw === 'extreme' || raw === 'deep' || raw === 'hard' ? 'max' : (raw === 'easy' ? 'low' : (raw as 'off' | 'low' | 'medium' | 'high' | 'max'));
    }
    return 'medium';
  }

  async run(task: Task): Promise<AgentResult> {
    // B21/G11 ordering — the steer-acceptance window MUST open before the
    // first await in run(). The child-launch handover (launchTrackedChild)
    // calls acceptParentSteer as soon as startChildRun resolves; an await
    // here — even on an already-resolved promise, and especially through
    // .catch()'s extra promise hop — defers runActive past that handover,
    // so a queued child's first steer is refused as "not started" and
    // marked undelivered (subagent-steer test (e) regression). Capture the
    // pre-run active state first: the idle guard must see the PREVIOUS
    // run's value, not the window being opened.
    const wasActive = this.runActive;
    this.runActive = true;
    this.deliveredParentSteers = [];
    // G11 idle compaction: a reused instance returning after a long idle
    // gap compacts BEFORE the new run's first model turn, so the resumed
    // turn doesn't pay full uncached context. Fires only at this run
    // boundary (never mid-turn — wasActive is the previous run's value),
    // only when the host opted in, and at most once per idle period.
    // Never breaks a run: failures are swallowed.
    await this.maybeIdleCompact(Date.now(), wasActive).catch(() => {});
    this.startTime = performance.now();
    this.activeTask = task;
    // B2: each run() gets exactly one finish(). A previous run's guard entry
    // must not swallow this run's teardown (auto-resume reuses the instance).
    this.finishPromise = null;
    // The gate verdict is per-run evidence: a reused instance must not
    // attribute a previous run's PASS to this run's skill loads.
    this.lastVerifyStatus = null;
    // Mark the bus position so the finish-time summary covers THIS run only.
    const hist = this.events.snapshot();
    this.runStartMarker = hist.length > 0 ? hist[hist.length - 1] : undefined;
    this.consecutiveVerifyFailures = 0;
    this.escalatedThisTask = false;
    this.routingTableCache = undefined;
    this.routingEscalationsThisRun = 0;
    this.routingAttemptedModels = new Set();
    this.routingLastEscalationVerifyCount = -1;
    this.routingCandidatesSnapshot = this.routingCandidates();
    this.complexityEscalated = false;
    // Fast-lane state is per-run (instances are reused on auto-resume).
    this.fastLane = false;
    this.fastLaneEscalated = false;
    this.fastLaneEscalationReason = undefined;
    this.fastLaneDecision = undefined;
    this.fastLaneMemoryReleased = false;
    this.fastLaneLoadToolsCalls = 0;
    this.fastLaneOutcomeRecorded = false;
    // Reproduce-first gate state is per-run: a reused instance (auto-resume)
    // must not inherit "already reproduced / already vetoed" from a prior run.
    this.reproAttempted = false;
    this.reproVetoFired = false;
    this.reproGateBypassed = false;
    this.reproSynthTried = false;
    this.reproFileChangedAtRunStart = this.fileChanged;
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
    // Fast-lane entry decision (src/core/fastlane.ts): cheap up-front signals
    // only — task text, kind, complexity verdict, referenced files, repo
    // size, chameleon difficulty. No model call. Entered ONLY on positive
    // proof of shortness; the decision (and later, any escalation) is
    // recorded in .mochi/state/fastlane.json so the false-short rate is
    // measured, not assumed. Subagents keep the standard profile: their
    // scope is set by the parent's role preset, not by task text.
    {
      const kind = classifyTaskKind(task);
      const decision = decideFastLane({
        kind,
        complexity: complexityScore.complexity,
        complexityScore: complexityScore.score,
        referencedFiles: referencedFilesFor(task),
        textChars: `${task.title} ${task.description ?? ''}`.length,
        acceptanceCriteria: task.acceptanceCriteria?.length ?? 0,
        chameleonDifficulty: classifyChameleonTask(`${task.title} ${task.description ?? ''}`).difficulty,
        repoFiles: countRepoFiles(this.cwd),
        role: task.role,
        simpleScript: isSimpleScriptTask(task),
        trivialWrite: isTrivialWriteTask(task),
      }, resolveFastLaneEnabled(this.config.fastlane) && !this.subagentDepth && !this.planMode);
      this.fastLaneDecision = decision;
      if (!decision.eligible) {
        // A reused ContextEngine must never inherit a previous run's gate.
        this.context.setMemoryInjectionEnabled(true);
      }
      if (decision.eligible) {
        this.fastLane = true;
        recordFastLaneEntry(this.workspace, kind);
        // Struggle-gated recall (B19): the lane starts from a minimal
        // brief; memory is released on struggle or escalation.
        this.context.setMemoryInjectionEnabled(false);
        this.events.emit({
          type: 'agent:log', agentId: this.id,
          message: `[fastlane] entered for "${task.title}" (${decision.reasons.join('; ')}) — lean profile: ≤${FASTLANE_LIMITS.maxIterations} turns, targeted verify only, memory gated until struggle`,
        });
      }
    }
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
    this.greenfieldTask = isGreenfieldTask(task.title, task.description ?? '', task.fileScope, (p) => { try { return existsSync(resolve(this.cwd, p)); } catch { return false; } });
    for (const token of [...(task.fileScope ?? []), ...this.taskFileTokens(task)]) {
      if (!this.namedPathsExistedAtStart.has(token)) {
        try { this.namedPathsExistedAtStart.set(token, existsSync(resolve(this.cwd, token))); } catch { this.namedPathsExistedAtStart.set(token, false); }
      }
    }
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
    // Fast lane: skipped — a proven-short task pays for no warm-start
    // machinery; escalation restores the standard profile wholesale.
    if (!this.fastLane) try {
      const { findPriorPlan } = await import('../core/plan-cache.js');
      const priorPlan = findPriorPlan(this.workspace.dir, task.title, task.description ?? '');
      if (priorPlan) {
        this.context.addMessage({
          role: 'system',
          content: `PRIOR SUCCESS CONTEXT: a similar task ("${priorPlan.taskTitle}") previously succeeded with this plan:\n${priorPlan.plan.slice(0, 1500)}\nUse it as a starting point if it still fits the current code; verify assumptions before reusing it.`,
        });
      }
    } catch { /* plan-cache warm-start must never affect task start */ }
    // MCH-49 + P1.2: repo-map — surface the files most relevant to THIS task
    // (task-conditioned: PageRank + lexical relevance over the codegraph
    // symbol graph, with key symbol signatures; deterministic, no model
    // call, falls back to the global PageRank map when the task carries no
    // usable terms) so the model starts from the right files instead of
    // discovering them by sequential grep/read.
    // Fast lane: skipped — targeted reads only; the map is built and
    // injected at escalation time if the run proves to need it.
    if (!this.fastLane) try {
      const { taskRepoMapText } = await import('../repo/repo-map.js');
      const mapText = taskRepoMapText(this.workspace.dir, {
        task: `${task.title}\n${task.description ?? ''}`,
        kind: this.taskKind ?? classifyTaskKind(task),
        // Aider chat-files personalization: everything already read (abs
        // paths; taskRepoMap normalizes) anchors the map on the live
        // working set.
        chatFiles: [...this.readCache.keys()],
      });
      if (mapText) {
        this.context.addMessage({ role: 'system', content: mapText });
      }
    } catch { /* repo-map must never affect task start */ }
    // Wave J: semantic retrieval — hybrid vector+lexical hits from the
    // persistent .mochi/index, re-ranked by the same task conditioning as
    // the repo map above. AUGMENTS the map packet (concept matches the
    // lexical map cannot see), under its own hard char budget; best-effort
    // and time-boxed exactly like its neighbours. On a cold index it kicks
    // off a background build and contributes nothing this run.
    try {
      const { semanticContextText } = await import('../repo/semantic-index.js');
      const semText = await semanticContextText(this.workspace.dir, `${task.title}\n${task.description ?? ''}`, {
        config: this.config,
      });
      if (semText) {
        this.context.addMessage({ role: 'system', content: semText });
      }
    } catch { /* semantic retrieval must never affect task start */ }
    // MCH-50: prefetch — fused structural+temporal+runtime prediction of the
    // files this task will likely read next.
    // Fast lane: skipped (prediction machinery is the overhead being cut).
    if (!this.fastLane) try {
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
    // Fast lane: skipped (pattern injection is context the lane does without).
    if (!this.fastLane) try {
      const { loadToolSeqStore, toolPatternText } = await import('../core/tool-sequence.js');
      // D9: the v2 store carries per-sequence outcomes, so the pattern hint
      // can filter to successful runs once outcome evidence exists.
      const patText = toolPatternText(loadToolSeqStore(this.workspace.dir));
      if (patText) this.context.addMessage({ role: 'system', content: patText });
    } catch { /* tool-seq injection must never affect task start */ }
    if (this.planMode) {
      this.context.addMessage({
        role: 'system',
        content: 'PLAN MODE: Research the codebase with read-only tools if needed, then submit your complete plan by calling the accept_plan tool with the plan as its argument (numbered steps, files to change, risks, and how to verify). Do NOT edit files or run mutating commands. After calling accept_plan, end your turn — do not call other tools.',
      });
    }

    // Durable run journal (C6): keyed by the task's stable identity, so a
    // new process resuming the same task loads the prior session's
    // completed steps as claimable — runMoolCall replays them instead of
    // re-executing/re-billing. Journal failures never affect the run.
    // Opened BEFORE the checkpoint injection below: when the journal
    // holds claimable model turns, exact model-turn replay supersedes
    // both prose injections (checkpoint + journal note) — either message
    // would alter the first request's fingerprint and silently disable
    // the replay, and the replayed transcript carries strictly more of
    // the run's real history than the prose summary does.
    this.modelReplayArmed = false;
    this.journalModelReplayed = 0;
    try {
      if (this.journalDisabled) {
        this.journal = undefined;
      } else {
        this.journal = this.journalOverride
          ?? RunJournal.open({ baseDir: this.workspace.dir, runId: this.journalRunId ?? task.id, taskId: task.id });
        this.journalReplayed = 0;
        this.journalRecorded = 0;
        const priorSteps = this.journal.completedSteps()
          .filter((s) => s.sessionId !== this.journal!.sessionId);
        this.journal.beginRun({ taskId: task.id, title: task.title });
        this.modelReplayArmed = !this.journalModelTurnsDisabled && this.journal.hasClaimableModelTurns();
        if (priorSteps.length > 0) {
          const names = priorSteps.slice(0, 12).map((s) => s.toolName).join(', ');
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[journal] resuming run ${task.id}: ${priorSteps.length} completed step(s) journaled — matching calls will replay, not re-execute${this.modelReplayArmed ? '; model-turn replay armed (recorded responses will be served for exact-matching requests)' : ''}` });
          if (!this.modelReplayArmed) {
            this.context.addMessage({
              role: 'system',
              content: `RUN JOURNAL RESUME: a previous session of this task completed ${priorSteps.length} step(s) (${names}${priorSteps.length > 12 ? ', …' : ''}). Those steps are journaled durably: calling the same tool with the same arguments replays the recorded result WITHOUT re-executing — do not redo their side effects (files already written, commands already run). Continue from the first step that has no journal entry.`,
            });
          }
        }
      }
    } catch { this.journal = undefined; }

    // Phase 7 (VNext): resume with the last durable checkpoint if one exists
    // for THIS specific goal (e.g. on resume or post-compaction restart).
    // Fresh sessions and unrelated goals do not load old checkpoints.
    // Skipped when model-turn replay is armed (see the journal block):
    // the checkpoint prose would poison the first replayed request.
    try {
      const activeGoal = this.context.state.goal;
      const durable = this.workspace.loadCheckpoint(activeGoal);
      if (!this.modelReplayArmed && durable && durable.checkpoint.trim() && durable.goalId && activeGoal && durable.goalId === activeGoal) {
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
    // Cost-per-solve routing (B22): with a stored routing table, the run
    // STARTS on the cheapest model with a measured cost-per-solve for this
    // task kind instead of the configured default — the default is a guess,
    // the table is a measurement. No table / no proven cell / user-pinned
    // model → the run starts exactly where it always did.
    this.applyRoutingStart(taskKind);
    // Reasoning discipline: create the per-run tracker and pin the task
    // contract. Chat runs are exempt (their own turn caps govern them);
    // every mechanism consults the tracker through the resolved flags, and
    // MOCHI_DISCIPLINE=0 / config.discipline.enabled=false restores the
    // legacy loop wholesale. Per-run state resets here because instances
    // are reused across runs (auto-resume).
    this.disciplineFlags = resolveDisciplineFlags(this.config.discipline);
    this.discipline = undefined;
    // S4 per-run resets: result cache, open objection, effort attribution.
    this.resultCache.clear();
    this.openObjection = null;
    this.runBaseReasoningTier = undefined;
    this.effortCalibrationLogged = false;
    this.disciplineSnap = { read: 0, edited: 0, verifyPass: 0 };
    this.disciplineForceArmed = false;
    this.disciplineTurnMutating = false;
    this.disciplineEditedSinceVerify = [];
    this.disciplineShellRanSinceVerify = false;
    this.lastDisciplineEffort = '';
    {
      const anyDiscipline = Object.values(this.disciplineFlags).some(Boolean);
      const rawReasoning = (this.config.reasoning || process.env.MOCHI_REASONING || 'auto').trim().toLowerCase();
      this.disciplineEffortAuto = rawReasoning === 'auto';
      if (anyDiscipline && taskKind !== 'chat') {
        this.discipline = new DisciplineTracker(this.disciplineFlags, {
          goal: task.title,
          checklist: [
            ...(task.acceptanceCriteria ?? []),
            ...(KIND_CHECKLISTS[taskKind] ?? KIND_CHECKLISTS.general),
          ],
          scopeFiles: task.fileScope ?? [],
        });
        if (this.disciplineFlags.replanGate || this.disciplineFlags.progressForcing || this.disciplineFlags.driftSnapback) {
          this.context.addMessage({ role: 'system', content: this.discipline.contractMessage() });
        }
      }
    }
    // Long-task milestone strategy: decompose complex/long tasks into
    // verified milestones with budget slices, checkpoints at milestone
    // boundaries, and budget pacing (src/agent/milestones.ts). Inert
    // unless activated (host plan/planner or a 'complex' score); any
    // failure here leaves the run exactly as it was.
    try {
      await this.initLongtask(task, taskKind);
    } catch { this.ltTracker = undefined; }
    // S4: hand the context engine the task's open obligations (the
    // contract checklist, which already folds in the acceptance criteria)
    // so verified compaction carries them in the ledger and probes them
    // as must-survive facts — the pinned contract message alone is a
    // droppable transcript message. Without a discipline contract (chat /
    // discipline off), the bare acceptance criteria still count.
    this.context.setObligations(
      this.discipline ? [...this.discipline.contract.checklist] : [...(task.acceptanceCriteria ?? [])],
    );
    // P1.3 measured exposure: MOCHI_TOOLS=full / config.toolExposure='full'
    // is the escape hatch — legacy behavior, every built tool advertised,
    // no tiering or budgeting at all. Otherwise 'complex' tasks no longer
    // keep the full ~45K-char schema by default (see the branch below).
    const exposureFull = toolExposureMode(this.config) === 'full';
    if (exposureFull) {
      this.events.emit({ type: 'agent:log', agentId: this.id, message: `[tools] full exposure (escape hatch): advertising all ${this.tools.size} tools, ${toolsSchemaChars(this.toolDefs)} schema chars, no measured budgeting` });
    }
    // Complexity gate: taskComplexity was already computed at the top of run().
    // When 'complex', apply measured exposure instead of the old full
    // toolset: deep-analysis tools (find_definitions/analyze_code/
    // type_hierarchy/blast_radius) stay advertised when the task implicates
    // them or this workspace's ledger says they get used; the rest are
    // deferred to load_tools, not disabled. Otherwise fall through to the
    // lean/read/heavy tiers, which preserve the ~2s / ~2.5K-token fast path
    // for simple/standard tasks (with the measured policy as their cap
    // when they defer nothing and the set is still over budget).
    if (this.taskComplexity === 'complex') {
      if (exposureFull) {
        this.events.emit({ type: 'agent:log', agentId: this.id, message: `[complexity] full toolset for ${taskKind} task (score ${this.tasksScoreMeta.score ?? 0}: ${(this.tasksScoreMeta.reasons ?? []).join('; ')})` });
      } else {
        this.applyMeasuredExposurePolicy(task, taskKind, 'complex');
      }
    } else if (!exposureFull) {
      // MCH-91: task-adaptive tool advertising — focused coding tasks don't need
      // browser/db/PR/SQL schemas burning ~4-5K tokens on EVERY call. Trim heavy
      // tools unless the task text itself signals them (trimHeavyTools is a no-op
      // then); the model can pull any back mid-run via `load_tools`.
      if (taskKind === 'implement' || taskKind === 'fix' || taskKind === 'refactor' || taskKind === 'test') {
        const taskText = `${task.title} ${task.description ?? ''}`;
        // MCH-110: lean tier first — simple focused coding tasks advertise only
        // the ~21 core tools (~2.5K tokens) instead of the full default set
        // (~69 tools, ~11K tokens). Restores are identical to mch91: the
        // model calls `load_tools` mid-run.
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
        // P1.3 cap: if the keyword tiers left the advertised set over the
        // schema budget (signal-escape kept everything), fit it by usage.
        this.applyMeasuredExposurePolicy(task, taskKind, 'tier-cap');
        this.injectDeferredToolsNote('lean');
      } else if (taskKind === 'chat') {
            // MCH-111: chat tasks tell the model "do not call any tools", yet were
            // still advertised nearly the full default schema (~69 tools, ~11K
            // tokens) on every call — the single largest avoidable latency cost
            // on a trivial question. Advertise
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
            // READ tier: read-only task shapes advertised the full default schema
            // (~69 tools, ~11K tokens/call) despite never legitimately mutating
            // (plan mode vetoes mutations anyway). Advertise the 17 read-only
            // essentials; anything else restores mid-run via load_tools.
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
            // P1.3 cap: same over-budget backstop as the coding branch.
            this.applyMeasuredExposurePolicy(task, taskKind, 'tier-cap');
            this.injectDeferredToolsNote('read');
      }
    } // end complexity-gate else
    // Tool Forge (Wave O): probationary forged tools are advertised only
    // when the exposure signals predict relevance for THIS task (task text
    // naming the tool / its source sequence, domain signals, or the usage
    // ledger's history for this task kind). Earned (active) forged tools
    // always stay. Runs after every tier above so no tier can re-advertise
    // what the prediction deferred; executeTool remains reachable via the
    // registry fallback exactly like other deferred tools.
    {
      const forgeRemoved = trimForgedProbationTools(
        this.tools,
        this.workspace.dir || this.cwd,
        `${task.title} ${task.description ?? ''}`,
        loadToolUsageLedger(this.workspace),
        taskKind,
      );
      if (forgeRemoved.length) {
        const removed = new Set(forgeRemoved);
        this.toolDefs = this.toolDefs.filter((d) => !removed.has(d.name));
        this.events.emit({ type: 'agent:log', agentId: this.id, message: `[forge] probationary forged tools not relevant to this task, deferred: ${forgeRemoved.join(', ')}` });
      }
    }
    // Fast lane: shrink the ADVERTISED set to the lane's allowlist (plus any
    // tool the task text names explicitly — implicated tools are never
    // dropped, the measured-exposure rule). Execution is unaffected:
    // executeTool resolves deferred tools from the full registry, and
    // load_tools re-advertises on demand (its use is an escalation signal).
    if (this.fastLane) this.applyFastLaneToolProfile(task, taskKind);
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
          // Fast lane: the project-memory prefix is memory injection too —
          // gated until struggle/escalation like the volatile block.
          if (memPrefix && !this.fastLaneMemoryGated()) this.context.addMessage({ role: 'system', content: memPrefix });
        }
        // Decision memory: past REJECTED approaches whose task signature
        // matches this task, as warnings. Deliberately NOT fast-lane gated:
        // a dead-approach warning at task start is exactly what prevents the
        // struggle the fast lane waits for. Bounded (<=3 records, ~10 lines).
        const dmBlock = decisionMemoryPrefix(this.workspace.dir, `${task.title} ${task.description ?? ''}`);
        if (dmBlock) this.context.addMessage({ role: 'system', content: dmBlock });
        this.context.addMessage({ role: 'system', content: TASK_FOCUS_PROTOCOL });
        this.maybeInjectStaleTodoNote();
      }
    }

    const maxIterations = this.config.safety.maxIterations;
    // Fast lane: tight turn budget. Escalation restores the configured cap
    // (this.iterationCap is the loop's live bound, not this local).
    this.iterationCap = this.fastLane ? Math.min(maxIterations, FASTLANE_LIMITS.maxIterations) : maxIterations;
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

    // Speculative reasoning preflight (default ON for complex tasks at
    // medium+ reasoning; explicit config / env can force or kill it — see
    // specPreflightEnabled). For hard non-chat tasks, run the existing
    // SpeculativeEngine once and inject its chosen approach + pitfall notes
    // as a system hint that biases the main reasoning path —
    // DeepSeek/Cline-style "think a cheap model ahead, then commit the fast
    // model to a better plan" before it fires tools.
    // Bounded: runs at most once (guarded by speculativePreflighted), only if
    // budget allows, and swallows any failure so it never blocks the task.
    if (!this.planMode && taskKind !== 'chat' && this.specPreflightEnabled(task) && !this.specPreflighted) {
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
      const lazySchemas = mcpLazySchemasEnabled(this.config);
      const connected = await buildMcpTools(this.config.mcpServers, log, { lazySchemas });
      for (const [name, tool] of connected.tools) {
        if (!this.tools.has(name)) this.tools.set(name, tool);
      }
      for (const err of connected.errors) log(err);
      if (lazySchemas && connected.tools.size > 0) {
        // Lazy schemas: task-named MCP tools get their full input schemas
        // up front — the measured-exposure rule ("a tool the task names is
        // never dropped") applied to schemas. Everything else is exposed
        // thin and inflated on demand via load_tools.
        const taskText = task ? `${task.title} ${task.description ?? ''}` : '';
        const named = [...connected.tools.keys()].filter((n) => taskText.includes(n));
        const inflated = inflateMcpToolSchemas(this.tools, named);
        if (inflated.length > 0) log(`[mcp] full schemas injected for task-named tool(s): ${inflated.join(', ')}`);
      }
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
    for (let i = 0; i < this.iterationCap; i++) {
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
      // Multi-agent: surface background-child completions the same way, so a
      // parent learns its research/review child landed without polling.
      this.drainChildInbox();
      // Quality slice: surface the agent's struggle state (consecutive tool
      // errors, empty-response retries, recent known errors) to the model on
      // every turn. Without this, a model in trouble starts each turn fresh —
      // it doesn't know it has failed 3 tool calls in a row or that 2 verify
      // attempts have already passed. The injection is rate-limited to once
      // per 2 iterations and a no-op when no struggle signals exist, so the
      // cost is zero on healthy runs.
      await this.injectStruggleState(i);
      // Self-tuning complexity: promote a struggling task to `complex` mid-run
      // (full toolset + context preservation) once real hard-task evidence
      // accumulates — no separate classification LLM call on the fast path.
      this.maybeEscalateComplexity(i);
      // Fast lane: exit to the standard profile the moment the run itself
      // produces not-short evidence (see maybeEscalateFastLane).
      await this.maybeEscalateFastLane(i);
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

      // Long-task pacing: attribute the last iteration's spend to the
      // current milestone and judge burn vs progress. Fires before the
      // model call so an escalation never pays for one more turn.
      if (this.ltTracker) {
        const lt = await this.ltPace(task, i);
        if (lt) return lt;
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
      // P5: surface prefix breaks as they happen — a changed stable prefix
      // or an in-place history rewrite means the provider cache re-warms
      // on the next call; the cause names the segment or rewrite.
      {
        const stats = this.context.prefixStats();
        if (stats.breakCount > this.lastLoggedBreaks) {
          const fresh = stats.breaks.slice(this.lastLoggedBreaks);
          this.lastLoggedBreaks = stats.breakCount;
          for (const b of fresh) {
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[prefix-cache] prefix break at packet ${b.packet} (cause: ${b.cause}) — provider cache will re-warm` });
          }
        }
      }
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
        // Fast lane: gated until struggle/escalation (struggle-gated recall).
        const memPrefix = projectMemoryPrefix(this.workspace.dir);
        if (memPrefix && !this.fastLaneMemoryGated()) this.context.addMessage({ role: 'system', content: memPrefix });
        // Decision memory: past REJECTED approaches matching this task, as
        // warnings (see the twin injection site above for the rationale).
        const dmBlock = decisionMemoryPrefix(this.workspace.dir, `${task.title} ${task.description ?? ''}`);
        if (dmBlock) this.context.addMessage({ role: 'system', content: dmBlock });
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
          // Only read-only tools can spec-execute: check the NAME first so a
          // mutating call's ever-growing args buffer never reaches the parse
          // below at all.
          const canonical = TOOL_ALIASES[acc.name] || acc.name;
          if (!this.isReadOnly(canonical)) return;
          // Only fire when the args buffer is COMPLETE JSON: the trailing
          // non-space char of a finished object is '}'. Parsing every delta
          // of a 20KB payload throws (exception construction is the expensive
          // part) ~hundreds of times per call for nothing.
          const trimmed = acc.args.trimEnd();
          if (!trimmed.endsWith('}')) return;
          let specArgs: Record<string, unknown> | undefined;
          try { specArgs = JSON.parse(trimmed); } catch { return; }
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

        let activeReasoning = this.resolveReasoning(task);
        // S4: remember the run's starting (pre-discipline-offset) tier so
        // finish() can attribute the outcome to the tier actually used.
        if (this.runBaseReasoningTier === undefined) this.runBaseReasoningTier = activeReasoning;
        // Discipline (adaptive effort): the per-kind base tier is adjusted
        // by the run's evidence state — raised by hard signals (a new
        // failure class, complexity escalation), decayed by clean progress.
        // Only when the user left reasoning on auto; an explicit tier is
        // the user's choice and is never overridden.
        if (this.discipline && this.disciplineFlags.adaptiveEffort && this.disciplineEffortAuto) {
          const adjusted = this.discipline.adjustEffort(activeReasoning);
          if (adjusted !== activeReasoning && adjusted !== this.lastDisciplineEffort) {
            this.lastDisciplineEffort = adjusted;
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[discipline] effort ${activeReasoning} -> ${adjusted} (adaptive offset ${this.discipline.effortOffset})` });
          }
          activeReasoning = adjusted;
        }
        // Model-turn replay (run journal): if a previous session of this
        // run already obtained a response to EXACTLY this request (same
        // fingerprint — same messages, tools, model, params), serve the
        // recorded response instead of calling the provider again. The
        // recorded usage flows through the normal accounting below, so
        // the turn is billed exactly once across both sessions. A
        // mismatch ends replay inside the journal (claimModelTurn) and
        // this falls through to the live stream. The replayed prose is
        // delivered as a single chunk, as if freshly streamed.
        const replayedTurn = this.journalClaimModelTurn(messages, activeReasoning);
        if (replayedTurn) {
          this.journalModelReplayed++;
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[journal] replayed model turn (journal seq ${replayedTurn.seq}) — provider not called, recorded response served` });
          if (replayedTurn.response.content) {
            this.events.emit({ type: 'message:chunk', content: replayedTurn.response.content, agentId: this.id });
          }
          return replayedTurn.response;
        }
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
        const assembled: import('../types.js').ModelResponse = {
          content,
          toolCalls: tool_calls.length ? tool_calls : undefined,
          finishReason: chunks[chunks.length - 1]?.finishReason,
          usage: chunks[chunks.length - 1]?.usage,
          looped,
        };
        // Journal the completed LIVE turn (response payload + usage +
        // request fingerprint) so a resume can replay it instead of
        // re-calling/re-billing the provider. Only live responses reach
        // this line — the replay path returns above — so a replayed
        // turn is never re-recorded.
        this.journalRecordModelTurn(messages, activeReasoning, assembled, Date.now() - turnStartedAt);
        return assembled;
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
        this.cacheCalls.push({ promptTokens: u.promptTokens ?? 0, cachedTokens: u.cachedTokens });
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
        // with agent work. Cost: the provider's own billing figure wins when
        // nonzero (OpenRouter-style usage.cost); when it reports $0/nothing,
        // BudgetEngine falls back to the offline price table (pricing.ts)
        // and ledgers that portion as ESTIMATED (snapshot.costSource), never
        // as provider-reported.
        const providerCost = u.costUsd ?? 0;
        const costBefore = this.budget?.snapshot(this.config.model.model).usedCostUsd ?? 0;
        this.budget?.recordUsage(u, this.config.model.model, this.config.model.provider);
        const costAfter = this.budget?.snapshot(this.config.model.model).usedCostUsd ?? providerCost;
        // Phase 4 (VNext): feed REAL provider usage into the context engine so
        // the compaction floor triggers on actuals instead of the chars/3.8 guess.
        this.context.recordReportedUsage(u.promptTokens);
        // Surface usage to the TUI: input, output, cache reads, and cost in USD.
        // costUsd here is THIS CALL's effective cost (provider-reported, or
        // the budget's price-table estimate when the provider reported $0) —
        // the per-call delta of the budget ledger, NOT the cumulative total.
        // Every trace consumer (gate scanRunTraces, trace-cost, trajectory
        // aggregation) SUMS the per-call values to reconstruct the run total;
        // emitting the cumulative figure made them double-count any run with
        // more than one model call. Consumers that display a running total
        // (the TUI status bar) accumulate the deltas themselves. `model`
        // rides along so traces can price $0 calls offline.
        const callCostUsd = Math.max(0, costAfter - costBefore);
        this.costUsd += callCostUsd;
        this.events.emit({
          type: 'usage:updated',
          agentId: this.id,
          inputTokens: Math.max(0, (u.promptTokens ?? 0) - (u.cachedTokens ?? 0)),
          outputTokens: u.completionTokens ?? 0,
          cacheTokens: u.cachedTokens ?? 0,
          cacheMeasured: u.cachedTokens !== undefined,
          totalTokens: u.totalTokens ?? 0,
          costUsd: callCostUsd,
          model: this.config.model.model,
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

      // Discipline (progress forcing): feed this turn to the deliberation
      // detector. A turn that neither mutates nor covers new ground (no
      // calls, re-reads of already-read files, near-repeated prose) is
      // deliberation; the streak escalates commit-directive -> forced
      // decisive finish. The branches below consume disciplineForceArmed:
      // no-tool responses fall through to completion instead of eating
      // another nudge-and-continue, and read-only batches execute and then
      // finish decisively. Mutating/progress turns clear the arm.
      if (this.discipline && this.disciplineFlags.progressForcing && !this.planMode && (this.taskKind ?? 'chat') !== 'chat') {
        const counts = this.context.fileOpCounts();
        const snap: ProgressSnap = { read: counts.read, edited: counts.edited, verifyPass: this.verifyPassTotal };
        const progress = heartbeatShowsProgress(this.disciplineSnap, snap);
        this.disciplineSnap = snap;
        const calls = response.toolCalls ?? [];
        const mutating = calls.some((c) => MUTATING_TOOLS.has(TOOL_ALIASES[c.function.name] || c.function.name));
        const workTool = calls.some((c) => ['shell', 'verify', 'bg_task', 'subagent', 'spawn_subagent', 'git'].includes(TOOL_ALIASES[c.function.name] || c.function.name));
        this.disciplineTurnMutating = mutating;
        const verdict = this.discipline.noteTurn({
          hasToolCalls: calls.length > 0,
          mutating,
          workTool,
          progress,
          content: response.content ?? '',
        });
        if (verdict.action === 'commit') {
          this.context.addMessage({ role: 'system', content: this.discipline.commitDirective(verdict.streak) });
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[discipline] commit directive injected (deliberation streak ${verdict.streak})` });
        } else if (verdict.action === 'force' && !this.disciplineForceArmed) {
          this.disciplineForceArmed = true;
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[discipline] progress forcing: ${verdict.streak} deliberation turns without acting — decisive path forced` });
        }
        if (mutating || progress) this.disciplineForceArmed = false;
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
        // Fast lane: count load_tools calls — needing the deferred arsenal
        // repeatedly is escalation evidence (see FASTLANE_LIMITS).
        if (this.fastLane && !this.fastLaneEscalated) {
          for (const c of response.toolCalls) {
            if ((TOOL_ALIASES[c.function.name] || c.function.name) === 'load_tools') this.fastLaneLoadToolsCalls++;
          }
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
        // Long-task: if this batch ran the current milestone's own check
        // command verbatim, the harness re-runs it and closes the
        // milestone on a pass (checkpoint without a claim round-trip).
        try { await this.ltMaybeCloseOnShellCheck(response.toolCalls); } catch { /* milestone bookkeeping never breaks the loop */ }
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
        // Discipline (adaptive effort): a mutating batch that landed with
        // no outstanding consecutive tool errors is clean progress — it
        // decays the effort offset (cruising runs get cheaper).
        if (this.discipline && this.disciplineFlags.adaptiveEffort && this.disciplineTurnMutating && this.consecutiveToolErrorsCount === 0) {
          this.discipline.noteCleanTurn();
        }
        // Discipline (progress forcing): the force was armed and this
        // batch STILL did not mutate — the deliberation ends here, with
        // the batch's results already in context. Finish decisively with
        // the current best state instead of looping.
        if (this.disciplineForceArmed && !this.disciplineTurnMutating) {
          return this.disciplineForceFinish(task, repo, response.content);
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
          if (this.autoPlanEscapePending && !this.planMode && taskKind !== 'chat' && !this.disciplineForceArmed) {
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
          if (response.content.length > 12_000 && this.proseRunwayNudges < 1 && !this.disciplineForceArmed) {
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
          if ((expectsFiles || executionPreamble) && !this.planMode && taskKind !== 'chat' && this.fileGuardNudges < 1 && !this.disciplineForceArmed) {
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
          // P0.5: this prose finish is inside the !fileChanged branch — the
          // run changed NO files. For mutation-expecting kinds that is
          // exactly the no-change auto-pass hole (previously this return
          // completed such runs as success without verify() ever running).
          // Route them through verify(), which BLOCKs the zero-change case;
          // read-only and other kinds keep the direct prose finish.
          if (PROSE_VERIFY_KINDS.has(taskKind) && !this.planMode && this.changeExpectationGrounded(task, detectRepo(this.cwd))) {
            const verification = await this.verify(task, detectRepo(this.cwd));
            if (!verification.passed) {
              return this.finish(task, false, `Completion claimed in prose but verification failed:\n${verification.summary}`, 'verification_failed');
            }
            return this.finish(task, true, `${response.content}\n\n${verification.summary}`, 'completed');
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

      // Long-task: a completion claim is judged by the CURRENT
      // milestone's harness-run check first. Only when every milestone
      // is closed does the claim reach the task-level verify gate.
      if (this.ltTracker) {
        const lt = await this.ltMilestoneClaim(task);
        if (lt === 'continue') continue;
        if (lt !== 'proceed') return lt;
      }
      sm.enter('verify');
      const verification = await this.verify(task, repo);
      this.verifyCount++;
      // Discipline: snapshot-and-clear the files mutated since the last
      // verification attempt — the list is the "approach" fingerprint the
      // same-failure switch reasons over (same failure + same files =
      // same approach).
      const discEditedDelta = this.disciplineEditedSinceVerify;
      this.disciplineEditedSinceVerify = [];
      // Shell-driven mutations never appear in filesModified. When a
      // cycle's ONLY work was shell commands AND the workspace actually
      // moved, that is an approach — mark it (consistently, every such
      // cycle) so shell-retry loops escalate like edit loops. A cycle with
      // tracked edits needs no marker, and a cycle with no shell work at
      // all (a bare re-claim) must stay approach-less: re-claiming is
      // owned by the verify-retry budget, not by the strategy switch.
      if (discEditedDelta.length === 0 && this.disciplineShellRanSinceVerify && this.shellWorkspaceMoved) {
        discEditedDelta.push('<shell-mutation>');
      }
      this.disciplineShellRanSinceVerify = false;
      let discFail: FailureVerdict | undefined;
      if (verification.passed) {
        this.lastVerifyPassed = true;
        this.recordVerifyPass(verification.summary);
        // Discipline: a pass resets the adaptive-effort offset (fresh
        // evidence state) — struggle pricing must not leak past success.
        this.discipline?.noteVerifyPass();
        this.consecutiveVerifyFailures = 0;
        // S4: the gate passed — close the pinned verifier objection in
        // place, so no stale OPEN objection outlives its resolution (the
        // transcript keeps exactly one objection block, now CLOSED).
        if (this.openObjection) {
          this.context.upsertMarkedSystemMessage(OBJECTION_MARKER, renderObjectionClosed(this.openObjection.attempt));
          this.openObjection = null;
        }
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
        // Discipline (decisive finish): verification passed on EVIDENCE
        // (a real check command ran green) on the first attempt, the diff
        // is small, the task is not complex, and the change came through
        // tracked edits — the run is DONE. The self-review round below is
        // an anxiety loop in exactly this case (an extra model call that
        // can talk a verified pass back into more work), so it is skipped.
        // A vacuous pass (no real command, `true`, greenfield skip) or any
        // risk signal keeps the review: that is the case it exists for.
        let skipSelfReview = false;
        if (this.discipline && this.disciplineFlags.decisiveFinish && !this.planMode) {
          const evidenced = verifySummaryEvidenced(verification.summary);
          const filesN = (this.context.state.filesModified ?? []).length;
          const risky = this.verifyCount > 1
            || filesN >= 5
            || this.taskComplexity === 'complex'
            || (this.shellWorkspaceMoved && !this.fileChanged);
          if (evidenced && !risky) {
            skipSelfReview = true;
            this.events.emit({ type: 'agent:log', agentId: this.id, message: '[discipline] decisive finish: evidenced first-pass verification — self-review skipped' });
          }
        }
        if (!this.planMode && !skipSelfReview && (await this.shouldSelfReview(task))) {
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
      // Discipline (same-failure switch + replan evidence + adaptive
      // effort): register this failure BEFORE the retry machinery runs.
      // A new failure class is fresh evidence (replan allowed, effort up);
      // the same class with the same edited-file set is the same approach
      // being retried — the third such failure forces a strategy switch,
      // and one more identical retry after that is refused outright.
      if (this.discipline) {
        discFail = this.discipline.noteVerifyFailure(verification.summary, discEditedDelta);
        if (discFail.isNewClass && this.disciplineFlags.adaptiveEffort) {
          this.discipline.noteHardSignal();
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[discipline] hard signal: new failure class "${discFail.failureClass.slice(0, 80)}" (effort offset ${this.discipline.effortOffset})` });
        }
        if (discFail.action === 'refuse' && this.disciplineFlags.sameFailureSwitch) {
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[discipline] identical retry refused (failure class "${discFail.failureClass.slice(0, 80)}", ${discFail.classCount} failures, same approach)` });
          if (this.autopsy) {
            this.autopsy = finalizeAutopsy(this.workspace.dir, this.autopsy, { outcome: 'unresolved' });
          }
          this.recordFailure(task, verification.summary);
          return this.finish(task, false,
            `Verification kept failing with the same failure (${discFail.classCount} times) and the recent attempts kept editing the same files (${[...new Set(discEditedDelta.map((f) => f.split('/').pop() ?? f))].join(', ') || 'none'}) even after a forced strategy switch. Refusing another identical retry.\n${verification.summary}`,
            'verification_failed');
        }
      }
      this.addAttempt(task, 'verify', [`${repo.testCommand || repo.buildCommand || 'verify'}`], 'failure', verification.summary);
      // S4 verifier-objection threading: pin the STRUCTURED objection as
      // the one live retry context — failing checks, salient evidence,
      // what closes it — refreshed in place on every rejection (never a
      // growing stack of stale objections). state.knownErrors gets a
      // one-line digest instead of the full summary: the state block is
      // re-rendered into EVERY later prompt, so appending the whole
      // summary per failure was a per-turn tax that grew with each retry
      // while burying the current objection among dead ones. The full
      // summary still reaches recordFailure/observeFailure unchanged.
      // Kill-switch: MOCHI_OBJECTION_THREADING=0 restores the legacy
      // full-summary knownErrors entry (and no pinned block).
      if (process.env.MOCHI_OBJECTION_THREADING !== '0') {
        const objection = buildObjection({
          status: verification.status,
          summary: verification.summary,
          attempt: this.consecutiveVerifyFailures + 1,
        });
        this.openObjection = objection;
        this.context.upsertMarkedSystemMessage(OBJECTION_MARKER, renderObjection(objection));
        this.context.addKnownError(objectionDigestLine(objection));
      } else {
        this.context.addKnownError(verification.summary);
      }
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
      // Cost-per-solve routing gets first claim on the escalation: when the
      // measured ladder has a demonstrably stronger model for this kind, it
      // outranks the static profile ladder (which was configured by guess).
      // A routing escalation consumes the streak exactly like a tier one —
      // the stronger model starts with a clean failure count.
      let routingEscalated = false;
      if (this.consecutiveVerifyFailures >= ESCALATE_AFTER_FAILURES) {
        routingEscalated = this.tryRoutingEscalation('verify_failures');
        if (routingEscalated) this.consecutiveVerifyFailures = 0;
      }
      const baseTier: TaskTier =
        this.profile.defaultModel === 'fast' ? 'fast'
        : this.profile.defaultModel === 'reasoning' ? 'reasoning'
        : 'standard';
      const escalation = routingEscalated ? null : nextEscalationTier(
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
      // Discipline (same-failure switch): the third failure of this class
      // with the same approach indicts the approach itself. The directive
      // lands after the diagnosis/escalation messages so it is the last
      // word the model reads before its next turn.
      if (discFail?.action === 'switch' && this.discipline && this.disciplineFlags.sameFailureSwitch) {
        this.context.addMessage({ role: 'system', content: this.discipline.strategySwitchMessage(discFail, discEditedDelta) });
        this.events.emit({ type: 'agent:log', agentId: this.id, message: `[discipline] strategy switch forced (failure class "${discFail.failureClass.slice(0, 80)}", ${discFail.classCount} failures, same approach)` });
        // The same failure with the same approach, three times, is also
        // routing evidence: the current model has demonstrated it cannot
        // crack this class. Offer the measured ladder a say (the guard in
        // tryRoutingEscalation stops one failure buying two rungs when the
        // verify-streak path already escalated on this same verify).
        this.tryRoutingEscalation('same_failure');
      }
    }

    this.addAttempt(task, 'exhausted', [], 'failure', `Reached maximum iterations (${this.iterationCap})`);
    return this.finish(task, false, `Reached maximum iterations (${this.iterationCap})`, 'max_iterations');
  }

  // ── Long-task milestone strategy (src/agent/milestones.ts) ──────────
  //
  // The loop owns the side effects; MilestoneTracker owns the decisions.
  // Wiring points: initLongtask (run start, after the journal opens),
  // ltPace (every iteration, after the budget sample), ltMilestoneClaim
  // (a completion claim is judged by the CURRENT milestone's check before
  // the task-level verify gate), ltMaybeCloseOnShellCheck (a tool batch
  // that ran the milestone's own check command verbatim).

  /** Event sink for the tracker: persist the plan state, journal the
   *  event (toolName 'milestone' — never a real tool, so the journal's
   *  replay-claim path never mistakes these for tool steps), and log it. */
  private ltOnEvent(e: MilestoneEvent): void {
    const t = this.ltTracker;
    if (!t) return;
    try { saveMilestoneState(this.workspace, t.state); } catch { /* best-effort */ }
    let message = '';
    let output = '';
    let milestoneId = '';
    switch (e.type) {
      case 'plan':
        message = `[longtask] milestone plan adopted: ${e.state.milestones.length} milestones (${e.state.milestones.map((m) => m.title).join(' → ')})`;
        output = t.planOverview();
        break;
      case 'passed':
        milestoneId = e.milestone.id;
        message = `[longtask] milestone PASSED: "${e.milestone.title}" (check attempt ${e.milestone.attempts}) — checkpoint journaled`;
        output = e.milestone.lastCheckOutput ?? '';
        break;
      case 'check-failed':
        milestoneId = e.milestone.id;
        message = `[longtask] milestone check FAILED: "${e.milestone.title}" (attempt ${e.milestone.attempts})`;
        output = e.output;
        break;
      case 'tightened':
        milestoneId = e.milestoneId;
        message = `[longtask] budget pacing TIGHTENED (${e.reason}); dropped: ${e.droppedIds.join(', ') || 'none'}`;
        output = e.reason;
        break;
      case 'dropped':
        milestoneId = e.milestone.id;
        message = `[longtask] optional milestone DROPPED under pacing: "${e.milestone.title}"`;
        output = e.reason;
        break;
      case 'replanned':
        message = `[longtask] plan REVISED — trigger: ${e.record.trigger} (replaced: ${e.record.replacedIds.join(', ') || 'none'}; added: ${e.record.addedIds.join(', ') || 'none'})`;
        output = e.record.trigger;
        break;
      case 'escalated':
        message = `[longtask] budget pacing ESCALATED: ${e.reason}`;
        output = e.reason;
        break;
    }
    try {
      this.journal?.recordStep({
        stepId: `milestone:${e.type}:${milestoneId}:${t.state.updatedAt}`,
        toolName: 'milestone',
        args: { event: e.type, ...(milestoneId ? { milestone: milestoneId } : {}) },
        output: output.slice(0, 2000),
      });
    } catch { /* journaling must never break the run */ }
    if (message) this.events.emit({ type: 'agent:log', agentId: this.id, message });
  }

  /** Write the workspace checkpoint at a milestone boundary (or an
   *  escalation), formatted for the existing resume injection, whose
   *  contract is "Continue from 'Next:'". */
  private ltWriteCheckpoint(note: string): void {
    const t = this.ltTracker;
    if (!t) return;
    try {
      const goal = this.context.state.goal || this.activeTask?.title || t.state.title;
      this.workspace.saveCheckpoint(goal, t.checkpointText(note));
    } catch { /* best-effort */ }
  }

  private async ltProviderPlan(
    task: Task,
    opts?: { remainingTitles?: string[]; evidence?: string[] },
  ): Promise<MilestoneInput[] | null> {
    return planMilestonesWithChat(task, async (messages) => {
      const provider = createProvider(this.config.model, 'reasoning');
      const res = await provider.chat(messages as import('../types.js').ChatMessage[], [], { temperature: 0.2 });
      return { content: res.content };
    }, opts);
  }

  /** Activate the milestone layer for this run: restore a persisted plan
   *  (resume at the first open boundary) or decompose fresh (host plan →
   *  host planner → provider decomposition). Any dead end leaves
   *  ltTracker unset and the run proceeds exactly as before. */
  private async initLongtask(task: Task, taskKind: string): Promise<void> {
    this.ltTracker = undefined;
    const flags = resolveLongtaskFlags(this.config.longtask);
    if (!flags.enabled || this.planMode) return;
    if (!['implement', 'fix', 'refactor', 'test'].includes(taskKind)) return;
    const hostActivated = this.ltPlanInputs !== undefined || this.ltPlannerFn !== undefined;
    if (!hostActivated && this.taskComplexity !== 'complex') return;
    this.ltPacing = flags.pacing;
    const budget = {
      tokens: Number.isFinite(this.config.safety.maxTokens) ? (this.config.safety.maxTokens as number) : 0,
      turns: this.config.safety.maxIterations,
    };
    const saved = loadMilestoneState(this.workspace, task.id);
    if (saved) {
      if (!saved.milestones.some((m) => m.status !== 'passed' && m.status !== 'dropped')) {
        return; // a prior session closed the whole plan: nothing to strategize
      }
      const tracker = new MilestoneTracker(saved, (e) => this.ltOnEvent(e));
      this.ltTracker = tracker;
      this.ltLastTokensOut = this.tokensOut;
      this.ltLastIteration = 0;
      const cur = tracker.activate();
      if (cur) {
        const pos = tracker.position();
        this.events.emit({
          type: 'agent:log', agentId: this.id,
          message: `[longtask] resuming milestone plan at ${pos.index}/${pos.total} — ${tracker.passedCount()} milestone(s) already passed, checkpointed and journaled`,
        });
        this.context.addMessage({ role: 'system', content: tracker.brief(true) });
      }
      return;
    }
    let inputs: MilestoneInput[] | null = this.ltPlanInputs ?? null;
    if (!inputs && this.ltPlannerFn) {
      inputs = await this.ltPlannerFn({ task, remaining: [], evidence: [], replan: false }).catch(() => null);
    }
    if (!inputs) inputs = await this.ltProviderPlan(task);
    if (!inputs || inputs.length === 0) return;
    let plan;
    try {
      plan = buildMilestonePlan(task.id, task.title, inputs, budget);
    } catch { return; }
    const tracker = new MilestoneTracker(plan, (e) => this.ltOnEvent(e));
    this.ltTracker = tracker;
    this.ltLastTokensOut = this.tokensOut;
    this.ltLastIteration = 0;
    tracker.activate();
    this.ltOnEvent({ type: 'plan', state: plan });
    this.context.addMessage({ role: 'system', content: `${tracker.planOverview()}\n\n${tracker.brief()}` });
  }

  /** Per-iteration pacing: attribute this iteration's spend to the
   *  current milestone, then let the tracker judge burn vs progress.
   *  Returns a finished result only when pacing escalates. */
  private async ltPace(task: Task, i: number): Promise<AgentResult | null> {
    const t = this.ltTracker;
    if (!t) return null;
    const dTokens = Math.max(0, this.tokensOut - this.ltLastTokensOut);
    this.ltLastTokensOut = this.tokensOut;
    const dTurns = Math.max(0, i - this.ltLastIteration);
    this.ltLastIteration = i;
    if (dTokens > 0 || dTurns > 0) {
      t.noteSpend(dTokens, dTurns);
      try { saveMilestoneState(this.workspace, t.state); } catch { /* best-effort */ }
    }
    if (!this.ltPacing) return null;
    const a = t.assessPacing();
    if (a.action === 'none') return null;
    if (a.action === 'tighten') {
      const dropped = t.applyTightening(a.reason);
      if (t.current()) this.context.addMessage({ role: 'system', content: t.tightenMessage(a.reason, dropped) });
      return null;
    }
    if (a.action === 'replan') {
      const done = await this.ltTryReplan(task, `pacing: ${a.reason}`);
      if (!done) {
        const dropped = t.applyTightening(`${a.reason} (re-plan unavailable — tightening instead)`);
        if (t.current()) this.context.addMessage({ role: 'system', content: t.tightenMessage(a.reason, dropped) });
      }
      return null;
    }
    // escalate: stop loudly, checkpointed, with the precise state.
    t.markEscalated(a.reason);
    this.ltWriteCheckpoint(`escalated by budget pacing: ${a.reason}`);
    const summary = t.stateSummary(
      `LONG-TASK ESCALATION — budget pacing stopped this run before it could die silently mid-milestone. ${a.reason}. ` +
      'Work is checkpointed at the last passed milestone boundary; resume with "mochi resume" (with a larger budget or trimmed scope) to continue from there.',
    );
    return this.finish(task, false, summary, 'budget');
  }

  /** Evidence-gated re-plan of the remaining milestones. The tracker's
   *  gate consumes the pending evidence, so when both pacing and a check
   *  failure want a re-plan, whoever asks first with fresh evidence
   *  wins; the other finds the gate closed and tightens instead. */
  private async ltTryReplan(task: Task, source: string): Promise<boolean> {
    const t = this.ltTracker;
    if (!t) return false;
    const gate = t.gateReplan(source);
    if (!gate.allowed) return false;
    const current = t.current();
    const remaining = t.state.milestones.filter((m) => m.status === 'pending' || m.status === 'active');
    let inputs: MilestoneInput[] | null = null;
    if (this.ltPlannerFn) {
      inputs = await this.ltPlannerFn({ task, current: current ?? undefined, remaining, evidence: [gate.reason], replan: true }).catch(() => null);
    }
    if (!inputs) {
      const passedTitles = t.state.milestones.filter((m) => m.status === 'passed').map((m) => m.title);
      const evidence = [gate.reason];
      if (current?.lastCheckOutput) {
        evidence.push(`last check output for "${current.title}": ${current.lastCheckOutput.slice(0, 400)}`);
      }
      inputs = await this.ltProviderPlan(task, { remainingTitles: passedTitles, evidence });
    }
    if (!inputs || inputs.length === 0) return false;
    try {
      t.applyReplan(inputs, `${source}; ${gate.reason}`);
    } catch { return false; }
    t.activate();
    this.context.addMessage({
      role: 'system',
      content: `PLAN REVISED — the remaining milestones were re-decomposed from new evidence (${gate.reason}). The revised plan:\n${t.planOverview()}\n\n${t.brief()}`,
    });
    return true;
  }

  /** A completion claim under an active plan is judged by the CURRENT
   *  milestone's check — executed harness-side — before the task-level
   *  verify gate sees it. 'proceed' = all milestones closed, fall through
   *  to the normal gate (the run's final judge); 'continue' = keep
   *  working; an AgentResult = pacing escalated and finished the run. */
  private async ltMilestoneClaim(task: Task): Promise<'proceed' | 'continue' | AgentResult> {
    const t = this.ltTracker;
    if (!t) return 'proceed';
    const m = t.current();
    if (!m) return 'proceed';
    const result = await runMilestoneCheck(m.check, this.cwd, (cmd, secs) => this.runShell(cmd, secs));
    const closed = t.recordCheck(result.passed, result.output);
    // The claim was ADJUDICATED by a harness-run check: the state it
    // referred to has changed (milestone closed, check failed with a
    // directive injected, or the plan revised). A model that repeats the
    // same claim sentence about the NEW state is not stagnating — reset
    // the same-answer guard, whose streak would otherwise eat the next
    // claim unseen and finish the run as tool_loop before the milestone
    // layer's own bounded responses (re-plan gate, pacing escalation)
    // can engage. Runs without an active plan never touch this.
    this.lastCompletionAnswer = '';
    this.sameAnswerStreak = 0;
    if (result.passed && closed) {
      this.ltWriteCheckpoint(`milestone passed: ${closed.title}`);
      if (t.allPassed()) return 'proceed';
      t.activate();
      this.context.addMessage({
        role: 'system',
        content: `MILESTONE PASSED — "${closed.title}" is closed and checkpointed.\n\n${t.brief()}`,
      });
      return 'continue';
    }
    // A repeated failure of the same milestone indicts the milestone
    // SPEC (a wrong assumption baked into its check), not just the work:
    // attempt an evidence-gated re-plan of what remains before asking
    // the model to push on against a check that may never pass.
    if (m.attempts >= 2) {
      const replanned = await this.ltTryReplan(task, `milestone check failed ${m.attempts}x: ${m.id}`);
      if (replanned) return 'continue';
      if (this.ltPacing) {
        const a = t.assessPacing();
        if (a.action === 'escalate') {
          t.markEscalated(a.reason);
          this.ltWriteCheckpoint(`escalated: ${a.reason}`);
          const summary = t.stateSummary(
            `LONG-TASK ESCALATION — ${a.reason}. Work is checkpointed at the last passed milestone boundary; resume with "mochi resume" to continue.`,
          );
          return this.finish(task, false, summary, 'budget');
        }
      }
    }
    this.context.addMessage({ role: 'system', content: t.checkFailedMessage(m, result.output) });
    return 'continue';
  }

  /** When a tool batch ran the current milestone's own check command
   *  verbatim, re-run the check harness-side and close the milestone on
   *  a pass — a checkpoint the model just demonstrated should not cost
   *  a separate claim round-trip. (The harness re-runs it: milestone
   *  evidence is never the model's own report of its command.) */
  private async ltMaybeCloseOnShellCheck(
    toolCalls: Array<{ function: { name: string; arguments: string } }>,
  ): Promise<void> {
    const t = this.ltTracker;
    if (!t) return;
    const m = t.current();
    if (!m || m.check.kind !== 'command') return;
    const want = m.check.command.trim();
    const ranCheck = toolCalls.some((c) => {
      const name = TOOL_ALIASES[c.function.name] || c.function.name;
      if (name !== 'shell') return false;
      try {
        const args = JSON.parse(c.function.arguments) as { command?: string };
        return typeof args.command === 'string' && args.command.trim() === want;
      } catch { return false; }
    });
    if (!ranCheck) return;
    const result = await runMilestoneCheck(m.check, this.cwd, (cmd, secs) => this.runShell(cmd, secs));
    const closed = t.recordCheck(result.passed, result.output);
    if (result.passed && closed) {
      this.ltWriteCheckpoint(`milestone passed: ${closed.title}`);
      if (!t.allPassed()) {
        t.activate();
        this.context.addMessage({
          role: 'system',
          content: `MILESTONE PASSED — "${closed.title}" is closed and checkpointed (its check ran green).\n\n${t.brief()}`,
        });
      }
    }
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
    // Unified estimator (context.ts estimateMessagesTokens): the digest
    // trigger must count the conversation exactly the way buildPacket does
    // (approxTokens over the JSON message form, cached per message). The
    // previous content-only estimate disagreed with the packet accounting
    // by the JSON structure overhead and fired the digest late.
    const est = () => estimateMessagesTokens(msgs);
    if (est() <= floorTokens) return;
    // Digest window: all but the last RECENT_KEEP messages (current working set).
    // Complex tasks keep a much deeper working set (20 vs 8): the digest throws
    // the source of the old messages away, so a hard refactor must retain the
    // files/commands it is actively reasoning over instead of a 300-word stub.
    const RECENT_KEEP = this.taskComplexity === 'complex' ? 20 : 8;
    const oldCount = msgs.length - RECENT_KEEP;
    if (oldCount < 4) return;
    const old = msgs.slice(0, oldCount);
    // Salience-ranked input at the SAME total budget: the legacy
    // head-slice (400 chars/message + head cut) dropped paths, errors and
    // decisions that sat past the slice; buildDigestInput keeps a floor
    // render per message and spends the rest on salient lines.
    const transcript = buildDigestInput(old, this.taskComplexity === 'complex' ? 24_000 : 12_000);
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
      // C7 lineage: the digest is a summary — stamp it with the parent
      // pointers to the messages it replaces so a later compaction of this
      // digest can chain back to the raw history.
      msgs.splice(0, oldCount, { role: 'user' as const, content: `[digest of ${oldCount} earlier messages]\n${digest}\n${renderSummaryLineage(buildSummaryLineage(old))}` } as ChatMessage);
      const after = est();
      this.events.emit({ type: 'agent:log', agentId: this.id, message: `[context] MCH-32 digest: ${oldCount} old messages -> ${digest.length} chars (~${Math.max(0, before - after)} tokens saved)` });
      // S4: a digest rewrites history exactly like a compaction does —
      // the same stub/objection invalidation applies.
      this.clearReadStub();
      this.onHistoryRewritten();
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

  /** G11: compact-on-idle trigger. Returns true when an idle compaction
   *  ran. Called once at run() start (a run boundary — never mid-turn);
   *  run() passes the PREVIOUS run's active state (it opens the
   *  steer-acceptance window before its first await — see run()):
   *  the session's in-process activity clock (ContextEngine, fed by
   *  every addMessage) is compared against the engine's idle config
   *  (host opt-in, or a parent-set per-child window). The compaction
   *  names itself 'idle-compaction' in P5 break attribution. A no-op
   *  when disabled (the default), when a turn is in flight, when the
   *  clock is unknown, when not yet idle, or when this idle period
   *  already compacted — see shouldIdleCompact. */
  private async maybeIdleCompact(now = Date.now(), active = this.runActive): Promise<boolean> {
    const cfg = this.context.getIdleCompactionConfig();
    const verdict = shouldIdleCompact({
      enabled: cfg.enabled,
      thresholdMs: cfg.thresholdMs ?? DEFAULT_IDLE_COMPACTION_THRESHOLD_MS,
      lastActivityAt: this.context.getLastActivityAt(),
      now,
      active,
      lastIdleCompactionAt: this.context.getLastIdleCompactionAt(),
    });
    if (!verdict.eligible) return false;
    await this.checkpointAndCompact('idle');
    this.context.markIdleCompaction(now);
    return true;
  }

  private async checkpointAndCompact(reason: 'periodic' | 'floor' | 'error' | 'idle', keepFloor?: number): Promise<void> {
    const dropped = await this.context.previewCompact(keepFloor);
    if (!dropped || dropped.length === 0) {
      this.context.compact(undefined, keepFloor).catch(() => {});
      this.clearReadStub();
      return;
    }
    // Render the to-be-dropped slice for the checkpoint summarizer with the
    // salience-ranked digest builder (same 12K budget as the legacy
    // per-message head-slice renderer it replaces): floor render per
    // message, salient lines (paths/errors/decisions) kept from deep inside
    // long tool outputs instead of only the first 150 chars.
    let checkpoint: string | undefined;
    const skipModelCheckpoint = Boolean(
      (process.env.VITEST && !process.env.TEST_COMPACTION_MODEL) ||
      this.config.safety.contextBudgetTokens < 10000
    );
    if (!skipModelCheckpoint) {
      // Goose summarize.rs lesson: a summarizer failure should retry with a
      // SMALLER input (its REMOVAL_PERCENTAGES ladder) before giving up on
      // semantic continuity — an oversized 12K slice is a different failure
      // than a broken model. Ladder: 12K -> 6K -> 2.5K chars.
      for (const budget of [12_000, 6_000, 2_500]) {
      try {
        const input = buildDigestInput(dropped, budget);
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
        if (text.length > 40 && /(goal|progress)/i.test(text)) { checkpoint = text; break; }
      } catch { /* next ladder rung (smaller input); heuristic after last */ }
      }
    }
    if (!checkpoint) {
      try {
        // C7 lineage: the heuristic checkpoint summarizes the same dropped
        // slice compact() is about to cut, so it carries that slice's
        // lineage (same deterministic id compact() will stamp).
        const compactCtx = compactSession(this.events.snapshot(), { goal: this.context.state.goal, lineage: buildSummaryLineage(dropped) });
        if (!compactCtx.isEmpty) {
          checkpoint = compactToPrompt(compactCtx);
        }
      } catch {
        /* heuristic fallback inside compact() */
      }
    }
    // B15: pass the caller's explicit floor through — previewCompact() must
    // agree with the compact() cut, or the checkpoint would summarize a
    // slice that compact() then keeps. G11: an idle compaction names its
    // reason so P5 break attribution can tell it apart.
    await this.context.compact(checkpoint, keepFloor, reason === 'idle' ? { reason: 'idle-compaction' } : undefined);
    this.clearReadStub();
    this.onHistoryRewritten();
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

  /** Models this install can actually run for the current provider: the
   *  primary, every configured profile, and failover entries on the SAME
   *  provider (a model swap keeps provider/key/baseUrl — see setActiveModel —
   *  so another provider's models are not reachable candidates). */
  private routingCandidates(): string[] {
    const out = new Set<string>();
    const add = (m: string | undefined): void => { if (m && m.trim()) out.add(m); };
    add(this.config.model.model);
    for (const v of Object.values(this.config.model.profiles ?? {})) add(v);
    for (const fb of this.config.model.failover ?? []) {
      if ((fb.provider || '').toLowerCase() === (this.config.model.provider || '').toLowerCase()) add(fb.model);
    }
    return [...out];
  }

  /** The candidate pool routing decisions draw from: the run-start snapshot
   *  once taken, the live configuration before that. */
  private routingPool(): string[] {
    return this.routingCandidatesSnapshot.length > 0 ? this.routingCandidatesSnapshot : this.routingCandidates();
  }

  /** The stored routing table, loaded at most once per run. Undefined until
   *  first consulted; null when no table exists (cold start). A table that
   *  was derived against a different minSamples than the config asks for is
   *  still honored — its cells carry their own sufficiency flags — because
   *  re-deriving is the stats pass's job, not the loop's. */
  private routingTable(): RoutingTable | null {
    if (this.routingTableCache === undefined) {
      try {
        this.routingTableCache = loadRoutingTable(this.workspace.dir);
      } catch {
        this.routingTableCache = null;
      }
    }
    return this.routingTableCache;
  }

  /** Start-of-run routing decision (see the run() call site). Emits exactly
   *  one routing:decision event when routing is enabled AND there is a
   *  decision to record (a stored table, or a user pin to defer to); a cold
   *  start with neither is silent — the legacy default rules, unremarked. */
  private applyRoutingStart(kind: string): void {
    const settings = resolveRoutingSettings(this.config.routing);
    if (!settings.enabled) return;
    const current = this.config.model.model;
    if (this.config.model.modelPinned) {
      this.routingAttemptedModels.add(current);
      this.events.emit({ type: 'routing:decision', agentId: this.id, taskKind: kind, model: current, source: 'pinned' });
      return;
    }
    const table = this.routingTable();
    if (!table) return;
    const choice = chooseStartModel(table, kind, this.routingPool(), this.config.safety.pricing?.overrides);
    if (!choice) {
      this.routingAttemptedModels.add(current);
      this.events.emit({ type: 'routing:decision', agentId: this.id, taskKind: kind, model: current, source: 'insufficient-data' });
      return;
    }
    if (choice.model === current) {
      this.routingAttemptedModels.add(current);
      this.events.emit({
        type: 'routing:decision', agentId: this.id, taskKind: kind, model: current, source: 'already-optimal',
        costPerSolveUsd: choice.cell.costPerSolveUsd ?? undefined, solveRate: choice.cell.solveRate, samples: choice.cell.runs,
      });
      return;
    }
    this.setActiveModel(choice.model);
    this.routingAttemptedModels.add(choice.model);
    // The context-window clamp in run() was computed against the pre-routing
    // model; re-clamp so a smaller-window routed model compacts earlier
    // instead of dying on the provider's hard limit.
    const reclamped = Math.min(
      this.effectiveBudgetTokens ?? Number.POSITIVE_INFINITY,
      modelContextBudget(choice.model, this.config.model.provider),
      learnedWindowBudget(choice.model, this.config.model.provider) ?? Number.POSITIVE_INFINITY,
    );
    if (Number.isFinite(reclamped) && reclamped !== this.effectiveBudgetTokens) {
      this.effectiveBudgetTokens = reclamped;
      this.context.setBudgetTokens(reclamped);
    }
    this.events.emit({
      type: 'routing:decision', agentId: this.id, taskKind: kind, model: choice.model, source: 'routed',
      fromModel: current, costPerSolveUsd: choice.cell.costPerSolveUsd ?? undefined,
      solveRate: choice.cell.solveRate, samples: choice.cell.runs,
    });
    this.events.emit({
      type: 'agent:log', agentId: this.id,
      message: `[routing] start model ${choice.model} for kind "${kind}" — measured cost-per-solve $${(choice.cell.costPerSolveUsd ?? 0).toFixed(4)} over ${choice.cell.runs} runs (solve rate ${(choice.cell.solveRate * 100).toFixed(0)}%), replacing default ${current}`,
    });
  }

  /** Attempt one escalation up the MEASURED ladder, bought by `trigger`
   *  evidence. Returns true when the run's model actually changed. Every
   *  refusal is silent except the budget block, which is an event + a note
   *  to the model: the trajectory must never imply the stronger model was
   *  tried when the budget forbade it. De-escalation does not exist here —
   *  see tryRoutingEscalation's contract in RESULT.md (a run only ever
   *  moves UP the ladder; a weaker later model would inherit a transcript
   *  written by a stronger one and strand the failure evidence). */
  private tryRoutingEscalation(trigger: RoutingTrigger): boolean {
    const settings = resolveRoutingSettings(this.config.routing);
    if (!settings.enabled) return false;
    if (this.config.model.modelPinned) return false;
    if (this.routingEscalationsThisRun >= MAX_ROUTING_ESCALATIONS_PER_RUN) return false;
    if (trigger !== 'complexity_escalation' && this.routingLastEscalationVerifyCount === this.verifyCount) return false;
    const kind = this.taskKind ?? 'unknown';
    const table = this.routingTable();
    if (!table) return false;
    const current = this.config.model.model;
    const choice = chooseEscalationTarget(
      table, kind, current, this.routingPool(), this.routingAttemptedModels,
      this.config.safety.pricing?.overrides,
    );
    if (!choice) return false;
    const block = escalationBudgetBlock(this.budget);
    if (block) {
      this.events.emit({
        type: 'routing:escalation-blocked', agentId: this.id, taskKind: kind,
        fromModel: current, toModel: choice.model, trigger, reason: block,
      });
      this.events.emit({
        type: 'agent:log', agentId: this.id,
        message: `[routing] escalation to ${choice.model} (${trigger}) blocked: ${block} — continuing on ${current}`,
      });
      this.context.addMessage({
        role: 'system',
        content: `A stronger model (${choice.model}) was warranted by repeated failures, but the run's budget forbids switching (${block}). Continue on the current model and finish as far as the budget allows.`,
      });
      return false;
    }
    this.setActiveModel(choice.model);
    this.routingAttemptedModels.add(choice.model);
    this.routingEscalationsThisRun++;
    this.routingLastEscalationVerifyCount = this.verifyCount;
    this.syncStallBudget();
    this.events.emit({
      type: 'routing:escalated', agentId: this.id, taskKind: kind,
      fromModel: current, toModel: choice.model, trigger,
      costPerSolveUsd: choice.cell.costPerSolveUsd ?? undefined, solveRate: choice.cell.solveRate,
    });
    this.events.emit({
      type: 'agent:log', agentId: this.id,
      message: `[routing] escalated ${current} -> ${choice.model} on ${trigger} — measured solve rate ${(choice.cell.solveRate * 100).toFixed(0)}% over ${choice.cell.runs} ${kind} runs (cost-per-solve $${(choice.cell.costPerSolveUsd ?? 0).toFixed(4)})`,
    });
    this.context.addMessage({
      role: 'system',
      content: `A stronger model (${choice.model}) is taking over after ${trigger === 'verify_failures' ? 'repeated verification failures' : trigger === 'same_failure' ? 'the same failure recurring' : 'the task proving harder than classified'}. Re-read the failing checks with fresh eyes, change strategy — do NOT repeat the last approach verbatim.`,
    });
    return true;
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

  /** S4: the canonical cache key name for a call, or null when the call is
   *  not result-cacheable (not read-only, or an excluded stateful /
   *  measurement / remote tool). Consulted identically at lookup and at
   *  store time so the two can never disagree about a call's identity. */
  private resultCacheName(name: string, args: Record<string, unknown>): string | null {
    const canonical = TOOL_ALIASES[name] || name;
    if (RESULT_CACHE_EXCLUDE.has(canonical)) return null;
    return this.isReadOnly(canonical, args) ? canonical : null;
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
    // Discipline: remember shell activity in the current verify window
    // (the same-failure switch uses it as an approach marker — see the
    // verify branch's discEditedDelta computation).
    if (canonical === 'shell') this.disciplineShellRanSinceVerify = true;
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
    // S4: the same completions invalidate the run result cache — any
    // non-read-only call may have changed what a cached read-only result
    // would return, so no stored result survives it (epoch bump).
    if (!this.isReadOnly(canonical, args)) this.resultCache.noteMutation();
    if (['write', 'edit', 'delete', 'patch'].includes(canonical)) {
      if (toolResult?.error) {
        this.failedMutation = true;
        const failedPath = String(args.path ?? '');
        if (canonical === 'write' && failedPath) this.failedMutationWrites.push(resolve(this.cwd, failedPath));
        return;
      }
      this.fileChanged = true;
      this.consecutiveToolErrorsCount = 0;
      // Dataset #4 (SWE-agent action_sampler): a landed EDIT is itself the
      // high-stakes signal — errors past this point cost rework. One effort
      // rung up (capped, decays on clean turns), exactly once per run.
      if (!this.mutationHardSignaled && this.discipline) {
        this.mutationHardSignaled = true;
        this.discipline.noteHardSignal();
      }
      this.cycleNudges = 0;
      this.nudgeInjections = 0;
      // Real progress invalidates read-veto memory: re-reading a file the
      // model just changed is legitimate, but readTargetCounts never reset
      // (n >= 4 vetoed forever), turning every later re-read into a blocked
      // no-op and strangling multi-step workflows.
      this.readTargetCounts.clear();
      const path = String(args.path ?? '');
      if (path) this.context.addModifiedFile(resolve(this.cwd, path));
      // Discipline: record the mutation in the current verify window (the
      // same-failure switch's approach fingerprint — see the verify
      // branch). Recorded whether or not the tracker exists; the list is
      // bounded by the verify cadence and snapshot-cleared each attempt.
      if (path) this.disciplineEditedSinceVerify.push(resolve(this.cwd, path));
      // Discipline (drift snap-back): an edit that touches nothing the
      // pinned contract names is drift evidence. DRIFT_AT consecutive
      // unrelated edits earn ONE concise snap-back restating the contract
      // (bounded per run; a message, never a veto — the scope fence above
      // remains the only hard boundary).
      if (path && this.discipline && this.disciplineFlags.driftSnapback) {
        const rel = relative(this.cwd, resolve(this.cwd, path));
        const dv = this.discipline.noteEdit(rel);
        if (dv.snapback) {
          this.context.addMessage({ role: 'system', content: this.discipline.snapbackMessage() });
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[discipline] drift snap-back (edits strayed from the task contract)` });
        }
      }
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
      // MCH-210: predictive edit-impact. A successful edit is the strongest
      // known signal of what happens next: the model will verify (test/
      // typecheck) and read the co-changed files. Fire the co-change prefetch
      // NOW with the edited path as the seed instead of waiting for the next
      // turn boundary, so the verification reads are already cache-warm.
      if (path) {
        void this.prefetchForNextTurn(path);
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
    // 64-bit-equivalent FNV-1a as two 32-bit Number lanes. (Was BigInt per
    // char: a BigInt XOR+multiply per character over the full folded output
    // is ~50-100x slower than Number math — ~5-15ms per 48KB tool result on
    // the hot path of every successful call, purely to seed a 50-entry
    // redundancy heuristic. Two independent 32-bit lanes give an equivalent
    // collision profile here; lane 2 folds a rotated code unit so
    // adjacent-character reordering still distinguishes.)
    let h1 = 0x811c9dc5;
    let h2 = 0x1b873593;
    for (let i = 0; i < output.length; i++) {
      const ch = output.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
      const r = ((ch << 9) | (ch >>> 7)) & 0xffff;
      h2 = Math.imul(h2 ^ r, 0x85ebca6b) >>> 0;
    }
    const key = h1.toString(16) + h2.toString(16).padStart(8, '0');
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
      // read-only shell commands (ls, cat, grep, head, tail, wc, jq,
      // tree, file, stat, ps, env, which, type, du, df, ripgrep) can run in
      // parallel — they don't change state and don't interfere with each other.
      // Stateful commands (anything with `&&`, `||`, `|`, `>`, `>>`, `<`,
      // backticks, `$()`, `;`, `cd`, or shell metacharacters) still go one at
      // a time to preserve causal order.
      if (headName === 'shell') {
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
            if (isPureReadOnlyShellCommand(cmd)) group.push(tc);
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
  private async prefetchForNextTurn(seedPath?: string): Promise<void> {
    try {
      // MCH-209: next-tool prediction from this run's live sequence. When the
      // mined bigrams say the next tool is likely a reader, the co-change
      // warming below is not a guess — it is the statistically likely target
      // of the model's next action. A confidence log keeps it observable.
      try {
        const { loadToolSeqs, predictNextTools } = await import('../core/tool-sequence.js');
        const predicted = predictNextTools(loadToolSeqs(this.workspace.dir), this.toolSeq, 1);
        if (predicted.length > 0 && ['read', 'search', 'glob', 'outline'].includes(predicted[0]!.tool)) {
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `predict: after ${this.toolSeq[this.toolSeq.length - 1]} → ${predicted[0]!.tool} (${predicted[0]!.count} past occurrences); warming reads` });
        }
      } catch { /* prediction is strictly optional */ }
      const touched = this.context.getMessages()
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .slice(-20)
        .flatMap((m) => (contentText(m).match(/[\w./-]+\.(?:ts|js|py|go|rs)/g) ?? []));
      // MCH-210: an edit-seeded call puts the edited file FIRST in the seed
      // list — co-change mining from the just-edited file predicts what the
      // verification step will read (the test file, the sibling module).
      if (seedPath) touched.unshift(seedPath);
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
    if (t) this.steerQueue.push({ text: t, source: 'user' });
  }

  /** B21: accept a mid-run steer from a PARENT agent (steerChildRun).
   *  Same queue, same turn-boundary delivery as a user steer — but the
   *  entry carries its provenance event, and acceptance is refused once
   *  the run has finished so the parent can fail loudly instead of the
   *  steer dying silently in a queue nobody drains. A steer is guidance
   *  only: it never touches this agent's tool allowlist or permission
   *  posture (both are fixed at construction). */
  acceptParentSteer(text: string, event: ChildSteerEvent): boolean {
    const t = text.trim();
    if (!t || !this.runActive) return false;
    this.steerQueue.push({ text: t, source: 'parent', event });
    return true;
  }

  /** Drain any mid-run steering into the transcript (called at each
   *  iteration top). Returns true if anything was injected. */
  private drainSteerQueue(): boolean {
    if (this.steerQueue.length === 0) return false;
    const entries = this.steerQueue.splice(0, this.steerQueue.length);
    const userLines = entries.filter((e) => e.source === 'user').map((e) => e.text);
    const parentEntries = entries.filter((e) => e.source === 'parent');
    if (userLines.length) {
      this.context.addMessage({
        role: 'user',
        content: `[mid-run steer] The user sent this while the task was running — take it into account NOW and adjust course if needed:\n${userLines.join('\n')}`,
      });
    }
    if (parentEntries.length) {
      this.context.addMessage({
        role: 'user',
        content: `[subagent steer] Your parent agent sent this while you were running — take it into account NOW and adjust course if needed. A steer changes your DIRECTION only: it does not change your tools, your permissions, or your output contract.\n${parentEntries.map((e) => e.text).join('\n')}`,
      });
      // Provenance: stamp delivery onto each shared event object (the
      // child's run record holds the same objects), log the events for
      // the trajectory exporter, and remember them for the run-finish
      // attribution flag.
      for (const e of parentEntries) {
        if (!e.event) continue;
        e.event.deliveredAt = Date.now();
        this.deliveredParentSteers.push(e.event);
        this.events.emit({
          type: 'subagent:steered',
          agentId: this.id,
          parentId: e.event.from,
          from: e.event.from,
          at: e.event.at,
          hash: e.event.hash,
          chars: e.event.chars,
        });
      }
    }
    const lines = entries.map((e) => e.text);
    this.events.emit({ type: 'agent:log', agentId: this.id, message: `steer: injected ${lines.length} mid-run guidance line(s)` });
    // Discipline: an interjection is one of the three legitimate
    // re-plan triggers — record it as fresh evidence for the gate.
    this.discipline?.noteEvidence(`steer:${lines.join('\n').slice(0, 160)}`);
    // B24: correction-shaped steers are also captured as STRUCTURED lesson
    // candidates (redacted, local-only) instead of living only as raw
    // transcript text. Only USER lines are captured: a parent agent's
    // steer is agent-generated guidance, not a user correction, and
    // capturing it would poison the lessons signal. Best-effort: capture
    // must never break the loop.
    try {
      for (const line of userLines) {
        const rec = captureCorrection(line, { session: this.id });
        if (rec) promoteCorrectionToLesson(this.workspace.dir, rec);
      }
    } catch { /* correction capture is strictly optional */ }
    return true;
  }

  /** Lazily-built on-disk store for background child-run records. */
  private childStore(): ChildRunStore {
    if (!this.childStoreInstance) this.childStoreInstance = new ChildRunStore(this.workspace);
    return this.childStoreInstance;
  }

  /** Lazily-built worktree manager rooted at this agent's cwd. Worktrees it
   *  creates are registered in its live map, so its own reapOrphans treats
   *  running children as live (never reaped). */
  private worktreeManager(): WorktreeManager {
    if (!this.worktreeManagerInstance) {
      this.worktreeManagerInstance = new WorktreeManager(this.cwd, this.workspace.dir);
    }
    return this.worktreeManagerInstance;
  }

  /** Tool-context spawner bundle: sync delegation + the background
   *  spawn/collect/cancel runtime + review fleets. Injected only while this
   *  agent may still delegate (depth < safety.maxSubagentDepth, default 2),
   *  so children can themselves delegate but the tree stays bounded. */
  private spawnerContext(): Partial<ToolContext> {
    if (!canSpawnAtDepth(this.subagentDepth, resolveMaxSubagentDepth(this.config))) return {};
    return {
      spawnSubagent: (prompt: string, opts?: { role?: string; preset?: string; isolate?: boolean; timeoutMs?: number; scratchpad?: string; autoCompactWindow?: number }) => this.spawnSubagent(prompt, opts),
      spawnSubagents: (tasks: Array<{ prompt: string; role?: string; preset?: string; timeoutMs?: number; scratchpad?: string; autoCompactWindow?: number }>) => this.spawnSubagents(tasks),
      spawnAgentAsync: (spec) => this.spawnAgentAsync(spec),
      collectAgent: (id: string, opts?: { waitMs?: number; apply?: boolean }) => this.collectChildResult(id, opts),
      cancelAgent: (id: string) => this.cancelChildRun(id),
      steerAgent: (id: string, text: string) => this.steerChildRun(id, text),
      reviewFleet: (spec) => this.runReviewFleet(spec),
    };
  }

  /** Surface finished-background-child notices at the iteration top, next
   *  to the steer queue: the parent learns a research/review child landed
   *  without having to poll. Returns true if anything was injected. */
  private drainChildInbox(): boolean {
    if (this.childInbox.length === 0) return false;
    const lines = this.childInbox.splice(0, this.childInbox.length);
    this.context.addMessage({
      role: 'user',
      content: `[subagent updates] Background subagents finished:\n${lines.join('\n')}\nCollect the full result of any of them with collect_agent when you reach a natural pause.`,
    });
    return true;
  }

  /** Construct AND START a child agent for `spec`. Shared by the sync
   *  delegate path and the background runtime: role/preset resolution,
   *  per-child scoped budget, output contract, worktree isolation for
   *  mutating presets, posture inheritance. The child's run is fenced —
   *  `completion` resolves with {result} or {error} and never rejects, so a
   *  late child failure can never surface as an unhandled rejection in the
   *  parent. */
  private async startChildRun(spec: ChildRunSpec): Promise<PreparedChild> {
    // Forged personas (agent-forge) resolve first: `forged/<name>` is a
    // registry persona; anything else falls through to the static presets.
    const preset = resolveSpawnPreset(this.workspace.dir, spec.preset) ?? resolvePreset(spec.preset);
    const roleStr = spec.role ?? (preset ? String(preset.role) : undefined);
    const childRole = (roleStr ?? 'coder') as import('../types.js').AgentRole;
    const childProfile = new AgentProfileService(this.workspace.dir).get(childRole) ?? this.profile;
    const childId = spec.runId ?? `${this.id}-sub-${Math.random().toString(36).slice(2, 8)}`;

    // Worktree isolation: mutating presets (and explicit isolate=true) get a
    // private git worktree + branch. Read-only presets share the parent's
    // cwd — they cannot write, so sharing is safe. If the cwd is not a git
    // repo (or worktree creation fails) a mutating child falls back to the
    // shared cwd and the record says so.
    let childCwd = this.cwd;
    let worktree: import('../teams/subagent-runtime.js').ChildWorktreeInfo | undefined;
    const wantsWorktree = spec.isolate === true || preset?.access === 'worktree';
    if (wantsWorktree && (await isGitRepo(this.cwd))) {
      try {
        const info = await this.worktreeManager().create(`agent-${childRole}`);
        const baseSha = await gitOut(this.cwd, ['rev-parse', 'HEAD']).catch(() => 'HEAD');
        worktree = { id: info.id, branch: info.branch, path: info.path, baseSha };
        childCwd = info.path;
      } catch { /* fall back to shared cwd */ }
    }

    const childContext = new ContextEngine(this.config, childCwd);
    // G11: per-child idle-compaction window — a parent-specified window
    // opts this child into idle compaction with its own threshold (the
    // child's own idle clock, not the parent's schedule). Invalid values
    // are ignored (the child's default: off).
    if (spec.autoCompactWindow !== undefined && Number.isFinite(spec.autoCompactWindow) && spec.autoCompactWindow > 0) {
      childContext.setIdleCompactionConfig({ enabled: true, thresholdMs: spec.autoCompactWindow });
    }
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
    // Output contract. Structured spawns (presets, background, fleets) use
    // the JSON contract the parent aggregates; plain sync delegates keep the
    // legacy <result> footer (parseChildResult understands both).
    const structured = Boolean(spec.preset || spec.runId || spec.extraSystem);
    childContext.addMessage({
      role: 'system',
      content: structured
        ? STRUCTURED_RESULT_CONTRACT
        : '[Output contract] End your FINAL message with exactly this footer:\n<result>\nSTATUS: done | partial | blocked\nFILES: comma-separated paths you created or modified (or "none")\nRESULT: one-paragraph summary of the outcome\n</result>',
    });
    if (preset) {
      childContext.addMessage({ role: 'system', content: `[Spawn preset: ${preset.name}] ${preset.systemAddendum}` });
    }
    if (spec.extraSystem) {
      childContext.addMessage({ role: 'system', content: spec.extraSystem });
    }
    if (worktree) {
      childContext.addMessage({
        role: 'system',
        content: `[Isolated worktree] You are working in a PRIVATE git worktree at ${worktree.path} (branch ${worktree.branch}). Edit freely there — nothing you do touches the parent agent's working tree. The parent reviews your diff before applying it.`,
      });
    }
    if (spec.scratchpad) {
      childContext.addMessage({
        role: 'system',
        content: `[Shared Context / Scratchpad from Parent Agent]:\n${spec.scratchpad}`,
      });
    }
    // MCH-54: give spawned subagents the speculative stack — seed the child's
    // context with the parent's fused prefetch hints (parent's read footprint
    // drives the co-change signal, so children land pre-oriented on the files
    // the parent was actually working in). Best-effort. (Worktree children
    // skip it: the hints name parent-cwd paths that differ in the worktree.)
    if (!worktree) {
      try {
        const { prefetchText } = await import('../core/prefetch.js');
        const touched = Array.from(this.readCache.keys()).slice(-10);
        const childHint = prefetchText(this.workspace.dir, touched);
        if (childHint) childContext.addMessage({ role: 'system', content: childHint });
      } catch { /* subagent prefetch must never affect spawning */ }
    }

    const childAbort = new AbortController();
    const combinedAbort = this.abortSignal
      ? AbortSignal.any([this.abortSignal, childAbort.signal])
      : childAbort.signal;

    // Role-scope cap: a preset child's tool allowlist is enforced in the
    // child constructor (map pruning) and by executeTool (ctx check). Host
    // extra tools (MCP) are filtered to the same allowlist — a read-only
    // child must not inherit a mutating MCP tool from its parent.
    const toolAllowlist = preset ? preset.tools : undefined;
    // P5 fork inheritance: a child with the parent's full tool universe
    // inherits the parent's stable head verbatim (the child engine applies
    // it only when its own head signature matches — same project root,
    // tool set, root rules, repo info). Pruned-tool children render their
    // own head: their guidelines legitimately differ.
    if (!toolAllowlist) {
      const snap = this.context.stableHeadSnapshot();
      if (snap) childContext.inheritStableHead(snap.text, snap.sig);
    }
    let extraTools = this.extraTools;
    if (toolAllowlist && extraTools) {
      const allowed = new Set(toolAllowlist);
      extraTools = new Map([...extraTools].filter(([name]) => allowed.has(name)));
    }

    const child = new Agent({
      id: childId,
      role: childRole,
      // MCH-41 lanes: read-only research roles run the fast profile (breadth
      // not depth, 3-5x cheaper); explicit `lane` overrides; coder keeps its
      // role profile.
      modelProfile: (spec.lane === 'fast' || (!spec.lane && (childRole === 'researcher' || childRole === 'reviewer')))
        ? ('fast' as import('../types.js').ModelProfile)
        : (childProfile.defaultModel ?? 'coding'),
      // MCH-41 failover-aware fanout: rotate failover entries as the child's
      // PRIMARY so parallel siblings land on distinct endpoints instead of
      // stampeding one free-tier rate limit. Original chain order is kept as
      // each child's fallback path.
      config: { ...this.config, model: this.fanoutConfig(this.config.model, spec.failoverIndex) },
      workspace: this.workspace,
      events: this.events,
      cwd: childCwd,
      context: childContext,
      budget: childBudget,
      abortSignal: combinedAbort,
      // Worktree children get a FRESH read cache: the shared cache is keyed
      // to the parent's tree and its "already read" stubs would reference
      // content at different paths in the child's checkout.
      readCache: worktree ? new Map() : this.readCache,
      subagentDepth: this.subagentDepth + 1,
      extraTools,
      toolAllowlist,
      // Permission posture is INHERITED, never silently reset: the child
      // gets the parent's policy tier, its session allow-always memory, and
      // its explicit unattended opt-in — but NOT the approval handler
      // (subagents never prompt; with no handler their non-auto-approved
      // calls are denied by the gate unless inherited posture allows them).
      permPolicy: this.permPolicy,
      approvedAlways: this.approvedAlways,
      unattendedAllow: this.unattendedAllow,
    });
    const task: Task = {
      id: `sub-${Math.random().toString(36).slice(2, 10)}`,
      title: `Subtask: ${spec.prompt.split('\n')[0].slice(0, 60)}`,
      description: spec.prompt,
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
      prompt: spec.prompt.slice(0, 300),
    });

    // Usage accounting: count the child's executed tool calls off the shared
    // event bus (the child emits tool:completed under its own agentId).
    let toolCallCount = 0;
    const stopCounting = this.events.on('tool:completed', (e) => {
      if (e.agentId === childId) toolCallCount++;
    });

    const completion: Promise<{ result?: AgentResult; error?: string }> = (async () => {
      try {
        const result = await child.run(task);
        return { result };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    })();

    return {
      childId,
      role: childRole,
      task,
      abort: childAbort,
      cwd: childCwd,
      worktree,
      toolCalls: () => toolCallCount,
      stopCounting,
      steerChild: (text: string, event: ChildSteerEvent) => child.acceptParentSteer(text, event),
      completion,
      ...(spec.preset?.startsWith('forged/') ? { forgedPersonaName: spec.preset.slice('forged/'.length) } : {}),
    };
  }

  /** Await a started child with the historical sync-delegate semantics:
   *  optional wall-clock timeout (aborts the child), subagent:completed
   *  event, and the [completed=...] string with its contract tail. */
  private async runChildSync(prepared: PreparedChild, timeoutMs?: number): Promise<string> {
    let timeoutTimer: NodeJS.Timeout | undefined;
    const timeoutPromise = timeoutMs && timeoutMs > 0
      ? new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => {
            prepared.abort.abort('Subagent execution timed out');
            reject(new Error(`Subagent timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      : null;
    try {
      const outcome = timeoutPromise
        ? await Promise.race([prepared.completion, timeoutPromise])
        : await prepared.completion;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      prepared.stopCounting();
      if (outcome.error) throw new Error(outcome.error);
      const result = outcome.result!;
      this.events.emit({
        type: 'subagent:completed',
        agentId: prepared.childId,
        parentId: this.id,
        role: prepared.role,
        success: result.success,
        summary: result.summary,
        tokensUsed: result.tokensUsed,
      });
      // Agent-forge ledger: a forged persona's survival depends on honest
      // post-run accounting. The child's verdict of its own work (success)
      // plus parent's contract compliance is the helpfulness signal.
      if (prepared.forgedPersonaName) {
        try {
          recordAgentForgeSpawn(this.workspace.dir, prepared.forgedPersonaName, {
            ok: result.success,
            helpfulness: result.success && !result.summary.includes('[contract: missing]') ? 'helpful' : (result.success ? 'neutral' : 'regression'),
            tokens: result.tokensUsed,
            ...(result.success ? {} : { detail: result.summary.slice(0, 200) }),
          });
        } catch { /* ledger must never break delegation */ }
      }
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
      prepared.stopCounting();
      // Wait briefly for the orphaned child to honour the abort signal so
      // its tail-end outcome is consumed by the fence in startChildRun
      // rather than racing past this report.
      await Promise.race([
        prepared.completion,
        new Promise<void>((res) => setTimeout(res, 1500)),
      ]);
      const msg = err instanceof Error ? err.message : String(err);
      this.events.emit({
        type: 'subagent:completed',
        agentId: prepared.childId,
        parentId: this.id,
        role: prepared.role,
        success: false,
        summary: msg,
        tokensUsed: 0,
      });
      throw err;
    }
  }

  /** Spawn a fresh child agent on a subtask and return a short summary. The
   *  child shares this run's config, workspace, events, abort signal and
   *  (unless worktree-isolated) cwd, so delegation is cheap and consistent. */
  private async spawnSubagent(
    prompt: string,
    opts?: { role?: string; preset?: string; isolate?: boolean; timeoutMs?: number; scratchpad?: string; lane?: string; failoverIndex?: number; autoCompactWindow?: number } | string
  ): Promise<string> {
    const spec: ChildRunSpec = typeof opts === 'string'
      ? { prompt, role: opts }
      : {
          prompt,
          role: opts?.role,
          preset: opts?.preset,
          isolate: opts?.isolate,
          scratchpad: opts?.scratchpad,
          lane: opts?.lane,
          failoverIndex: opts?.failoverIndex,
          autoCompactWindow: opts?.autoCompactWindow,
        };
    const timeoutMs = typeof opts === 'object' ? opts?.timeoutMs : undefined;
    const prepared = await this.startChildRun(spec);
    const text = await this.runChildSync(prepared, timeoutMs);
    // A synchronous worktree child has no collect step, so surface where its
    // changes live instead of letting them vanish into an unknown branch.
    if (prepared.worktree) {
      try {
        await commitWorktreeChanges(prepared.worktree.path, `mochi: subagent ${prepared.childId} (${prepared.role})`);
        const diffSummary = await summarizeWorktreeDiff(prepared.worktree.path, prepared.worktree.baseSha);
        return `${text}\n[worktree: branch ${prepared.worktree.branch} at ${prepared.worktree.path} — ${diffSummary}. NOT merged into your tree; review/apply it with git when ready.]`;
      } catch { /* the summary still stands */ }
    }
    return text;
  }

  // ---------------------------------------------------------------------
  // Background child runtime (spawn_agent): async spawn + collect + cancel
  // with a concurrency cap, FIFO queueing, on-disk durability, and an
  // inbox notice on completion. "Async" here means in-process background:
  // children are Agent instances on this process's event loop, started
  // without awaiting; their state is persisted at every transition so a
  // restarted parent can still collect finished results from disk.
  // ---------------------------------------------------------------------

  /** Register a background child: persist its record, enqueue it under the
   *  concurrency cap, and return the live handle immediately. */
  private registerChild(spec: ChildRunSpec): LiveChildRun {
    const preset = resolveSpawnPreset(this.workspace.dir, spec.preset) ?? resolvePreset(spec.preset);
    const id = spec.runId ?? `sub-${randomUUID().slice(0, 8)}`;
    const record: ChildRunRecord = {
      id,
      parentAgentId: this.id,
      role: spec.role ?? (preset ? String(preset.role) : 'coder'),
      preset: preset?.name,
      promptPreview: spec.prompt.slice(0, 300),
      status: 'queued',
      access: preset?.access ?? (spec.isolate ? 'worktree' : 'shared'),
      cwd: this.cwd,
      createdAt: Date.now(),
    };
    let settle!: () => void;
    const promise = new Promise<void>((res) => { settle = res; });
    const live: LiveChildRun = { record, spec: { ...spec, runId: id }, promise, settle, pendingSteers: [] };
    this.childRuns.set(id, live);
    this.childQueue.push(live);
    this.childStore().save(record);
    this.pumpChildQueue();
    return live;
  }

  /** Start queued children while concurrency slots are free. Fully
   *  synchronous: launchTrackedChild flips the record to 'running' in its
   *  synchronous prefix, so the cap counts correctly across the loop. */
  private pumpChildQueue(): void {
    try {
      for (;;) {
        const running = [...this.childRuns.values()].filter((l) => l.record.status === 'running').length;
        if (running >= resolveMaxConcurrentSubagents(this.config)) return;
        const idx = this.childQueue.findIndex((l) => l.record.status === 'queued');
        if (idx < 0) return;
        const [next] = this.childQueue.splice(idx, 1);
        this.launchTrackedChild(next);
      }
    } catch { /* the pump must never break the parent run */ }
  }

  /** Launch one queued child: mark it running NOW, then construct + start
   *  it asynchronously and wire its completion into finalizeChild. */
  private launchTrackedChild(live: LiveChildRun): void {
    const rec = live.record;
    rec.status = 'running';
    rec.startedAt = Date.now();
    this.childStore().save(rec);
    void (async () => {
      let timeoutTimer: NodeJS.Timeout | undefined;
      try {
        const prepared = await this.startChildRun(live.spec);
        live.prepared = prepared;
        // B21: hand over any steers issued while this child was queued or
        // launching, in issue order. startChildRun returns with the
        // child's run() parked before its first turn, so a steer handed
        // over here still lands ahead of the first drain — the child sees
        // it as guidance from the start, never as a lost message.
        if (live.pendingSteers.length) {
          const pending = live.pendingSteers.splice(0, live.pendingSteers.length);
          for (const p of pending) {
            if (!prepared.steerChild(p.text, p.event)) {
              p.event.undelivered = true;
              this.childStore().save(rec);
              this.childInbox.push(`${rec.id} — a steer from ${p.event.from} could not be delivered (the run ended before it started).`);
            }
          }
        }
        // Cancel landed while the child was still being constructed:
        // honour it now that there is something to abort.
        if (rec.status === 'cancelled') prepared.abort.abort('Cancelled by parent agent');
        rec.cwd = prepared.cwd;
        if (prepared.worktree) {
          rec.worktree = prepared.worktree;
          rec.access = 'worktree';
          this.childStore().save(rec);
        }
        if (live.spec.timeoutMs && live.spec.timeoutMs > 0) {
          timeoutTimer = setTimeout(() => {
            prepared.abort.abort('Subagent execution timed out');
          }, live.spec.timeoutMs);
        }
        const outcome = await prepared.completion;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        await this.finalizeChild(live, outcome);
      } catch (err) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        await this.finalizeChild(live, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  }

  /** Fold a finished background child into its persisted record: structured
   *  result parse, worktree commit + diff summary, inbox notice, next
   *  queued child. Never throws. */
  private async finalizeChild(
    live: LiveChildRun,
    outcome: { result?: AgentResult; error?: string },
  ): Promise<void> {
    const rec = live.record;
    const prepared = live.prepared;
    try {
      prepared?.stopCounting();
      if (rec.status === 'cancelled') {
        // Parent cancelled while running: discard the unapplied worktree,
        // keep the record as cancelled (no result fold-back).
        if (prepared?.worktree) {
          await this.discardWorktree(prepared.worktree).catch(() => { /* best effort */ });
        }
      } else if (outcome.result) {
        const result = outcome.result;
        const parsed = parseChildResult(result.summary, {
          success: result.success,
          filesModified: result.filesModified,
          tokensUsed: result.tokensUsed,
          toolCalls: prepared?.toolCalls() ?? 0,
          durationMs: result.durationMs,
        });
        rec.result = parsed;
        rec.status = parsed.status;
        if (outcome.result.stopReason === 'aborted') rec.error = 'aborted';
        this.events.emit({
          type: 'subagent:completed',
          agentId: rec.id,
          parentId: this.id,
          role: rec.role as import('../types.js').AgentRole,
          success: result.success,
          summary: result.summary,
          tokensUsed: result.tokensUsed,
        });
        if (prepared?.worktree) {
          try {
            await commitWorktreeChanges(prepared.worktree.path, `mochi: subagent ${rec.id} (${rec.preset ?? rec.role})`);
            rec.diffSummary = await summarizeWorktreeDiff(prepared.worktree.path, prepared.worktree.baseSha);
          } catch { /* diff summary is advisory */ }
        }
        this.childInbox.push(`${rec.id} (${rec.preset ?? rec.role}) ${rec.status}${parsed.verdict ? ` · verdict ${parsed.verdict}` : ''}: ${parsed.summary.slice(0, 160)}`);
      } else {
        rec.status = 'failed';
        rec.error = outcome.error ?? 'child run failed';
        this.events.emit({
          type: 'subagent:completed',
          agentId: rec.id,
          parentId: this.id,
          role: rec.role as import('../types.js').AgentRole,
          success: false,
          summary: rec.error,
          tokensUsed: 0,
        });
        if (prepared?.worktree) {
          // Keep a failed child's partial work inspectable on its branch.
          try {
            await commitWorktreeChanges(prepared.worktree.path, `mochi: subagent ${rec.id} (failed, partial)`);
            rec.diffSummary = await summarizeWorktreeDiff(prepared.worktree.path, prepared.worktree.baseSha);
          } catch { /* best effort */ }
        }
        this.childInbox.push(`${rec.id} (${rec.preset ?? rec.role}) FAILED: ${rec.error.slice(0, 160)}`);
      }
    } catch { /* finalize must never break the parent */ } finally {
      // B21: reconcile steer provenance before the record goes durable.
      // A steer whose shared event was never stamped deliveredAt by the
      // child did not land — mark it undelivered (never silently dropped)
      // and, unless the run was cancelled anyway, warn via the inbox.
      if (rec.steers?.length) {
        let lost = 0;
        for (const s of rec.steers) {
          if (s.deliveredAt === undefined && !s.undelivered) {
            s.undelivered = true;
            lost++;
          }
        }
        rec.steered = rec.steers.some((s) => s.deliveredAt !== undefined);
        if (lost > 0 && rec.status !== 'cancelled') {
          this.childInbox.push(`${rec.id} — ${lost} steer(s) arrived too late and were NOT delivered (the run had already finished).`);
        }
      }
      rec.finishedAt = Date.now();
      this.childStore().save(rec);
      live.settle();
      this.pumpChildQueue();
    }
  }

  /** Start a background child and return its handle immediately — the
   *  parent keeps working and collects the result when ready. */
  async spawnAgentAsync(spec: {
    prompt: string;
    role?: string;
    preset?: string;
    scratchpad?: string;
    timeoutMs?: number;
    isolate?: boolean;
    autoCompactWindow?: number;
  }): Promise<{ id: string; status: string; note: string }> {
    if (!canSpawnAtDepth(this.subagentDepth, resolveMaxSubagentDepth(this.config))) {
      return {
        id: '',
        status: 'refused',
        note: `Delegation depth cap reached (safety.maxSubagentDepth=${resolveMaxSubagentDepth(this.config)}): agents at this depth cannot spawn children.`,
      };
    }
    const live = this.registerChild({ ...spec });
    const cap = resolveMaxConcurrentSubagents(this.config);
    return {
      id: live.record.id,
      status: live.record.status,
      note: live.record.status === 'queued'
        ? `Queued behind running siblings (concurrency cap ${cap}); it starts automatically as a slot frees.`
        : `Running in the background (${live.record.preset ?? live.record.role}, ${live.record.access}). Its result is persisted under .mochi/state/subagents/${live.record.id}.json.`,
    };
  }

  /** Collect a background child's result digest. Live runs report their
   *  live status (or are awaited up to waitMs); finished runs fold back the
   *  structured digest. When this process no longer owns the run (parent
   *  restarted), the persisted record is served instead — finished results
   *  survive restarts. apply=true squash-merges a finished worktree child's
   *  branch into this tree (the ONLY way child changes land — never
   *  automatic). */
  async collectChildResult(id: string, opts?: { waitMs?: number; apply?: boolean }): Promise<string> {
    const live = this.childRuns.get(id);
    if (live) {
      if ((live.record.status === 'running' || live.record.status === 'queued') && opts?.waitMs && opts.waitMs > 0) {
        await Promise.race([
          live.promise,
          new Promise<void>((res) => setTimeout(res, opts.waitMs)),
        ]);
      }
      if (opts?.apply) {
        const msg = await this.applyChildWorktree(live.record);
        return `${msg}\n${formatChildDigest(live.record)}`;
      }
      return formatChildDigest(live.record);
    }
    const rec = this.childStore().load(id);
    if (!rec) {
      return `No subagent run with id "${id}": not live under this agent and no persisted record in .mochi/state/subagents/. Check the id from the spawn result.`;
    }
    if (opts?.apply) {
      const msg = await this.applyChildWorktree(rec);
      return `${msg}\n${formatChildDigest(rec)}`;
    }
    const orphan = rec.status === 'running' || rec.status === 'queued'
      ? `\nNote: the process that owned this run is gone (record left at "${rec.status}") — there is no live child to collect from.`
      : '';
    return formatChildDigest(rec) + orphan;
  }

  /** Cancel a background child: queued children are dropped, running
   *  children are aborted (their worktrees are discarded at finalize), and
   *  orphaned records (owning process gone) are marked cancelled with
   *  their worktree cleaned up by path/branch. */
  async cancelChildRun(id: string): Promise<string> {
    const live = this.childRuns.get(id);
    if (live) {
      const rec = live.record;
      if (rec.status === 'queued') {
        this.childQueue = this.childQueue.filter((l) => l !== live);
        rec.status = 'cancelled';
        // B21: steers queued for a child that will now never start are
        // marked undelivered on the record — never silently dropped.
        for (const s of rec.steers ?? []) {
          if (s.deliveredAt === undefined) s.undelivered = true;
        }
        live.pendingSteers.length = 0;
        rec.finishedAt = Date.now();
        this.childStore().save(rec);
        live.settle();
        return `Subagent ${id} was queued and is now cancelled — it never ran.`;
      }
      if (rec.status === 'running') {
        rec.status = 'cancelled';
        this.childStore().save(rec);
        live.prepared?.abort.abort('Cancelled by parent agent');
        return `Subagent ${id} cancellation signalled — it is aborting and its unapplied worktree will be discarded.`;
      }
      return formatChildDigest(rec);
    }
    const rec = this.childStore().load(id);
    if (!rec) {
      return `No subagent run with id "${id}": not live under this agent and no persisted record in .mochi/state/subagents/.`;
    }
    if (rec.status === 'running' || rec.status === 'queued') {
      rec.status = 'cancelled';
      rec.finishedAt = Date.now();
      this.childStore().save(rec);
      if (rec.worktree) await this.discardWorktree(rec.worktree).catch(() => { /* best effort */ });
      return `Subagent ${id} belonged to a process that is gone; marked cancelled${rec.worktree ? ' and its worktree discarded' : ''}.`;
    }
    return formatChildDigest(rec);
  }

  /** B21: steer a background child MID-RUN — redirect what it is doing
   *  without killing it and losing its context. The steer rides the
   *  child's own steer channel (the MCH-74 pattern, extended from the
   *  main loop) and is injected at its next turn boundary with framing
   *  that names it as parent steering. Steering changes DIRECTION only:
   *  the child's role allowlist and permission posture are fixed at
   *  construction — a steer that asks for a forbidden tool is just a
   *  message, and the allowlist still refuses the call. Provenance: every
   *  steer is logged on the child's run record (who / when / sha256 /
   *  redacted preview — raw text is never persisted); the child stamps
   *  delivery when the steer lands, and a steer that cannot land is
   *  reported as NOT delivered, never silently dropped. Steering a
   *  queued child queues the steer for its first turn. */
  async steerChildRun(id: string, text: string, opts?: { from?: string }): Promise<string> {
    const t = text.trim();
    if (!t) {
      return `steer_agent needs a non-empty message — there is nothing to steer subagent ${id} with. (No steer recorded.)`;
    }
    const event: ChildSteerEvent = {
      at: Date.now(),
      from: opts?.from ?? this.id,
      hash: createHash('sha256').update(t, 'utf8').digest('hex'),
      chars: t.length,
      preview: redact(t).slice(0, 160),
    };
    const live = this.childRuns.get(id);
    if (live) {
      const rec = live.record;
      if (rec.status === 'queued') {
        (rec.steers ??= []).push(event);
        live.pendingSteers.push({ text: t, event });
        this.childStore().save(rec);
        return `Steer queued for subagent ${id} — it has not started yet, so the steer will be part of its context from its first turn. Delivery is stamped on its run record when it starts.`;
      }
      if (rec.status === 'running') {
        (rec.steers ??= []).push(event);
        const prepared = live.prepared;
        if (!prepared) {
          // Still launching (startChildRun in flight): the launch path
          // hands pending steers over the moment the child exists.
          live.pendingSteers.push({ text: t, event });
          this.childStore().save(rec);
          return `Steer queued for subagent ${id} — its run is starting; the steer will be handed over before its first turn.`;
        }
        if (prepared.steerChild(t, event)) {
          this.childStore().save(rec);
          return `Steer sent to subagent ${id} — it lands in the child's context at its next turn boundary, and delivery is stamped on its run record (.mochi/state/subagents/${id}.json). A steer redirects the child; it does not change its tools or permissions.`;
        }
        // The child finished between the status check and the handoff.
        event.undelivered = true;
        this.childStore().save(rec);
        return `Subagent ${id} finished before the steer could be delivered — the steer was NOT delivered. Collect its result; if the work still needs redirecting, spawn a new subagent with the corrected instructions.`;
      }
      return `Subagent ${id} already ${rec.status} — a steer cannot be delivered to a finished run (steer NOT delivered). Collect its result; if the work still needs redirecting, spawn a new subagent with the corrected instructions.`;
    }
    const rec = this.childStore().load(id);
    if (!rec) {
      return `No subagent run with id "${id}": not live under this agent and no persisted record in .mochi/state/subagents/. Check the id from the spawn result. (Steer NOT delivered.)`;
    }
    if (rec.status === 'running' || rec.status === 'queued') {
      return `Subagent ${id} belonged to a process that is gone (record left at "${rec.status}") — there is no live child to steer. (Steer NOT delivered.)`;
    }
    return `Subagent ${id} already ${rec.status} — a steer cannot be delivered to a finished run (steer NOT delivered). Spawn a new subagent with the corrected instructions if the work still needs redirecting.`;
  }

  /** Squash-merge a finished worktree child's branch into this tree.
   *  Explicit parent action only — nothing merges child work implicitly. */
  private async applyChildWorktree(record: ChildRunRecord): Promise<string> {
    if (!record.worktree) {
      return `Subagent ${record.id} has no worktree to apply (it ran ${record.access} in the shared tree).`;
    }
    if (record.applied) return `Subagent ${record.id}'s worktree was already applied.`;
    if (record.status === 'running' || record.status === 'queued') {
      return `Subagent ${record.id} is still ${record.status} — collect it after it finishes before applying.`;
    }
    const wt = record.worktree;
    try {
      const mgr = this.worktreeManager();
      let sha: string;
      if (mgr.get(wt.id)) {
        sha = await mgr.merge(wt.id, `mochi: apply subagent ${record.id} (${record.preset ?? record.role})`);
      } else {
        // The manager that created this worktree is gone (parent restarted):
        // squash-merge by branch name, which survives in the repo.
        await gitOut(this.cwd, ['merge', '--squash', wt.branch]);
        await gitOut(this.cwd, ['commit', '-m', `mochi: apply subagent ${record.id} (${record.preset ?? record.role})`, '--allow-empty']);
        sha = await gitOut(this.cwd, ['rev-parse', 'HEAD']);
      }
      record.applied = true;
      this.childStore().save(record);
      await this.discardWorktree(wt).catch(() => { /* cleanup is best effort */ });
      return `Applied subagent ${record.id}: squash-merged ${wt.branch} into this tree as ${sha.slice(0, 10)}.`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Could not apply subagent ${record.id}: ${msg} — the branch ${wt.branch} is untouched; resolve any conflicts in your tree and retry.`;
    }
  }

  /** Remove a worktree + branch by info, via the live manager when it owns
   *  the registration, else by raw git (post-restart records). */
  private async discardWorktree(wt: import('../teams/subagent-runtime.js').ChildWorktreeInfo): Promise<void> {
    const mgr = this.worktreeManager();
    if (mgr.get(wt.id)) {
      await mgr.discard(wt.id);
      return;
    }
    await gitOut(this.cwd, ['worktree', 'remove', '--force', wt.path]).catch(() => { /* already gone */ });
    await gitOut(this.cwd, ['branch', '-D', wt.branch]).catch(() => { /* already gone */ });
  }

  /** Fan out N pr-reviewer children over the SAME diff — one per lens —
   *  and return a single aggregated report: findings deduplicated by
   *  file+line+issue, verdicts merged (any request-changes wins). */
  async runReviewFleet(spec: {
    target?: string;
    lenses?: string[];
    instructions?: string;
  }): Promise<string> {
    if (!canSpawnAtDepth(this.subagentDepth, resolveMaxSubagentDepth(this.config))) {
      return `Review fleet unavailable: delegation depth cap reached (safety.maxSubagentDepth=${resolveMaxSubagentDepth(this.config)}).`;
    }
    const LENS_GUIDANCE: Record<string, string> = {
      correctness: 'Judge ONLY correctness: logic errors, edge cases, off-by-ones, broken invariants, wrong error handling, regressions against the stated intent.',
      security: 'Judge ONLY security: injection, authn/authz gaps, secret exposure, unsafe deserialization, path traversal, SSRF, missing validation of untrusted input.',
      tests: 'Judge ONLY tests: is the change covered by tests that would actually fail if the change were wrong? Name missing cases and flaky patterns.',
      performance: 'Judge ONLY performance: hot-path regressions, N+1 patterns, needless allocations/copies, unbounded work, missing caching where the codebase already caches.',
    };
    const { label, diff } = await captureReviewDiff(this.cwd, spec.target ?? 'working');
    const lenses = (spec.lenses?.length ? spec.lenses : ['correctness', 'security', 'tests'])
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 6);
    if (!lenses.length) return 'Review fleet: no lenses given.';
    const lives = lenses.map((lens) =>
      this.registerChild({
        preset: 'pr-reviewer',
        prompt: `Review this change through the ${lens} lens. The diff is in your context (scratchpad). ${spec.instructions ? `Change intent / extra instructions: ${spec.instructions}` : ''} Read surrounding code only where a hunk cannot be judged from the diff alone.`,
        scratchpad: `[Change under review: ${label}]\n\n${diff}`,
        extraSystem: `[Review lens: ${lens}] ${LENS_GUIDANCE[lens] ?? `Judge ONLY the ${lens} aspect of this change.`}`,
      }),
    );
    await Promise.all(lives.map((l) => l.promise));
    const failedLenses: string[] = [];
    lives.forEach((l, i) => { if (!l.record.result) failedLenses.push(lenses[i]); });
    const reviewed = lives
      .map((l, i) => ({ lens: lenses[i], result: l.record.result }))
      .filter((r): r is { lens: string; result: NonNullable<ChildRunRecord['result']> } => !!r.result);
    if (!reviewed.length) {
      const errors = lives.map((l) => l.record.error).filter(Boolean).join('; ');
      return `Review fleet over ${label}: every reviewer failed${errors ? ` (${errors})` : ''}.`;
    }
    const agg = aggregateReviews(reviewed, { failedLenses });
    return formatFleetReport(agg, { target: label, reviewers: reviewed.length });
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
    tasks: Array<{ prompt: string; role?: string; preset?: string; timeoutMs?: number; scratchpad?: string; autoCompactWindow?: number }>
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
          const val = await this.spawnSubagent(t.prompt, { role: t.role, preset: t.preset, timeoutMs: t.timeoutMs, scratchpad: t.scratchpad, lane, failoverIndex: i, autoCompactWindow: t.autoCompactWindow });
          results[i] = `[Subagent #${i + 1} (${t.role ?? 'coder'})]: ${val}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          try {
            const lane = (t as { lane?: string }).lane;
            const retryTimeout = t.timeoutMs && t.timeoutMs > 0 ? Math.max(30_000, Math.floor(t.timeoutMs / 2)) : undefined;
            const val = await this.spawnSubagent(t.prompt, { role: t.role, preset: t.preset, timeoutMs: retryTimeout, scratchpad: t.scratchpad, lane, failoverIndex: i + tasks.length, autoCompactWindow: t.autoCompactWindow });
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
        taskKind: this.taskKind,
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
    // Durable journal replay (C6): a step a PREVIOUS session of this run
    // already completed (same tool_call_id, or same tool+args signature —
    // a resumed model regenerates ids) is served from the on-disk journal
    // instead of re-executing: no side effect repeated, no tool re-billed.
    // The step already passed every gate when it first ran, so replay
    // short-circuits the gates below. Session-local/interactive tools
    // (load_tools, ask_question) are never journaled or replayed.
    if (this.journal && isJournalableTool(toolName)) {
      try {
        const jArgs = normalizeToolArgs(toolName, this.parseArgs(tc.function.arguments));
        const prior = this.journal.claim({ stepId: tc.id, toolName, args: jArgs });
        if (prior) {
          this.journalReplayed++;
          const replayOutput = prior.output ?? '';
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[journal] replayed completed step ${toolName} (journal seq ${prior.seq}) — not re-executed` });
          this.context.addMessage({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: replayOutput });
          this.events.emit({
            type: 'tool:completed',
            tool: tc.function.name,
            result: { toolCallId: tc.id, name: tc.function.name, output: replayOutput, durationMs: 0 },
            agentId: this.id,
          });
          // Bookkeeping parity with a real execution: a replayed shell/
          // verify counts as the repro attempt it originally was, and a
          // replayed mutation restores fileChanged (its effect is already
          // on disk) so the completion gate sees the run's true state.
          if (toolName === 'shell' || toolName === 'verify') this.reproAttempted = true;
          this.trackFileChange(toolName, jArgs, { output: replayOutput });
          return;
        }
      } catch { /* a journal fault must never block the real execution */ }
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
    // REPRODUCE-FIRST GATE (fix/debug kinds): the kind hint has always TOLD
    // the model to reproduce before editing, but nothing enforced it — a
    // model that edits immediately and passes the suite sails through, and
    // symptom-patches ship. The FIRST mutating call on a fix task is vetoed
    // once, before the approval gate (no point asking a human to approve a
    // call the harness will refuse), with a directive to observe the failure
    // first via shell/verify/bg_task. Exactly ONE veto: if the model comes
    // back and mutates again without reproducing, the call proceeds and the
    // bypass is recorded — some fixes have no runnable entrypoint yet, and a
    // permanent block would trap those runs (same philosophy as the
    // chat-lane escape above). Read/search/glob never reach this gate.
    // NEW-FILE EXEMPTION: the gate guards changes to EXISTING behavior. A
    // mutation whose every determinable target does not exist yet is
    // creating a brand-new artifact (a greeting file, a repro script, a
    // fresh test file) — there is no pre-existing failure in that file to
    // observe, and vetoing it broke create-then-fix runs whose first step
    // is the creation itself. Such calls skip the gate entirely: the one
    // veto is NOT spent and no bypass is recorded, so a later edit to an
    // existing file still hits the gate. Calls whose target cannot be
    // determined from the args (replace_symbol) keep the gate.
    if (MUTATING_TOOLS.has(toolName) && !this.reproAttempted && this.reproGateApplies()
      && this.reproMutationTargetState(toolName, tc.function.arguments ?? '') !== 'absent') {
      if (!this.reproVetoFired) {
        this.reproVetoFired = true;
        this.vetoLog.push({ tool: tc.function.name, reason: 'reproduce-first gate: first mutation vetoed pending a repro attempt' });
        if (this.vetoLog.length > 20) this.vetoLog.shift();
        this.events.emit({ type: 'agent:log', agentId: this.id, message: '[repro-first] vetoed first mutating call on a fix task — no reproduction attempted yet' });
        // Before sending the model off to hand-write a repro, try to
        // synthesise a validated one from the failure material already in
        // the task (repro-synth.ts). Best-effort: on any failure the veto
        // message is exactly the historical one.
        const synthesized = await this.trySynthesizeRepro();
        this.vetoToolCall(tc, 'REPRODUCE FIRST: this is a fix/debug task and you have not yet observed the failure. Before editing any code, reproduce it: run the failing test/command or a minimal repro script (shell or verify tool) and look at the actual failure output. Then edit, and re-run the same check to prove the fix. If no runnable check exists for this failure, attempt the closest one you can (e.g. run the affected module/test file directly) — after that attempt, or if you retry this edit, the edit will be allowed through.' + (synthesized ? `\n\n${synthesized}` : ''));
        return;
      }
      if (!this.reproGateBypassed) {
        this.reproGateBypassed = true;
        this.events.emit({ type: 'agent:log', agentId: this.id, message: '[repro-first] model mutated without reproducing after the veto — allowed through, bypass recorded' });
      }
    }
    // APPROVAL GATE (the tiers in security/permission.ts finally enforced):
    // anything the policy does not auto-allow needs a human decision when a
    // UI handler is attached (TUI menu: allow once / always / deny), and is
    // audit-logged either way. With NO handler (headless CLI, daemon, ACP,
    // SDK) — and for subagents, which never prompt — the gate is
    // DENY-BY-DEFAULT for approval-requiring calls (destructive/network
    // shell, outside-workspace writes, remote mutations): only the
    // headless-safe floor may proceed (what the workspace-safe tier
    // auto-allows: read-only tools, in-workspace edits, low-risk shell).
    // An explicit host opt-in (unattendedAllow /
    // MOCHI_UNATTENDED_ALLOW=1, or the yolo tier) restores allow + audit
    // beyond the floor for unattended runs, but it is never the default.
    // Shell commands on the hardline floor are denied under EVERY policy,
    // yolo included.
    // Plan-mode mutating calls never reach here (batch veto above).
    {
      const policy = normalizePolicy(this.permPolicy);
      if (!this.permMgr || this.permMgr.policy !== policy) {
        this.permMgr = { policy, mgr: new PermissionManager(policy, this.workspace.dir) };
      }
      const parsedArgs = this.parseArgs(tc.function.arguments);
      const auto = this.permMgr.mgr.autoAllow({ tool: toolName, args: parsedArgs, cwd: this.cwd, workspaceDir: this.workspace.dir });
      const auditBase = { ts: new Date().toISOString(), tool: toolName, args: parsedArgs, policy } as const;
      const hardline = toolName === 'shell' ? matchHardline(typeof parsedArgs.command === 'string' ? parsedArgs.command : '') : null;
      if (hardline) {
        // Hardline floor: refused even under yolo / allow-always / an
        // interactive allow — no standing consent covers catastrophic
        // commands. (The shell tool and exec.ts enforce the same floor for
        // calls that never reach this gate, e.g. speculative execution.)
        this.permMgr.mgr.audit({ ...auditBase, decision: 'deny' });
        this.vetoToolCall(tc, `Refused by the hardline safety floor (${hardline}): this command is catastrophic and is denied under every permission policy, including yolo. Do not retry it or rephrase it to evade the floor; find a non-destructive way to achieve the goal.`);
        return;
      }
      if (auto || policy === 'yolo') {
        this.permMgr.mgr.audit({ ...auditBase, decision: 'allow' });
      } else {
        const alwaysKey = `${toolName}:${tc.function.arguments ?? ''}`;
        if (this.approvedAlways.has(alwaysKey)) {
          this.permMgr.mgr.audit({ ...auditBase, decision: 'allow' });
        } else if (this.subagentDepth > 0 || !this.approvalHandler) {
          // No one to ask (headless host or child agent). Deny by default
          // for approval-requiring calls — destructive/network shell,
          // writes outside the workspace, remote mutations — the
          // fail-closed behavior approval.ts always documented. The
          // headless floor: calls the workspace-safe tier would auto-allow
          // (read-only tools, in-workspace edits, low-risk shell) are
          // "safe without a handler" and proceed under any policy, so an
          // unattended coding run can still do ordinary workspace work.
          // Beyond the floor, only an explicit unattended opt-in from the
          // host (unattendedAllow / MOCHI_UNATTENDED_ALLOW=1) allows.
          const permReq = { tool: toolName, args: parsedArgs, cwd: this.cwd, workspaceDir: this.workspace.dir };
          let headlessSafe = this.permMgr.mgr.autoAllowAs('workspace-safe', permReq)
            // File-mutation tools: TARGET containment is the scope fence's
            // job — it runs below in every mode and vetoes sibling-project,
            // out-of-workspace, and out-of-fileScope targets with its own
            // streak protocol. Denying them here too would pre-empt the
            // fence's richer veto and break its bookkeeping, without
            // changing the outcome (the write never lands either way).
            || MUTATING_TOOLS.has(toolName)
            // Host-registered tools: extraTools (SDK registerTool) and
            // MCP-namespaced tools (`server__tool`) exist only because the
            // operator configured them — registration is standing consent.
            || (this.extraTools?.has(toolName) ?? false)
            || toolName.includes('__');
          if (!headlessSafe && this.planMode) {
            // Plan-mode exemptions the batch gate above already vetted:
            // operator-allowlisted network reads (planModeNetworkReads)
            // and low-risk verify commands under snapshot/rollback
            // containment (agent/plan-verify.ts). Re-denying them here
            // would silently override the operator's plan-mode config.
            if (toolName === 'fetch') {
              const hosts = (this.config.safety?.planModeNetworkReads ?? []).map((h) => h.toLowerCase());
              try {
                headlessSafe = hosts.includes(new URL(String(parsedArgs.url ?? '')).hostname.toLowerCase());
              } catch { headlessSafe = false; }
            } else if (toolName === 'verify') {
              const resolved = resolveVerifyCommand(parsedArgs, this.cwd);
              headlessSafe = resolved !== null && classifyCommand(resolved) === 'low';
            }
          }
          if (this.unattendedAllow || headlessSafe) {
            this.permMgr.mgr.audit({ ...auditBase, decision: 'allow' });
          } else {
            this.permMgr.mgr.audit({ ...auditBase, decision: 'deny' });
            const { summary } = describeApproval(toolName, parsedArgs);
            this.vetoToolCall(tc, `Denied by default: ${summary} requires approval, but this run has no interactive approver (headless or subagent) and it is outside the headless-safe tier (read-only tools, in-workspace edits, low-risk shell). Proceed WITHOUT it using headless-safe tools, or ask the user to run interactively, switch policy, or explicitly enable unattended approvals (MOCHI_UNATTENDED_ALLOW=1). Do not just retry the same call.`);
            return;
          }
        } else {
          const { summary, risk } = describeApproval(toolName, parsedArgs);
          // W3-4 per-hunk edit review: best-effort hunk decomposition for
          // file-edit calls (edit/write/patch). Undefined → the host UI
          // falls back to the plain allow/deny menu.
          const editReview = buildEditReview(toolName, parsedArgs, this.cwd);
          let norm: { decision: 'allow-once' | 'allow-always' | 'deny'; acceptedHunks?: number[] } = { decision: 'deny' };
          try {
            norm = normalizeApprovalDecision(await this.approvalHandler({
              tool: toolName,
              summary,
              risk,
              policy,
              ...(editReview ? { edit: editReview } : {}),
            }));
          } catch {
            norm = { decision: 'deny' }; // a broken prompt UI fails closed, never hangs
          }
          if (norm.decision === 'allow-once' && norm.acceptedHunks && norm.acceptedHunks.length === 0) {
            norm = { decision: 'deny' }; // reviewed every hunk away = nothing to apply
          }
          if (norm.decision === 'allow-always') {
            if (this.approvedAlways.size < 200) this.approvedAlways.add(alwaysKey);
            this.permMgr.mgr.audit({ ...auditBase, decision: 'allow' });
          } else if (norm.decision === 'allow-once') {
            this.permMgr.mgr.audit({ ...auditBase, decision: 'allow' });
            // Revise the call args to the accepted hunk subset. A full set
            // (or an unrevisable call) applies the original args verbatim.
            if (norm.acceptedHunks && editReview && norm.acceptedHunks.length < editReview.hunks.length) {
              const revised = applyAcceptedHunks(toolName, parsedArgs, editReview, norm.acceptedHunks, this.cwd);
              if (revised) {
                try { tc.function.arguments = JSON.stringify(revised); } catch { /* keep original args */ }
              }
            }
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

    // S4 result cache: an identical read-only call already completed
    // earlier in this run and nothing that could change its result has
    // happened since (no mutation epoch bump, no history rewrite) — serve
    // the stored result instead of re-executing and re-injecting it:
    // verbatim when small, a short stub pointing at the copy already in
    // context when large. Consulted BEFORE the ExecutionRegistry on
    // purpose: the registry's 1500 ms replay re-injects the FULL output,
    // which is exactly the token waste this cache exists to remove (the
    // registry still owns in-flight duplicates, which a completed-result
    // cache cannot serve). Kill-switch: MOCHI_RESULT_CACHE=0.
    if (this.resultCacheEnabled) {
      const cacheName = this.resultCacheName(toolName, args);
      if (cacheName) {
        const hit = this.resultCache.lookup(cacheName, args);
        if (hit) {
          const served = hit.kind === 'verbatim' ? hit.output : hit.text;
          this.context.addMessage({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: served });
          this.events.emit({
            type: 'tool:completed',
            tool: tc.function.name,
            result: { toolCallId: tc.id, name: tc.function.name, output: served, durationMs: 0 },
            agentId: this.id,
          });
          this.events.emit({
            type: 'agent:log',
            agentId: this.id,
            message: `[smartturns] result-cache ${hit.kind} hit: ${cacheName}${hit.kind === 'stub' ? ` (~${hit.savedChars} chars not re-injected)` : ' (verbatim replay, no re-execution)'}`,
          });
          return;
        }
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
        // Redaction contract: maybeRedact is the single tool-output→context
        // gate and must hold on EVERY path that feeds the model. The normal
        // completion path stores POLICY-processed output (folded+scrubbed+
        // redacted); the speculative exec path stores RAW output — so the
        // replay must apply the same gate here or an unredacted replayed
        // read (e.g. a file containing an API key) reaches the model context.
        const replayOutput = applyToolOutputPolicy(
          scrubAnsiFragments(maybeRedact(cached.output)),
          { toolName: tc.function.name },
        ).content;
        // S4: this serve is where a speculatively-executed result ENTERS
        // the context — backfill the run result cache with the processed
        // output so a later identical call can be stubbed at the consult
        // above. And when this call is a SIGNATURE duplicate (a different,
        // earlier call whose identical output is already in the context),
        // the registry's full replay is exactly the W2 waste: serve the
        // cache's stub treatment instead. An explicit replay of THIS
        // call's own executionId (its speculative completion) is not a
        // repeat — the content enters the context here, in full.
        let servedOutput = replayOutput;
        if (this.resultCacheEnabled) {
          const cacheName = this.resultCacheName(toolName, args);
          if (cacheName) {
            this.resultCache.store(cacheName, args, replayOutput);
            if (execRecord.executionId !== tc.id) {
              const hit = this.resultCache.lookup(cacheName, args);
              if (hit?.kind === 'stub') {
                servedOutput = hit.text;
                this.events.emit({
                  type: 'agent:log',
                  agentId: this.id,
                  message: `[smartturns] result-cache stub on registry replay: ${cacheName} (~${hit.savedChars} chars not re-injected)`,
                });
              }
            }
          }
        }
        this.context.addMessage({
          role: 'tool',
          tool_call_id: tc.id,
          name: tc.function.name,
          content: servedOutput,
        });
        this.events.emit({
          type: 'tool:completed',
          tool: tc.function.name,
          result: { toolCallId: tc.id, name: tc.function.name, output: servedOutput, durationMs: 0 },
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
      taskKind: this.taskKind,
      toolAllowlist: this.toolAllowlist,
      // Delegation bundle (sync + background spawn/collect/cancel + review
      // fleets), present only while this agent may still delegate —
      // depth < safety.maxSubagentDepth (default 2).
      ...this.spawnerContext(),
      // Interactive questions are a top-level affordance (see above): deeper
      // agents resolve ask_question to deterministic defaults instead.
      ...(this.subagentDepth === 0 && this.promptUser ? { promptUser: this.promptUser } : {}),
      callerEmittedEvent: true,
    };
    this.events.emit({ type: 'tool:called', tool: tc.function.name, args, agentId: this.id, tool_call_id: tc.id });
    const { output, error, durationMs, images } = await executeTool(tc.function.name, args, ctx, this.tools) as { output: string; error?: string; durationMs: number; images?: Array<{ type: 'image_url'; image_url: { url: string } }> };
    // Reproduce-first gate: a shell/verify/bg_task call that EXECUTED counts
    // as a reproduction attempt — success or failure (a failing run IS the
    // reproduction). Set here, past every veto path, so only calls that
    // actually ran count. bg_task merely queues work, so it counts only when
    // the queueing itself succeeded.
    if (!this.reproAttempted && (toolName === 'shell' || toolName === 'verify' || (toolName === 'bg_task' && !error))) {
      this.reproAttempted = true;
    }
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
      // S4: feed the run result cache (read-only calls only — the same
      // identity the lookup consults; validity is enforced at lookup
      // time via the mutation epoch + history generation stamps).
      if (this.resultCacheEnabled) {
        const cacheName = this.resultCacheName(toolName, args);
        if (cacheName) this.resultCache.store(cacheName, args, foldedOutput);
      }
      // MCH-28: a successful accept_plan call flips plan mode to "plan
      // submitted" — the loop's no-tool-call path then ends the run with the
      // submitted plan instead of regex-guessing prose shape.
      if ((TOOL_ALIASES[toolName] || toolName) === 'accept_plan' && this.planMode && String(result.output ?? '').startsWith('Plan accepted')) {
        this.planAccepted = true;
        // Recover the submitted plan text from the persisted artifact.
        try {
          const saved = this.workspace.readJson<{ plan?: string }>('state/plan.json', {});
          if (typeof saved.plan === 'string' && saved.plan) this.planAcceptedText = saved.plan;
        // Discipline: an adopted plan defines what "on-task" means — its
        // files and vocabulary join the contract's relevance set, so the
        // drift guard measures against the PLAN, not just the task title.
        if (this.planAcceptedText) this.discipline?.adoptPlan(this.planAcceptedText);
        } catch { /* fall back to prose */ }
      }
      // Quality slice 5: track result-hash redundancy. When the model re-reads
      // the same file (or any tool returns the same output repeatedly) it has
      // lost the thread. The result-hash map feeds the STRUGGLE STATE
      // injector on the next iteration. Cap entries at 50 to bound memory.
      this.trackToolResultHash(toolName, foldedOutput);
    }
    // Wave H3 + EYES: the computer tool's screenshot rides inline in the tool
    // message for vision-capable models (capped/downscaled by
    // buildScreenshotImage; text-only models degrade to the path-only result).
    // Any OTHER tool that produced pictures (rendered pages, captures) hands
    // them to the model as image parts on a follow-up user turn — otherwise
    // the agent photographs the screen and then acts on it blind.
    let toolContent: string | ContentPart[] = foldedOutput;
    if (toolName === 'computer') {
      const shot = takeLastComputerScreenshot(this.workspace.stateDir);
      if (shot && !err && foldedOutput.includes(shot.path)
        && modelSupportsVision(this.config.model.model, this.config.model.provider)) {
        const built = buildScreenshotImage(shot.png);
        if (built) {
          const note = built.downscaled
            ? `\n[screenshot inlined at ${built.width}x${built.height}, downscaled from ${built.origWidth}x${built.origHeight} — image coordinates map to display pixels at x${(built.origWidth / built.width).toFixed(2)}]`
            : '\n[screenshot inlined below]';
          toolContent = [
            { type: 'text', text: foldedOutput + note },
            { type: 'image_url', image_url: { url: built.dataUri } },
          ];
        } else {
          toolContent = `${foldedOutput}\n[screenshot not inlined: the frame exceeds the ${SCREENSHOT_INLINE_MAX_BYTES}-byte inline cap even after downscaling — read the file at the path above to view it]`;
        }
      }
    }
    this.context.addMessage({ role: 'tool', tool_call_id: tc.id, content: toolContent, name: tc.function.name });
    // EYES (generic tools): images returned by non-computer tools go on a
    // user turn right after the tool result so the model's next turn is
    // grounded in what the tool actually saw.
    if (toolName !== 'computer' && images && images.length > 0) {
      this.context.addMessage({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `[${images.length} image(s) captured by the \`${toolName}\` tool — this is what the screen/page looks like right now. Use the coordinates and labels you can see to drive the next action.]`,
          },
          ...images,
        ],
      });
    }
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
    // Durable journal (C6): record the step as it completes — synchronous
    // fsynced append, so a kill after this point never re-executes it on
    // resume. Only real executions reach here (vetoes return early and are
    // never journaled); failed steps are recorded for audit but are not
    // replayable — a resume retries them.
    if (this.journal && isJournalableTool(toolName)) {
      try {
        this.journal.recordToolResult({ toolCallId: tc.id, toolName, args, output: foldedOutput, error: err, durationMs });
        this.journalRecorded++;
      } catch { /* journal must never affect the run */ }
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

  // P0.5 — one evidence standard on the default path. verify() now speaks
  // the VerifierEngine's verdict vocabulary (see LoopVerification below) and
  // enforces its three load-bearing behaviors in-loop: scoped git-diff
  // evidence (the mutation check scopes itself to this run's changed files),
  // the adversarial mutation downgrade on genuine test passes, and
  // BLOCKED-instead-of-PASS when a mutation-expecting task has no verifiable
  // deliverable. The engine itself is NOT re-run here: it would re-execute
  // the whole check set a second time on every completion attempt and spend
  // the run's model budget on its judge. The judge remains a goals-layer
  // step, run once per task on top of this gate.

  /** P0.5 grounding for the no-change BLOCK: the completion gate only
   *  demands file changes when the workspace/task actually ground that
   *  expectation — a git repo, a detected repo check, an explicit
   *  verification command / criteria / fileScope, or a task that names a
   *  file that exists. A mutation-kind task in a completely empty scratch
   *  directory (no repo, no files, nothing runnable) has nothing to mutate
   *  and nothing to check against; prose remains its only possible
   *  deliverable and keeps the historical pass. */
  private changeExpectationGrounded(task: Task, repo: ReturnType<typeof detectRepo>): boolean {
    return this.isGitWorkspace()
      || Boolean(repo.testCommand || repo.buildCommand)
      || Boolean(task.verificationCommand)
      || (task.acceptanceCriteria?.length ?? 0) > 0
      || (task.fileScope?.length ?? 0) > 0
      || this.taskMentionsExistingFile(task);
  }

  /** File-path tokens named by the task text (title + description). */
  private taskFileTokens(task: Task): string[] {
    const text = `${task.title} ${task.description ?? ''}`;
    return (text.match(/[\w./-]+\.[a-z]{1,6}\b/g) ?? [])
      .map((t) => t.replace(/^\.\//, '').replace(/[.,;:)]+$/, ''))
      .filter((t) => t && !t.includes('://'));
  }

  /** Does the task text name a file that exists in the workspace? */
  private taskMentionsExistingFile(task: Task): boolean {
    for (const token of this.taskFileTokens(task)) {
      try { if (existsSync(resolve(this.cwd, token))) return true; } catch { /* keep looking */ }
    }
    return false;
  }

  /** Was the run's own verification attempt vetoed by policy (approval
   *  denial / hook) this run? The completion gate must not BLOCK a run for
   *  missing evidence that the user's own policy forbade it to gather —
   *  "verification was denied; reporting without it" is the designed
   *  outcome of a denied verify call. */
  private verifyWasPolicyDenied(): boolean {
    return this.vetoLog.some((v) => v.tool === 'verify');
  }

  /** Did any file the task names (text tokens or fileScope) exist when the
   *  run STARTED? Judged from the run-start probe (populated in run());
   *  direct verify() calls without a run fall back to current existence.
   *  This is the creation-vs-modification line for the checks-empty BLOCK:
   *  a deliverable the run created from nothing carries file existence as
   *  its evidence (the greenfield standard), while a change to a file that
   *  was already there is exactly what must not pass unchecked. */
  private taskNamesPreExistingFile(task: Task): boolean {
    const tokens = [...(task.fileScope ?? []), ...this.taskFileTokens(task)];
    for (const token of tokens) {
      const probed = this.namedPathsExistedAtStart.get(token);
      if (probed !== undefined) { if (probed) return true; continue; }
      try { if (existsSync(resolve(this.cwd, token))) return true; } catch { /* keep looking */ }
    }
    return false;
  }

  /** Does the git worktree show a change to a TRACKED file (modification,
   *  deletion, rename) as opposed to pure creations (untracked '??' or
   *  staged-new 'A*')? Best-effort: any git failure reads as "no tracked
   *  modification known". */
  private async gitShowsModifiedTrackedFile(): Promise<boolean> {
    if (!this.isGitWorkspace()) return false;
    try {
      const out = await this.runShell('git status --porcelain', 15);
      if (!/^exit_code: 0\b/.test(out)) return false;
      return this.filterHarnessStatus(out).split('\n').filter(Boolean)
        .some((line) => { const xy = line.slice(0, 2); return xy !== '??' && !xy.startsWith('A'); });
    } catch { return false; }
  }

  /** Files this run changed, for the flaky gate's anti-gaming rule: tool-
   *  tracked modifications plus the live git status (shell mutations never
   *  reach filesModified). Harness state (.mochi) is filtered out — a flake
   *  in a file the HARNESS touched is not the model's own edit. */
  private async changedFilesForFlakeGate(): Promise<string[]> {
    const files = new Set<string>();
    for (const f of this.context.state.filesModified) files.add(f.replace(/^\.\//, ''));
    if (this.isGitWorkspace()) {
      try {
        const out = await this.runShell('git status --porcelain', 15);
        if (/^exit_code: 0\b/.test(out)) {
          for (const line of this.filterHarnessStatus(out).split('\n')) {
            if (line.length < 4) continue;
            const p = (line.slice(3).trim().replace(/^"|"$/g, '').split(' -> ').pop() ?? '').trim();
            if (p) files.add(p);
          }
        }
      } catch { /* best-effort: tool-tracked files still apply */ }
    }
    return [...files];
  }

  /** Gate entry point: runs the completion gate and stamps its structured
   *  verdict on the run (lastVerifyStatus) so finish-time attribution —
   *  skill lifecycle evidence, trajectory export — reads the GATE's final
   *  word rather than re-deriving it from success booleans. */
  private async verify(task: Task, repo: ReturnType<typeof detectRepo>): Promise<LoopVerification> {
    const v = await this.verifyGate(task, repo);
    this.lastVerifyStatus = v.status;
    return v;
  }

  /** The run's final verdict for skill attribution, in trajectory
   *  vocabulary. The gate's structured status is authoritative; the
   *  verifyCount/lastVerifyPassed pair is only a fallback for paths that
   *  counted attempts without a gate call (defensive — the wrapper stamps
   *  every gate call). 'none' = no verification evidence exists, and
   *  attribution must not invent any. */
  private skillRunVerdict(): 'pass' | 'fail' | 'partial' | 'blocked' | 'none' {
    if (this.lastVerifyStatus) {
      switch (this.lastVerifyStatus) {
        case 'PASS': return 'pass';
        case 'FAIL': return 'fail';
        case 'PARTIAL': return 'partial';
        case 'BLOCKED': return 'blocked';
      }
    }
    if (this.verifyCount > 0) return this.lastVerifyPassed ? 'pass' : 'fail';
    return 'none';
  }

  private async verifyGate(task: Task, repo: ReturnType<typeof detectRepo>): Promise<LoopVerification> {
    if (this.profile?.verification === 'none') {
      return { passed: true, status: 'PASS', checks: [], summary: 'Verification skipped by profile.' };
    }
    const taskKind = this.taskKind ?? classifyTaskKind(task);
    if (taskKind === 'chat' || taskKind === 'research' || taskKind === 'plan' || this.planMode) {
      return { passed: true, status: 'PASS', checks: [], summary: `No verification required for ${taskKind} task.` };
    }
    // Refresh the shell-mutation flag BEFORE any gate consults it: the model
    // may have mutated the workspace entirely via shell (`sed -i`, scaffolds),
    // which never sets fileChanged.
    await this.shellMovedWorkspace();
    if (!this.fileChanged && !this.shellWorkspaceMoved && !task.verificationCommand) {
      // P0.5 — the no-change auto-pass hole is closed. A task whose kind
      // promises file mutations (fix/implement/refactor/test) but produced
      // ZERO changes has not delivered anything verifiable; the old code
      // passed it, teaching completion (and every downstream trajectory
      // label) that "did nothing" == "resolved". It now returns the
      // VerifierEngine's BLOCKED verdict as a failed verify, so the run
      // retries and ends verification_failed instead of completed.
      // Exemptions mirror the reproduce-first gate's, for the same reasons:
      // warm starts (this run's changes predate it — reproFileChangedAtRunStart
      // — and were judged by the run that made them) and simple-script tasks
      // (create-and-run shape; the run itself is the deliverable check).
      // Read-only kinds (chat/research/plan, review→research) returned above.
      if (MUTATION_KINDS.has(taskKind) && task.role !== 'reviewer' && task.role !== 'pr_reviewer' && !this.verifyWasPolicyDenied() && !this.reproFileChangedAtRunStart && !isSimpleScriptTask(task) && this.changeExpectationGrounded(task, repo)) {
        return {
          passed: false, status: 'BLOCKED', checks: [],
          summary: `Verification blocked: this ${taskKind} task requires file changes, but the run changed no files (no write/edit/patch and no shell-side workspace changes). Do the work the task asks for, then finish — completion without changes is not verifiable.`,
        };
      }
      return { passed: true, status: 'PASS', checks: [], summary: 'No changes made to verify.' };
    }

    const checks: string[] = [];
    // Run verification commands from the task's fileScope directory when it
    // is consistent. This lets the model write commands like `npx vitest run`
    // without having to remember the `cd <dir> &&` prefix, and fixes a class
    // of "command not found" failures where the runner lives under the
    // fileScope's package.json but the project root has no test runner.
    const scopeDir = cwdForScope(this.cwd, task.fileScope);
    let pushedTaskCmd: string | undefined;
    if (task.verificationCommand) {
      const cmd = this.sanitizeVerify(task.verificationCommand);
      pushedTaskCmd = withCwd(cmd, scopeDir);
      checks.push(pushedTaskCmd);
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
      if (criteriaFailGreen) return { passed: false, status: 'FAIL', checks, summary: criteriaFailGreen };
      if (this.fileChanged) return { passed: true, status: 'PASS', checks, summary: 'Greenfield build: files created, no repo suite applicable (skipped by design).' };
    }
    // Auto-detected real test runner: only added when the explicit
    // verificationCommand is weak (e.g. `test -f ... && grep ...`) so the
    // mutation check has actual code coverage to evaluate. Skipped when the
    // command is already a real runner, and skipped for CONTENT-ONLY tasks:
    // a direct check IS the proportionate verification for content, and an
    // auto-added repo suite burns tokens / fails correct work on debt.
    // Also skipped for greenfield builds: a new game file must not trigger
    // the host repo's suite.
    let autoTestCmd: string | undefined;
    if (isWeakVerification(task.verificationCommand) && !this.contentOnly && !greenfield) {
      const auto = autoTestCommand(this.cwd, task.fileScope);
      if (auto) { autoTestCmd = auto; checks.push(auto); }
    }
    // MCH-31: independent acceptance-criteria gate runs BEFORE any command
    // logic — a task can state concrete criteria with no verification command
    // at all, and those must still gate completion (Codex re-checks acceptance
    // independently of whatever evidence the builder collected).
    const criteriaFail = this.checkArtifactCriteria(task);
    if (criteriaFail) return { passed: false, status: 'FAIL', checks, summary: criteriaFail };

    // Fast lane: targeted-only verification (see verifyGateFastLane). The
    // branches ABOVE this point are shared with the standard profile and
    // are NOT relaxed: read-only kinds, the zero-change BLOCK, greenfield
    // handling, and the acceptance-criteria gate all already ran. What the
    // lane skips is only the heavy tail below — full-repo suite/typecheck/
    // lint/build, baseline masking, flake re-runs, and the mutation check.
    if (this.fastLane && !this.fastLaneEscalated) {
      return this.verifyGateFastLane(task, repo, pushedTaskCmd);
    }

    if (checks.length === 0) {
      // P0.5 (VerifierEngine parity): files changed but NO runnable check
      // and no artifact criterion covers them. The engine returns BLOCKED
      // here, not PASS — a diff nobody can check is not a verified
      // deliverable. Content-only tasks keep the pass: for content, the
      // direct check IS the proportionate evidence, and it would have been
      // an entry in `checks`.
      // Modification evidence is required: pure creations (a new file in a
      // workspace with no check infrastructure — the one-shot build flow)
      // carry file existence as their proportionate evidence and keep the
      // historical pass; the BLOCK targets changes to PRE-EXISTING code
      // (a tracked file modified per git status, or a task-named file that
      // existed at run start) that nothing checks.
      if (MUTATION_KINDS.has(taskKind) && !this.contentOnly && !greenfield && !this.greenfieldTask
        && (await this.gitShowsModifiedTrackedFile() || this.taskNamesPreExistingFile(task))) {
        return {
          passed: false, status: 'BLOCKED', checks,
          summary: 'Verification blocked: files were changed, but no verification command, repo check, or artifact acceptance criterion covers them. Add a verification command or acceptance criteria for the changed files, or run the project tests so the change is actually checked.',
        };
      }
      return { passed: true, status: 'PASS', checks, summary: 'No verification configured.' };
    }

    const baseline = await this.verifyBaseline;
    // Flaky-test quarantine (src/core/flaky.ts): a failed check gets a
    // bounded re-run classification before it may fail the run — flakes are
    // excused loudly, consistent failures stand, and flakes in files THIS
    // run changed are never excused (anti-gaming). Registry persists at
    // .mochi/state/flaky-tests.json across runs.
    const flakyRegistry: FlakyRegistry = loadFlakyRegistry(this.workspace);
    const knownFlakyAtStart = new Set(knownFlakyCommandKeys(flakyRegistry));
    const flakyRefs: FlakyTestRef[] = [];
    const flakeTargets = [...(task.fileScope ?? []), ...this.taskFileTokens(task)];
    const resolveFlakyFailure = async (
      cmd: string,
      firstOut: string,
    ): Promise<{ kind: 'flaky'; hits: FlakyTestRef[] } | { kind: 'fail'; output: string; note?: string }> => {
      const analysis = await analyzeFailure(
        cmd,
        { exitCode: exitCodeOfEnvelope(firstOut), output: firstOut },
        async () => {
          const out = await this.runShell(cmd, 180);
          return { exitCode: exitCodeOfEnvelope(out), output: out };
        },
      );
      if (analysis.flakyIds.length > 0) {
        recordFlakes(flakyRegistry, flakeCommandKey(cmd), analysis.flakyIds, firstOut);
        saveFlakyRegistry(this.workspace, flakyRegistry);
      }
      if (!analysis.eligible || !analysis.resolved || analysis.flakyIds.length === 0) {
        return {
          kind: 'fail',
          output: analysis.eligible ? analysis.lastOutput : firstOut,
          note: analysis.flakyIds.length > 0
            ? `Note: ${analysis.flakyIds.join(', ')} flaked during re-runs (recorded in the flaky registry), but no re-run went fully green, so this failure stands.`
            : undefined,
        };
      }
      const parts = partitionFlakes(analysis.flakyIds, await this.changedFilesForFlakeGate(), flakeTargets);
      const hits: FlakyTestRef[] = parts.excused.map((id) => ({
        id, command: cmd, known: isKnownFlaky(flakyRegistry, id), ownTarget: parts.ownTarget.includes(id),
      }));
      flakyRefs.push(...hits);
      if (parts.ownEdit.length > 0) {
        return {
          kind: 'fail',
          output: analysis.lastOutput,
          note: `Flake excuse DENIED for ${parts.ownEdit.join(', ')}: the test file was changed by this run, so its failure is treated as a real failure, not flakiness.`,
        };
      }
      this.events.emit({
        type: 'agent:log', agentId: this.id,
        message: `[flaky] ${cmd}: ${hits.map((h) => h.id).join(', ')} flaked (passed on re-run, tree unchanged) — excused and recorded in the flaky registry`,
      });
      return { kind: 'flaky', hits };
    };
    // Intent gate on debt-masking: when the TASK ITSELF demands green checks
    // ("make npm test pass", "fix so pytest passes"), a failing check IS the
    // success criterion - pre-existing identical failure must NOT mask it.
    // Dogfood finding: masking let an unfixed broken runner count as done.
    const wantsGreen = /\b(make|get|turn)\b[^.\n]{0,60}\b(pass|green)\b|\b(tests?|suite)\b[^.\n]{0,40}\b(must|should|to)\b[^.\n]{0,20}\bpass\b|\ball tests?\b|\b(pytest|npm test|node --test|go test|vitest|jest)\b[^.\n]{0,40}\b(pass(ing|es)?|green)\b/i.test(
      `${task.title} ${task.description} ${(task.acceptanceCriteria ?? []).join(' ')}`,
    );

    // Fast-fail with the blast-radius subset for the changed files before
    // paying for the full suite. A targeted failure is breakage in the code
    // the agent just touched, so surface it now and skip the slow checks this
    // iteration; on a targeted pass we still run the authoritative full set
    // below (a narrow pass never stands in for the real gate — the subset is
    // a PARTIAL result, labeled as such in the summary).
    if (repo.testCommand && checks.includes(repo.testCommand)) {
      try {
        const plan = await planVerificationTests(this.cwd, repo, repo.testCommand, { cadence: false });
        if (plan.command) {
          const out = await this.runShell(plan.command, 180);
          const exitLine = out.match(/^exit_code: (\d+)/);
          const failedNow = !((exitLine && Number(exitLine[1]) === 0) || out.trim().endsWith('PASS'));
          if (failedNow && (wantsGreen || !matchesBaseline(baseline, plan.command, out))) {
            // Flake classification before the fast-fail: a targeted failure
            // that goes green on a bounded re-run of the unchanged command
            // is a flake — fall through to the authoritative full set rather
            // than failing the run on a coin flip.
            const flake = await resolveFlakyFailure(plan.command, out);
            if (flake.kind === 'fail') {
              const condensed = condenseOutput(flake.output, { maxLines: 60, preserveContext: 3 });
              return { passed: false, status: 'FAIL', checks: [plan.command], summary: `Check failed: ${plan.command} (PARTIAL targeted pre-check: ${plan.reason})\n${condensed.condensed}${flake.note ? `\n${flake.note}` : ''}` };
            }
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
    // Genuine passes (strict exit-0 parse, NOT baseline-masked) — the
    // mutation gate below keys on these, mirroring the VerifierEngine's
    // rule that only a test command that really ran green counts.
    const genuinePasses: string[] = [];
    for (const { cmd, out } of outcomes) {
      // Strict exit-code parse: the old substring check false-PASSed when
      // "exit_code: 0" was echoed inside stdout/stderr of a failing command.
      const exitLine = out.match(/^exit_code: (\d+)/);
      if (exitLine && Number(exitLine[1]) === 0) genuinePasses.push(cmd);
      if ((exitLine && Number(exitLine[1]) === 0) || out.trim().endsWith('PASS')) {
        // A clean first-attempt pass decays this command's flaky scores —
        // healing evidence, persisted only when it changes the registry.
        if (exitLine && Number(exitLine[1]) === 0 && recordCleanPass(flakyRegistry, flakeCommandKey(cmd))) {
          saveFlakyRegistry(this.workspace, flakyRegistry);
        }
        continue;
      }
      // Pre-existing failure: identical failure captured before this run
      // started. It is repo debt, not agent breakage; do not fail the task.
      if (!wantsGreen && matchesBaseline(baseline, cmd, out)) {
        continue;
      }
      // Flake classification: bounded re-runs of the unchanged command.
      // Excused flakes do NOT join genuinePasses — a command that just
      // flaked is not a trustworthy mutation-check baseline either.
      const flake = await resolveFlakyFailure(cmd, out);
      if (flake.kind === 'flaky') continue;
      const condensed = condenseOutput(flake.output, { maxLines: 60, preserveContext: 3 });
      return { passed: false, status: 'FAIL', checks, summary: `Check failed: ${cmd}\n${condensed.condensed}${flake.note ? `\n${flake.note}` : ''}` };
    }

    // P0.5 — adversarial mutation check (VerifierEngine parity). A suite
    // that passes but cannot catch an injected logic bug in the very files
    // this run changed is not evidence the change is guarded. The engine
    // downgrades PASS → PARTIAL on a surviving mutant; this binary gate
    // expresses PARTIAL as a failed verify carrying the engine's
    // harden-your-tests recommendation, so the model gets bounded retries
    // to close the coverage hole instead of completing on a hollow pass.
    // Gating mirrors the engine: a real (non-weak) test command must have
    // genuinely passed above — baseline-masked failures and missing-tool
    // skips do not count. Content-only and greenfield runs skip it: there
    // is no behavior for a suite to guard. Best-effort like the engine's:
    // a machinery error never fails verification by itself.
    if (!this.contentOnly && !greenfield && !this.greenfieldTask) {
      const mutationCmd =
        (autoTestCmd && genuinePasses.includes(autoTestCmd) ? autoTestCmd : undefined) ??
        (repo.testCommand && genuinePasses.includes(repo.testCommand) && !isWeakVerification(repo.testCommand) ? repo.testCommand : undefined) ??
        (pushedTaskCmd && genuinePasses.includes(pushedTaskCmd) && !isWeakVerification(task.verificationCommand) ? pushedTaskCmd : undefined);
      // Flaky commands are excluded from the mutation check (VerifierEngine
      // parity): a baseline that flips on its own makes killed/survived
      // verdicts unreadable. Known = quarantined in the registry, or flaked
      // during this very verify.
      const mutationCmdFlaky = Boolean(mutationCmd) && (
        knownFlakyAtStart.has(flakeCommandKey(mutationCmd as string)) ||
        flakyRefs.some((f) => f.command === mutationCmd)
      );
      if (mutationCmd && mutationCmdFlaky) {
        this.events.emit({
          type: 'agent:log', agentId: this.id,
          message: `[flaky] mutation check skipped for ${mutationCmd}: known-flaky command (quarantine) — flaky baselines make mutant verdicts unreadable`,
        });
      }
      if (mutationCmd && !mutationCmdFlaky) {
        try {
          const mutation = await runMutationCheck(
            this.cwd,
            mutationCmd,
            async (c) => {
              const out = await this.runShell(c, 180);
              const m = out.match(/^exit_code: (\d+)/);
              return m ? Number(m[1]) : 1;
            },
            async (c) => {
              const out = await this.runShell(c, 180);
              return out.replace(/^exit_code: \d+\n/, '');
            },
            task.fileScope,
            // The default path inherits arbitrary repo test scripts; a
            // command that prints nothing on a green run (placeholder
            // scripts like `node -e "process.exit(0)"`) cannot observe a
            // mutant, so its "survival" must not downgrade the gate.
            { requireObservableBaseline: true },
          );
          if (mutation.applied && mutation.survived) {
            return {
              passed: false, status: 'PARTIAL', checks,
              summary: `All checks passed (${checks.join(', ')}), but the mutation check failed: ${mutation.note ?? 'an injected logic bug was NOT caught by the tests'} — the tests do not guard the changed logic. Harden the tests to cover this path, then finish.`,
            };
          }
        } catch {
          /* adversarial best-effort; never fail verification on its own machinery */
        }
      }
    }
    // FLAKY-PASS: green only via flake resolution. Completion is NOT blocked
    // (the suite demonstrably passed with the tree unchanged), but the
    // verdict is a distinct status and the summary names the flakes loudly —
    // a coin-flip pass must never masquerade as a trustworthy one.
    if (flakyRefs.length > 0) {
      const byCommand = new Map<string, FlakyTestRef[]>();
      for (const ref of flakyRefs) {
        const list = byCommand.get(ref.command) ?? [];
        list.push(ref);
        byCommand.set(ref.command, list);
      }
      const flakyNote = [...byCommand.entries()].map(([cmd, hits]) => formatFlakyHits(hits, cmd)).join('\n');
      return {
        passed: true, status: 'FLAKY-PASS', checks, flaky: flakyRefs,
        summary: `All checks passed: ${checks.join(', ')}\n${flakyNote}`,
      };
    }
    return { passed: true, status: 'PASS', checks, summary: `All checks passed: ${checks.join(', ')}` };
  }

  /**
   * Fast-lane verification: the changed files' OWN checks, nothing else —
   * the task's explicit verification command, the tests related to the
   * changed files (planTargetedTests), and a per-file syntax check for
   * changed script files. The evidence standard is the standard gate's:
   * a mutation-kind change to pre-existing code that NO check covers is
   * BLOCKED, exactly as in the full gate's checks.length===0 branch; a
   * failing check is a FAIL with no baseline masking and no flake excuse
   * (an excused flake in the lane is indistinguishable from a real failure
   * the lane was too cheap to see — the failure feeds escalation instead).
   */
  private async verifyGateFastLane(
    task: Task,
    repo: ReturnType<typeof detectRepo>,
    pushedTaskCmd: string | undefined,
  ): Promise<LoopVerification> {
    const checks: string[] = [];
    if (pushedTaskCmd) checks.push(pushedTaskCmd);
    if (repo.testCommand) {
      let targeted = false;
      try {
        const plan = await planTargetedTests(this.cwd, repo, repo.testCommand);
        if (plan.command && !checks.includes(plan.command)) { checks.push(plan.command); targeted = true; }
      } catch { /* targeting is best-effort; the task command still covers */ }
      // Composition fix (R1×S4 integration): when targeting finds no
      // behavioral check, a syntax check alone does not "cover" a change —
      // the deliberately-wrong-but-valid fix in S4's A3 fixture passed the
      // lane on `node --check` alone while the full gate rejected it. Fall
      // back to the repo test command so the lane's evidence standard is
      // the standard gate's whenever targeting comes up empty; the lane
      // keeps its savings exactly when targeting does find the checks.
      if (!targeted && !checks.includes(repo.testCommand)) checks.push(repo.testCommand);
    }
    for (const f of new Set(this.context.state.filesModified)) {
      const rel = f.startsWith(this.cwd) ? f.slice(this.cwd.length + 1) : f;
      if (/\.(?:js|mjs|cjs)$/.test(rel)) checks.push(`node --check ${rel}`);
      else if (/\.py$/.test(rel)) checks.push(`python3 -m py_compile ${rel}`);
    }
    if (checks.length === 0) {
      // Mirror of the standard gate's checkless-change BLOCK: files changed
      // but nothing runnable covers them. Pure creations keep the standard
      // exemption (existence is their proportionate evidence).
      const taskKind = this.taskKind ?? classifyTaskKind(task);
      if (MUTATION_KINDS.has(taskKind) && !this.contentOnly
        && (await this.gitShowsModifiedTrackedFile() || this.taskNamesPreExistingFile(task))) {
        return {
          passed: false, status: 'BLOCKED', checks,
          summary: 'Verification blocked (fast lane): files were changed, but no targeted check covers them. Add a verification command or acceptance criteria for the changed files, or run the project tests so the change is actually checked.',
        };
      }
      return { passed: true, status: 'PASS', checks, summary: 'No verification configured (fast lane).' };
    }
    const outcomes = await Promise.all(
      checks.map(async (cmd) => ({ cmd, out: await this.runShell(cmd, 120) })),
    );
    for (const { cmd, out } of outcomes) {
      const exitLine = out.match(/^exit_code: (\d+)/);
      if ((exitLine && Number(exitLine[1]) === 0) || out.trim().endsWith('PASS')) continue;
      const condensed = condenseOutput(out, { maxLines: 60, preserveContext: 3 });
      return { passed: false, status: 'FAIL', checks, summary: `Check failed (fast lane): ${cmd}\n${condensed.condensed}` };
    }
    // Summary format matters beyond cosmetics: discipline's decisive-finish
    // only skips the self-review round for summaries verifySummaryEvidenced
    // recognises ('All checks passed: <real commands>'). A lane-specific
    // phrasing silently cost every clean fast-lane run an extra review turn
    // the standard profile never pays — the bench's turn counts caught it.
    return { passed: true, status: 'PASS', checks, summary: `All checks passed: ${checks.join(', ')} [fast lane — targeted set]` };
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
   * Reproduce-first gate: does this mutating call touch something that
   * ALREADY EXISTS on disk? Creating a brand-new file is building an
   * artifact (very often the repro/regression script itself), not patching
   * existing behavior, so it must not trip the gate, spend its one veto,
   * or be recorded as a bypass. Returns:
   *  - 'exists': at least one determinable target exists → gate applies.
   *  - 'absent': targets were determined and NONE exist → skip the gate.
   *  - 'unknown': the target(s) cannot be determined from the args (e.g.
   *    replace_symbol, whose file is resolved from the codegraph at
   *    execution time) → keep the gate (pre-exemption behavior).
   */
  private reproMutationTargetState(toolName: string, rawArgs: string): 'exists' | 'absent' | 'unknown' {
    const args = normalizeToolArgs(toolName, this.parseArgs(rawArgs));
    const candidates: string[] = [];
    const push = (v: unknown): void => { if (typeof v === 'string' && v.trim()) candidates.push(v); };
    switch (toolName) {
      case 'patch': {
        // Multi-target: the gate fires only if at least one section
        // targets an existing file; a patch that only adds new files is
        // pure creation. An unparseable patch is 'unknown' (gate fires).
        const text = typeof args.patch === 'string' ? args.patch : '';
        if (!text) return 'unknown';
        let sections: Array<{ path: string }>;
        try { sections = parsePatch(text); } catch { return 'unknown'; }
        if (!sections.length) return 'unknown';
        for (const s of sections) push(s.path);
        break;
      }
      case 'move_file':
      case 'copy_file':
        push(args.source);
        push(args.destination);
        break;
      case 'search_replace_multi':
      case 'rename_symbol':
        // `path` is an optional SCOPE (a file or a directory). Without it
        // the tool sweeps the whole workspace — the individual targets are
        // undeterminable here and the workspace itself exists, so the gate
        // keeps its current behavior.
        if (typeof args.path !== 'string' || !args.path.trim()) return 'unknown';
        push(args.path);
        break;
      case 'replace_symbol':
        // No path arg at all: the file is resolved from the codegraph by
        // symbol name at execution time — undeterminable at gate time.
        return 'unknown';
      default:
        // write / edit / delete / regex_replace / notebook /
        // create_directory / mkdir: a single `path` arg (aliases were
        // normalized into `path` by normalizeToolArgs).
        push(args.path);
        break;
    }
    if (!candidates.length) return 'unknown';
    for (const c of candidates) {
      try { if (existsSync(this.resolveTargetPath(c))) return 'exists'; } catch { /* unreadable -> treat as absent */ }
    }
    return 'absent';
  }

  /**
   * Reproduce-first gate eligibility for the CURRENT run. Enforced only where
   * "edit first, understand later" is the observed failure mode: fix/debug
   * kinds on an existing codebase. Never fires for chat (mutations already
   * vetoed there), plan mode (mutations already vetoed there), greenfield /
   * content-only creation (nothing exists to reproduce yet), or runs whose
   * instance already changed files BEFORE this run started (resume / warm
   * start — the repro, if any, happened in the earlier session). The
   * run-start snapshot is deliberate: an exempt new-file creation during
   * THIS run flips live `fileChanged` too, and must not disarm the gate
   * for a later edit to an existing file. Kill-switch: MOCHI_REPRO_FIRST=0.
   */
  /** Repro synthesis (observability/repro-synth.ts): when the
   *  reproduce-first veto fires and the model has not supplied a repro,
   *  attempt to synthesise a validated one from the failure material the
   *  run already has (task title/description + the last tool error) and
   *  return a message fragment handing it to the model. In-place mode
   *  only: one confirmation run in the real tree, no shrinking, nothing
   *  written. Best-effort by design — any failure returns null and the
   *  gate behaves exactly as it did before synthesis existed.
   *  Kill-switch: MOCHI_REPRO_SYNTH=0. */
  private async trySynthesizeRepro(): Promise<string | null> {
    if (this.reproSynthTried || !reproSynthEnabled()) return null;
    this.reproSynthTried = true;
    try {
      const task = this.activeTask;
      const material = [task?.title ?? '', task?.description ?? '', this.lastToolError ?? '']
        .filter(Boolean).join('\n');
      if (!material.trim()) return null;
      const result = await synthesizeRepro({
        repoRoot: this.workspace.dir,
        text: material,
        source: 'task-text',
        testCommand: task?.verificationCommand,
      }, { inPlace: true, timeoutMs: 30_000 });
      if (result.outcome === 'validated') {
        this.events.emit({ type: 'agent:log', agentId: this.id, message: `[repro-synth] synthesised + validated a repro for this task: ${result.candidate.command}` });
        const sig = result.validation.signature;
        return `A minimal reproduction was synthesised and verified against the current tree — run it (shell) to observe the failure, then re-run it after your fix to prove the fix:\n  ${result.candidate.command}${sig ? `\nIt currently fails with: ${sig}` : ''}`;
      }
      this.events.emit({ type: 'agent:log', agentId: this.id, message: `[repro-synth] synthesis attempted first; outcome=${result.outcome} — model reproduces manually` });
      return null;
    } catch { return null; }
  }

  private reproGateApplies(): boolean {
    if (process.env.MOCHI_REPRO_FIRST === '0') return false;
    // Test seam: scripted-fake harnesses can't adapt to a one-shot veto, so
    // scripted-e2e configs disable the gate explicitly.
    if ((this.config.safety as { skipReproGate?: boolean } | undefined)?.skipReproGate) return false;
    if (this.planMode || this.contentOnly || this.reproFileChangedAtRunStart) return false;
    const kind = this.taskKind;
    if (kind !== 'fix') return false;
    const task = this.activeTask;
    if (!task) return false;
    // The classifier's 'fix' lane also catches pure-logic one-shot script
    // fixes ("fix sum.js, run node run.js") — those ARE create-and-run tasks
    // whose "repro" is the run after the edit, so the gate would only tax
    // them. Same exemption the reasoning tiers already grant this shape.
    if (isSimpleScriptTask(task)) return false;
    // NOTE: no isGreenfieldTask exemption here, deliberately. That heuristic
    // (creation-verb + greenfield-noun) misfires on genuine fix tasks —
    // "diagnose the existing CODE" + "the repro SCRIPT fails" trips both
    // halves — and a task the classifier put in the fix lane is by
    // definition about existing behavior. Greenfield creation tasks
    // classify as implement/content kinds, never fix, and content-only
    // deliverables are exempted above.
    return true;
  }

  /**
   * Speculative reasoning preflight gate. The SpeculativeEngine builds its
   * own provider from this.config.model (bound to a 'reasoning' profile we
   * can borrow), and we bind the engine to a fresh budget that borrows the
   * shared run budget's limits so a runaway preflight can't silently
   * overspend the task's model-call allocation.
   *
   * DEFAULT (changed 2026-10): preflight used to be strictly opt-in
   * (config.model.speculative.preflight === true), which meant Mochi's best
   * reasoning feature never ran in practice. It now defaults ON for
   * structurally COMPLEX tasks at medium+ reasoning — the tasks where a
   * cheap multi-candidate pass pays for itself — while simple/standard
   * tasks keep the lean path (the cost concern that made it opt-in).
   * Explicit config wins both ways: `preflight: true` forces it on for any
   * non-chat kind (the historical behavior), `preflight: false` disables it
   * outright. MOCHI_SPECULATIVE_PREFLIGHT=0 is a hard env kill-switch.
   * Exported as a pure function (specPreflightDefault) so the policy is
   * unit-testable without orchestrating the whole loop.
   */
  private specPreflightEnabled(task?: Task): boolean {
    return specPreflightDefault({
      configured: this.config.model?.speculative?.preflight,
      env: process.env.MOCHI_SPECULATIVE_PREFLIGHT,
      complexity: this.taskComplexity,
      reasoning: task ? this.resolveReasoning(task) : undefined,
    });
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
      // start() resets startedAt (the wall-clock baseline): calling it on the
      // SHARED session budget restarted maxRuntimeMinutes mid-session, so
      // every speculative-preflight run silently bought a full fresh runtime
      // window and runtime_limit accounting lied. Only a freshly created
      // engine starts its clock; the shared one is already running.
      if (!shared) budget.start();
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
    for (const l of this.lastLessons) this.surfacedLessonIds.add(l.id);

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

    // Discipline (evidence-gated replanning): the diagnosis package below
    // is a RECONSIDERATION device — it asks the model to re-derive its
    // approach from hypotheses. Reconsideration is only permitted on new
    // evidence (a failure class not seen before, a fresh tool-error
    // signature, a user steer). The same failure recurring with nothing new
    // gets a terse continuation instead: the plan stands, execute it. The
    // bookkeeping above (autopsy, lessons, probes) still ran — only the
    // model-facing re-plan is gated.
    if (this.discipline && this.disciplineFlags.replanGate) {
      const gate = this.discipline.gateReconsideration('verify-failure');
      if (!gate.allowed) {
        this.events.emit({ type: 'agent:log', agentId: this.id, message: '[discipline] replan suppressed (verify-failure: no new evidence)' });
        this.context.addMessage({
          role: 'system',
          content: this.autoPlanEscapePending
            ? 'Same failure as the previous cycle — no new evidence. The plan-escape above is this cycle\'s reconsideration: answer it, then act. Do not re-plan again.'
            : 'Same failure as the previous cycle — no new evidence, so no re-plan. Continue the current plan: take the next step you already identified, or make the smallest change that tests your leading hypothesis, then re-verify.',
        });
        return;
      }
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
  /** Discipline (progress forcing): the decisive finish after a forced
   *  deliberation stop. The model's read-only batch (if any) has already
   *  executed and its results are in context. If work exists, verification
   *  is the verdict — pass completes, fail reports honestly. If no work
   *  exists, the run stops as stuck instead of burning the remaining
   *  iterations re-deliberating. Never manufactures a success. */
  private async disciplineForceFinish(task: Task, repo: ReturnType<typeof detectRepo>, lastContent?: string): Promise<AgentResult> {
    if (this.discipline) this.discipline.stats.forceFinishes++;
    this.disciplineForceArmed = false;
    this.events.emit({ type: 'agent:log', agentId: this.id, message: '[discipline] force-finished a deliberation loop' });
    if (this.fileChanged || this.shellWorkspaceMoved) {
      const v = await this.verify(task, repo);
      if (v.passed) {
        this.recordVerifyPass(v.summary);
        const summary = (lastContent && lastContent.trim())
          ? `${lastContent.trim()}\n\n${v.summary}`
          : `Complete (verified): ${v.summary}`;
        return this.finish(task, true, summary, 'completed');
      }
      return this.finish(task, false, `Stopped a deliberation loop; verification does not pass:\n${v.summary}`, 'verification_failed');
    }
    return this.finish(task, false,
      'Stopped: consecutive turns were spent deliberating (re-reading known files, re-stating the same considerations) without acting or covering new ground, and no work product exists. ' +
      'Narrow the task or provide direction and re-run.',
      'stuck_no_progress');
  }

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

  private async injectStruggleState(iter: number): Promise<void> {
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

    // MCH-203: when repeated tool errors are the struggle, surface the most
    // relevant high-quality skill's body so the model gets the FIX, not just
    // the diagnosis. Bounded to 2000 chars; never breaks the loop.
    let skillBlock = '';
    if (this.lastToolError && this.consecutiveToolErrors.size > 0) {
      try {
        const { matchSkillToError } = await import('../skills/skills.js');
        const match = matchSkillToError(String(this.lastToolError).slice(0, 300), this.workspace.dir);
        if (match) {
          skillBlock = `\n\nRELEVANT SKILL — "${match.name}":\n${match.body}`;
        }
      } catch { /* skill match must never break struggle injection */ }
    }

    const summary =
      `STRUGGLE STATE (turn ${iter + 1}) — read this BEFORE your next action:\n` +
      parts.join('\n') +
      skillBlock +
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
    // Discipline (evidence-gated replanning): the escape is a forced
    // re-plan. Register the current tool-error total as potential evidence
    // (a GROWN total is new evidence; an unchanged one is not), then peek:
    // with no new evidence since the last reconsideration, the escape is
    // suppressed — the model already re-planned for this exact situation.
    // Peeking does not consume; observeFailure's gate consumes. Bare
    // agents (no run tracker — direct unit-test calls) skip the gate.
    if (this.discipline && this.disciplineFlags.replanGate) {
      this.discipline.noteEvidence(`toolerrors:${this.totalToolErrors()}`);
      if (!this.autoPlanEscaped && !this.planMode && !this.discipline.peekReconsideration()) {
        this.events.emit({ type: 'agent:log', agentId: this.id, message: '[discipline] replan suppressed (auto-plan-escape: no new evidence)' });
        return;
      }
    }
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
        toolAllowlist: this.toolAllowlist,
        ...this.spawnerContext(),
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
    // B21: the run is over — parent steers can no longer be accepted, so a
    // late steer fails loudly at the parent instead of queueing into a
    // context that will never drain again.
    this.runActive = false;
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
    // Long-task strategy: persist the final plan state on EVERY finish
    // path, so a later resume (or a post-mortem) sees exactly which
    // milestone boundary the run stopped at.
    if (this.ltTracker) {
      try { saveMilestoneState(this.workspace, this.ltTracker.state); } catch { /* best-effort */ }
    }
    // Claude Code gates completion on the last tool's exit code; Codex re-runs
    // acceptance criteria independently. Mochi (MCH-26): a run that ENDS on a
    // failed tool call (failed git commit, failed verify command) cannot
    // truthfully be "completed" — downgrade and surface the real error, so the
    // user sees the failure instead of a false "done". Runs that RECOVERED from
    // earlier errors (last tool succeeded) still finish as completed.
    // MCH-26 (false-"Task Failed" fix): a run whose own verification gate
    // PASSED is complete by definition — the gate's structured verdict is the
    // completion evidence. A stale lastToolError from an earlier tangential
    // failed work call (a failed `git commit` probe, a verify retry, a deny
    // veto recorded as error) must NOT downgrade a gate-passed run. Downgrade
    // only when there is no explicit gate verdict, or the gate FAILED.
    if (success && this.lastToolError && this.skillRunVerdict() !== 'pass') {
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
    // B1: the same join, with the GATE's verdict, is the skill lifecycle's
    // evidence (recordSkillOutcome) and the trajectory exporter's skills[]
    // (the skills:attributed event below, lifted by buildTrajectory). The
    // verdict comes from lastVerifyStatus — the completion gate's final
    // structured word — never from the run's self-reported success.
    try {
      const { getSkillsLoadedThisRun, clearSkillsLoadedThisRun } = await import('../tools/skill.js');
      const { recordSkillUsage, recordSkillFailure, clearSkillFailures, recordSkillOutcome, recordSkillKindOutcome } = await import('../skills/skills.js');
      const loadedSkills = getSkillsLoadedThisRun();
      const verdict = this.skillRunVerdict();
      const kind = this.taskKind ?? classifyTaskKind(task);
      for (const name of loadedSkills) {
        recordSkillUsage(this.workspace.dir, name, success === true);
        recordSkillOutcome(this.workspace.dir, name, verdict, kind);
        // MCH-201: accrue win/loss outcome into the skill quality score DB.
        try {
          const { markUsed } = await import('../skills/skill-manager.js');
          markUsed(this.workspace.dir, name, { win: success === true });
        } catch { /* score accrual is best-effort */ }
        // Failure notes feed the curator's self-repair pass; a green run clears
        // the queue so a one-off flake doesn't permanently scar the skill.
        if (success === true) clearSkillFailures(this.workspace.dir, name);
        else recordSkillFailure(this.workspace.dir, name, String(this.lastToolError ?? summary).slice(0, 500));
      }
      // Baseline arm: every verified run feeds its kind's totals, whether or
      // not it loaded skills — the curator subtracts a skill's own loads to
      // get the matched no-skill comparison.
      if (verdict !== 'none') recordSkillKindOutcome(this.workspace.dir, kind, verdict === 'pass');
      // S4 effort calibration: the same gate verdict, attributed to the
      // (kind x base-tier) outcome table — pass/fail only (partial and
      // blocked are not clean solve/fail evidence). This is the data the
      // calibrated base tier in resolveReasoning() is allowed to move on.
      if (verdict === 'pass' || verdict === 'fail') {
        recordEffortOutcome(this.workspace.dir, kind, this.runBaseReasoningTier ?? resolveAutoReasoning(kind), verdict === 'pass');
      }
      this.events.emit({
        type: 'skills:attributed',
        agentId: this.id,
        skills: loadedSkills.map((id) => ({ id, verdict })),
        verifyStatus: this.lastVerifyStatus ?? 'NONE',
        taskKind: kind,
        // B21: a run whose course was corrected mid-flight by a parent
        // steer is marked, so skill evidence never credits an unsteered
        // success with what the steer caused (lifted by buildTrajectory).
        steered: this.deliveredParentSteers.length > 0,
      });
      clearSkillsLoadedThisRun();
    } catch { /* skill outcome attribution must never affect task completion */ }
    // Lesson attribution: a retrieved lesson that was actually injected gets
    // its useCount/successCount advanced. This is what makes promotion
    // (3+ uses, 1+ success) reachable instead of permanently stuck at zero.
    try {
      if (this.surfacedLessonIds.size > 0) {
        const { markLessonUsed } = await import('../lessons.js');
        for (const id of this.surfacedLessonIds) markLessonUsed(this.workspace.dir, id, success === true);
        this.surfacedLessonIds.clear();
      }
    } catch { /* lesson attribution must never affect task completion */ }
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
    // Durable journal (C6): audit marker only — step entries stay claimable
    // so a later session with the same run id resumes by replay.
    try { this.journal?.finishRun(success ? 'completed' : stopReason); } catch { /* best effort */ }
    this.budget?.recordAgentEnd();
    // Skill curator pass (on by default): archives stale agent-created skills,
    // writes a report, keeps the skill tree healthy as experience accumulates.
    // Idle-gated by its own interval; any failure is silently ignored.
    try {
      const ccfg = defaultCuratorConfig();
      if (shouldRunCurator(this.workspace.dir, ccfg)) {
        const out = runCurator(this.workspace.dir, ccfg);
        recordCuratorRun(this.workspace.dir, `scanned ${out.scanned}, archived ${out.archived.length}`);
        // MCH-204: self-patch low-scoring, repeatedly-failing agent-created
        // skills — the curator rewrites their Procedure section via a cheap
        // model call so skills get better over time instead of just archived.
        try {
          const { selfPatchSkill } = await import('../skills/skill-curator.js');
          const { loadUsage: loadU, skillsRoot: sRoot } = await import('../skills/skill-manager.js');
          const udb = loadU(this.workspace.dir);
          const root = sRoot(this.workspace.dir);
          const failuresBySkill = new Map<string, string[]>();
          const { loadSkillFailures } = await import('../skills/skills.js');
          const failsMap = loadSkillFailures(this.workspace.dir);
          for (const [name, frec] of Object.entries(failsMap) as Array<[string, import('../skills/skills.js').SkillFailureRecord]>) {
            const rec = udb.byName[name];
            // MCH-207: self-patch ANY repeatedly-failing skill, not just
            // agent-created ones — a hand-written skill that keeps failing is
            // exactly the one that needs a Procedure update. Two caps keep it
            // sane: skip skills already patched ≥5 times (persistent failure
            // after 5 rewrites is a design problem, not a wording one) and
            // skip scores ≥40 (working well enough).
            if (!rec || (rec.score ?? 0) >= 40 || (frec.count ?? 0) < 2) continue;
            if ((rec.patches ?? 0) >= 5) continue;
            failuresBySkill.set(name, [...(frec.recent ?? []).map((r) => r.error), frec.lastError].filter(Boolean));
          }
          for (const [name, fails] of failuresBySkill) {
            const slug = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
            for (const candidate of [join(root, slug, 'SKILL.md'), join(root, name, 'SKILL.md')]) {
              if (!existsSync(candidate)) continue;
              const patched = await selfPatchSkill(this.workspace.dir, { name, path: candidate }, fails, this.provider);
              if (patched) {
                this.events.emit({ type: 'agent:log', agentId: this.id, message: `[curator] self-patched skill "${name}" from ${fails.length} failure(s)` });
              }
              break;
            }
          }
        } catch { /* self-patch must never affect task completion */ }
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
      // MCH-205: pitfall mining from FAILED runs — the inverted twin of the
      // success-path miner. Failures carry the most durable lessons; a run
      // that died with real errors + a diagnosis drafts an avoid-* skill.
      try {
        if (success !== true && !isSimpleScriptTask(task) && this.provider) {
          const { minePitfallSkillFromTrace } = await import('../skills/skill-curator.js');
          const pitfallErrors = ((this.context['state']?.knownErrors as string[] | undefined) ?? [])
            .concat(this.lastToolError ? [this.lastToolError] : []).slice(0, 3);
          const mined = await minePitfallSkillFromTrace(this.workspace.dir, {
            taskTitle: task.title,
            errors: pitfallErrors,
            lessons: (this.lastLessons ?? []).map((l) => l.lesson).slice(0, 3),
            toolSequence: [...this.toolSeq].slice(0, 10),
            provider: this.provider,
          });
          if (mined) {
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[skills] mined pitfall skill "${mined}" from failed run` });
          }
        }
      } catch { /* pitfall mine must never affect task completion */ }
      // MCH-206: lesson graduation — lessons that proved themselves in the
      // field (retrieved ≥3x, fixed ≥2x) get promoted into a real skill so
      // they stop depending on fuzzy lesson retrieval and enter the quality-
      // scored, curator-managed library like any hand-written skill.
      try {
        const { graduateLessonsToSkill } = await import('../skills/skill-curator.js');
        const graduated = graduateLessonsToSkill(this.workspace.dir);
        if (graduated) {
          this.events.emit({ type: 'agent:log', agentId: this.id, message: `[skills] graduated proven lesson(s) into skill "${graduated}"` });
        }
      } catch { /* graduation must never affect task completion */ }
      // MCH-200: model-driven skill mine for complex tasks — sends the run's
      // real trace (lessons, tools, errors fixed) to the provider to draft a
      // proper SKILL.md, far richer than the template autoDraftSkill stubs.
      // Fires only on success and only for non-simple tasks; never throws.
      try {
        if (!isSimpleScriptTask(task) && this.provider) {
          const { mineSkillFromTrace } = await import('../skills/skill-curator.js');
          const mined = await mineSkillFromTrace(this.workspace.dir, {
            taskTitle: task.title,
            lessons: (this.lastLessons ?? []).map((l) => l.lesson).slice(0, 5),
            toolSequence: [...this.toolSeq].slice(0, 10),
            errorsFixed: ((this.context['state']?.knownErrors as string[] | undefined) ?? []).slice(0, 3),
            pattern: [...this.seenPatterns][0] ?? 'general',
            strategy: this.lastStrategy ?? 'unclassified',
            provider: this.provider,
          });
          if (mined) {
            this.events.emit({ type: 'agent:log', agentId: this.id, message: `[skills] mined skill "${mined}" from run trace` });
          }
        }
      } catch { /* mine must never affect task completion */ }
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
      // Unified memory (P1.5): record ONE substantive success fact in the
      // GLOBAL fact store — what was accomplished, which files changed, and
      // how verification ended. addFact() previously had no caller in the
      // loop at all (SDK only), so durable memory learned from failures and
      // files-touched lines but never from a win. Deduped against
      // near-identical facts by trigram similarity inside
      // recordRunSuccessFact, so re-runs don't stack copies. Subagents skip
      // (the parent run records the outcome); chat/plan kinds skip (no work
      // product to remember). Under vitest the write is skipped unless
      // MOCHI_MEMORY_FILE points at a test-owned file, so the suite never
      // pollutes the real ~/.mochi store.
      try {
        if (
          stopReason === 'completed'
          && this.subagentDepth === 0
          && !(process.env.VITEST && !process.env.MOCHI_MEMORY_FILE)
        ) {
          const kind = this.taskKind ?? classifyTaskKind(task);
          if (kind !== 'chat' && kind !== 'plan') {
            const { recordRunSuccessFact } = await import('../memory/unified-search.js');
            const relFiles = [...new Set(this.context['state'].filesModified)]
              .map((p) => (p.startsWith(this.cwd) ? p.slice(this.cwd.length + 1) : p))
              .slice(0, 25);
            recordRunSuccessFact({
              kind,
              taskTitle: task.title,
              summary,
              filesChanged: relFiles,
              verification: this.verifyCount === 0 ? 'not run' : this.lastVerifyPassed ? 'passed' : 'failed',
            });
          }
        }
      } catch { /* success memory must never affect task completion */ }
      // Decision memory: a run that did REAL work (files changed) and then
      // FAILED abandoned its approach — that is the exact write condition for
      // a rejection record ("tried X, failed because Y"), so a future session
      // on a similar task is warned before repeating it. Runs that merely
      // considered an approach (no edits) write nothing. Subagents skip (the
      // parent run owns the outcome); chat/plan kinds skip (no approach to
      // abandon). Same vitest guard as the success fact above.
      try {
        if (
          !success
          && this.fileChanged
          && this.subagentDepth === 0
          && !(process.env.VITEST && !process.env.MOCHI_MEMORY_FILE)
        ) {
          const kind = this.taskKind ?? classifyTaskKind(task);
          if (kind !== 'chat' && kind !== 'plan') {
            const relFiles = [...new Set(this.context['state'].filesModified)]
              .map((p: string) => (p.startsWith(this.cwd) ? p.slice(this.cwd.length + 1) : p));
            recordRejectedApproach(this.workspace.dir, {
              taskSignature: task.title,
              approach: summary.split('\n').map((l: string) => l.trim()).filter(Boolean).slice(0, 2).join(' — ') || task.title,
              reason: (this.lastToolError ?? summary).split('\n')[0]?.trim() || `run ended: ${stopReason}`,
              evidence: `run stopReason=${stopReason}; files: ${relFiles.slice(0, 5).join(', ')}`,
            });
          }
        }
      } catch { /* decision memory must never affect task completion */ }
      // MCH-52: persist this run's tool sequence for route-pattern mining.
      try {
        // D9: persist the v2 record (outcome + gate-verified + task kind)
        // instead of the bare v1 sequence — the store's legacy `seqs` view
        // is derived from records, so MCH-52/55 consumers are unaffected.
        const { loadToolSeqStore, saveToolSeqRecord } = await import('../core/tool-sequence.js');
        if (this.toolSeq.length > 0) saveToolSeqRecord(this.workspace.dir, loadToolSeqStore(this.workspace.dir), {
          tools: this.toolSeq,
          outcome: 'success',
          verified: this.skillRunVerdict() === 'pass',
          taskKind: this.taskKind ?? classifyTaskKind(task),
          endedAt: Date.now(),
        });
        // MCH-55: habitual opening routes become auto-drafted skills.
        const { draftSkillFromToolRoutes } = await import('../skills/skill-curator.js');
        await draftSkillFromToolRoutes(this.workspace.dir);
        // MCH-56: archive stale never-used auto skills so the list stays dense.
        const { curateAutoSkills } = await import('../skills/skill-manager.js');
        curateAutoSkills(this.workspace.dir);
      } catch { /* tool-route persistence must never affect task completion */ }
    }
    // D9: failed runs are recorded too (outcome 'failure', never verified) —
    // v2 mining filters on outcome, and the negative evidence keeps
    // toolPatternText / induction honest about what did NOT work.
    if (!success) {
      try {
        const { loadToolSeqStore, saveToolSeqRecord } = await import('../core/tool-sequence.js');
        if (this.toolSeq.length > 0) saveToolSeqRecord(this.workspace.dir, loadToolSeqStore(this.workspace.dir), {
          tools: this.toolSeq,
          outcome: 'failure',
          verified: false,
          taskKind: this.taskKind ?? classifyTaskKind(task),
          endedAt: Date.now(),
        });
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
    const cacheRatio = cacheHitRatio(this.cacheCalls);

    // Fast lane: record the run's outcome exactly once (finishOnce is the
    // single exit) so the stats store can price the classifier: completed
    // in lane vs needed escalation vs failed either way.
    if (this.fastLane && !this.fastLaneOutcomeRecorded) {
      this.fastLaneOutcomeRecorded = true;
      recordFastLaneOutcome(this.workspace, this.fastLaneEscalated
        ? (success ? 'completed-after-escalation' : 'failed-after-escalation')
        : (success ? 'completed-in-lane' : 'failed-in-lane'));
    }

    return {
      success,
      summary,
      filesModified: [...new Set(this.context['state'].filesModified)],
      attempts: this.errors.length + 1,
      tokensUsed: this.tokensUsed,
      tokensIn: this.tokensIn,
      tokensOut: this.tokensOut,
      tokensCached: this.tokensCached,
      cacheHitRatio: cacheRatio.ratio,
      cacheMeasured: cacheRatio.measuredCalls > 0,
      prefixCache: this.context.prefixStats(),
      contextUsed: this.lastContextUsed,
      costUsd: this.costUsd,
      durationMs,
      stopReason,
      runDigest: _runDigest,
      ...(this.fastLane
        ? {
          fastLane: {
            entered: true,
            escalated: this.fastLaneEscalated,
            ...(this.fastLaneEscalationReason ? { escalationReason: this.fastLaneEscalationReason } : {}),
          },
        }
        : {}),
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
