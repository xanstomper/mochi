// Cost-per-solve from traces (C5): fold the usage records already sitting in
// a run's trace into a dollar figure, even when the provider reported $0.
//
// Two usage shapes appear in traces (mirroring trajectory.ts):
//  - flat `usage:updated` events: inputTokens is the NON-cached input count,
//    cacheTokens bills on top, costUsd is the per-call provider figure;
//  - nested provider `usage` objects on other entries: promptTokens INCLUDES
//    cachedTokens, costUsd likewise per-call.
// For each record: a nonzero provider costUsd wins as-is; a $0/absent one is
// estimated from the offline price table (pricing.ts) when the entry carries
// a model id and a token split. Records that can be neither reported nor
// priced are counted `unpricedCalls` and make the summary incomplete — the
// effective cost is then null instead of a partial sum that would flatter
// the run (same honesty rule as regression-gate's scanRunTraces).
import { estimateCostUsd, type PriceOverrides } from '../pricing.js';

export interface TraceCostSummary {
  /** Summed totalTokens across usage records; null when no usage was seen. */
  tokens: number | null;
  providerCostUsd: number;
  estimatedCostUsd: number;
  /** provider + estimated; null when any usage record stayed unpriced or no
   *  usage was seen at all. */
  effectiveCostUsd: number | null;
  costSource: 'provider' | 'estimated' | 'mixed' | 'none';
  pricedCalls: number;
  unpricedCalls: number;
  complete: boolean;
}

interface FlatEntry { [key: string]: unknown }

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function costFromTraceEntries(entries: readonly FlatEntry[], overrides?: PriceOverrides): TraceCostSummary {
  let tokens = 0;
  let sawUsage = false;
  let provider = 0;
  let estimated = 0;
  let priced = 0;
  let unpriced = 0;
  let usedProvider = false;
  let usedEstimate = false;

  const fold = (rec: {
    model?: string; providerCost?: number;
    inputTokens?: number; outputTokens?: number; cacheTokens?: number; totalTokens?: number;
    inputIncludesCache: boolean;
  }): void => {
    sawUsage = true;
    if (rec.totalTokens !== undefined) tokens += rec.totalTokens;
    else if (rec.inputTokens !== undefined || rec.outputTokens !== undefined) {
      tokens += (rec.inputTokens ?? 0) + (rec.outputTokens ?? 0);
    }
    if (rec.providerCost !== undefined && rec.providerCost > 0) {
      provider += rec.providerCost;
      priced++;
      usedProvider = true;
      return;
    }
    const hasTokens = (rec.inputTokens ?? 0) + (rec.outputTokens ?? 0) + (rec.cacheTokens ?? 0) > 0;
    if (!hasTokens) {
      // A usage record with no billable tokens costs $0 under any table.
      priced++;
      return;
    }
    const est = rec.model
      ? estimateCostUsd(rec.model, {
          inputTokens: rec.inputTokens,
          outputTokens: rec.outputTokens,
          cacheReadTokens: rec.cacheTokens,
          inputIncludesCache: rec.inputIncludesCache,
        }, overrides)
      : null;
    if (est) {
      estimated += est.costUsd;
      priced++;
      usedEstimate = true;
    } else {
      unpriced++;
    }
  };

  for (const e of entries) {
    if (e.kind === 'usage:updated') {
      fold({
        model: typeof e.model === 'string' ? e.model : undefined,
        providerCost: num(e.costUsd),
        inputTokens: num(e.inputTokens),
        outputTokens: num(e.outputTokens),
        cacheTokens: num(e.cacheTokens),
        totalTokens: num(e.totalTokens),
        inputIncludesCache: false,
      });
    }
    const nested = e.usage;
    if (nested && typeof nested === 'object') {
      const u = nested as FlatEntry;
      fold({
        model: typeof e.model === 'string' ? e.model : typeof u.model === 'string' ? u.model : undefined,
        providerCost: num(u.costUsd),
        inputTokens: num(u.promptTokens) ?? num(u.inputTokens),
        outputTokens: num(u.completionTokens) ?? num(u.outputTokens),
        cacheTokens: num(u.cachedTokens) ?? num(u.cacheTokens),
        totalTokens: num(u.totalTokens),
        inputIncludesCache: true,
      });
    }
  }

  const complete = sawUsage && unpriced === 0;
  return {
    tokens: sawUsage ? tokens : null,
    providerCostUsd: Math.round(provider * 1e10) / 1e10,
    estimatedCostUsd: Math.round(estimated * 1e10) / 1e10,
    effectiveCostUsd: complete ? Math.round((provider + estimated) * 1e10) / 1e10 : null,
    costSource: usedProvider && usedEstimate ? 'mixed' : usedProvider ? 'provider' : usedEstimate ? 'estimated' : 'none',
    pricedCalls: priced,
    unpricedCalls: unpriced,
    complete,
  };
}

/** Cost per solve over many runs' trace entries: total effective cost of the
 *  solved runs ÷ number solved. Null when any included run's cost is
 *  incomplete or nothing was solved — never a partial-sum average. `solved`
 *  is decided by the caller (verifier/bench outcome), not inferred here. */
export function costPerSolveFromTraces(
  runs: ReadonlyArray<{ entries: readonly FlatEntry[]; solved: boolean }>,
  overrides?: PriceOverrides,
): { usdPerSolve: number | null; tokensPerSolve: number | null; solvedRuns: number; totalRuns: number } {
  const solved = runs.filter((r) => r.solved);
  if (!solved.length) return { usdPerSolve: null, tokensPerSolve: null, solvedRuns: 0, totalRuns: runs.length };
  let usd = 0;
  let tokens = 0;
  for (const r of solved) {
    const s = costFromTraceEntries(r.entries, overrides);
    if (s.effectiveCostUsd === null || s.tokens === null) {
      return { usdPerSolve: null, tokensPerSolve: null, solvedRuns: solved.length, totalRuns: runs.length };
    }
    usd += s.effectiveCostUsd;
    tokens += s.tokens;
  }
  return { usdPerSolve: usd / solved.length, tokensPerSolve: tokens / solved.length, solvedRuns: solved.length, totalRuns: runs.length };
}
