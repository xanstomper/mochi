// Short-task fast lane: an execution PROFILE for tasks the up-front evidence
// proves are short/simple, entered at run start and exited the moment the
// run itself produces not-short evidence.
//
// Why this exists: on short tasks, ~100-line harnesses tie elaborate ones —
// the elaborate harness's machinery (task-conditioned repo map, prefetch
// prediction, tool-sequence pattern injection, full unified memory retrieval
// on every packet, the full-repo verify suite + mutation check, an
// 80-iteration budget) is pure overhead on a one-file fix. The standard
// profile pays all of it on EVERY run, because the existing tiers key on
// task KIND × complexity but never drop the context machinery itself.
//
// The lane drops the machinery, never the discipline:
//   - the verifier's evidence standard still governs the final verdict
//     (zero-change and checkless-change still BLOCK — see the fast-lane
//     branch in Agent.verifyGate, which swaps the full check suite for the
//     changed files' own targeted checks but keeps every BLOCK rule);
//   - classification is honest about its error rate: every entry and every
//     escalation is recorded in .mochi/state/fastlane.json, so the
//     false-short rate (escalations / entries) is a measured number;
//   - escalation is one-way and immediate: files-edited / verify-failure /
//     tool-error / load_tools / turn-budget evidence restores the standard
//     profile mid-run (full tier toolset, repo map, memory, full turn cap).
//
// Everything in this file is pure and synchronous except countRepoFiles
// (one bounded git call). Policy lives here so the loop wiring stays thin
// and the thresholds are unit-testable without orchestrating the loop —
// the same shape as taskkind.ts's COMPLEXITY_ESCALATION.

import { spawnSync } from 'node:child_process';
import type { FastLaneConfig, Task } from '../types.js';
import type { TaskComplexity, TaskKind } from './taskkind.js';

/** Kill-switch resolution, mirroring resolveDisciplineFlags: config
 *  `fastlane.enabled: false` or env MOCHI_FASTLANE=0 disables the lane. */
export function resolveFastLaneEnabled(
  cfg?: FastLaneConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return cfg?.enabled !== false && env.MOCHI_FASTLANE !== '0';
}

/** Task kinds the lane serves. research/plan/unknown stay on the read tier
 *  (already lean, and their deliverable is breadth of reading, not speed of
 *  mutation); refactor is excluded — even a "simple" refactor verdict can
 *  hide cross-file blast radius the lane is blind to by design. */
export const FASTLANE_KINDS: ReadonlySet<TaskKind> = new Set(['fix', 'implement', 'test', 'document', 'chat']);

/** The lane's advertised tool sets — deliberately smaller than the lean
 *  tier's 21. load_tools is always present: it is the escape hatch whose
 *  USE is itself an escalation signal (see FASTLANE_LIMITS.loadToolsCalls). */
export const FASTLANE_CODING_TOOLS: readonly string[] = [
  'read', 'edit', 'write', 'patch', 'search', 'glob', 'shell',
  'verify', 'get_diagnostics', 'think', 'ask_question', 'load_tools',
];
export const FASTLANE_DOCUMENT_TOOLS: readonly string[] = [
  'read', 'write', 'edit', 'search', 'glob', 'shell',
  'think', 'ask_question', 'load_tools',
];
/** Mirrors CHAT_TOOL_NAMES in tools/index.ts (kept there as the single
 *  source for the standard chat tier; a unit test pins the two equal). */
export const FASTLANE_CHAT_TOOLS: readonly string[] = [
  'read', 'glob', 'search', 'skill', 'load_tools', 'ask_question', 'think',
];

export function fastLaneToolNames(kind: TaskKind): readonly string[] {
  if (kind === 'chat') return FASTLANE_CHAT_TOOLS;
  if (kind === 'document') return FASTLANE_DOCUMENT_TOOLS;
  return FASTLANE_CODING_TOOLS;
}

