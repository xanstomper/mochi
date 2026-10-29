/**
 * Verification-first critic (verification-first default mode).
 *
 * Two mechanisms compose into the mode:
 *
 *  1. Reproduce-before-fix: the reproduce-first gate (loop.ts) already
 *     vetoes the first mutating call on a fix task until a reproduction
 *     attempt has actually executed. What the gate never had is a RECORD —
 *     every pre-mutation shell/verify observation (command, exit code,
 *     whether it failed) is kept in a per-run ledger, persisted with the
 *     task, and RE-RUN by the completion verify step so after-evidence is
 *     about the same reproduction, not a new check the run picked post hoc.
 *
 *  2. The critic pass: when the agent concludes ("fix works, task done"),
 *     the conclusion is re-derived from the recorded evidence alone:
 *       - a failing observation of the reproduction BEFORE the fix,
 *       - a green run of the SAME command AFTER it (the verify gate's own
 *         green checks count; otherwise the critic re-runs the recorded
 *         command, bounded),
 *       - when the model never produced the before-half, the loop may
 *         produce it with a bounded git-stash A/B (run the reproduction on
 *         the original tree and on the fixed tree) instead of taking the
 *         model's word for it.
 *     A conclusion the evidence does not support is BLOCKED with the gap
 *     named — never silently softened into a passing claim.
 *
 * Everything decision-shaped here is pure and deterministic (no model
 * calls, no I/O in the verdict): the loop owns all side effects. The
 * critic's worst case is a handful of bounded shell runs at verify time —
 * it never re-runs the task.
 */

import type { Workspace } from '../workspace.js';
import type { MochiConfig } from '../types.js';

/** Tools whose execution can carry reproduction evidence (the same set the
 *  reproduce-first gate accepts as a repro attempt). */
export const REPRO_EVIDENCE_TOOLS: ReadonlySet<string> = new Set(['shell', 'verify', 'bg_task']);

/** A recorded reproduction observation. `phase` is the run-relative position:
 *  'pre' = executed before this run's first mutating call (before-fix
 *  evidence about the run-start tree), 'post' = executed at/after the
 *  completion verify (after-fix evidence about the fixed tree). */
export interface ReproObservation {
  tool: string;
  /** What was asked to run. Shell: the raw command. Verify: the raw command
   *  when one was given, else `verify(<keyword>)`. bg_task: wrapped. */
  command: string;
  /** Parsed exit code; null when the envelope does not carry one. */
  code: number | null;
  /** The run OBSERVED a failure (nonzero exit / FAIL marker / tool error). */
  failed: boolean;
  at: number;
  phase: 'pre' | 'post';
  origin: 'model' | 'critic-rerun' | 'synth' | 'ab';
}

/** One task's durable reproduction record, persisted at
 *  .mochi/state/repro-ledger.json (mirrors the flaky-registry pattern). */
export interface ReproLedgerRecord {
  taskId: string;
  observations: ReproObservation[];
  vetoFired: boolean;
  bypassed: boolean;
  /** Named exemption/opt-out when the reproduce-first gate did not apply. */
  exempt?: string;
  /** The critic's final word for the task. */
  verdict?: 'supported' | 'blocked' | 'exempt' | 'indeterminate';
  gaps?: string[];
  updatedAt: number;
}

export interface ReproLedgerFile {
  version: 1;
  updatedAt: number;
  tasks: Record<string, ReproLedgerRecord>;
}

const REPRO_LEDGER_STATE_PATH = 'state/repro-ledger.json';
const REPO_LEDGER_MAX_TASKS = 50;

/** Master switch for the whole verification-first mode (gate + critic).
 *  Env kill-switch first (MOCHI_REPRO_FIRST=0), then the scripted-e2e test
 *  seam, then the declared config flag. Default ON. */
