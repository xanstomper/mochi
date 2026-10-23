/**
 * Reasoning discipline — the harness mechanisms that keep a run decisive.
 *
 * The failure mode this module exists to kill: a model that goes off task,
 * re-opens settled questions, debates itself in circles, and burns the whole
 * iteration budget deliberating instead of acting. Prompt text alone never
 * fixed that; these are STATE MACHINES the loop consults every turn:
 *
 *  1. Evidence-gated replanning — a plan, once adopted, is only re-opened
 *     when NEW evidence arrives (a new failure class, a fresh tool-error
 *     signature, a user steer). A reconsideration with no new evidence is
 *     suppressed and the model is told to continue the current plan.
 *  2. Progress forcing — consecutive turns that neither mutate nor cover
 *     new ground (deliberation turns) accumulate: at 2 the model gets a
 *     terse commit directive; at 3 the harness forces the decisive path
 *     (finish with the current best state instead of looping).
 *  3. Drift snap-back — the task is distilled into a pinned contract
 *     (goal + evidence checklist). Edits that wander across 3+ unrelated
 *     files earn exactly one concise snap-back restating the contract.
 *  4. Decisive finish — when verification passes on EVIDENCE (a real check
 *     command ran green) with no risk signals, the run is done: the
 *     anxiety-driven self-review round is skipped (see loop wiring).
 *  5. Same-failure strategy switch — the same failure class attempted with
 *     the same approach (same edited-file set) is allowed twice; the third
 *     occurrence forces a strategy switch, the fourth is refused outright.
 *  6. Adaptive effort — reasoning effort is a run-state offset over the
 *     per-kind base tier: hard signals (a NEW failure class, complexity
 *     escalation) raise it; sustained clean progress decays it. Deep
 *     thought is earned by evidence, not spent by default.
 *
 * Everything here is pure (no I/O, no timers) so the state machines are
 * unit-testable without a provider. The loop owns all side effects
 * (messages, telemetry, finishes) and consults this module for verdicts.
 *
 * Kill-switches (house style, checked in resolveDisciplineFlags):
 *   MOCHI_DISCIPLINE=0                    — everything off
 *   MOCHI_DISCIPLINE_REPLAN_GATE=0        — mechanism 1 off
 *   MOCHI_DISCIPLINE_PROGRESS_FORCING=0   — mechanism 2 off
 *   MOCHI_DISCIPLINE_DRIFT_SNAPBACK=0     — mechanism 3 off
 *   MOCHI_DISCIPLINE_DECISIVE_FINISH=0    — mechanism 4 off
 *   MOCHI_DISCIPLINE_SAME_FAILURE_SWITCH=0 — mechanism 5 off
 *   MOCHI_DISCIPLINE_ADAPTIVE_EFFORT=0    — mechanism 6 off
 *   config.discipline.<key> = false       — same, per mechanism
 */
import type { DisciplineConfig } from '../types.js';

export type EffortTier = 'off' | 'low' | 'medium' | 'high' | 'max';
export const EFFORT_TIERS: readonly EffortTier[] = ['off', 'low', 'medium', 'high', 'max'];

export interface DisciplineFlags {
  replanGate: boolean;
  progressForcing: boolean;
  driftSnapback: boolean;
  decisiveFinish: boolean;
  sameFailureSwitch: boolean;
  adaptiveEffort: boolean;
}

export const ALL_DISCIPLINE_OFF: DisciplineFlags = {
  replanGate: false,
  progressForcing: false,
  driftSnapback: false,
  decisiveFinish: false,
  sameFailureSwitch: false,
  adaptiveEffort: false,
};

const ENV_KEYS: Record<keyof DisciplineFlags, string> = {
  replanGate: 'MOCHI_DISCIPLINE_REPLAN_GATE',
  progressForcing: 'MOCHI_DISCIPLINE_PROGRESS_FORCING',
  driftSnapback: 'MOCHI_DISCIPLINE_DRIFT_SNAPBACK',
  decisiveFinish: 'MOCHI_DISCIPLINE_DECISIVE_FINISH',
  sameFailureSwitch: 'MOCHI_DISCIPLINE_SAME_FAILURE_SWITCH',
  adaptiveEffort: 'MOCHI_DISCIPLINE_ADAPTIVE_EFFORT',
};