export const FASTLANE_LIMITS = {
  /** Turn budget in the lane (vs the 80-iteration standard default). */
  maxIterations: 12,
  /** Distinct files edited beyond this = the task was not one-file work. */
  escalateFilesEdited: 3,
  /** Distinct files read beyond this = discovery, not targeted reads. */
  escalateFilesRead: 8,
  /** Accumulated tool errors (mirrors COMPLEXITY_ESCALATION, tighter). */
  escalateToolErrors: 4,
  /** Consecutive lightweight-verify failures (mirrors the complexity gate). */
  escalateVerifyFailures: 2,
  /** load_tools calls: needing the deferred arsenal twice = wrong profile. */
  escalateLoadToolsCalls: 2,
  /** Escalate this many iterations before the lane cap so the standard
   *  profile inherits a live run, not a corpse at the cap. */
  turnBudgetGrace: 2,
  /** Referenced files (fileScope ∪ paths named in the task text) above
   *  this are not short-task scope. */
  maxReferencedFiles: 2,
  /** Task text (title + description) longer than this is a spec, not a
   *  short task. */
  maxTextChars: 600,
  /** Acceptance criteria at or above this count are a multi-part
   *  deliverable even when the complexity scorer stays 'simple'. */
  maxAcceptanceCriteria: 1,
  /** 'standard'-band tasks enter only at or below this complexity score —
   *  the benign-signals ceiling (mutate-existing +2, length +1). Anything
   *  substantive scores higher. */
  maxStandardScore: 3,
  /** Chameleon difficulty at or above this vetoes entry (deep/extreme
   *  work the keyword classifier smells even when structure looks small). */
  maxChameleonDifficulty: 7,
  /** A scopeless mutation task (no file named, no fileScope) may enter
   *  only when the repo is known to be at most this many files — in a big
   *  repo, finding the file IS the task and needs discovery machinery. */
  maxScopelessRepoFiles: 500,
} as const;

/** Path-like tokens named in free text: `src/foo.ts`, `math.js`,
 *  `a/b/c.py`. Deliberately conservative (extension must be alphabetic,
 *  so version strings like 18.2 or v1.2 never match). */
const REFERENCED_PATH_RE = /(?:[\w@-]+\/)*[\w-]+\.[a-z]{1,6}\b/g;

/** Files a task references up front: its declared fileScope plus any path
 *  named in the title/description, deduplicated. Pure. */
export function referencedFilesFor(task: Pick<Task, 'title' | 'description' | 'fileScope'>): string[] {
  const out = new Set<string>();
  for (const f of task.fileScope ?? []) {
    if (f && f.trim()) out.add(f.trim());
  }
  const text = `${task.title} ${task.description ?? ''}`;
  for (const m of text.match(REFERENCED_PATH_RE) ?? []) out.add(m);
  return [...out];
}

/** Cheap repo-size signal: tracked-file count via one bounded git call.
 *  Returns null when the count is not cheaply knowable (not a git repo,
 *  git missing, timeout) — callers must treat null as "unknown", never 0. */