export function verificationFirstEnabled(
  config: MochiConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.MOCHI_REPRO_FIRST === '0') return false;
  if ((config.safety as { skipReproGate?: boolean } | undefined)?.skipReproGate) return false;
  if (config.safety?.verificationFirst === false) return false;
  return true;
}

/** Parse a tool execution into a structured exit observation. Shell output
 *  carries the `exit_code: N` envelope (exec.ts); the verify tool marks its
 *  verdict with [PASS]/[FAIL]/[ERR]; anything else falls back to the tool's
 *  error flag. */
export function parseToolExit(toolName: string, output: string, error: boolean): { code: number | null; failed: boolean } {
  if (toolName === 'verify') {
    if (/\[(?:FAIL|ERR)\]/.test(output)) return { code: null, failed: true };
    if (/\[PASS\]/.test(output)) return { code: 0, failed: false };
    return { code: null, failed: error };
  }
  const m = /^exit_code: (\d+)/m.exec(output);
  if (m) {
    const code = Number(m[1]);
    return { code, failed: code !== 0 };
  }
  return { code: null, failed: error };
}

/** The repro-shaped command string for a tool call, or null when the args
 *  carry nothing runnable/identifiable. Verify keyword commands are recorded
 *  in `verify(<keyword>)` form — identifiable, but not re-runnable as-is. */
export function reproObservationCommand(toolName: string, args: Record<string, unknown>): string | null {
  const raw = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : null);
  if (toolName === 'shell') return raw(args.command);
  if (toolName === 'verify') {
    const given = raw(args.command);
    if (given && !/^(test|build|typecheck|lint|auto)$/i.test(given)) return given; // raw command — re-runnable
    const target = raw(args.target);
    return `verify(${given ?? 'auto'}${target ? ` ${target}` : ''})`;
  }
  if (toolName === 'bg_task') {
    const c = raw(args.command);
    return c ? `bg_task(${c.slice(0, 280)})` : null;
  }
  return null;
}

/** Candidates for the post-fix re-run: DISTINCT failing pre-mutation shell
 *  commands (verify keyword-forms are not re-runnable), most recent first,
 *  capped — the critic re-runs at most this many commands. */
export function pickReproCandidates(observations: ReproObservation[], cap = 3): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = observations.length - 1; i >= 0; i--) {
    const o = observations[i];
    if (o.phase !== 'pre' || !o.failed) continue;
    if (o.command.startsWith('verify(')) continue;
    if (seen.has(o.command)) continue;
    seen.add(o.command);
    out.push(o.command);
    if (out.length >= cap) break;
  }
  return out;
}

/** Patterns a reproduction command must NOT match for the harness to re-run
 *  it: the critic re-executes recorded commands at verify time, so a
 *  mutating command (rm, git state changes, package installs, in-place
 *  edits) must never be replayed. Reproduction commands are observations —
 *  test runners, repro scripts, plain invocations. */
const RERUN_UNSAFE_RE = [
  /^\s*(?:rm|rmdir|mv|cp|dd|chmod|chown|mkfs|shutdown|reboot|kill|pkill|tee|truncate)\b/,
  /^\s*git\s+(?!status\b|log\b|diff\b|show\b|rev-parse\b|ls-files\b|stash\s+list\b)/,
  /\bsed\b[^|;&]*\s-i\b/,
  /\b(?:npm|pnpm|yarn|bun|pip3?|cargo|go|mvn|gradle)\s+(?:install|add|remove|update|upgrade|uninstall|publish|clean)\b/,
  /\b(?:curl|wget)\b[^|;&]*\s(?:-o|-O|--output)\b/,
  /\b(?:git\s+)?(?:push|pull|fetch|clone|commit|reset|checkout|restore|rebase|merge|revert|clean|apply)\b/,
  /(?:^|\s)[0-2]?>{1,2}\s*(?!&)\S/, // redirection into a file (fd dups like 2>&1 are fine)
].map((r) => new RegExp(r.source, 'i'));

