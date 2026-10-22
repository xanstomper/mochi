// Automatic skill repair loop (D8) — demoted skills get patched from the
// trajectories of the runs that loaded them and failed, then re-enter
// through the EXISTING probation path. Model-free and deterministic: the
// patch is compiled from recorded failure evidence (taxonomy labels,
// failing tools, error snippets), never invented, so the same evidence
// always produces the same repair.
//
// Hard invariants (the falsifiable contract):
//   - ONLY demoted skills are eligible. Repair is the demotion recovery
//     path, not a general editor — active/probation/legacy skills refuse.
//   - A repaired skill NEVER goes straight back to active. The patch is
//     written through writeSkill with lifecycle 'probation' (which stamps
//     probation via stampSkillBirth and resets passesInState), so the
//     repaired body must re-earn activation with verifier-passed runs,
//     exactly like a newly authored skill.
//   - At most MAX_SKILL_REPAIR_ATTEMPTS repairs per skill. A skill at the
//     cap stays demoted with the exhaustion recorded as its
//     lastRepairReason — no silent loop of endless self-patching.
//   - No failure evidence, no patch. A demotion the trajectories can't
//     explain is a human's problem, not a template's.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  loadSkillUsage, saveSkillUsage, resolveSkillsSettings,
  type SkillLifecycleState,
} from './skills.js';
import {
  skillsRoot, safeSlug, parseFrontmatter, writeSkill,
} from './skill-manager.js';
import { maybeRedact } from '../security/security.js';
import type { TrajectoryRecord } from '../observability/trajectory.js';

/** Hard cap on automatic repairs per skill. After this many patched
 *  re-probations have failed to re-earn activation, the skill stays
 *  demoted and a human decides (fix by hand, or archive it). */
export const MAX_SKILL_REPAIR_ATTEMPTS = 3;

/** Heading of the section a repair appends. A later repair REPLACES the
 *  previous section (matched by this prefix) instead of stacking them,
 *  so repeated repairs cannot grow the body without bound. */
export const REPAIR_SECTION_HEADING = '## Repair notes — auto-repair attempt';

/** Structural subset of TrajectoryRecord the repair pass reads. Accepting
 *  the subset (not the full record) keeps callers free to pass trajectory
 *  exports, in-memory records, or test fixtures interchangeably. */
export type RepairTrajectoryInput = Pick<TrajectoryRecord, 'runId' | 'skills' | 'verification' | 'failureTaxonomy' | 'steps' | 'task'>;

const FAILING_VERDICTS: ReadonlySet<string> = new Set(['fail', 'partial', 'blocked']);

export interface FailureEvidenceRun {
  runId: string;
  verdict: string;
  taskTitle?: string;
  failureLabels: string[];
  failedTools: string[];
}

export interface FailureEvidence {
  /** Failed runs that loaded the skill, oldest evidence first as given. */
  runs: FailureEvidenceRun[];
  /** Failure-taxonomy label -> number of runs exhibiting it. */
  labelCounts: Record<string, number>;
  /** Tool name -> number of failed steps across the evidence runs. */
  failedToolCounts: Record<string, number>;
  /** Deduped, redacted, length-capped error strings from failed steps. */
  errorSnippets: string[];
}

