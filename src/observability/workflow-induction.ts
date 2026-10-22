// D9: workflow induction — mine VERIFIED successful trajectories for the
// tool spines that keep winning and the recovery sequences that rescue
// failing runs, then emit them as DRAFT macros (skills).
//
// Admission rule (the whole point): only gate-verified records count —
// verification PASS / FLAKY-PASS (trajectory `verified`), or for tool-seq
// records outcome 'success' AND verified === true. A run that merely
// *finished*, or a corpus of failures, induces NOTHING: an unverified
// "winning" spine is just a habit, and habits include the bad ones.
//
// Emission rule: drafts are born through skill-manager's writeSkill with
// lifecycle 'probation' — the Phase B machinery owns promotion from there
// (advertising floors, curator promotion on verifier-passed runs). This
// module never stamps a macro active and never overwrites an existing
// skill. Pure mining functions are deterministic and filesystem-free.
import type { TrajectoryRecord } from './trajectory.js';
import { isVerifiedRecord } from './trajectory.js';
import type { ToolSeqRecord } from '../core/tool-sequence.js';
import { safeSlug, writeSkill, skillsRoot } from '../skills/skill-manager.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface InducedMacro {
  kind: 'spine' | 'recovery';
  /** Slug naming the sequence, e.g. 'spine-read-search-edit-shell' or
   *  'recovery-shell-via-edit-shell'. The draft skill carries this name. */
  name: string;
  /** The tool sequence itself, in order. For a recovery macro the first
   *  entry is the tool that FAILED and the last is its eventual success. */
  spine: string[];
  /** Distinct verified records containing the sequence. */
  support: number;
  taskKinds: string[];
  sourceRunIds: string[];
  /** Mean total cost (reported + estimated) of supporting records, when
   *  at least one of them carried cost data. */
  avgCostUsd?: number;
  /** Recovery macros only: the tool whose failure opens the sequence. */
  failedTool?: string;
}

export interface InductionOptions {
  /** Distinct verified records a sequence must appear in. Default 2. */
  minSupport?: number;
  /** Shortest sequence worth inducing. Default 3 for spines, 2 for
   *  recovery windows (a fail→retry pair is already a pattern). */
  minSpineLen?: number;
  /** Longest sequence considered. Default 6. */
  maxSpineLen?: number;
  /** Cap on returned macros per kind. Default 8. */
  maxMacros?: number;
}

interface NormSeq {
  tools: string[];
  runId: string;
  taskKind?: string;
  costUsd?: number;
  /** Per-step ok flags (trajectories only; tool-seq records lack them). */
  oks?: boolean[];
}

function trajectoryCost(rec: TrajectoryRecord): number | undefined {
  if (rec.cost) return rec.cost.totalUsd;
  if (rec.usage) {
    const t = (rec.usage.costUsd ?? 0) + (rec.usage.estimatedCostUsd ?? 0);
    return t > 0 ? t : undefined;
  }
  return undefined;
}

function fromTrajectories(records: readonly TrajectoryRecord[]): NormSeq[] {
  return records.filter(isVerifiedRecord).map((rec) => ({
    tools: rec.steps.map((s) => s.tool),
    runId: rec.runId,
    ...(rec.taskKind && rec.taskKind !== 'unknown' ? { taskKind: rec.taskKind } : {}),
    ...(trajectoryCost(rec) !== undefined ? { costUsd: trajectoryCost(rec) } : {}),
    oks: rec.steps.map((s) => s.ok),
  }));
}

interface Candidate {
  spine: string[];
  runIds: Set<string>;
  taskKinds: Set<string>;
  costs: number[];
}

function countWindows(
  seqs: NormSeq[],
  windowsOf: (seq: NormSeq) => string[][],
): Candidate[] {
  const byKey = new Map<string, Candidate>();
  for (const seq of seqs) {
    const seenHere = new Set<string>();
    for (const w of windowsOf(seq)) {
      const key = w.join('\u0000');
      if (seenHere.has(key)) continue; // support counts RECORDS, not occurrences
      seenHere.add(key);
      let c = byKey.get(key);
      if (!c) {
        c = { spine: w, runIds: new Set(), taskKinds: new Set(), costs: [] };
        byKey.set(key, c);
      }
      c.runIds.add(seq.runId);
      if (seq.taskKind) c.taskKinds.add(seq.taskKind);
      if (seq.costUsd !== undefined) c.costs.push(seq.costUsd);
    }
  }
  return [...byKey.values()];
}