/** Resolve the effective flags: master env/config switch first, then the
 *  per-mechanism config flag, then the per-mechanism env kill-switch.
 *  Everything defaults ON — discipline is the default posture. */
export function resolveDisciplineFlags(
  cfg?: DisciplineConfig,
  env: NodeJS.ProcessEnv = process.env,
): DisciplineFlags {
  const master = cfg?.enabled !== false && env.MOCHI_DISCIPLINE !== '0';
  const out = { ...ALL_DISCIPLINE_OFF };
  if (!master) return out;
  (Object.keys(ENV_KEYS) as Array<keyof DisciplineFlags>).forEach((key) => {
    out[key] = cfg?.[key] !== false && env[ENV_KEYS[key]] !== '0';
  });
  return out;
}

/** Per-kind evidence checklists for the pinned contract — the concrete
 *  artifacts that prove a task of this kind is done. Mirrors the spirit of
 *  the prompt-compiler's per-kind evidence lists (src/prompt/prompt-compiler.ts)
 *  in contract-sized form: this list is re-checked cheaply all run long, so
 *  it stays at 2–3 terse items per kind. */
export const KIND_CHECKLISTS: Record<string, string[]> = {
  fix: [
    'The failure was reproduced (or observed) before the fix and is gone after it',
    'The root cause is fixed — not the symptom, and not the test',
    'The existing test suite still passes',
  ],
  implement: [
    'Every acceptance criterion has produced evidence (test, typecheck, or a real run)',
    'The new code path was actually exercised, not just written',
  ],
  refactor: [
    'A behavior baseline was captured before the change',
    'The same checks pass after, with public contracts unchanged',
  ],
  test: [
    'New tests fail on the old behavior and pass on the new',
    'No existing test was weakened, skipped, or deleted to get green',
  ],
  research: [
    'Claims are backed by cited sources or code evidence',
    'The answer addresses the exact question that was asked',
  ],
  plan: ['Steps are ordered and concrete, naming files and how each is verified'],
  document: [
    'The content exists in the target file',
    'Every claim matches the code as it actually is',
  ],
  general: ['The deliverable was produced and checked against the request'],
};

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'make', 'makes',
  'add', 'fix', 'task', 'code', 'file', 'files', 'should', 'when', 'what',
  'using', 'use', 'used', 'all', 'any', 'not', 'but', 'are', 'its', 'it',
  'in', 'on', 'of', 'to', 'a', 'an', 'is', 'be', 'by', 'at', 'or', 'as',
  'so', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'has', 'have',
]);

/** Normalized content tokens for similarity checks (deliberation detection,
 *  relevance tokens). Lowercase alnum words of length >= 3, stopwords kept
 *  only when `keepStopwords` — similarity wants the filler (repeated filler
 *  is exactly the loop signal); relevance wants content words only. */
export function contentTokenSet(text: string, keepStopwords = true): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3) continue;
    if (!keepStopwords && STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Failure-class key for a verification summary. Two failures share a class
 * when their SALIENT lines agree after normalization: digits collapse to
 * `#` (add(2,3)=6 and add(2,3)=-1 are the same root failure), absolute
 * paths collapse to their basename, line numbers collapse to `:L`. This is
 * deliberately coarser than verification.ts failureSignature (which keeps
 * values, for baseline equality): class identity answers "have we seen
 * THIS failure before", not "is this byte-identical to baseline".
 */
export function failureClassOf(summary: string): string {
  const salient = summary
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /fail|error|expected|assert|wrong|✕|×|✗/i.test(l))
    .slice(0, 3);
  const lines = salient.length > 0 ? salient : summary.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2);
  const norm = lines
    .map((l) =>
      l
        .split(/\s+/)
        .map((tok) => {
          if (tok.includes('/')) {
            const parts = tok.split('/').filter(Boolean);
            return parts.length > 0 ? parts[parts.length - 1] : tok;
          }
          return tok;
        })
        .join(' ')
        .replace(/\(fast lane\)/g, '')
        .replace(/:\d+(:\d+)?/g, ':L')
        .replace(/[+-]?\d+(\.\d+)?/g, '#')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s*:/g, ':')
        .toLowerCase(),
    )
    .join(' | ')
    .slice(0, 200);
  return norm || 'unknown-failure';
}