function clip(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/** Extract the failure evidence for `skillName` from a trajectory corpus:
 *  only runs that LOADED the skill and ended in a failing verifier verdict
 *  (fail / partial / blocked — the same buckets recordSkillOutcome treats
 *  as harmful evidence). Passing runs and runs that never loaded the skill
 *  carry no repair signal and are ignored. */
export function extractFailureEvidence(
  skillName: string,
  trajectories: readonly RepairTrajectoryInput[],
): FailureEvidence {
  const runs: FailureEvidenceRun[] = [];
  const labelCounts: Record<string, number> = {};
  const failedToolCounts: Record<string, number> = {};
  const errorSnippets: string[] = [];
  const seenErrors = new Set<string>();
  for (const traj of trajectories) {
    const use = (traj.skills ?? []).find((s) => s.id === skillName);
    if (!use) continue;
    const verdict = FAILING_VERDICTS.has(use.verdict)
      ? use.verdict
      : (traj.verification && FAILING_VERDICTS.has(traj.verification.verdict) ? traj.verification.verdict : null);
    if (!verdict) continue;
    const failureLabels: string[] = [];
    for (const f of traj.failureTaxonomy ?? []) {
      if (!f || typeof f.label !== 'string' || !f.label) continue;
      failureLabels.push(f.label);
      labelCounts[f.label] = (labelCounts[f.label] ?? 0) + 1;
    }
    const failedTools: string[] = [];
    for (const step of traj.steps ?? []) {
      if (step.ok) continue;
      if (step.tool && !failedTools.includes(step.tool)) failedTools.push(step.tool);
      if (step.tool) failedToolCounts[step.tool] = (failedToolCounts[step.tool] ?? 0) + 1;
      if (step.error) {
        const err = clip(maybeRedact(String(step.error)), 160);
        if (err && !seenErrors.has(err)) {
          seenErrors.add(err);
          if (errorSnippets.length < 5) errorSnippets.push(err);
        }
      }
    }
    runs.push({
      runId: traj.runId,
      verdict,
      ...(traj.task?.title ? { taskTitle: clip(traj.task.title, 100) } : {}),
      failureLabels,
      failedTools,
    });
  }
  return { runs, labelCounts, failedToolCounts, errorSnippets };
}

/** Load exported trajectories (`<project>/exports/trajectory-*.jsonl`, the
 *  durable artifact trajectory.ts writes) for the repair pass. When
 *  `skillName` is given, only its failure runs are returned. Corrupt or
 *  unreadable export files are skipped — a repair pass must never die on
 *  one bad line of telemetry. */
export function loadExportedTrajectories(projectDir: string): TrajectoryRecord[] {
  const dir = join(projectDir, 'exports');
  const out: TrajectoryRecord[] = [];
  try {
    if (!existsSync(dir)) return out;
    for (const f of readdirSync(dir)) {
      if (!/^trajectory-.+\.jsonl$/.test(f)) continue;
      try {
        for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
          const t = line.trim();
          if (!t) continue;
          try {
            const rec = JSON.parse(t) as TrajectoryRecord;
            if (rec && typeof rec.runId === 'string' && Array.isArray(rec.skills)) out.push(rec);
          } catch { /* skip the bad line, keep the rest of the file */ }
        }
      } catch { /* skip the unreadable file */ }
    }
  } catch { /* exports are best-effort telemetry */ }
  return out;
}

/** Concrete guardrails derived from the evidence's dominant failure modes.
 *  Each maps a taxonomy label the harness actually emits (see
 *  trajectory.ts buildFailureTaxonomy) to the countermeasure that would
 *  have interrupted that failure. Evidence-free labels get no guardrail —
 *  the section still carries the generic evidence-check rule. */
export function guardrailsFor(evidence: FailureEvidence): string[] {
  const out: string[] = [
    'Treat the failure evidence in this section as a pre-flight checklist: before finishing, confirm none of the recorded failure modes recurred in the current run.',
  ];
  const has = (label: string): boolean => (evidence.labelCounts[label] ?? 0) > 0;
  if (has('tool_loop') || has('repeated_tool_calls')) {
    out.push('Never repeat an identical tool call with identical arguments after a failure — change one variable (arguments, order, or approach), or stop and re-plan instead of looping.');
  }
  if (has('verification_failed')) {
    out.push('Before claiming completion, re-run the exact verifier or test command that failed in the recorded runs and require a passing result; a fix that was never re-verified does not count as done.');
  }
  if (has('tool_errors') || Object.keys(evidence.failedToolCounts).length > 0) {
    const tools = Object.keys(evidence.failedToolCounts).slice(0, 3).join(', ');
    out.push(`When a tool call errors${tools ? ` (recorded failing tools: ${tools})` : ''}, read its full output and fix the cause before retrying; never retry the same failing call unchanged.`);
  }
  if (has('stuck_no_progress')) {
    out.push('If two consecutive steps produce no new evidence or progress, stop, restate what is known, and choose a different approach instead of continuing the same line.');
  }
  return out.slice(0, 4);
}

