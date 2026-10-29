// Sleeptime integration for self-writing skills (endless-workflow item 16).
// Runs the detect → draft → held-out-proof → install loop as ONE step of the
// EXISTING nightly sleeptime pipeline — never on the per-turn hot path.
//
// Ordering: after `induction` (which drafts probation macros from verified
// runs) and after the curator. This step is the stricter sibling: it drafts
// into the proposals staging area (outside the catalog) and installs ONLY a
// draft that passed a held-out test on a real task it was not drafted from.
//
// The step is INERT without an injected HeldOutRunner: planning yields no
// units and the morning report says so — drafting without the ability to
// prove would only manufacture rejections. Inject a runner via
// SleeptimeOptions.ports.selfWriting to arm the step. Model-free and $0.
import type { PlannedStep, PlannedUnit, SleeptimeStep, SleeptimeStepContext, UnitOutcome } from './orchestrator.js';
import {
  detectRepeatedPatterns, processCandidate, loadProposalLedger,
  defaultSelfWritingConfig, type SelfWritingConfig, type HeldOutRunner,
  type PatternEvidence,
} from '../skills/self-writing.js';
import { loadExportedTrajectories } from '../skills/skill-repair.js';

export interface SelfWritingPort {
  /** Executes held-out tasks with/without the draft (the proof runner). */
  runner?: HeldOutRunner;
  /** Override defaults (minSupport, caps, window). */
  config?: Partial<SelfWritingConfig>;
}

export function createSelfWritingStep(port: SelfWritingPort = {}): SleeptimeStep {
  return {
    id: 'self-writing',
    title: 'Self-writing skills (draft → held-out proof → gated install)',
    plan(ctx: SleeptimeStepContext): PlannedStep {
      if (!port.runner) {
        return {
          units: [],
          note: 'self-writing step inert: no held-out runner configured (inject ports.selfWriting.runner) — an unprovable draft would only be manufactured to be rejected',
        };
      }
      const records = loadExportedTrajectories(ctx.projectDir);
      if (!records.length) return { units: [], note: 'no exported trajectories yet — nothing to mine' };
      const cfg = { ...defaultSelfWritingConfig(), ...port.config };
      const patterns = detectRepeatedPatterns(records, cfg);
      if (!patterns.length) {
        return {
          units: [],
          note: `no repeated multi-step pattern across ≥${cfg.minSupport} distinct verified tasks among ${records.length} record(s)`,
        };
      }
      // Skip candidates already decided for this evidence (ledger consult is
      // cheap; processCandidate re-checks caps + retry discipline itself).
      const ledger = loadProposalLedger(ctx.projectDir);
      const known = new Set(ledger.map((p) => p.patternId));
      const fresh = patterns.filter((p) => !known.has(p.patternId));
      const capped = fresh.slice(0, cfg.maxPatternsPerPass);
      const units: PlannedUnit[] = capped.map((ev) => ({
        key: `selfwriting:${ev.patternId}`,
        title: `Prove pattern "${ev.spine.join(' → ')}" (support ${ev.support}) on a held-out task`,
        payload: { patternId: ev.patternId },
      }));
      return {
        units,
        note: `${patterns.length} pattern(s) detected, ${fresh.length} not yet proposed, drafting/proving ${capped.length}` +
          (patterns.length > capped.length ? ` (per-pass cap ${cfg.maxPatternsPerPass})` : ''),
      };
    },
    async execute(unit: PlannedUnit, ctx: SleeptimeStepContext): Promise<UnitOutcome> {
      const patternId = String(unit.payload?.patternId ?? '');
      if (!patternId) throw new Error(`self-writing unit ${unit.key} carries no pattern id`);
      // Re-detect deterministically (pure mining) rather than shipping the
      // evidence through the plan payload: the corpus may have grown between
      // plan and execute within the same night.
      const records = loadExportedTrajectories(ctx.projectDir);
      const cfg = { ...defaultSelfWritingConfig(), ...port.config };
      const ev: PatternEvidence | undefined = detectRepeatedPatterns(records, cfg).find((p) => p.patternId === patternId);
      if (!ev) return { detail: `pattern ${patternId} no longer induced by the current corpus — skipped` };
      const out = await processCandidate(ctx.projectDir, records, ev, { runner: port.runner, config: port.config });
      return { detail: `[${out.outcome}] ${out.name ?? out.patternId}${out.reason ? ` — ${out.reason}` : ''}` };
    },
  };
}
