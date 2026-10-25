// Short-task fast lane.
//
// Most coding requests are small: one file, one edit, one run. Sending those
// through the full apparatus — 80 advertised tool schemas, repo map, memory
// recall, deep-verify loops — costs seconds and tokens for no benefit. The
// fast lane enters ONLY on positive proof that the task is short (task text,
// classifier kind, complexity verdict, referenced files, repo size, chameleon
// difficulty) and then watches for evidence that the bet was wrong; the loop
// escalates back to the standard profile the moment that evidence appears.
//
// Design rules:
//   - No model call, no filesystem mutation: pure functions over cheap inputs.
//   - Positive proof only. A missing signal is NOT shortness evidence.
//   - One-way: an escalated run never re-enters the lane.
//   - Every entry and escalation is recorded (core/fastlane-stats.ts) so the
//     false-short rate is measured, not assumed.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRole, Task } from '../types.js';
import type { TaskKind } from './taskkind.js';

/** Hard limits the lane runs under. Exported so the loop's log line and the
 *  escalation predicate cannot drift apart. */
export const FASTLANE_LIMITS = {
  /** Turn cap while in the lane (the configured cap is restored on exit). */
  maxIterations: 12,
  /** Task text (title + description) longer than this is not short. */
  maxTextChars: 700,
  /** More than this many referenced files means cross-file work. */
  maxReferencedFiles: 2,
  /** Acceptance criteria beyond this imply a multi-step deliverable. */
  maxAcceptanceCriteria: 2,
  /** Repos larger than this are not "one obvious edit" territory. */
  maxRepoFiles: 4000,
  /** Escalation thresholds — evidence the run is bigger than it looked. */
  maxFilesEdited: 3,
  maxFilesRead: 6,
  maxToolErrors: 3,
  maxLoadToolsCalls: 3,
  maxVerifyFailures: 2,
} as const;

export type FastLaneEscalationReason =
  | 'edits-exceeded'
  | 'reads-exceeded'
  | 'tool-errors'
  | 'verify-failures'
  | 'load-tools'
  | 'turn-budget';

export interface FastLaneDecision {
  eligible: boolean;
  /** Human-readable positive signals (when eligible) or refusal reasons. */
  reasons: string[];
}

export interface FastLaneInput {
  kind: TaskKind;
  /** Coarse classifier verdict ('simple' | 'moderate' | 'complex'). */
  complexity: string;
  /** Numeric complexity score from the same classifier (higher = harder). */
  complexityScore: number;
  /** Paths named by the task text / criteria. */
  referencedFiles: string[];
  /** Title + description length in chars. */
  textChars: number;
  acceptanceCriteria: number;
  /** Chameleon task-classifier difficulty (1 = trivial, 10 = extreme). */
  chameleonDifficulty: number;
  /** Bounded count of files in the repo (0 = unknown). */
  repoFiles: number;
  role?: AgentRole;
  /** Task shape signals the classifier already computed. */
  simpleScript: boolean;
  trivialWrite: boolean;
}

const LANE_KINDS: ReadonlySet<TaskKind> = new Set<TaskKind>(['implement', 'fix', 'test', 'refactor']);

/** Roles whose scope is inherently cross-cutting; never fast-laned. */
const SPECIALIST_ROLES: ReadonlySet<AgentRole> = new Set<AgentRole>([
  'architect', 'reviewer', 'pr_reviewer', 'security', 'redteam', 'integrator',
  'performance', 'qa_engineer', 'researcher', 'scout', 'explorer', 'tech_writer',
]);

/** Lean advertised set for the lane. Mirrors tools/index LEAN_TOOL_NAMES and
 *  adds the one kind-specific tool that short work legitimately needs. The
 *  loop still resolves ANY tool at execution time; this only shapes what the
 *  model sees up front (and what `load_tools` can restore). */
const LEAN_NAMES: readonly string[] = [
  'read', 'write', 'edit', 'patch', 'search', 'glob', 'shell', 'git', 'think',
  'ask_question', 'todo', 'load_tools', 'verify', 'lint', 'format',
  'find_definitions', 'replace_symbol', 'move_file', 'create_directory',
  'outline', 'delete',
];

/** Tools advertised for a lane task of `kind`. */
export function fastLaneToolNames(kind: TaskKind): string[] {
  if (kind === 'test') return [...LEAN_NAMES.filter((n) => n !== 'delete'), 'verify'];
  if (kind === 'refactor') return [...LEAN_NAMES.filter((n) => n !== 'format')];
  return [...LEAN_NAMES];
}

/** Config/env resolution for the lane. Default ON — the classifier refuses
 *  anything that is not provably short, and every refusal/escalation is
 *  logged. `fastlane: false` or MOCHI_FASTLANE=0 turns it off. */
export function resolveFastLaneEnabled(config?: { enabled?: boolean } | boolean): boolean {
  if (process.env.MOCHI_FASTLANE === '0') return false;
  if (typeof config === 'boolean') return config;
  return config?.enabled ?? true;
}