/** Remove a previous auto-repair section (from its heading to end of body;
 *  repairs always append last, so the section is always trailing). */
export function stripPriorRepairSection(body: string): string {
  const idx = body.indexOf(REPAIR_SECTION_HEADING);
  return idx === -1 ? body : body.slice(0, idx).trimEnd();
}

/** Build the patched body: the original procedure untouched, plus ONE
 *  repair section summarizing the demotion, the failure evidence, and the
 *  guardrails derived from it. Pure — the falsifiable patch content lives
 *  here, separate from the registry/file writes in attemptSkillRepair. */
export function buildRepairedBody(
  originalBody: string,
  opts: { attempt: number; demotionReason?: string; evidence: FailureEvidence },
): string {
  const { attempt, demotionReason, evidence } = opts;
  const base = stripPriorRepairSection(originalBody).trimEnd();
  const lines: string[] = [
    '',
    `${REPAIR_SECTION_HEADING} ${attempt} of ${MAX_SKILL_REPAIR_ATTEMPTS}`,
    '',
    `This skill was demoted${demotionReason ? ` (${clip(demotionReason, 240)})` : ''} and automatically repaired from ${evidence.runs.length} failed run${evidence.runs.length === 1 ? '' : 's'} that loaded it. It re-enters on probation and must re-earn activation with verifier-passed runs, exactly like a newly authored skill.`,
    '',
    'Failure evidence:',
    ...evidence.runs.slice(0, 5).map((r) => {
      const bits: string[] = [`run ${r.runId} (${r.verdict})`];
      if (r.taskTitle) bits.push(`task "${r.taskTitle}"`);
      if (r.failureLabels.length) bits.push(`failures: ${r.failureLabels.join(', ')}`);
      if (r.failedTools.length) bits.push(`failing tools: ${r.failedTools.join(', ')}`);
      return `- ${bits.join(' — ')}`;
    }),
    ...(evidence.runs.length > 5 ? [`- …and ${evidence.runs.length - 5} more failed run(s) with the same pattern`] : []),
    ...evidence.errorSnippets.map((e) => `- recorded error: "${e}"`),
    '',
    'Guardrails added by this repair:',
    ...guardrailsFor(evidence).map((g, i) => `${i + 1}. ${g}`),
    '',
  ];
  return base + '\n' + lines.join('\n');
}

export interface RepairResult {
  ok: boolean;
  skillName: string;
  /** repaired = patched + re-probationed; refused = policy said no
   *  (not demoted / cap reached / no evidence / lifecycle off);
   *  failed = eligible but the patch could not be written. */
  status: 'repaired' | 'refused' | 'failed';
  /** Repair attempts recorded for the skill AFTER this call. */
  repairAttempts: number;
  /** The attempt number performed (only on status 'repaired'). */
  attempt?: number;
  /** Lifecycle state after this call (only when a record exists). */
  state?: SkillLifecycleState;
  /** Failure runs the patch was built from. */
  evidenceRuns: number;
  reason: string;
  path?: string;
}

/** Locate a skill's SKILL.md under the project skills tree (root or one
 *  category level), mirroring skill-manager's private finder. Returns the
 *  path and the category directory it lives in, if any. */
function findSkillFile(projectDir: string, name: string): { path: string; category?: string } | null {
  const root = skillsRoot(projectDir);
  if (!existsSync(root)) return null;
  const slug = safeSlug(name);
  const exact = join(root, slug, 'SKILL.md');
  if (existsSync(exact)) return { path: exact };
  try {
    for (const cat of readdirSync(root, { withFileTypes: true })) {
      if (!cat.isDirectory() || cat.name.startsWith('.')) continue;
      const p = join(root, cat.name, slug, 'SKILL.md');
      if (existsSync(p)) return { path: p, category: cat.name };
    }
  } catch { /* unreadable tree = not found */ }
  return null;
}