export function isSafeToRerun(command: string): boolean {
  const c = command.trim();
  if (!c || c.length > 300) return false;
  return !RERUN_UNSAFE_RE.some((re) => re.test(c));
}

export interface CriticInput {
  /** Named exemption/opt-out when the reproduce-first gate does not apply;
   *  null = the gate applies and the critic judges. */
  exemption: string | null;
  vetoFired: boolean;
  bypassed: boolean;
  observations: ReproObservation[];
  /** Commands the verify gate ran GREEN this pass (LoopVerification.checks
   *  on a PASS — every failing check returns early, so a passed gate's
   *  checks are all green; on FLAKY-PASS the re-runs went green). */
  gateGreenChecks: string[];
  /** Harness A/B result when the loop produced the before-half itself:
   *  the command failed on the original tree and passed on the fixed tree. */
  abPair?: { command: string } | null;
}

export type CriticVerdict =
  | { verdict: 'exempt'; reason: string }
  | { verdict: 'supported'; note: string; pairCommand?: string }
  | { verdict: 'blocked'; gaps: string[] }
  | { verdict: 'indeterminate'; reason: string };

const VERIFY_KEYWORD_RE = /^verify\((?:test|build|typecheck|lint|auto)?\)/i;

/** The critic's deterministic re-derivation. Evidence alone — no model
 *  output is consulted, no heuristic prose is parsed. */
export function deriveCriticVerdict(input: CriticInput): CriticVerdict {
  if (input.exemption) return { verdict: 'exempt', reason: input.exemption };
  // Pair rule: the SAME command that failed pre-fix ran green post-fix —
  // via the critic's own re-runs, the gate's green checks (exact command),
  // or the harness A/B. The A/B pair is checked FIRST: it is produced
  // exactly when the model never recorded a pre-fix failure, and it is
  // harness-observed evidence on the real trees.
  if (input.abPair) {
    return { verdict: 'supported', note: `harness A/B: reproduction "${input.abPair.command}" fails on the original tree and passes on the fixed tree`, pairCommand: input.abPair.command };
  }
  const preFailing = input.observations.filter((o) => o.phase === 'pre' && o.failed);
  if (preFailing.length === 0) {
    const gap = input.bypassed
      ? 'no reproduction exists: the fix was applied after a reproduce-first veto without any reproduction attempt'
      : 'no failing reproduction was recorded before the fix: every command run before the first edit passed';
    return { verdict: 'blocked', gaps: [gap] };
  }
  // Pair rule: the SAME command that failed pre-fix ran green post-fix —
  // via the critic's own re-runs, the gate's green checks (exact command),
  // or the harness A/B.
  const postPassed = new Set<string>();
  for (const o of input.observations) {
    if (o.phase === 'post' && !o.failed && o.code === 0) postPassed.add(o.command);
  }
  for (const c of input.gateGreenChecks) postPassed.add(c);
  const failingCommands = [...new Set(preFailing.map((o) => o.command))];
  for (const cmd of failingCommands) {
    if (postPassed.has(cmd)) {
      return { verdict: 'supported', note: `reproduction "${cmd}" failed before the fix and passed after it`, pairCommand: cmd };
    }
  }
  // Keyword-verify subsumption: verify(test)/verify(auto) pre-failures are
  // the project's test suite; the gate just ran that suite green. The
  // recorded keyword string cannot match a resolved check exactly, so a
  // green TEST-shaped gate check closes the pair for them.
  const keywordVerify = preFailing.find((o) => VERIFY_KEYWORD_RE.test(o.command));
  if (keywordVerify && input.gateGreenChecks.some((c) => isTestishCheck(c))) {
    return { verdict: 'supported', note: `reproduction ${keywordVerify.command} failed before the fix; the verify gate's test suite ran green after it`, pairCommand: keywordVerify.command };
  }
  // No pair — name the precise gap. Distinguish "repro still fails" (the
  // false-fix class) from "never re-ran the same reproduction".
  const reRanAndFailed = input.observations.some((o) => o.phase === 'post' && o.failed && failingCommands.includes(o.command));
  if (reRanAndFailed) {
    return { verdict: 'blocked', gaps: [`the reproduction still fails after the fix: ${failingCommands.join(', ')}`] };
  }
  return { verdict: 'blocked', gaps: ['no same-reproduction evidence exists: the failing pre-fix observation was never re-run after the fix'] };
}