function containsSpine(haystack: string[], needle: string[]): boolean {
  if (needle.length >= haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Drop any candidate that is a contiguous subsequence of a longer kept
 *  candidate with at least its support — the longest statement of the same
 *  evidence wins, so a corpus doesn't emit spine A→B→C AND A→B→C→D. */
function pruneSubsumed(cands: Candidate[]): Candidate[] {
  const sorted = [...cands].sort((a, b) => b.spine.length - a.spine.length || b.runIds.size - a.runIds.size);
  const kept: Candidate[] = [];
  for (const c of sorted) {
    if (kept.some((k) => k.runIds.size >= c.runIds.size && containsSpine(k.spine, c.spine))) continue;
    kept.push(c);
  }
  return kept;
}

function toMacro(kind: 'spine' | 'recovery', c: Candidate, failedTool?: string): InducedMacro {
  const spineText = c.spine.join('-');
  const name = kind === 'spine'
    ? safeSlug(`spine-${spineText}`)
    : safeSlug(`recovery-${failedTool ?? c.spine[0]}-via-${c.spine.slice(1, -1).join('-') || 'retry'}-${c.spine[c.spine.length - 1]}`);
  return {
    kind,
    name: name.slice(0, 64).replace(/-+$/g, ''),
    spine: c.spine,
    support: c.runIds.size,
    taskKinds: [...c.taskKinds].sort(),
    sourceRunIds: [...c.runIds].sort(),
    ...(c.costs.length ? { avgCostUsd: c.costs.reduce((a, b) => a + b, 0) / c.costs.length } : {}),
    ...(failedTool ? { failedTool } : {}),
  };
}

function mineSpinesFrom(seqs: NormSeq[], opts: InductionOptions): InducedMacro[] {
  const minSupport = opts.minSupport ?? 2;
  const minLen = opts.minSpineLen ?? 3;
  const maxLen = opts.maxSpineLen ?? 6;
  const maxMacros = opts.maxMacros ?? 8;
  if (seqs.length < minSupport) return [];
  const cands = countWindows(seqs, (seq) => {
    const out: string[][] = [];
    const hi = Math.min(maxLen, seq.tools.length);
    for (let n = minLen; n <= hi; n++) {
      for (let i = 0; i + n <= seq.tools.length; i++) out.push(seq.tools.slice(i, i + n));
    }
    return out;
  }).filter((c) => c.runIds.size >= minSupport);
  return pruneSubsumed(cands)
    .map((c) => toMacro('spine', c))
    .sort((a, b) => b.support - a.support || b.spine.length - a.spine.length || a.name.localeCompare(b.name))
    .slice(0, maxMacros);
}

/** Winning spines: contiguous tool sequences repeated across verified
 *  successful trajectories. Failed / unverified records never contribute. */
export function mineWinningSpines(records: readonly TrajectoryRecord[], opts: InductionOptions = {}): InducedMacro[] {
  return mineSpinesFrom(fromTrajectories(records), opts);
}

/** Recovery sequences: inside verified successful runs, a step that FAILED
 *  and the steps up to the same tool's eventual success — the fail→fix
 *  pattern the run used to rescue itself, worth teaching as a macro. */
export function mineRecoverySequences(records: readonly TrajectoryRecord[], opts: InductionOptions = {}): InducedMacro[] {
  const minSupport = opts.minSupport ?? 2;
  const maxLen = opts.maxSpineLen ?? 6;
  const maxMacros = opts.maxMacros ?? 8;
  const seqs = fromTrajectories(records);
  if (seqs.length < minSupport) return [];
  const byFailed = new Map<string, Candidate[]>();
  const cands = countWindows(seqs, (seq) => {
    if (!seq.oks) return [];
    const out: string[][] = [];
    for (let i = 0; i < seq.tools.length; i++) {
      if (seq.oks[i]) continue;
      // The rescue window: from the failure through the SAME tool's next
      // success, bounded so a late unrelated retry doesn't count.
      for (let j = i + 1; j < seq.tools.length && j <= i + maxLen - 1; j++) {
        if (seq.tools[j] === seq.tools[i] && seq.oks[j]) {
          out.push(seq.tools.slice(i, j + 1));
          break;
        }
      }
    }
    return out;
  }).filter((c) => c.runIds.size >= minSupport);
  for (const c of pruneSubsumed(cands)) {
    const arr = byFailed.get(c.spine[0]) ?? [];
    arr.push(c);
    byFailed.set(c.spine[0], arr);
  }
  return [...byFailed.values()].flat()
    .map((c) => toMacro('recovery', c, c.spine[0]))
    .sort((a, b) => b.support - a.support || b.spine.length - a.spine.length || a.name.localeCompare(b.name))
    .slice(0, maxMacros);
}

/** All induced macros for a trajectory corpus: winning spines + recoveries. */
export function induceWorkflows(records: readonly TrajectoryRecord[], opts: InductionOptions = {}): InducedMacro[] {
  return [...mineWinningSpines(records, opts), ...mineRecoverySequences(records, opts)];
}

/** Spine induction over v2 tool-seq records (no per-step ok flags exist
 *  there, so recoveries can't be mined from this source — spines only). */
export function induceFromToolSeqs(records: readonly ToolSeqRecord[], opts: InductionOptions = {}): InducedMacro[] {
  const seqs: NormSeq[] = records
    .filter((r) => r.outcome === 'success' && r.verified === true)
    .map((r, i) => ({
      tools: r.tools,
      runId: `toolseq-${i}`,
      ...(r.taskKind ? { taskKind: r.taskKind } : {}),
      ...((r.costUsd !== undefined || r.estimatedCostUsd !== undefined)
        ? { costUsd: (r.costUsd ?? 0) + (r.estimatedCostUsd ?? 0) }
        : {}),
    }));
  return mineSpinesFrom(seqs, opts);
}

// ─── Draft emission (Phase B owns promotion) ─────────────────────────────

export interface InducedDraft {
  macro: InducedMacro;
  slug: string;
  path: string;
  /** Lifecycle state stamped at birth ('probation' when enforcement is on). */
  state?: string;
}

function macroDescription(m: InducedMacro): string {
  const route = m.spine.join(' → ');
  const kinds = m.taskKinds.length ? ` Task kinds: ${m.taskKinds.join(', ')}.` : '';
  return m.kind === 'spine'
    ? `Induced workflow macro: winning tool spine ${route}, seen in ${m.support} verified successful runs.${kinds}`
    : `Induced recovery macro: when ${m.failedTool ?? m.spine[0]} fails, recover via ${route}, seen in ${m.support} verified successful runs.${kinds}`;
}

function macroBody(m: InducedMacro): string {
  const route = m.spine.join(' → ');
  const steps = m.spine.map((t, i) => (m.kind === 'recovery' && i === 0
    ? `${i + 1}. Note the \`${t}\` failure — do not retry it unchanged; start the recovery below.`
    : `${i + 1}. Call \`${t}\` as step ${i + 1} of the ${m.kind === 'recovery' ? 'recovery' : 'winning'} sequence.`));
  // A closing step keeps even a 2-call recovery window above the skill
  // quality gate's 3-numbered-steps bar, and states the macro's contract.
  steps.push(`${steps.length + 1}. Confirm completion with the verification step below before claiming the task is done.`);
  const lines = [
    `# Induced ${m.kind === 'recovery' ? 'recovery' : 'workflow'}: ${route}`,
    '',
    `Status: DRAFT macro induced from trajectory mining (D9). It was born on probation and is promoted only by the skill curator's verifier-pass gate — treat it as a strong hint, not a requirement.`,
    `Evidence: ${m.support} verified successful run(s)${m.taskKinds.length ? ` across task kind(s): ${m.taskKinds.join(', ')}` : ''}. Source runs: ${m.sourceRunIds.join(', ')}.`,
    ...(m.avgCostUsd !== undefined ? [`Mean cost of supporting runs: $${m.avgCostUsd.toFixed(4)}.`] : []),
    '',
    '## When to use',
    m.kind === 'spine'
      ? `Use this spine when a task matches the kinds above and the opening situation resembles the supporting runs: the sequence ${route} repeatedly ended in a verifier PASS for those tasks.`
      : `Use this recovery when a \`${m.failedTool ?? m.spine[0]}\` call has just failed mid-task and the run is otherwise on track: this exact fail-then-fix sequence rescued ${m.support} verified runs.`,
    '',
    '## Procedure',
    ...steps,
    '',
    '## Pitfalls and failure recovery',
    m.kind === 'spine'
      ? `If a step in the spine fails, stop following the spine blindly: inspect the failure output first, change the failing call's inputs, and only then resume the sequence at the failed step. A spine that needed rescue is evidence for a recovery macro, not for repeating the same calls.`
      : `The common pitfall is retrying \`${m.failedTool ?? m.spine[0]}\` with identical inputs — every supporting run changed something (the steps between the failure and the success) before the retry. If the recovery window fails twice, abandon it and re-plan rather than looping.`,
    '',
    '## Verification',
    `After following the sequence, run the project's verification (test suite or the run's verify step) and check that it passes before claiming completion. A macro run only counts as evidence when the verifier gate passes.`,
  ];
  return lines.join('\n');
}

/** Emit ONE induced macro as a DRAFT skill via the Phase B birth path
 *  (writeSkill, lifecycle 'probation', category 'induced'). Returns null
 *  when the skill already exists or the quality/lint gates reject the
 *  draft — gates are never bypassed. Never stamps anything active. */
export function draftInducedMacro(projectDir: string, macro: InducedMacro): InducedDraft | null {
  try {
    const slug = safeSlug(macro.name);
    if (existsSync(join(skillsRoot(projectDir), 'induced', slug, 'SKILL.md'))) return null;
    const r = writeSkill(projectDir, {
      name: slug,
      description: macroDescription(macro),
      body: macroBody(macro),
      category: 'induced',
      lifecycle: 'probation',
    });
    if (!r.ok || !r.path) return null;
    return { macro, slug, path: r.path, ...(r.state ? { state: r.state } : {}) };
  } catch {
    return null;
  }
}

/** Mine a corpus and draft every induced macro. Idempotent per skill name:
 *  a second run over the same corpus drafts nothing new. */
export function induceAndDraft(
  projectDir: string,
  records: readonly TrajectoryRecord[],
  opts: InductionOptions = {},
): InducedDraft[] {
  const out: InducedDraft[] = [];
  for (const macro of induceWorkflows(records, opts)) {
    const d = draftInducedMacro(projectDir, macro);
    if (d) out.push(d);
  }
  return out;
}