/** Record WHY a repair did not (or did) happen on the skill's registry
 *  record, without touching its lifecycle state or attempt counter. */
function recordRepairNote(projectDir: string, name: string, reason: string, now: number): void {
  try {
    const all = loadSkillUsage(projectDir);
    const cur = all.get(name);
    if (!cur) return;
    cur.lastRepairAt = now;
    cur.lastRepairReason = reason;
    all.set(name, cur);
    saveSkillUsage(projectDir, all);
  } catch { /* bookkeeping is best-effort, like all skill stats */ }
}

/** Attempt ONE automatic repair of a demoted skill. See the module header
 *  for the invariants; every refusal/failure leaves the skill demoted and
 *  records its reason on the registry record. */
export function attemptSkillRepair(
  projectDir: string,
  skillName: string,
  trajectories: readonly RepairTrajectoryInput[],
  opts: { now?: number } = {},
): RepairResult {
  const now = opts.now ?? Date.now();
  const usage = loadSkillUsage(projectDir);
  const rec = usage.get(skillName);
  const attempts = rec?.repairAttempts ?? 0;
  const base: Omit<RepairResult, 'status' | 'reason'> = {
    ok: false,
    skillName,
    repairAttempts: attempts,
    ...(rec?.state ? { state: rec.state } : {}),
    evidenceRuns: 0,
  };

  if (!resolveSkillsSettings().probationEnabled) {
    return { ...base, status: 'refused', reason: 'skill probation lifecycle is disabled — repair requires the probation re-entry path' };
  }
  if (!rec || rec.state !== 'demoted') {
    return {
      ...base, status: 'refused',
      reason: !rec
        ? 'no lifecycle record for this skill — repair only applies to demoted skills'
        : `skill is '${rec.state ?? 'legacy (no state)'}', not demoted — repair only applies to demoted skills`,
    };
  }
  if (attempts >= MAX_SKILL_REPAIR_ATTEMPTS) {
    const reason = `repair attempts exhausted (${attempts}/${MAX_SKILL_REPAIR_ATTEMPTS}) — skill stays demoted; a human must fix it by hand or archive it (last demotion: ${rec.lastDemotionReason ?? 'reason not recorded'})`;
    recordRepairNote(projectDir, skillName, reason, now);
    return { ...base, status: 'refused', reason };
  }

  const evidence = extractFailureEvidence(skillName, trajectories);
  if (evidence.runs.length === 0) {
    const reason = 'no failure trajectories for this skill — a repair patch needs recorded failed runs that loaded it; refusing to patch blind';
    recordRepairNote(projectDir, skillName, reason, now);
    return { ...base, status: 'refused', evidenceRuns: 0, reason };
  }

  const found = findSkillFile(projectDir, skillName);
  if (!found) {
    const reason = 'skill file not found in the project skills tree — nothing to patch';
    recordRepairNote(projectDir, skillName, reason, now);
    return { ...base, status: 'failed', evidenceRuns: evidence.runs.length, reason };
  }
  let raw: string;
  try {
    raw = readFileSync(found.path, 'utf8');
  } catch (e) {
    const reason = `skill file unreadable: ${e instanceof Error ? e.message : String(e)}`;
    recordRepairNote(projectDir, skillName, reason, now);
    return { ...base, status: 'failed', evidenceRuns: evidence.runs.length, reason };
  }
  const parsed = parseFrontmatter(raw);
  const description = parsed && typeof parsed.meta.description === 'string' ? parsed.meta.description : '';
  const originalBody = parsed ? parsed.body : raw;
  if (!description || !originalBody.trim()) {
    const reason = 'skill file has no usable description/body to patch';
    recordRepairNote(projectDir, skillName, reason, now);
    return { ...base, status: 'failed', evidenceRuns: evidence.runs.length, reason };
  }
  // Preserve the on-disk location: a categorized skill must be rewritten
  // into its category dir, not duplicated at the tree root.
  const relCategory = found.category
    ?? (() => { const rel = relative(skillsRoot(projectDir), found.path).split('/'); return rel.length > 2 ? rel[0] : undefined; })();

  const attempt = attempts + 1;
  const patchedBody = buildRepairedBody(originalBody, { attempt, demotionReason: rec.lastDemotionReason, evidence });
  const written = writeSkill(projectDir, {
    name: skillName,
    description,
    body: patchedBody,
    ...(relCategory ? { category: relCategory } : {}),
    // THE invariant: always probation, never straight back to active.
    // writeSkill stamps the birth via stampSkillBirth, which moves a
    // demoted record to probation and resets passesInState.
    lifecycle: 'probation',
  });
  if (!written.ok) {
    const reason = `repair patch rejected by the skill gates: ${written.error ?? 'unknown error'}`;
    recordRepairNote(projectDir, skillName, reason, now);
    return { ...base, status: 'failed', evidenceRuns: evidence.runs.length, reason };
  }

  // The write succeeded: NOW count the attempt (a rejected patch must not
  // burn one of the three), stamp the repair bookkeeping, and count the
  // repair in the patch telemetry the curator reports.
  const summary = `auto-repair attempt ${attempt}/${MAX_SKILL_REPAIR_ATTEMPTS}: patched from ${evidence.runs.length} failed run(s) (${evidence.runs.map((r) => r.runId).slice(0, 5).join(', ')}) and re-entered on probation`;
  try {
    const all = loadSkillUsage(projectDir);
    const cur = all.get(skillName) ?? { loads: 0, wins: 0 };
    cur.repairAttempts = attempt;
    cur.lastRepairAt = now;
    cur.lastRepairReason = summary;
    cur.patches = (cur.patches ?? 0) + 1;
    all.set(skillName, cur);
    saveSkillUsage(projectDir, all);
  } catch { /* the patch landed; bookkeeping failure must not un-report it */ }
  const after = loadSkillUsage(projectDir).get(skillName);
  return {
    ok: true,
    skillName,
    status: 'repaired',
    repairAttempts: attempt,
    attempt,
    ...(after?.state ? { state: after.state } : (written.state ? { state: written.state } : {})),
    evidenceRuns: evidence.runs.length,
    reason: summary,
    ...(written.path ? { path: written.path } : {}),
  };
}

