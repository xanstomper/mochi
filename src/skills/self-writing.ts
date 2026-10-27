// Self-writing skills with a held-out test gate (endless-workflow item 16).
//
// The loop this module closes: Mochi notices it repeats a multi-step pattern
// across ≥3 distinct verified tasks, DRAFTS a skill for it, PROVES the draft
// on a held-out task (a real task of the same kind that was NOT a source),
// and only installs on pass. An unproven draft can never reach the catalog:
// the gate IS the approval.
//
// What is REUSED vs built here:
//   Reused — workflow-induction's verified-spine miner (detection),
//   skill-manager's writeSkill/deleteSkill/usage registry (draft→install→
//   uninstall + curator lifecycle), skill-lint + AAIF conformance gates,
//   skill-curator's scanSkills (collision check) and skillSimilarity (dedup),
//   skill-repair's loadExportedTrajectories (history source), and the
//   sleeptime orchestrator (scheduling; see ../sleeptime/self-writing-step.ts).
//   Built — the held-out runner seam + gate decision rule, the proposals
//   staging area + ledger + caps, install/uninstall proof bookkeeping, and
//   the pass itself.
//
// Non-negotiables (all enforced below, all tested):
//   - Detection needs ≥3 DISTINCT source tasks (a 2-task pattern is rejected;
//     a skill drafted from a single task or invented examples is out of scope).
//   - Drafts live OUTSIDE the discovered catalog (.mochi/skill-proposals/) and
//     are never silently dropped: every draft file, its evidence, and its
//     verdict stay on disk for inspection.
//   - Install re-validates the on-disk draft (lint + AAIF) and requires a
//     recorded held-out PASS — a ledger lie or a tampered file cannot install.
//   - Uninstall archives (never hard-deletes) and restores prior behavior.
//   - Curator activity is capped: max drafts and max installs per window.
//   - The pass is model-free (template compilation from recorded evidence):
//     0 model tokens, schedulable off the hot path.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mineWinningSpines, type InducedMacro } from '../observability/workflow-induction.js';
import { isVerifiedRecord, type TrajectoryRecord } from '../observability/trajectory.js';
import {
  writeSkill, deleteSkill, markUsed, safeSlug,
} from './skill-manager.js';
import { lintSkillDoc, formatSkillLint } from './skill-lint.js';
import { validateAaifSkill, formatAaifViolations } from './aaif-conformance.js';
import { skillSimilarity, scanSkills, defaultCuratorConfig } from './skill-curator.js';
import { mochiStateDir } from '../core/mochi-dir.js';
import { loadExportedTrajectories } from './skill-repair.js';

// ─── Config ────────────────────────────────────────────────────────────────

export interface SelfWritingConfig {
  /** Distinct verified tasks a pattern must recur across. The whole point:
   *  below 3 the "pattern" is a habit of one or two sessions, not a reusable
   *  procedure. */
  minSupport: number;
  /** Steps in the repeated sequence (3+ = multi-step, per the item spec). */
  minSteps: number;
  /** Draft proposals allowed per rolling window. The anti-spam cap. */
  maxDraftsPerWindow: number;
  /** Installs allowed per rolling window. */
  maxInstallsPerWindow: number;
  /** Rolling window length. */
  windowMs: number;
  /** Candidates examined per pass (before the window caps bite). */
  maxPatternsPerPass: number;
}

export function defaultSelfWritingConfig(): SelfWritingConfig {
  return {
    minSupport: 3,
    minSteps: 3,
    maxDraftsPerWindow: 2,
    maxInstallsPerWindow: 2,
    windowMs: 24 * 3600_000,
    maxPatternsPerPass: 4,
  };
}

// ─── Pattern detection (evidence-first) ────────────────────────────────────

export interface PatternEvidence {
  /** Content-addressed id: hash of the exact step sequence. */
  patternId: string;
  /** The repeated step sequence (tool names, in order). */
  spine: string[];
  /** Number of DISTINCT verified tasks carrying the sequence. */
  support: number;
  sourceRunIds: string[];
  /** The tasks themselves — what the draft was distilled FROM. */
  sourceTasks: Array<{ runId: string; title?: string; taskKind?: string }>;
  /** Per-step variation across source tasks: distinct recorded arg shapes
   *  for that step (how the tasks differed). Recorded, not gated. */
  stepVariation: Array<{ step: string; shapes: string[] }>;
  distinctTitles: number;
  taskKinds: string[];
  /** Verified later tasks that also contain the spine but were deliberately
   *  kept OUT of the source evidence (held-out material). */
  additionalVerifiedOccurrences?: number;
}

export interface RepeatedPattern extends PatternEvidence {
  /** Mean total cost of the supporting runs when any carried cost data. */
  avgSourceCostUsd?: number;
}

/** Stable short hash (djb2, hex) — content-addresses a spine so the same
 *  sequence always maps to the same proposal/pattern id. */
export function spineHash(spine: string[]): string {
  let h = 5381;
  for (const s of spine) {
    for (let i = 0; i < s.length; i++) h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
    h = (((h << 5) + h) ^ 0) >>> 0; // separator so ['ab'] ≠ ['a','b']
  }
  return h.toString(16).padStart(8, '0');
}

function containsSubsequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function firstWindowIndex(steps: string[], spine: string[]): number {
  for (let i = 0; i + spine.length <= steps.length; i++) {
    let ok = true;
    for (let j = 0; j < spine.length; j++) if (steps[i + j] !== spine[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

const ADMITTED = (r: TrajectoryRecord): boolean =>
  isVerifiedRecord(r) && r.outcome.completed === true;

/** Detect repeated multi-step patterns across recent verified task history.
 *  Only gate-verified, completed records are admitted (an unverified habit
 *  induces nothing — the induction module's rule, kept). A candidate needs
 *  the sequence in ≥ cfg.minSupport DISTINCT records. Deterministic and pure. */
export function detectRepeatedPatterns(records: readonly TrajectoryRecord[], cfg: Partial<SelfWritingConfig> = {}): RepeatedPattern[] {
  const c = { ...defaultSelfWritingConfig(), ...cfg };
  const admitted = records.filter(ADMITTED);
  if (admitted.length < c.minSupport) return [];
  // Reuse the verified-spine miner: support counts RECORDS (distinct tasks),
  // never occurrences within one run; subsumed shorter spines are pruned.
  const macros = mineWinningSpines(admitted, {
    minSupport: c.minSupport,
    minSpineLen: c.minSteps,
    maxSpineLen: 8,
    maxMacros: 24,
  });
  const out: RepeatedPattern[] = [];
  for (const m of macros) {
    if (m.kind !== 'spine') continue;
    // Sources are the OLDEST records carrying the spine, capped at
    // minSupport: the pattern is drafted from the evidence that established
    // it, and any LATER same-spine/same-kind task stays held-out material —
    // a task must never be both source and proof.
    const carrying = admitted
      .filter((r) => containsSubsequence(r.steps.map((s) => s.tool), m.spine))
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    const sources = carrying.slice(0, c.minSupport);
    const ev = withEvidence(m, sources);
    if (carrying.length > sources.length) ev.additionalVerifiedOccurrences = carrying.length - sources.length;
    out.push(ev);
  }
  return out.sort((a, b) => b.support - a.support || b.spine.length - a.spine.length || a.patternId.localeCompare(b.patternId));
}

/** Join an induced spine with its source records into full evidence. */
function withEvidence(m: InducedMacro, sources: TrajectoryRecord[]): RepeatedPattern {
  const spine = m.spine;
  const stepVariation = spine.map((step, i) => {
    const shapes = new Set<string>();
    for (const rec of sources) {
      const idx = firstWindowIndex(rec.steps.map((s) => s.tool), spine);
      if (idx < 0) continue;
      const st = rec.steps[idx + i];
      shapes.add(st?.argShape ?? argShapeFallback(st?.args));
    }
    return { step, shapes: [...shapes].sort() };
  });
  const titles = new Set(sources.map((r) => r.task?.title?.trim()).filter((t): t is string => !!t));
  const kinds = [...new Set(sources.map((r) => r.taskKind).filter((k): k is string => !!k && k !== 'unknown'))].sort();
  const costs = sources.map((r) => r.cost?.totalUsd).filter((c): c is number => typeof c === 'number');
  return {
    patternId: spineHash(spine),
    spine,
    support: sources.length,
    sourceRunIds: sources.map((r) => r.runId).sort(),
    sourceTasks: sources.map((r) => ({
      runId: r.runId,
      ...(r.task?.title ? { title: r.task.title } : {}),
      ...(r.taskKind && r.taskKind !== 'unknown' ? { taskKind: r.taskKind } : {}),
    })),
    stepVariation,
    distinctTitles: titles.size,
    taskKinds: kinds,
    ...(costs.length ? { avgSourceCostUsd: costs.reduce((a, b) => a + b, 0) / costs.length } : {}),
  };
}

function argShapeFallback(args: unknown): string {
  if (args === null || args === undefined) return 'none';
  if (Array.isArray(args)) return 'array';
  if (typeof args === 'object') {
    const keys = Object.keys(args as Record<string, unknown>).sort().slice(0, 8);
    return keys.length ? `{${keys.join(',')}}` : '{}';
  }
  return typeof args;
}

// ─── Held-out runner seam ──────────────────────────────────────────────────

/** The held-out task, as handed to a runner: a REAL task from history (never
 *  invented), with its recorded steps for context. */
export interface HeldOutTaskSpec {
  runId: string;
  title?: string;
  taskKind?: string;
  steps: string[];
  argShapes?: Array<string | undefined>;
}

export interface HeldOutRunResult {
  success: boolean;
  timeMs: number;
  costUsd?: number;
  notes?: string;
}

/** Executes one held-out task with or without the drafted skill loaded.
 *  Production wiring plugs the real agent runner in here; tests/bench plug a
 *  deterministic simulator. The gate never assumes a runner exists. */
export type HeldOutRunner = (task: HeldOutTaskSpec, skill: { name: string; body: string } | null) => Promise<HeldOutRunResult> | HeldOutRunResult;

export interface HeldOutGateVerdict {
  pass: boolean;
  reasons: string[];
}

export interface HeldOutGateOptions {
  /** Allowed skill-on time regression vs skill-off, as a fraction (0 = the
   *  spec's letter: no worse than skill-off; any regression is a fail). */
  maxTimeRegressionPct?: number;
  /** Same for cost. */
  maxCostRegressionPct?: number;
}

/** THE test-gate decision rule. Pass requires ALL of:
 *  1. the held-out task SUCCEEDS with the skill;
 *  2. success is no worse than skill-off (skill-off succeeding + skill-on
 *     failing is the classic rejection; skill-on succeeding where skill-off
 *     failed is an improvement and passes);
 *  3. when skill-off also succeeded, time/cost are no worse than skill-off
 *     within the configured regression budget (default: strictly none). */
export function evaluateHeldOutGate(on: HeldOutRunResult, off: HeldOutRunResult | null, opts: HeldOutGateOptions = {}): HeldOutGateVerdict {
  const reasons: string[] = [];
  const timePct = opts.maxTimeRegressionPct ?? 0;
  const costPct = opts.maxCostRegressionPct ?? 0;
  if (!on.success) {
    reasons.push(`held-out task FAILED with the skill${on.notes ? ` (${on.notes})` : ''}`);
  }
  if (off && off.success && on.success) {
    if (on.timeMs > off.timeMs * (1 + timePct) + 1e-9) {
      reasons.push(`time regression with the skill: ${Math.round(on.timeMs)}ms vs ${Math.round(off.timeMs)}ms skill-off (allowed regression ${(timePct * 100).toFixed(0)}%)`);
    }
    if (on.costUsd !== undefined && off.costUsd !== undefined
      && on.costUsd > off.costUsd * (1 + costPct) + 1e-12) {
      reasons.push(`cost regression with the skill: $${on.costUsd.toFixed(4)} vs $${off.costUsd.toFixed(4)} skill-off (allowed regression ${(costPct * 100).toFixed(0)}%)`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}

/** Pick the held-out task: the most recent verified, completed history task
 *  that is NOT a source of the pattern and is of the same kind (when kinds
 *  are known; otherwise one whose steps contain the same spine). Returns null
 *  when nothing qualifies — a draft without a held-out task can never be
 *  proven, so it can never install. */
export function pickHeldOut(records: readonly TrajectoryRecord[], ev: PatternEvidence): TrajectoryRecord | null {
  const src = new Set(ev.sourceRunIds);
  const candidates = records.filter((r) =>
    !src.has(r.runId) && ADMITTED(r)
    && (containsSubsequence(r.steps.map((s) => s.tool), ev.spine)
      || (ev.taskKinds.length > 0 && !!r.taskKind && ev.taskKinds.includes(r.taskKind))));
  const sameKind = candidates.filter((r) => !!r.taskKind && ev.taskKinds.includes(r.taskKind));
  const pool = sameKind.length ? sameKind : candidates;
  if (!pool.length) return null;
  return [...pool].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
}

// ─── Proposals: staging, ledger, caps ──────────────────────────────────────

export type ProposalStatus = 'drafted' | 'installed' | 'rejected' | 'uninstalled';

export interface HeldOutEvaluationRecord {
  heldOutRunId: string;
  heldOutTitle?: string;
  skillOn: HeldOutRunResult;
  skillOff: HeldOutRunResult;
  gate: HeldOutGateVerdict;
}

export interface ProposalRecord {
  name: string;
  patternId: string;
  attempt: number;
  createdAt: number;
  pattern: PatternEvidence;
  description: string;
  gates: {
    lint: { ok: boolean; detail: string };
    aaif: { ok: boolean; detail: string };
  };
  heldOut?: { runId: string; title?: string };
  evaluation?: HeldOutEvaluationRecord;
  status: ProposalStatus;
  reason?: string;
  installedPath?: string;
  draftPath: string;
  evidencePath: string;
}

export interface SelfWritingCapsState {
  windowStart: number;
  drafts: number;
  installs: number;
  lastPassAt?: number;
  passCount: number;
  lastPassSummary?: string;
}

function proposalsDir(projectDir: string): string {
  return join(mochiStateDir(projectDir), 'skill-proposals');
}
function ledgerPath(projectDir: string): string {
  return join(proposalsDir(projectDir), 'ledger.json');
}
function capsPath(projectDir: string): string {
  return join(proposalsDir(projectDir), 'caps-state.json');
}

export function loadProposalLedger(projectDir: string): ProposalRecord[] {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath(projectDir), 'utf8')) as { proposals?: ProposalRecord[] };
    return Array.isArray(raw.proposals) ? raw.proposals : [];
  } catch { return []; }
}

/** Write the proposal ledger (used by tests and tooling to repair state). */
export function saveProposalLedger(projectDir: string, proposals: ProposalRecord[]): void {
  mkdirSync(proposalsDir(projectDir), { recursive: true });
  writeFileSync(ledgerPath(projectDir), JSON.stringify({ proposals }, null, 2), 'utf8');
}

export function loadSelfWritingCapsState(projectDir: string): SelfWritingCapsState {
  try {
    const raw = JSON.parse(readFileSync(capsPath(projectDir), 'utf8')) as Partial<SelfWritingCapsState>;
    return {
      windowStart: typeof raw.windowStart === 'number' ? raw.windowStart : 0,
      drafts: typeof raw.drafts === 'number' ? raw.drafts : 0,
      installs: typeof raw.installs === 'number' ? raw.installs : 0,
      ...(typeof raw.lastPassAt === 'number' ? { lastPassAt: raw.lastPassAt } : {}),
      passCount: typeof raw.passCount === 'number' ? raw.passCount : 0,
      ...(typeof raw.lastPassSummary === 'string' ? { lastPassSummary: raw.lastPassSummary } : {}),
    };
  } catch { return { windowStart: 0, drafts: 0, installs: 0, passCount: 0 }; }
}

export function saveSelfWritingCapsState(projectDir: string, s: SelfWritingCapsState): void {
  mkdirSync(proposalsDir(projectDir), { recursive: true });
  writeFileSync(capsPath(projectDir), JSON.stringify(s, null, 2), 'utf8');
}

/** Roll the window when it expired; otherwise keep counters. */
function effectiveCaps(projectDir: string, cfg: SelfWritingConfig, now: number): SelfWritingCapsState {
  const s = loadSelfWritingCapsState(projectDir);
  if (!s.windowStart || now - s.windowStart >= cfg.windowMs) {
    return {
      windowStart: now, drafts: 0, installs: 0, passCount: s.passCount,
      ...(s.lastPassAt ? { lastPassAt: s.lastPassAt } : {}),
      ...(s.lastPassSummary ? { lastPassSummary: s.lastPassSummary } : {}),
    };
  }
  return s;
}

// ─── Drafting ──────────────────────────────────────────────────────────────

/** Sanitize a string for single-line unquoted YAML frontmatter use: strip
 *  quotes/colons/backslashes and newlines, so the description round-trips
 *  through every reader (quoted or not). */
function yamlSafeLine(s: string): string {
  return s.replace(/["':\\]/g, ' ').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function backtickSafe(s: string): string {
  return s.replace(/[`\r\n]+/g, ' ').trim();
}

/** Derive the skill name: readable prefix from the first spine steps, made
 *  unique and collision-free by the content-hash suffix. Always a valid AAIF
 *  slug ≤64 chars (underscores in tool names become hyphens — the AAIF name
 *  grammar is [a-z0-9-] only), with room left for an `-aN` attempt suffix. */
export function proposalNameFor(ev: PatternEvidence): string {
  const readable = safeSlug(ev.spine.slice(0, 4).map((t) => safeSlug(t).replace(/_/g, '-')).join('-'));
  const base = safeSlug(`selfwritten-${readable}`).slice(0, 48).replace(/-+$/g, '');
  return `${base}-${ev.patternId}`;
}

/** One recorded argument example for the i-th spine step, taken from the most
 *  recent source task. Values were redacted by the trace recorder at record
 *  time; this passes them through (capped) so the draft is concrete enough to
 *  follow — and, when the sources over-fit, concrete enough to FAIL the
 *  held-out task honestly. */
function sampleArgsFor(sources: readonly TrajectoryRecord[], spine: string[], i: number): string | null {
  const sorted = [...sources].sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  for (const rec of sorted) {
    const idx = firstWindowIndex(rec.steps.map((s) => s.tool), spine);
    if (idx < 0) continue;
    const st = rec.steps[idx + i];
    if (!st || st.args === null || st.args === undefined) continue;
    const s = backtickSafe(JSON.stringify(st.args)).slice(0, 120);
    if (s && s !== '{}') return s;
  }
  return null;
}

export interface BuiltDraft {
  name: string;
  description: string;
  body: string;
  rendered: string;
}

/** Compile the draft SKILL.md from the recorded evidence ONLY — no model
 *  round-trip, no invented specifics. Every claim in the body cites the
 *  source tasks. `samples` are concrete per-step example invocations lifted
 *  from the source records (buildDraftWithSamples); without them the steps
 *  stay shape-level. */
export function buildDraft(ev: PatternEvidence, opts: { attempt?: number; samples?: Array<string | null> } = {}): BuiltDraft {
  const attempt = opts.attempt ?? 1;
  const baseName = proposalNameFor(ev);
  const name = attempt <= 1 ? baseName : safeSlug(`${baseName}-a${attempt}`).slice(0, 64).replace(/-+$/g, '');
  const route = ev.spine.join(' → ');
  const kinds = ev.taskKinds.length ? ev.taskKinds.join(', ') : 'general';
  const description = yamlSafeLine(
    `Self-written ${ev.spine.length}-step procedure for ${kinds} tasks opening with ${ev.spine.slice(0, 2).join(' then ')} — observed in ${ev.support} verified successful tasks`,
  ).slice(0, 500);
  const variationSummary = ev.stepVariation
    .filter((v) => v.shapes.length > 0)
    .map((v) => `\`${v.step}\` recorded as ${v.shapes.join(' | ')}`)
    .join('; ') || 'no recorded argument variation';
  const steps = ev.spine.map((tool, i) => {
    const base = `Call \`${tool}\` (step ${i + 1} of the repeated ${ev.spine.length}-step sequence ${route}).`;
    const sample = opts.samples?.[i];
    return sample
      ? `${base} Example invocation from the source tasks: \`${sample}\` — adapt paths and ids to the current task, never replay them verbatim.`
      : base;
  });
  const body = [
    `# Self-written procedure for the repeated sequence ${route}`,
    '',
    `Distilled by the skill curator from ${ev.support} gate-verified successful tasks (never from a single task or invented examples). This skill installed only after passing a held-out test on a task it was NOT drafted from.`,
    '',
    '## When to use',
    `Use for ${kinds} tasks whose opening situation matches the repeated sequence ${route} (the ${ev.spine.length} steps below, in order). The source tasks recorded it as a winning route.`,
    '',
    '## Procedure',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    `${ev.spine.length + 1}. Run the task's own verification (test suite, typecheck, or the command the task defines) and require a clean exit before claiming completion.`,
    '',
    '## Pitfalls',
    `- The ${ev.support} source tasks varied as follows — adapt inputs per task: ${variationSummary}.`,
    '- If a step fails, inspect the failure output and change the inputs before retrying; repeating an identical failed call is a loop, not a procedure.',
    '- This procedure was proven on exactly one held-out task at install time. If it fights the current task, abandon it and re-plan rather than forcing the sequence.',
    '',
    '## Verification',
    'Run the project verification the task itself defines (tests, typecheck, or the recorded verify command) and require it to pass. A run only counts as evidence when the verifier gate passes.',
    '',
    '## Source evidence',
    `- Pattern id \`${ev.patternId}\`, support ${ev.support} distinct verified tasks.`,
    `- Steps: \`${route}\`.`,
    ...ev.sourceTasks.map((t) => `- Source task \`${t.runId}\`${t.title ? ` — "${backtickSafe(t.title).slice(0, 120)}"` : ''}${t.taskKind ? ` (${t.taskKind})` : ''}.`),
    `- Argument variation across sources: ${variationSummary}.`,
    `- Distinct source titles: ${ev.distinctTitles}.`,
    '',
  ].join('\n');
  const rendered = `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\ncategory: self-written\n---\n\n${body}`;
  return { name, description, body, rendered };
}

/** Like buildDraft but with concrete per-step example invocations lifted from
 *  the source records (most recent source wins). This is the form the pass
 *  actually writes. */
export function buildDraftWithSamples(ev: PatternEvidence, sources: readonly TrajectoryRecord[], opts: { attempt?: number } = {}): BuiltDraft {
  const samples = ev.spine.map((_, i) => sampleArgsFor(sources, ev.spine, i));
  return buildDraft(ev, { ...opts, ...(samples.some((s) => s !== null) ? { samples } : {}) });
}

// ─── Proposal write / install / uninstall ──────────────────────────────────

export interface ProposalOutcome {
  proposal: ProposalRecord;
  /** true when the pass should run the held-out evaluation (i.e. the draft
   *  passed all conformance gates). */
  proceedToHeldOut: boolean;
}

/** Draft ONE pattern into the staging area (never the catalog), recording
 *  evidence + gates. Conformance-failing drafts are STILL WRITTEN to disk
 *  with a rejected verdict — visible for inspection, never installed, never
 *  silently dropped. Enforces the drafts cap. */
export function draftProposal(
  projectDir: string,
  ev: PatternEvidence,
  sources: readonly TrajectoryRecord[],
  opts: { config?: Partial<SelfWritingConfig>; now?: number; attempt?: number } = {},
): ProposalOutcome {
  const cfg = { ...defaultSelfWritingConfig(), ...opts.config };
  const now = opts.now ?? Date.now();
  const caps = effectiveCaps(projectDir, cfg, now);
  const draft = buildDraftWithSamples(ev, sources, { attempt: opts.attempt });
  const dir = join(proposalsDir(projectDir), draft.name);
  const draftPath = join(dir, 'SKILL.md');
  const evidencePath = join(dir, 'evidence.json');
  const lint = lintSkillDoc(draft.name, draft.description, draft.body);
  const aaif = validateAaifSkill(draft.rendered, { file: 'SKILL.md', dirName: draft.name });
  const gates = {
    lint: { ok: lint.ok, detail: lint.ok ? 'clean' : formatSkillLint(lint) },
    aaif: { ok: aaif.ok, detail: aaif.ok ? 'conformant' : formatAaifViolations(aaif.violations) },
  };
  const conformanceOk = gates.lint.ok && gates.aaif.ok;
  const proposal: ProposalRecord = {
    name: draft.name,
    patternId: ev.patternId,
    attempt: opts.attempt ?? 1,
    createdAt: now,
    pattern: ev,
    description: draft.description,
    gates,
    status: conformanceOk ? 'drafted' : 'rejected',
    ...(conformanceOk ? {} : { reason: `conformance gate: ${!gates.lint.ok ? `lint (${gates.lint.detail})` : `AAIF (${gates.aaif.detail})`}` }),
    draftPath,
    evidencePath,
  };
  persistProposal(projectDir, draft, proposal);
  saveSelfWritingCapsState(projectDir, { ...caps, drafts: caps.drafts + 1 });
  return { proposal, proceedToHeldOut: conformanceOk };
}

function persistProposal(projectDir: string, draft: BuiltDraft, proposal: ProposalRecord): void {
  mkdirSync(join(proposalsDir(projectDir), draft.name), { recursive: true });
  writeFileSync(proposal.draftPath, draft.rendered, 'utf8');
  writeFileSync(proposal.evidencePath, JSON.stringify(proposal, null, 2), 'utf8');
  const ledger = loadProposalLedger(projectDir).filter((p) => p.name !== proposal.name);
  ledger.push(proposal);
  saveProposalLedger(projectDir, ledger);
}

function updateProposal(projectDir: string, next: ProposalRecord): void {
  try { writeFileSync(next.evidencePath, JSON.stringify(next, null, 2), 'utf8'); } catch { /* staging file missing: ledger still updated */ }
  const ledger = loadProposalLedger(projectDir).filter((p) => p.name !== next.name);
  ledger.push(next);
  saveProposalLedger(projectDir, ledger);
}

/** True when a skill with this name already exists in the discovered catalog
 *  (`.mochi/skills/**`). Drafts in skill-proposals/ are not in the catalog. */
function catalogHasName(projectDir: string, name: string): boolean {
  try {
    return scanSkills(projectDir, defaultCuratorConfig()).snapshots.some((s) => s.name === name);
  } catch { return false; }
}

/** Read back a staged draft from disk (the install gate re-validates the FILE,
 *  never the ledger's copy of it). */
function readStagedDraft(projectDir: string, name: string): { description: string; body: string; rendered: string } | null {
  const p = join(proposalsDir(projectDir), name, 'SKILL.md');
  if (!existsSync(p)) return null;
  try {
    const rendered = readFileSync(p, 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(rendered);
    if (!m) return null;
    let description = '';
    const dm = /^description:\s*(.*)$/m.exec(m[1]);
    if (dm) { try { description = JSON.parse(dm[1]) as string; } catch { description = dm[1].trim(); } }
    return { description, body: m[2].trim(), rendered };
  } catch { return null; }
}

export interface InstallResult {
  ok: boolean;
  path?: string;
  error?: string;
  proposal?: ProposalRecord;
}

/** Install a PROVEN draft into the catalog. The gate IS the approval:
 *  refuses unless the on-disk draft passes lint + AAIF conformance AND the
 *  proposal records a held-out evaluation whose gate verdict is PASS. Any
 *  refusal is recorded on the proposal (visible, never silent). The installed
 *  skill is born on probation — the curator's evidence lifecycle still governs
 *  its retention; this gate only decides entry. */
export function installProvenSkill(
  projectDir: string,
  name: string,
  opts: { config?: Partial<SelfWritingConfig>; now?: number } = {},
): InstallResult {
  const cfg = { ...defaultSelfWritingConfig(), ...opts.config };
  const now = opts.now ?? Date.now();
  const all = loadProposalLedger(projectDir);
  const proposal = all.find((p) => p.name === name);
  if (!proposal) return { ok: false, error: `no proposal named '${name}'` };
  if (proposal.status === 'installed') return { ok: false, error: `'${name}' is already installed` };
  const staged = readStagedDraft(projectDir, name);
  if (!staged) return refuse(projectDir, proposal, 'staged draft file missing — cannot verify what would be installed');
  // Re-validate the FILE on disk (a tampered/stale draft cannot ride in on a
  // clean ledger record).
  const lint = lintSkillDoc(name, staged.description, staged.body);
  if (!lint.ok) return refuse(projectDir, proposal, `install re-check failed lint: ${formatSkillLint(lint)}`);
  const aaif = validateAaifSkill(staged.rendered, { file: 'SKILL.md', dirName: name });
  if (!aaif.ok) return refuse(projectDir, proposal, `install re-check failed AAIF conformance: ${formatAaifViolations(aaif.violations)}`);
  if (!proposal.evaluation || !proposal.evaluation.gate.pass) {
    return refuse(projectDir, proposal, 'held-out gate has not passed — refusing to install an unproven skill');
  }
  if (catalogHasName(projectDir, name)) {
    return refuse(projectDir, proposal, `a skill named '${name}' already exists in the catalog — refusing to overwrite`);
  }
  const caps = effectiveCaps(projectDir, cfg, now);
  if (caps.installs >= cfg.maxInstallsPerWindow) {
    return refuse(projectDir, proposal, `install cap reached for this window (${cfg.maxInstallsPerWindow}) — try again after the window rolls`);
  }
  const r = writeSkill(projectDir, {
    name,
    description: staged.description,
    body: staged.body,
    category: 'self-written',
    lifecycle: 'probation',
  });
  if (!r.ok || !r.path) return refuse(projectDir, proposal, `catalog write rejected the install (${String(r.error).slice(0, 200)})`);
  try { markUsed(projectDir, name, { agentCreated: true, category: 'self-written' }); } catch { /* usage best-effort */ }
  const next: ProposalRecord = { ...proposal, status: 'installed', installedPath: r.path, reason: undefined };
  updateProposal(projectDir, next);
  saveSelfWritingCapsState(projectDir, { ...caps, installs: caps.installs + 1 });
  return { ok: true, path: r.path, proposal: next };
}

function refuse(projectDir: string, proposal: ProposalRecord, reason: string): InstallResult {
  const next: ProposalRecord = { ...proposal, status: 'rejected', reason };
  updateProposal(projectDir, next);
  return { ok: false, error: reason, proposal: next };
}

/** Uninstall a self-written skill: archive (never hard-delete) + ledger
 *  history. Prior behavior is restored because the skill simply leaves the
 *  discovered catalog. */
export function uninstallSelfWrittenSkill(projectDir: string, name: string): InstallResult {
  const all = loadProposalLedger(projectDir);
  const proposal = all.find((p) => p.name === name);
  if (!proposal) return { ok: false, error: `no proposal named '${name}'` };
  const r = deleteSkill(projectDir, name);
  if (!r.ok) return { ok: false, error: r.error };
  const next: ProposalRecord = { ...proposal, status: 'uninstalled', reason: 'uninstalled on request — archived, reversible', installedPath: undefined };
  updateProposal(projectDir, next);
  return { ok: true, ...(r.path ? { path: r.path } : {}), proposal: next };
}

// ─── Observability ─────────────────────────────────────────────────────────

export interface SelfWritingListingRow {
  name: string;
  status: ProposalStatus;
  reason?: string;
  patternId: string;
  support: number;
  spine: string[];
  heldOut?: { runId: string; successOn: boolean; successOff: boolean; timeOnMs: number; timeOffMs: number; pass: boolean };
  installedPath?: string;
  draftPath: string;
  createdAt: number;
}

/** The simple listing: drafted / installed / rejected skills with their proof. */
export function listSelfWrittenSkills(projectDir: string): SelfWritingListingRow[] {
  return loadProposalLedger(projectDir)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((p) => ({
      name: p.name,
      status: p.status,
      ...(p.reason ? { reason: p.reason } : {}),
      patternId: p.patternId,
      support: p.pattern.support,
      spine: p.pattern.spine,
      ...(p.evaluation ? {
        heldOut: {
          runId: p.evaluation.heldOutRunId,
          successOn: p.evaluation.skillOn.success,
          successOff: p.evaluation.skillOff.success,
          timeOnMs: p.evaluation.skillOn.timeMs,
          timeOffMs: p.evaluation.skillOff.timeMs,
          pass: p.evaluation.gate.pass,
        },
      } : {}),
      ...(p.installedPath ? { installedPath: p.installedPath } : {}),
      draftPath: p.draftPath,
      createdAt: p.createdAt,
    }));
}

export function renderSelfWritingListing(rows: SelfWritingListingRow[]): string {
  if (!rows.length) return 'No self-written skill proposals yet.';
  return rows.map((r) => {
    const proof = r.heldOut
      ? `held-out ${r.heldOut.runId}: skill-on ${r.heldOut.successOn ? 'pass' : 'FAIL'}/${Math.round(r.heldOut.timeOnMs)}ms vs skill-off ${r.heldOut.successOff ? 'pass' : 'FAIL'}/${Math.round(r.heldOut.timeOffMs)}ms → gate ${r.heldOut.pass ? 'PASS' : 'FAIL'}`
      : 'no held-out evaluation';
    const why = r.reason ? ` — ${r.reason.slice(0, 160)}` : '';
    return `${r.status.toUpperCase().padEnd(10)} ${r.name} (support ${r.support} tasks) — ${proof}${why}`;
  }).join('\n');
}

// ─── The pass ──────────────────────────────────────────────────────────────

export interface SelfWritingPassOptions {
  /** History to mine (defaults to the workspace's exported trajectories). */
  records?: TrajectoryRecord[];
  /** Held-out runner. Absent → drafts are recorded as rejected 'proof
   *  unavailable' and NOTHING installs (conservative default). */
  runner?: HeldOutRunner;
  config?: Partial<SelfWritingConfig>;
  now?: number;
  /** Skip loading the catalog for similarity dedup (tests). */
  skipCatalogDedup?: boolean;
}

export interface CandidateOutcome {
  patternId: string;
  spine: string[];
  support: number;
  outcome: 'installed' | 'rejected' | 'skipped' | 'drafted';
  name?: string;
  reason?: string;
}

export interface SelfWritingPassOutput {
  ran: boolean;
  recordsScanned: number;
  patternsDetected: number;
  candidates: CandidateOutcome[];
  installed: string[];
  rejected: Array<{ name?: string; reason: string }>;
  skippedByCap: number;
  cost: {
    durationMs: number;
    modelTokens: 0;
    modelCalls: 0;
    note: string;
  };
  caps: SelfWritingCapsState;
}

/** Process ONE candidate pattern end-to-end: draft → conformance gates →
 *  held-out proof → install on pass. Records everything on the proposal. */
export async function processCandidate(
  projectDir: string,
  records: readonly TrajectoryRecord[],
  ev: PatternEvidence,
  opts: SelfWritingPassOptions = {},
): Promise<CandidateOutcome> {
  const cfg = { ...defaultSelfWritingConfig(), ...opts.config };
  const now = opts.now ?? Date.now();
  // Retry discipline: a pattern with an existing proposal is skipped unless
  // the situation genuinely changed — fresh source evidence, fresh
  // spine-carrying history (new held-out material), or a transient rejection
  // (missing runner) that a later pass can resolve. Identical retries after
  // a content rejection are spam; a pattern already installed is closed.
  const prior = loadProposalLedger(projectDir).filter((p) => p.patternId === ev.patternId);
  if (prior.length) {
    const installed = prior.find((p) => p.status === 'installed');
    if (installed) return { patternId: ev.patternId, spine: ev.spine, support: ev.support, outcome: 'skipped', name: installed.name, reason: `pattern already installed as '${installed.name}'` };
    const seen = new Set<string>();
    for (const p of prior) for (const id of p.pattern.sourceRunIds) seen.add(id);
    const carryingIds = records.filter((r) => containsSubsequence(r.steps.map((s) => s.tool), ev.spine)).map((r) => r.runId);
    const freshEvidence = [...new Set([...ev.sourceRunIds, ...carryingIds])].some((id) => !seen.has(id));
    const transientRejection = prior.some((p) => p.status === 'rejected' && p.reason?.includes('no held-out runner configured'));
    if (!freshEvidence && !transientRejection) {
      const last = prior[prior.length - 1];
      return { patternId: ev.patternId, spine: ev.spine, support: ev.support, outcome: 'skipped', name: last.name, reason: `already drafted from this evidence (last verdict: ${last.status}${last.reason ? `: ${last.reason}` : ''})` };
    }
  }
  const caps = effectiveCaps(projectDir, cfg, now);
  if (caps.drafts >= cfg.maxDraftsPerWindow) {
    return { patternId: ev.patternId, spine: ev.spine, support: ev.support, outcome: 'skipped', reason: `draft cap reached for this window (${cfg.maxDraftsPerWindow})` };
  }
  const attempt = prior.length + 1;
  const sources = ev.sourceRunIds
    .map((id) => records.find((r) => r.runId === id))
    .filter((r): r is TrajectoryRecord => !!r);
  const { proposal, proceedToHeldOut } = draftProposal(projectDir, ev, sources, { config: opts.config, now, attempt });
  if (!proceedToHeldOut) {
    return { patternId: ev.patternId, spine: ev.spine, support: ev.support, outcome: 'rejected', name: proposal.name, reason: proposal.reason };
  }
  const heldOutRec = pickHeldOut(records, ev);
  if (!heldOutRec) {
    const next: ProposalRecord = { ...proposal, status: 'rejected', reason: 'no held-out task of the same kind available (all matching history is source material) — cannot prove, not installing' };
    updateProposal(projectDir, next);
    return { patternId: ev.patternId, spine: ev.spine, support: ev.support, outcome: 'rejected', name: proposal.name, reason: next.reason };
  }
  if (!opts.runner) {
    const next: ProposalRecord = { ...proposal, status: 'rejected', reason: 'no held-out runner configured — proof unavailable, not installing' };
    updateProposal(projectDir, next);
    return { patternId: ev.patternId, spine: ev.spine, support: ev.support, outcome: 'rejected', name: proposal.name, reason: next.reason };
  }
  const spec: HeldOutTaskSpec = {
    runId: heldOutRec.runId,
    ...(heldOutRec.task?.title ? { title: heldOutRec.task.title } : {}),
    ...(heldOutRec.taskKind && heldOutRec.taskKind !== 'unknown' ? { taskKind: heldOutRec.taskKind } : {}),
    steps: heldOutRec.steps.map((s) => s.tool),
    ...(heldOutRec.steps.some((s) => s.argShape) ? { argShapes: heldOutRec.steps.map((s) => s.argShape) } : {}),
  };
  const skill = { name: proposal.name, body: readStagedDraft(projectDir, proposal.name)?.body ?? '' };
  const off = await opts.runner(spec, null);
  const on = await opts.runner(spec, skill);
  const gate = evaluateHeldOutGate(on, off);
  const evaluation: HeldOutEvaluationRecord = {
    heldOutRunId: heldOutRec.runId,
    ...(heldOutRec.task?.title ? { heldOutTitle: heldOutRec.task.title } : {}),
    skillOn: on,
    skillOff: off,
    gate,
  };
  const afterEval: ProposalRecord = { ...proposal, heldOut: { runId: heldOutRec.runId, ...(heldOutRec.task?.title ? { title: heldOutRec.task.title } : {}) }, evaluation };
  updateProposal(projectDir, afterEval);
  if (!gate.pass) {
    const rejected: ProposalRecord = { ...afterEval, status: 'rejected', reason: `held-out gate failed: ${gate.reasons.join('; ')}` };
    updateProposal(projectDir, rejected);
    return { patternId: ev.patternId, spine: ev.spine, support: ev.support, outcome: 'rejected', name: proposal.name, reason: rejected.reason };
  }
  const install = installProvenSkill(projectDir, proposal.name, { config: opts.config, now });
  if (!install.ok) {
    return { patternId: ev.patternId, spine: ev.spine, support: ev.support, outcome: 'rejected', name: proposal.name, reason: install.error };
  }
  return { patternId: ev.patternId, spine: ev.spine, support: ev.support, outcome: 'installed', name: proposal.name };
}

/** One scheduled/triggered pass. Deliberately NOT wired into the per-turn
 *  loop: call it from the sleeptime pipeline (see createSelfWritingStep),
 *  a cron, or manually. Model-free: the cost block is real wall-clock time
 *  and zero model tokens, by construction. */
export async function runSelfWritingPass(projectDir: string, opts: SelfWritingPassOptions = {}): Promise<SelfWritingPassOutput> {
  const t0 = Date.now();
  const cfg = { ...defaultSelfWritingConfig(), ...opts.config };
  const now = opts.now ?? Date.now();
  const records = opts.records ?? loadExportedTrajectories(projectDir);
  const patterns = detectRepeatedPatterns(records, cfg);
  const candidates: CandidateOutcome[] = [];
  let skippedByCap = 0;
  // Catalog dedup: a pattern already covered by a similar skill is skipped
  // before drafting (reuses the curator's own similarity function).
  const existingNames = [...loadUsageKeys(opts.skipCatalogDedup ? undefined : projectDir)];
  for (const ev of patterns.slice(0, cfg.maxPatternsPerPass)) {
    if (existingNames.length) {
      const probe = `${ev.spine.join(' ')} ${ev.taskKinds.join(' ')}`;
      const dup = existingNames.find((n) => skillSimilarity(n.toLowerCase(), probe.toLowerCase()) > 0.5);
      if (dup) {
        candidates.push({ patternId: ev.patternId, spine: ev.spine, support: ev.support, outcome: 'skipped', reason: `existing skill '${dup}' already covers this pattern` });
        continue;
      }
    }
    const outcome = await processCandidate(projectDir, records, ev, opts);
    candidates.push(outcome);
    if (outcome.outcome === 'skipped' && outcome.reason?.includes('cap')) skippedByCap += 1;
  }
  const installed = candidates.filter((c) => c.outcome === 'installed').map((c) => c.name!);
  const rejected = candidates.filter((c) => c.outcome === 'rejected').map((c) => ({ ...(c.name ? { name: c.name } : {}), reason: c.reason ?? 'rejected' }));
  const durationMs = Date.now() - t0;
  const caps = loadSelfWritingCapsState(projectDir);
  const capsNow: SelfWritingCapsState = { ...caps, lastPassAt: now, passCount: caps.passCount + 1, lastPassSummary: `${candidates.length} candidate(s), ${installed.length} installed, ${rejected.length} rejected` };
  saveSelfWritingCapsState(projectDir, capsNow);
  const output: SelfWritingPassOutput = {
    ran: true,
    recordsScanned: records.length,
    patternsDetected: patterns.length,
    candidates,
    installed,
    rejected,
    skippedByCap,
    cost: {
      durationMs,
      modelTokens: 0,
      modelCalls: 0,
      note: 'model-free pass (deterministic template compilation from recorded evidence; no model round-trips)',
    },
    caps: capsNow,
  };
  writePassReport(projectDir, output);
  return output;
}

function loadUsageKeys(projectDir?: string): string[] {
  if (!projectDir) return [];
  try {
    // Lazy import avoided deliberately: loadUsage is already in the module
    // graph via skill-curator; but to keep this file's dependency surface
    // small we read the snapshots' names instead.
    return scanSkills(projectDir, defaultCuratorConfig()).snapshots.map((s) => s.name);
  } catch { return []; }
}

function writePassReport(projectDir: string, out: SelfWritingPassOutput): void {
  const dir = proposalsDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const lines = [
    `# Self-writing skills pass (${new Date().toISOString()})`,
    `History scanned: ${out.recordsScanned} exported trajectory record(s); patterns detected: ${out.patternsDetected}.`,
    `Curator cost: ${out.cost.durationMs}ms wall clock, ${out.cost.modelTokens} model tokens (${out.cost.note}).`,
    `Caps: ${JSON.stringify(out.caps)}.`,
    '',
    'Per-pattern outcomes:',
    ...(out.candidates.length
      ? out.candidates.map((c) => `- [${c.outcome}] ${c.name ?? c.patternId} (${c.spine.join(' → ')}, support ${c.support})${c.reason ? ` — ${c.reason}` : ''}`)
      : ['- (none)']),
    '',
    `Listing:\n${renderSelfWritingListing(listSelfWrittenSkills(projectDir))}`,
  ];
  writeFileSync(join(dir, `pass-${Date.now()}.md`), lines.join('\n'), 'utf8');
}

/** Proposal dirs on disk (visible artifacts, including rejected drafts). */
export function stagedProposalDirs(projectDir: string): string[] {
  const dir = proposalsDir(projectDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => join(dir, e.name));
}