const TRIVIAL_VERIFY_COMMANDS = new Set(['true', ':', 'exit 0', 'echo', 'echo pass', 'echo ok']);

/** Was a passing verification EVIDENCED — a real check command ran and
 *  passed — or vacuous (auto-pass: no checks configured, no changes, a
 *  trivial `true`, a greenfield skip, a profile skip)? Decisive finish may
 *  only skip the self-review round on evidenced passes; a vacuous pass is
 *  exactly the case self-review exists for (e.g. a wrong constant no test
 *  can see). */
export function verifySummaryEvidenced(summary: string): boolean {
  if (summary.startsWith('Manual check passed')) return true;
  if (!summary.startsWith('All checks passed:')) return false;
  const cmds = summary
    .slice('All checks passed:'.length)
    // Lane markers (`[fast lane — targeted set]`) are presentation, not
    // evidence: strip them or `true [fast lane…]` escapes the trivial set
    // and a vacuous pass masquerades as evidenced (skips self-review).
    .replace(/\s*\[fast lane[^\]]*\]/g, '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  return cmds.some((c) => !TRIVIAL_VERIFY_COMMANDS.has(c) && !c.startsWith('echo '));
}

export interface DisciplineContract {
  goal: string;
  checklist: string[];
  scopeFiles: string[];
}

export interface TurnObservation {
  hasToolCalls: boolean;
  /** The batch contains a workspace-mutating call. */
  mutating: boolean;
  /** The batch contains an execution tool (shell/verify/subagent/…) — real
   *  work even when nothing was mutated (a repro run, a check). */
  workTool: boolean;
  /** Distinct read/edited/verify-pass counts grew since the previous turn:
   *  the turn covered NEW ground. */
  progress: boolean;
  content: string;
}

export interface TurnVerdict {
  action: 'none' | 'commit' | 'force';
  streak: number;
  deliberative: boolean;
}

export interface FailureVerdict {
  /** Normalized failure class (see failureClassOf). */
  failureClass: string;
  /** Total times this class has failed this run. */
  classCount: number;
  /** Consecutive failures of this class with the SAME edited-file set. */
  sameApproachCount: number;
  /** First time this class was seen this run. */
  isNewClass: boolean;
  action: 'retry' | 'switch' | 'refuse';
}

interface FailureRecord {
  count: number;
  lastApproach: string;
  sameApproach: number;
  switchDemanded: boolean;
  /** sameApproach value at the moment the switch was demanded; a refusal
   *  requires the SAME approach to be retried past this count. A changed
   *  approach restarts sameApproach, so obeying the switch is never
   *  punished. */
  demandSameApproach: number;
}

/** Deliberation streak at which the commit directive fires. */
export const COMMIT_AT = 2;
/** Deliberation streak at which the harness forces the decisive path. */
export const FORCE_AT = 3;
/** Consecutive unrelated edits that trigger a drift snap-back. */
export const DRIFT_AT = 3;
/** Snap-backs per run (a snap-back is guidance, never a block). */
export const MAX_SNAPBACKS = 2;

export class DisciplineTracker {
  readonly flags: DisciplineFlags;
  readonly contract: DisciplineContract;
  readonly stats = {
    replansAllowed: 0,
    replansSuppressed: 0,
    commitDirectives: 0,
    forceFinishes: 0,
    snapbacks: 0,
    strategySwitches: 0,
    refusals: 0,
    effortEscalations: 0,
  };

  /** Tokens that mark a path as plausibly on-contract: goal/checklist
   *  content words + scope-file stems + anything adopted from the plan. */
  private relevanceTokens = new Set<string>();
  private editedPaths = new Set<string>();
  private driftStreak = 0;
  private driftPaths: string[] = [];

  /** Evidence ledger for the replan gate: a key counts as evidence only
   *  the FIRST time it is seen (a repeated identical failure is not new
   *  evidence). Allowed reconsiderations consume the pending set. */
  private seenEvidence = new Set<string>();
  private pendingEvidence = new Set<string>();

  private deliberationStreak = 0;
  private lastDeliberationTokens: Set<string> | null = null;
  private commitFiredAtStreak = -1;

  private failures = new Map<string, FailureRecord>();

  private effortOffsetValue = 0;
  private cleanStreak = 0;