const PATH_RE = /\b[\w@./-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|zig|lua|sh|bash|zsh|sql|md|json|jsonc|ya?ml|toml|ini|cfg|xml|html|css|scss|vue|svelte)\b/g;

/** Paths the task text names explicitly. Cheap regex — no repo access. */
export function referencedFilesFor(task: Pick<Task, 'title' | 'description'> & { acceptanceCriteria?: unknown }): string[] {
  const criteria = Array.isArray(task.acceptanceCriteria)
    ? task.acceptanceCriteria.filter((c): c is string => typeof c === 'string')
    : [];
  const text = [task.title, task.description ?? '', ...criteria].join('\n');
  const seen = new Set<string>();
  for (const m of text.matchAll(PATH_RE)) {
    const p = m[0].replace(/^\.\//, '');
    if (p && !seen.has(p)) seen.add(p);
    if (seen.size >= 10) break;
  }
  return [...seen];
}

const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  '.mochi', '.next', '.cache', 'coverage', '__pycache__', '.venv', 'venv',
]);

/**
 * Bounded file count for the repo rooted at `dir`. Stops at `limit` so a
 * runaway tree cannot stall the run-start path; returns 0 when the directory
 * is unreadable (unknown, not "small").
 */
export function countRepoFiles(dir: string, limit = FASTLANE_LIMITS.maxRepoFiles + 1): number {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (count >= limit) return count;
      if (IGNORED_DIRS.has(name)) continue;
      const full = join(current, name);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) stack.push(full);
      else count++;
    }
  }
  return count;
}

/**
 * Entry decision. Positive proof means EVERY positive signal is present and
 * no disqualifying signal is. `enabled=false` short-circuits before any
 * signal is trusted.
 */
export function decideFastLane(input: FastLaneInput, enabled: boolean): FastLaneDecision {
  if (!enabled) return { eligible: false, reasons: ['fast lane disabled by config/env'] };
  const reasons: string[] = [];

  if (!LANE_KINDS.has(input.kind)) {
    return { eligible: false, reasons: [`task kind "${input.kind}" is not single-edit work`] };
  }
  if (input.role && SPECIALIST_ROLES.has(input.role)) {
    return { eligible: false, reasons: [`role "${input.role}" has a cross-cutting scope`] };
  }
  if (input.textChars > FASTLANE_LIMITS.maxTextChars) {
    return { eligible: false, reasons: [`task text is ${input.textChars} chars (> ${FASTLANE_LIMITS.maxTextChars})`] };
  }
  if (input.referencedFiles.length > FASTLANE_LIMITS.maxReferencedFiles) {
    return { eligible: false, reasons: [`task names ${input.referencedFiles.length} files (> ${FASTLANE_LIMITS.maxReferencedFiles})`] };
  }
  if (input.acceptanceCriteria > FASTLANE_LIMITS.maxAcceptanceCriteria) {
    return { eligible: false, reasons: [`${input.acceptanceCriteria} acceptance criteria imply a multi-step deliverable`] };
  }
  if (input.complexity !== 'simple') {
    return { eligible: false, reasons: [`complexity "${input.complexity}" is not simple (score ${input.complexityScore})`] };
  }
  if (input.chameleonDifficulty > 3) {
    return { eligible: false, reasons: [`chameleon difficulty ${input.chameleonDifficulty}/10 is not easy`] };
  }
  if (input.repoFiles > FASTLANE_LIMITS.maxRepoFiles) {
    return { eligible: false, reasons: [`repo has ${input.repoFiles}+ files (> ${FASTLANE_LIMITS.maxRepoFiles})`] };
  }

  reasons.push(`kind=${input.kind}`, `complexity=simple (score ${input.complexityScore})`);
  reasons.push(`text=${input.textChars} chars`, `files=${input.referencedFiles.length}`);
  if (input.repoFiles > 0) reasons.push(`repo=${input.repoFiles} files`);
  if (input.simpleScript) reasons.push('simple-script shape');
  if (input.trivialWrite) reasons.push('trivial-write shape');
  return { eligible: true, reasons };
}

export interface FastLaneProgress {
  filesEdited: number;
  filesRead: number;
  toolErrors: number;
  consecutiveVerifyFailures: number;
  loadToolsCalls: number;
  iteration: number;
}

/**
 * Escalation predicate. Returns the strongest reason the run is bigger than
 * it looked, or null. Ordered by how conclusive the evidence is.
 */
export function fastLaneEscalationReason(p: FastLaneProgress): FastLaneEscalationReason | null {
  if (p.filesEdited > FASTLANE_LIMITS.maxFilesEdited) return 'edits-exceeded';
  if (p.consecutiveVerifyFailures >= FASTLANE_LIMITS.maxVerifyFailures) return 'verify-failures';
  if (p.toolErrors >= FASTLANE_LIMITS.maxToolErrors) return 'tool-errors';
  if (p.filesRead > FASTLANE_LIMITS.maxFilesRead) return 'reads-exceeded';
  if (p.loadToolsCalls >= FASTLANE_LIMITS.maxLoadToolsCalls) return 'load-tools';
  if (p.iteration >= FASTLANE_LIMITS.maxIterations) return 'turn-budget';
  return null;
}