/** A gate check that exercises tests (as opposed to typecheck/lint/build). */
function isTestishCheck(cmd: string): boolean {
  return /\b(test|vitest|jest|mocha|pytest|go test|cargo test|node --test|--run)\b/i.test(cmd);
}

/** The blocked verdict rendered for the model — the gap, the honest paths
 *  that close it, and the recorded opt-out. Returned through the normal
 *  verify-failure path (bounded retries, objection pinning), never a
 *  silent softening. */
export function renderCriticBlocked(gaps: string[]): string {
  const gapLines = gaps.map((g) => `- ${g}`).join('\n');
  return [
    'VERIFICATION CRITIC — the completion claim is not supported by the recorded evidence:',
    gapLines,
    '',
    'The claim is blocked, not softened. To close the gap:',
    '1. Produce the before/after pair for the SAME reproduction: with the pre-fix code restored (git stash or git checkout -- <changed files>), run the failing reproduction and observe the failure; then restore your fix and run the SAME reproduction until it passes.',
    '2. Finish again — the harness re-runs your recorded reproduction and the critic re-derives the verdict from that evidence.',
    'If this task genuinely cannot produce a reproduction, the operator can mark it repro-exempt (task annotation reproExempt) or disable the mode (config safety.verificationFirst=false / MOCHI_REPRO_FIRST=0); an unevidenced fix cannot be recorded as done.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Per-task ledger persistence (workspace state; mirrors the flaky registry).
// ---------------------------------------------------------------------------

export function emptyReproLedger(now = Date.now()): ReproLedgerFile {
  return { version: 1, updatedAt: now, tasks: {} };
}

export function loadReproLedger(workspace: Workspace, now = Date.now()): ReproLedgerFile {
  try {
    const raw = workspace.readJson<ReproLedgerFile | null>(REPRO_LEDGER_STATE_PATH, null);
    if (!raw || typeof raw !== 'object' || !raw.tasks || typeof raw.tasks !== 'object') {
      return emptyReproLedger(now);
    }
    return { version: 1, updatedAt: raw.updatedAt ?? now, tasks: raw.tasks };
  } catch {
    return emptyReproLedger(now);
  }
}

/** Merge one task's record into the persisted ledger (bounded: oldest task
 *  records beyond the cap are dropped). Best-effort like every workspace
 *  state write. */
export function saveReproLedgerRecord(workspace: Workspace, record: ReproLedgerRecord): void {
  try {
    const ledger = loadReproLedger(workspace);
    ledger.tasks[record.taskId] = record;
    const ids = Object.keys(ledger.tasks);
    if (ids.length > REPO_LEDGER_MAX_TASKS) {
      ids
        .sort((a, b) => (ledger.tasks[a]?.updatedAt ?? 0) - (ledger.tasks[b]?.updatedAt ?? 0))
        .slice(0, ids.length - REPO_LEDGER_MAX_TASKS)
        .forEach((id) => delete ledger.tasks[id]);
    }
    ledger.updatedAt = Date.now();
    workspace.writeJson(REPRO_LEDGER_STATE_PATH, ledger);
  } catch {
    /* ledger persistence is best-effort; never break the loop on it */
  }
}

export function loadReproLedgerRecord(workspace: Workspace, taskId: string): ReproLedgerRecord | undefined {
  return loadReproLedger(workspace).tasks[taskId];
}