  constructor(flags: DisciplineFlags, contract: DisciplineContract) {
    this.flags = flags;
    this.contract = contract;
    for (const t of contentTokenSet(`${contract.goal} ${contract.checklist.join(' ')}`, false)) {
      this.relevanceTokens.add(t);
    }
    for (const f of contract.scopeFiles) this.addPathTokens(f);
  }

  private addPathTokens(path: string): void {
    for (const seg of path.toLowerCase().split(/[^a-z0-9]+/)) {
      if (seg.length >= 3 && !STOPWORDS.has(seg)) this.relevanceTokens.add(seg);
    }
  }

  /** The pinned contract as injected at run start. Short on purpose: this
   *  is re-read (by the snap-back) all run long, so it stays terse. */
  contractMessage(): string {
    const goal = this.contract.goal.length > 220 ? `${this.contract.goal.slice(0, 220)}…` : this.contract.goal;
    const parts = [
      'TASK CONTRACT (pinned for this run — this is the whole job):',
      `Goal: ${goal}`,
      'Done means:',
      ...this.contract.checklist.map((c) => `- ${c}`),
    ];
    if (this.contract.scopeFiles.length > 0) {
      parts.push(`Scope: ${this.contract.scopeFiles.join(', ')}`);
    }
    parts.push(
      'Rules: work the contract. Re-plan only when NEW evidence contradicts the plan — otherwise execute the plan you have. ' +
        'When every item above is satisfied and verification passes, finish immediately: no extra polish, re-checks, or new scope.',
    );
    return parts.join('\n');
  }

  /** A plan was adopted (accept_plan in plan mode): its file mentions and
   *  content words join the relevance set, and its assumption lines become
   *  part of the evidence vocabulary. */
  adoptPlan(planText: string): void {
    for (const t of contentTokenSet(planText, false)) this.relevanceTokens.add(t);
    for (const m of planText.matchAll(/[\w./-]+\.[a-z]{1,5}\b/g)) this.addPathTokens(m[0]);
  }

  // ── Mechanism 1: evidence-gated replanning ─────────────────────────────

  /** Record an evidence key. Only the first sighting of a key is evidence;
   *  repeats are the same fact wearing a new timestamp. */
  noteEvidence(key: string): void {
    const k = key.slice(0, 200);
    if (this.seenEvidence.has(k)) return;
    this.seenEvidence.add(k);
    this.pendingEvidence.add(k);
  }

  /** Would a reconsideration right now be justified? Allowed only when
   *  evidence arrived since the last allowed reconsideration. Peeking does
   *  not consume; gating does. */
  peekReconsideration(): boolean {
    return this.pendingEvidence.size > 0;
  }

  gateReconsideration(_source: string): { allowed: boolean; reason: string } {
    if (this.pendingEvidence.size > 0) {
      const reason = `new evidence: ${[...this.pendingEvidence].slice(0, 3).join('; ')}`;
      this.pendingEvidence.clear();
      this.stats.replansAllowed++;
      return { allowed: true, reason };
    }
    this.stats.replansSuppressed++;
    return { allowed: false, reason: 'no new evidence since the last reconsideration' };
  }

  // ── Mechanism 2: progress forcing ──────────────────────────────────────

  /** Feed one model turn. A turn is DELIBERATIVE when it neither mutates
   *  nor covers new ground: no tool calls at all, or read-only calls whose
   *  distinct read/edited/verify counters did not grow (re-inspection), or
   *  prose that near-repeats the previous deliberation (self-debate). */
  noteTurn(obs: TurnObservation): TurnVerdict {
    const tokens = contentTokenSet(obs.content ?? '');
    let deliberative = false;
    if (!obs.mutating) {
      if (!obs.hasToolCalls) deliberative = true;
      else if (!obs.workTool && !obs.progress) deliberative = true;
      // Near-repeat prose on top of a non-mutating turn is self-debate even
      // when the turn also re-read something new: the words are the loop.
      if (
        !deliberative &&
        this.lastDeliberationTokens !== null &&
        tokens.size >= 4 &&
        jaccardSimilarity(tokens, this.lastDeliberationTokens) >= 0.75
      ) {
        deliberative = true;
      }
    }
    if (!deliberative) {
      this.deliberationStreak = 0;
      this.commitFiredAtStreak = -1;
      if (obs.mutating || obs.progress) this.lastDeliberationTokens = null;
      return { action: 'none', streak: 0, deliberative: false };
    }
    this.deliberationStreak++;
    this.lastDeliberationTokens = tokens;
    if (this.deliberationStreak >= FORCE_AT) {
      return { action: 'force', streak: this.deliberationStreak, deliberative: true };
    }
    if (this.deliberationStreak >= COMMIT_AT && this.commitFiredAtStreak !== this.deliberationStreak) {
      this.commitFiredAtStreak = this.deliberationStreak;
      this.stats.commitDirectives++;
      return { action: 'commit', streak: this.deliberationStreak, deliberative: true };
    }
    return { action: 'none', streak: this.deliberationStreak, deliberative: true };
  }

