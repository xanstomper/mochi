// Offline per-model price table (C5): USD list prices per 1M tokens, used to
// ESTIMATE cost when a provider reports $0 / no billing figure for a call.
//
// Why this exists alongside provider-reported billing: benchmarks and budget
// enforcement need a cost number for every run, but many endpoints (local
// servers, free tiers, several OpenAI-compatible gateways) never report one.
// The old policy — "no local table, cost is $0 unless the provider says
// otherwise" — made cost-per-solve uncomputable for exactly the runs the
// regression gate compares. The compromise: provider-reported cost ALWAYS
// wins when nonzero; the table only fills the $0 gap, and every dollar it
// produces is tracked separately as ESTIMATED (see BudgetEngine's
// usedEstimatedCostUsd / costSource) so reports never present an estimate as
// a provider measurement.
//
// Rates are vendor LIST prices as of PRICE_TABLE_AS_OF. They are a snapshot,
// not a feed: hosting providers discount/resell the same model id at other
// rates, which is exactly why `safety.pricing.overrides` (config) and the
// BudgetEngine constructor option exist — an operator who pays a different
// rate overrides the entry instead of editing source. Unknown models resolve
// to null (no estimate) rather than a guessed family rate.

/** USD per 1M tokens. cacheRead/cacheWrite fall back to `input` when absent. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Per-model partial rates merged over the built-in table (same model id
 *  matching rules as resolvePrice). An override entry for a new model should
 *  set at least input+output; missing rates on a new model default to 0. */
export type PriceOverrides = Record<string, Partial<ModelPrice>>;

/** Token counts for one model call, provider-usage shaped. */
export interface UsageBreakdown {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** True (default) when inputTokens INCLUDES the cached tokens (Anthropic /
   *  OpenAI usage convention): billable fresh input = input - cacheRead.
   *  False when inputTokens is already the non-cached count and cacheRead is
   *  billed on top (the loop's flat usage:updated event convention). */
  inputIncludesCache?: boolean;
}

export const PRICE_TABLE_AS_OF = '2026-10-22';

/** Built-in list prices, USD per 1M tokens. Deliberately conservative scope:
 *  flagship/coding models Mochi actually routes to, at the vendor's own list
 *  rate. Resold/open-weight endpoints vary too much per host to table.
 *
 * Per-entry provenance (ISSUES L-07 — a table without provenance is a rumor):
 * every entry carries a trailing tag —
 *   [vendor-list]  vendor's own list rate, cross-checked against the
 *                  vendor's published cache multipliers (Anthropic rows:
 *                  cacheWrite = 1.25× input, cacheRead = 0.1× input).
 *   [estimate]     per project history an ESTIMATE, not a confirmed list
 *                  price — treat with suspicion; override via
 *                  `safety.pricing.overrides` when you know the real rate.
 *   [unverified]   no project-history confirmation either way — same
 *                  override path applies.
 * No tag invents a URL: provenance this wave cannot re-verify 2026 vendor
 * pages, so it records confidence honestly instead of manufacturing it. */
export const DEFAULT_PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  // Anthropic (cache write = 1.25x input, cache read = 0.1x input)
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, // [vendor-list]
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }, // [vendor-list]
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }, // [vendor-list]
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }, // [vendor-list]
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, // [vendor-list]
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, // [vendor-list]
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }, // [vendor-list]
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }, // [vendor-list]
  'claude-haiku-3-5': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }, // [vendor-list]
  // OpenAI
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 }, // [estimate]
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 }, // [estimate]
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005 }, // [estimate]
  'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5 }, // [unverified]
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1 }, // [unverified]
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cacheRead: 0.025 }, // [unverified]
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 }, // [unverified]
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 }, // [unverified]
  'o3': { input: 2, output: 8, cacheRead: 0.5 }, // [unverified]
  'o4-mini': { input: 1.1, output: 4.4, cacheRead: 0.275 }, // [unverified]
  // Google
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.31 }, // [unverified]
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.03 }, // [unverified]
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cacheRead: 0.01 }, // [unverified]
  'gemini-2.0-flash': { input: 0.1, output: 0.4, cacheRead: 0.025 }, // [unverified]
  // DeepSeek (cache read = prompt-cache-hit rate)
  'deepseek-chat': { input: 0.27, output: 1.1, cacheRead: 0.07 }, // [estimate: cache rate]
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.14 }, // [estimate: cache rate]
  // xAI / Mistral
  'grok-4': { input: 3, output: 15, cacheRead: 0.75 }, // [estimate]
  'mistral-large': { input: 2, output: 6 }, // [unverified]
  'codestral': { input: 0.3, output: 0.9 }, // [unverified]
};