export interface RepairPassSummary {
  repaired: string[];
  refused: Array<{ name: string; reason: string }>;
  failed: Array<{ name: string; reason: string }>;
  results: RepairResult[];
}

/** One repair PASS over every demoted skill in the registry (the entry
 *  point a nightly/sleep-time pass calls). Deterministic order (by name);
 *  each skill is attempted independently — one skill's failure never
 *  blocks another's repair. When `trajectories` is omitted, the pass
 *  loads the workspace's exported trajectories from disk. */
export function repairDemotedSkills(
  projectDir: string,
  trajectories?: readonly RepairTrajectoryInput[],
  opts: { now?: number } = {},
): RepairPassSummary {
  const corpus = trajectories ?? loadExportedTrajectories(projectDir);
  const demoted = [...loadSkillUsage(projectDir).entries()]
    .filter(([, rec]) => rec.state === 'demoted')
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
  const summary: RepairPassSummary = { repaired: [], refused: [], failed: [], results: [] };
  for (const name of demoted) {
    const r = attemptSkillRepair(projectDir, name, corpus, opts);
    summary.results.push(r);
    if (r.status === 'repaired') summary.repaired.push(name);
    else if (r.status === 'refused') summary.refused.push({ name, reason: r.reason });
    else summary.failed.push({ name, reason: r.reason });
  }
  return summary;
}