  /** One-line commit directive (mechanism 2, first offense). */
  commitDirective(streak: number): string {
    return (
      `COMMIT — you have spent ${streak} consecutive turns deliberating without acting or covering new ground. ` +
      'State your decision in one line and ACT on it now: call the tool that advances the plan, or finish with your current best answer. ' +
      'Do not re-open settled questions without new evidence.'
    );
  }

  // ── Mechanism 3: drift snap-back ───────────────────────────────────────

  /** Feed one successful mutating edit (workspace-relative path). Returns
   *  snapback=true when the edit is the DRIFT_AT-th consecutive edit that
   *  touches nothing the contract names (bounded per run). */
  noteEdit(relPath: string): { snapback: boolean; streak: number } {
    const norm = (relPath ?? '').replace(/\\/g, '/').toLowerCase();
    if (!norm || norm.startsWith('../') || norm === '.mochi' || norm.startsWith('.mochi/') || norm.includes('/.mochi/')) {
      return { snapback: false, streak: this.driftStreak };
    }
    if (this.isRelevantPath(norm)) {
      this.driftStreak = 0;
      this.editedPaths.add(norm);
      return { snapback: false, streak: this.driftStreak };
    }
    // Every unrelated edit counts — including re-edits of a file the model
    // is fixating on (fixation on a wrong file IS drift). The per-run
    // snapback cap + streak reset on firing keep this from spamming.
    this.editedPaths.add(norm);
    this.driftStreak++;
    this.driftPaths = [...this.driftPaths.slice(-(DRIFT_AT - 1)), relPath];
    if (this.driftStreak >= DRIFT_AT && this.stats.snapbacks < MAX_SNAPBACKS) {
      this.stats.snapbacks++;
      this.driftStreak = 0;
      return { snapback: true, streak: DRIFT_AT };
    }
    return { snapback: false, streak: this.driftStreak };
  }

  private isRelevantPath(normPath: string): boolean {
    for (const scope of this.contract.scopeFiles) {
      const s = scope.replace(/\\/g, '/').toLowerCase();
      if (normPath === s || normPath.startsWith(s.endsWith('/') ? s : `${s}/`)) return true;
    }
    for (const seg of normPath.split(/[^a-z0-9]+/)) {
      if (seg.length >= 3 && this.relevanceTokens.has(seg)) return true;
    }
    for (const t of this.relevanceTokens) {
      if (t.length >= 4 && normPath.includes(t)) return true;
    }
    return false;
  }

  /** The snap-back message: the contract restated, the stray paths named.
   *  One concise correction — not a lecture, not a reset. */
  snapbackMessage(): string {
    const goal = this.contract.goal.length > 160 ? `${this.contract.goal.slice(0, 160)}…` : this.contract.goal;
    return (
      `DRIFT SNAP-BACK — your recent edits (${this.driftPaths.join(', ')}) do not touch anything the task contract names.\n` +
      `Contract goal: ${goal}\n` +
      `Done means: ${this.contract.checklist.join('; ')}\n` +
      'Get back on contract: work only on files the task names or the plan requires. ' +
      'If the contract itself is wrong, say so explicitly in one line instead of wandering.'
    );
  }

  // ── Mechanism 5: same-failure strategy switch ──────────────────────────