export function countRepoFiles(cwd: string): number | null {
  try {
    const out = spawnSync('git', ['-C', cwd, 'ls-files'], {
      timeout: 300, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    if (out.status === 0 && typeof out.stdout === 'string') {
      return out.stdout.split('\n').filter(Boolean).length;
    }
  } catch { /* not a repo / git unavailable → unknown */ }
  return null;
}

export interface FastLaneSignals {
  kind: TaskKind;
  complexity: TaskComplexity;
  complexityScore: number;
  referencedFiles: string[];
  textChars: number;
  acceptanceCriteria: number;
  chameleonDifficulty: number;
  repoFiles: number | null;
  role?: string;
  simpleScript: boolean;
  trivialWrite: boolean;
}

export interface FastLaneDecision {
  eligible: boolean;
  /** Human-readable evidence trail: positive signals when eligible, the
   *  veto reasons when not. Logged at entry and kept on the run result. */
  reasons: string[];
  signals: FastLaneSignals;
}

/**
 * Entry decision. EVERY condition must hold — the lane is entered only on
 * positive proof of shortness, never on absence of complexity evidence
 * (that asymmetry is the whole design: a false negative costs the standard
 * profile's overhead; a false positive is caught by mid-run escalation,
 * and the stats store prices how often that happens).
 */
export function decideFastLane(signals: FastLaneSignals, enabled: boolean): FastLaneDecision {
  const vetoes: string[] = [];
  if (!enabled) vetoes.push('fast lane disabled (config fastlane.enabled=false or MOCHI_FASTLANE=0)');
  if (!FASTLANE_KINDS.has(signals.kind)) vetoes.push(`kind '${signals.kind}' is not a fast-lane kind`);
  // Complexity bar: 'complex' never enters. 'standard' enters only at the
  // shallow end (score <= 3): the scorer's benign signals top out at 3
  // (mutate-existing +2, length/multi-sentence +1), while every substantive
  // evidence type (broad verify, hard trace, cross-file scope, repo-shaping)
  // either scores >= 3 alone AND needs a co-signal that pushes past 3, or
  // pushes the total to >= 4 outright. Measured on the real scorer, a
  // plainly-worded one-file fix lands at exactly 3 — requiring 'simple'
  // (score <= 2) would exclude nearly every real short fix.
  if (signals.complexity === 'complex') vetoes.push(`complexity 'complex' (score ${signals.complexityScore}) — deep work stays standard`);
  else if (signals.complexity === 'standard' && signals.complexityScore > FASTLANE_LIMITS.maxStandardScore) vetoes.push(`complexity 'standard' with substance (score ${signals.complexityScore} > ${FASTLANE_LIMITS.maxStandardScore})`);
  if (signals.role === 'security' || signals.role === 'architect') vetoes.push(`specialist role '${signals.role}' never fast-lanes`);
  if (signals.acceptanceCriteria > FASTLANE_LIMITS.maxAcceptanceCriteria) vetoes.push(`${signals.acceptanceCriteria} acceptance criteria — a multi-part deliverable`);
  if (signals.textChars > FASTLANE_LIMITS.maxTextChars) vetoes.push(`task text is ${signals.textChars} chars (cap ${FASTLANE_LIMITS.maxTextChars}) — a spec, not a short task`);
  if (signals.chameleonDifficulty > FASTLANE_LIMITS.maxChameleonDifficulty) vetoes.push(`chameleon difficulty ${signals.chameleonDifficulty}/10 — deep-work vocabulary`);
  if (signals.referencedFiles.length > FASTLANE_LIMITS.maxReferencedFiles) vetoes.push(`${signals.referencedFiles.length} referenced files (cap ${FASTLANE_LIMITS.maxReferencedFiles})`);
  const mutationKind = signals.kind === 'fix' || signals.kind === 'implement' || signals.kind === 'test';
  if (
    mutationKind
    && signals.referencedFiles.length === 0
    && !signals.simpleScript
    && !signals.trivialWrite
    && !(signals.repoFiles !== null && signals.repoFiles <= FASTLANE_LIMITS.maxScopelessRepoFiles)
  ) {
    vetoes.push('no file referenced and repo size unknown/large — finding the file is the task');
  }
  if (vetoes.length > 0) return { eligible: false, reasons: vetoes, signals };
  const reasons = [
    `complexity '${signals.complexity}' (score ${signals.complexityScore})`,
    `kind '${signals.kind}'`,
    signals.referencedFiles.length > 0
      ? `scope: ${signals.referencedFiles.join(', ')}`
      : 'scopeless but self-contained (script/trivial shape or small repo)',
    `chameleon difficulty ${signals.chameleonDifficulty}/10`,
  ];
  return { eligible: true, reasons, signals };
}

export type FastLaneEscalationReason =
  | 'verify-failures'
  | 'files-edited'
  | 'tool-errors'
  | 'load-tools'
  | 'files-read'
  | 'turn-budget';

export interface FastLaneRunState {
  filesEdited: number;
  filesRead: number;
  toolErrors: number;
  consecutiveVerifyFailures: number;
  loadToolsCalls: number;
  iteration: number;
}

/**
 * Mid-run exit predicate — the lane's honesty mechanism. Returns the FIRST
 * tripped reason (priority order: hard failure evidence before scope
 * evidence before budget evidence) or null to stay in the lane. Pure and
 * one-way in effect: the loop latches the escalation and never re-enters.
 */
export function fastLaneEscalationReason(s: FastLaneRunState): FastLaneEscalationReason | null {
  if (s.consecutiveVerifyFailures >= FASTLANE_LIMITS.escalateVerifyFailures) return 'verify-failures';
  if (s.filesEdited > FASTLANE_LIMITS.escalateFilesEdited) return 'files-edited';
  if (s.toolErrors >= FASTLANE_LIMITS.escalateToolErrors) return 'tool-errors';
  if (s.loadToolsCalls >= FASTLANE_LIMITS.escalateLoadToolsCalls) return 'load-tools';
  if (s.filesRead > FASTLANE_LIMITS.escalateFilesRead) return 'files-read';
  if (s.iteration >= FASTLANE_LIMITS.maxIterations - FASTLANE_LIMITS.turnBudgetGrace) return 'turn-budget';
  return null;
}
