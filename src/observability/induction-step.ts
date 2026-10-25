// Sleeptime integration for D9 workflow induction (audit L-05 wiring).
// The induction runs as one step of the EXISTING sleeptime pipeline — the
// nightly `mochi sleeptime` run picks it up with no second scheduler. It
// mines the exported trajectory corpus (exports/trajectory-*.jsonl) for the
// tool spines that keep winning and the sequences that rescue failing runs,
// and drafts each hit as a probation-lifecycle skill via skill-manager's
// writeSkill — the Phase B curator owns promotion from there; this step
// never stamps anything active and never overwrites an existing skill.
//
// Admission is the module's own rule, enforced by induceWorkflows: only
// gate-verified trajectories count, so an unverified "habit" induces nothing.
// Model-free and $0: pure local mining, so it declares no estimated usage
// and can never be stopped by (or counted against) the nightly spend cap.
// Idempotency is the orchestrator's ledger (one unit per drafted macro,
// key 'induction:<kind>:<name>'); draftInducedMacro additionally refuses
// to overwrite an existing skill, so a re-mine after a ledger loss is safe.
import type { PlannedStep, PlannedUnit, SleeptimeStep, SleeptimeStepContext, UnitOutcome } from '../sleeptime/orchestrator.js';
import { induceWorkflows, draftInducedMacro, type InductionOptions } from './workflow-induction.js';
import { loadExportedTrajectories } from '../skills/skill-repair.js';

/** Cap on drafted macros per night: induction over a large corpus must not
 *  flood the skills tree in one go — the curator needs a night to observe
 *  probation drafts before the next batch arrives. */
const MAX_DRAFTS_PER_NIGHT = 10;

export function createInductionStep(opts: InductionOptions = {}): SleeptimeStep {
  return {
    id: 'induction',
    title: 'Workflow induction (verified-run macros)',
    plan(ctx: SleeptimeStepContext): PlannedStep {
      const records = loadExportedTrajectories(ctx.projectDir);
      if (!records.length) {
        return { units: [], note: 'no exported trajectories yet — nothing to mine' };
      }
      const macros = induceWorkflows(records, opts);
      if (!macros.length) {
        return {
          units: [],
          note: `no repeated spines among ${records.length} exported trajectory record(s) (unverified runs are not admitted)`,
        };
      }
      const capped = macros.slice(0, MAX_DRAFTS_PER_NIGHT);
      const units: PlannedUnit[] = capped.map((m) => ({
        key: `induction:${m.kind}:${m.name}`,
        title: `Draft ${m.kind} macro "${m.name}" (support ${m.support})`,
        payload: { kind: m.kind, name: m.name },
      }));
      return {
        units,
        note: `${macros.length} macro(s) induced from ${records.length} record(s); drafting ${capped.length}` +
          (macros.length > capped.length ? ` (nightly cap ${MAX_DRAFTS_PER_NIGHT})` : ''),
      };
    },
    async execute(unit: PlannedUnit, ctx: SleeptimeStepContext): Promise<UnitOutcome> {
      const kind = String(unit.payload?.kind ?? '');
      const name = String(unit.payload?.name ?? '');
      if (!kind || !name) throw new Error(`induction unit ${unit.key} carries no macro identity`);
      // Re-mine deterministically (induction is pure + filesystem-free) rather
      // than shipping macro objects through the plan payload: the corpus may
      // have grown between plan and execute within the same night.
      const macro = induceWorkflows(loadExportedTrajectories(ctx.projectDir), opts)
        .find((m) => m.kind === kind && m.name === name);
      if (!macro) return { detail: `macro "${name}" no longer induced by the current corpus — skipped` };
      const draft = draftInducedMacro(ctx.projectDir, macro);
      return draft
        ? { detail: `drafted "${draft.slug}" (${draft.state ?? 'probation'}) at ${draft.path}; curator owns promotion` }
        : { detail: `no draft written for "${name}" (skill already exists or the quality gate rejected it)` };
    },
  };
}