  /** Feed one verification failure. `editedFiles` = files edited since the
   *  previous verification attempt (the "approach" fingerprint). */
  noteVerifyFailure(summary: string, editedFiles: string[]): FailureVerdict {
    const failureClass = failureClassOf(summary);
    const approach = [...new Set(editedFiles.map((f) => f.replace(/\\/g, '/')))].sort().join(',');
    const isNewClass = !this.failures.has(failureClass);
    if (isNewClass) this.noteEvidence(`verify-failure:${failureClass}`);
    const rec: FailureRecord = this.failures.get(failureClass) ?? {
      count: 0,
      lastApproach: '',
      sameApproach: 0,
      switchDemanded: false,
      demandSameApproach: 0,
    };
    rec.count++;
    if (rec.lastApproach === approach) rec.sameApproach++;
    else {
      rec.sameApproach = 1;
      rec.lastApproach = approach;
    }
    // An EMPTY approach (the model changed nothing since the last attempt
    // — it merely re-claimed completion) is not a retry of an approach at
    // all: it never escalates to switch/refusal. That failure shape is
    // owned by the loop's verify-retry budget + rollback, not by this
    // mechanism, which exists for approaches actually being repeated.
    const hasApproach = approach.length > 0;
    let action: FailureVerdict['action'] = 'retry';
    if (hasApproach && !rec.switchDemanded && rec.sameApproach >= 3) {
      // Third failure of this class with the same approach: the approach
      // is indicted, not the effort. Demand a strategy switch.
      rec.switchDemanded = true;
      rec.demandSameApproach = rec.sameApproach;
      action = 'switch';
      this.stats.strategySwitches++;
    } else if (hasApproach && rec.switchDemanded && rec.sameApproach > rec.demandSameApproach) {
      // A strategy switch was demanded and the SAME approach was retried
      // anyway (sameApproach only grows while the approach is unchanged):
      // refuse the cycle — the loop finishes honestly with what was tried.
      action = 'refuse';
      this.stats.refusals++;
    }
    this.failures.set(failureClass, rec);
    return { failureClass, classCount: rec.count, sameApproachCount: rec.sameApproach, isNewClass, action };
  }

  /** The strategy-switch directive injected when 'switch' fires. */
  strategySwitchMessage(v: FailureVerdict, editedFiles: string[]): string {
    const files = [...new Set(editedFiles.map((f) => f.split('/').pop() ?? f))].slice(0, 6).join(', ') || 'none';
    return (
      `STRATEGY SWITCH REQUIRED — this failure (${v.failureClass}) has now failed ${v.classCount} times, ` +
      `and the recent attempts kept editing the same files (${files}). Do NOT retry the same approach: another identical attempt will be refused. ` +
      'Either (1) name a DIFFERENT root-cause hypothesis and examine a file you have not opened yet, ' +
      '(2) re-survey the failing code path from scratch, or (3) stop and report exactly what you tried.'
    );
  }

  // ── Mechanism 6: adaptive effort ───────────────────────────────────────

  get effortOffset(): number {
    return this.effortOffsetValue;
  }

  /** A hard signal arrived (new failure class, complexity escalation):
   *  deepen thought by one rung, capped at +2. */
  noteHardSignal(): void {
    if (this.effortOffsetValue < 2) {
      this.effortOffsetValue++;
      this.stats.effortEscalations++;
    }
    this.cleanStreak = 0;
  }

  /** A clean, productive turn (mutation landed, no new errors). Two in a
   *  row decay the offset toward — and one step past — the base tier:
   *  cruising runs get cheaper, not just struggling runs dearer. */
  noteCleanTurn(): void {
    this.cleanStreak++;
    if (this.cleanStreak >= 2) {
      if (this.effortOffsetValue > -1) this.effortOffsetValue--;
      this.cleanStreak = 0;
    }
  }

  /** Verification passed: the evidence state is fresh — reset the offset. */
  noteVerifyPass(): void {
    this.effortOffsetValue = 0;
    this.cleanStreak = 0;
  }

  /** Apply the current offset to a base tier. Floor: adaptation never
   *  drops a run to 'off' (that is a user choice), and an 'off' base is
   *  never raised. */
  adjustEffort(base: EffortTier): EffortTier {
    if (base === 'off' || this.effortOffsetValue === 0) return base;
    const idx = EFFORT_TIERS.indexOf(base);
    const next = Math.min(EFFORT_TIERS.length - 1, Math.max(1, idx + this.effortOffsetValue));
    return EFFORT_TIERS[next];
  }
}
