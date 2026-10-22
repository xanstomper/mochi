// Cost-per-solve over EXPORTED trajectory records (C5): the headline
// efficiency metric — what does one verified-solved task cost — computed
// from the durable artifact (exports/trajectory-*.jsonl) rather than raw
// traces. A record counts as SOLVED only on the verifier's own word:
// verification.status PASS, or FLAKY-PASS (green via flake resolution,
// which goal.ts also treats as completion). Outcome flags, stop reasons,
// and skill verdicts never substitute for the gate verdict.
//
// Honesty rules (same standard as trace-cost.ts / regression-gate):
//  - reported and estimated money are averaged SEPARATELY and only then
//    summed — an estimate is never laundered into a reported figure;
//  - a solved record whose usage cannot be priced (tokens recorded but
//    neither a provider cost nor a price-table estimate on the export)
//    refuses the whole dollar figure: usdPerSolve comes back null and the
//    offending run ids are named in `unpricedRunIds`, instead of emitting
//    a partial-sum average that would flatter the harness;
//  - nothing solved → null, not $0.
import type { TrajectoryRecord } from './trajectory.js';

export interface CostPerSolveReport {
  totalRuns: number;
  solvedRuns: number;
  /** Mean effective $ per solved run (reported + estimated components);
   *  null when nothing was solved or any solved run is unpriced. */
  usdPerSolve: number | null;
  /** Mean provider-REPORTED $ per solved run; null under the same
   *  conditions as usdPerSolve. */
  reportedUsdPerSolve: number | null;
  /** Mean price-table-ESTIMATED $ per solved run; null likewise. */
  estimatedUsdPerSolve: number | null;
  /** Mean total tokens per solved run; null when nothing was solved or a
   *  solved run's export carries no totalTokens. Independent of the dollar
   *  refusal: token coverage and cost coverage are different facts. */
  tokensPerSolve: number | null;
  /** Solved runs whose cost coverage is incomplete (see header). Non-empty
   *  ⇒ the dollar figures are null. */
  unpricedRunIds: string[];
  complete: boolean;
}

const SOLVED_STATUSES: ReadonlySet<string> = new Set(['PASS', 'FLAKY-PASS']);

export function isSolvedRecord(rec: TrajectoryRecord): boolean {
  return rec.verification !== null && SOLVED_STATUSES.has(rec.verification.status);
}

export function costPerSolveFromTrajectories(records: readonly TrajectoryRecord[]): CostPerSolveReport {
  const solved = records.filter(isSolvedRecord);
  const base: CostPerSolveReport = {
    totalRuns: records.length,
    solvedRuns: solved.length,
    usdPerSolve: null,
    reportedUsdPerSolve: null,
    estimatedUsdPerSolve: null,
    tokensPerSolve: null,
    unpricedRunIds: [],
    complete: false,
  };
  if (!solved.length) return base;

  let reported = 0;
  let estimated = 0;
  let tokens = 0;
  let tokensKnown = true;
  const unpricedRunIds: string[] = [];
  for (const rec of solved) {
    const u = rec.usage;
    if (u === null || (u.costUsd === undefined && u.estimatedCostUsd === undefined && (u.totalTokens ?? 0) > 0)) {
      // No usage at all, or tokens were spent but no cost — reported or
      // estimated — survived onto the export: coverage is incomplete.
      unpricedRunIds.push(rec.runId);
    } else {
      reported += u.costUsd ?? 0;
      estimated += u.estimatedCostUsd ?? 0;
    }
    if (u?.totalTokens === undefined) tokensKnown = false;
    else tokens += u.totalTokens;
  }

  const n = solved.length;
  return {
    ...base,
    tokensPerSolve: tokensKnown ? tokens / n : null,
    ...(unpricedRunIds.length
      ? { unpricedRunIds, complete: false }
      : {
          usdPerSolve: (reported + estimated) / n,
          reportedUsdPerSolve: reported / n,
          estimatedUsdPerSolve: estimated / n,
          complete: true,
        }),
  };
}