const ZERO_PRICE: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Normalize a model id for table lookup: lowercase, drop a trailing release
 *  date (-20250929 / -2025-09-29) and surrounding whitespace. Provider path
 *  prefixes are handled by trying progressively shorter candidates. */
export function normalizeModelId(model: string): string {
  return model.trim().toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '');
}

function candidates(model: string): string[] {
  const full = normalizeModelId(model);
  const out = [full];
  const first = full.indexOf('/');
  if (first >= 0) out.push(full.slice(first + 1));
  const last = full.lastIndexOf('/');
  if (last > first) out.push(full.slice(last + 1));
  return [...new Set(out.filter(Boolean))];
}

function isFreeId(id: string): boolean {
  return id === 'free' || id.endsWith('-free') || id.endsWith(':free') || id.includes(':free-') || id.endsWith('/free');
}

function mergeEntry(base: ModelPrice | undefined, over: Partial<ModelPrice> | undefined): ModelPrice | null {
  if (!base && !over) return null;
  const merged: ModelPrice = {
    input: over?.input ?? base?.input ?? 0,
    output: over?.output ?? base?.output ?? 0,
    cacheRead: over?.cacheRead ?? base?.cacheRead,
    cacheWrite: over?.cacheWrite ?? base?.cacheWrite,
  };
  if (![merged.input, merged.output, merged.cacheRead ?? 0, merged.cacheWrite ?? 0].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return merged;
}

export interface ResolvedPrice {
  price: ModelPrice;
  /** The candidate id that matched (after normalization). */
  matchedId: string;
  source: 'override' | 'table' | 'free';
}

/** Resolve a model id to a price. Lookup order per candidate id (full id,
 *  then progressively un-prefixed): config override → built-in table →
 *  longest boundary prefix in either (so `gpt-4o-2024-08-06` and
 *  `claude-sonnet-4-5-20250929` hit their base entries). Ids marked free
 *  (-free / :free) resolve to an explicit $0 price. Unknown → null. */
export function resolvePrice(model: string, overrides?: PriceOverrides): ResolvedPrice | null {
  if (!model) return null;
  const overByNorm = new Map<string, Partial<ModelPrice>>();
  if (overrides) for (const [k, v] of Object.entries(overrides)) overByNorm.set(normalizeModelId(k), v);
  const tableKeys = [...Object.keys(DEFAULT_PRICE_TABLE), ...overByNorm.keys()];

  for (const cand of candidates(model)) {
    if (isFreeId(cand)) return { price: ZERO_PRICE, matchedId: cand, source: 'free' };
    const exact = mergeEntry(DEFAULT_PRICE_TABLE[cand], overByNorm.get(cand));
    if (exact) return { price: exact, matchedId: cand, source: overByNorm.has(cand) ? 'override' : 'table' };
    // Longest key that is a boundary prefix of the candidate.
    let best: string | null = null;
    for (const key of tableKeys) {
      if (key.length >= cand.length) continue;
      if (!cand.startsWith(key)) continue;
      const next = cand[key.length];
      if (next !== '-' && next !== '.' && next !== '/') continue;
      if (!best || key.length > best.length) best = key;
    }
    if (best) {
      const merged = mergeEntry(DEFAULT_PRICE_TABLE[best], overByNorm.get(best));
      if (merged) return { price: merged, matchedId: best, source: overByNorm.has(best) ? 'override' : 'table' };
    }
  }
  return null;
}

export interface CostEstimate {
  costUsd: number;
  matchedId: string;
  source: ResolvedPrice['source'];
}

function tok(n: number | undefined): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Estimate one call's cost from token counts. Returns null when the model
 *  is not priced (unknown id) or when NO billable token count is known at
 *  all — a totalTokens-only record cannot be priced honestly (input/output
 *  split unknown), so it stays unpriced rather than guessing a rate. */
export function estimateCostUsd(model: string, usage: UsageBreakdown, overrides?: PriceOverrides): CostEstimate | null {
  const resolved = resolvePrice(model, overrides);
  if (!resolved) return null;
  const input = tok(usage.inputTokens);
  const output = tok(usage.outputTokens);
  const cacheRead = tok(usage.cacheReadTokens);
  const cacheWrite = tok(usage.cacheWriteTokens);
  if (input + output + cacheRead + cacheWrite === 0) return null;
  const p = resolved.price;
  const per = (rate: number) => rate / 1_000_000;
  const billableInput = usage.inputIncludesCache === false ? input : Math.max(0, input - cacheRead);
  const cost = billableInput * per(p.input)
    + cacheRead * per(p.cacheRead ?? p.input)
    + cacheWrite * per(p.cacheWrite ?? p.input)
    + output * per(p.output);
  return { costUsd: Math.round(cost * 1e10) / 1e10, matchedId: resolved.matchedId, source: resolved.source };
}
