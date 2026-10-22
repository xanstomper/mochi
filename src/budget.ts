import type { SafetyConfig } from './types.js';
import { estimateCostUsd, type PriceOverrides, type UsageBreakdown } from './pricing.js';

export type { PriceOverrides, UsageBreakdown };

export interface BudgetLimits {
  maxTokens: number;
  maxCostUsd: number;
  maxDurationMs: number;
  maxToolCalls: number;
  maxModelCalls: number;
  maxAgents: number;
}

export type BudgetPhase = 'full' | 'reduced' | 'cheap' | 'verify' | 'exhausted';

export type CostSource = 'provider' | 'estimated' | 'mixed' | 'none';

export interface BudgetSnapshot {
  usedTokens: number;
  /** Effective cost: provider-reported where nonzero, else the price-table
   *  estimate. This is the figure budget limits enforce against. */
  usedCostUsd: number;
  /** Portion of usedCostUsd the provider itself reported (never estimated). */
  usedProviderCostUsd: number;
  /** Portion of usedCostUsd filled in by the offline price table because the
   *  provider reported $0 / nothing. */
  usedEstimatedCostUsd: number;
  /** Where usedCostUsd came from; 'estimated'/'mixed' must be labelled as
   *  estimates anywhere the number is shown. */
  costSource: CostSource;
  usedDurationMs: number;
  usedToolCalls: number;
  usedModelCalls: number;
  usedAgents: number;
  remainingTokens: number;
  remainingCostUsd: number;
  remainingDurationMs: number;
  phase: BudgetPhase;
  ratio: number;
  /** MCH-79: per-model token/cost breakdown for the summary card. */
  byModel: Array<{ model: string; tokens: number; costUsd: number; providerCostUsd: number; estimatedCostUsd: number; calls: number }>;
}

import { nativeBudgetDecide } from './native/core.js';

// Cost accounting (C5): provider-reported billing (OpenRouter-style
// usage.cost) ALWAYS wins when nonzero — it is a measurement, the table is
// not. When the provider reports $0 / nothing, the offline price table
// (pricing.ts, config-overridable via safety.pricing) fills the gap so that
// maxCostUsd limits and cost-per-solve stay computable on endpoints that
// never bill-report. The two sources are ledgered SEPARATELY
// (usedProviderCostUsd vs usedEstimatedCostUsd, snapshot.costSource) so no
// surface ever presents an estimate as a provider measurement. A record
// without a token breakdown cannot be estimated (input/output split
// unknown) and charges $0, exactly as before.

export interface BudgetEngineOptions {
  /** Price-table overrides; defaults to safety.pricing.overrides. */
  pricing?: PriceOverrides;
  /** Disable the price-table fallback entirely (legacy $0 behavior). */
  pricingDisabled?: boolean;
}

export class BudgetEngine {
  private limits: BudgetLimits;
  private startedAt = 0;
  private usedTokens = 0;
  private usedCostUsd = 0;
  private usedProviderCostUsd = 0;
  private usedEstimatedCostUsd = 0;
  private providerPricedCalls = 0;
  private estimatedCalls = 0;
  private pricingOverrides?: PriceOverrides;
  private pricingDisabled: boolean;
  private usedToolCalls = 0;
  private usedModelCalls = 0;
  private usedAgents = 0;
  /** MCH-79: per-model token/cost ledger. */
  private byModel = new Map<string, { tokens: number; costUsd: number; providerCostUsd: number; estimatedCostUsd: number; calls: number }>();

  constructor(safety: SafetyConfig, opts: BudgetEngineOptions = {}) {
    this.limits = {
      maxTokens: safety.maxTokens ?? Number.POSITIVE_INFINITY,
      maxCostUsd: safety.maxCostUsd ?? Number.POSITIVE_INFINITY,
      maxDurationMs: safety.maxRuntimeMinutes * 60_000,
      maxToolCalls: safety.maxToolCalls ?? Number.POSITIVE_INFINITY,
      maxModelCalls: safety.maxModelCalls ?? Number.POSITIVE_INFINITY,
      maxAgents: safety.maxConcurrentAgents,
    };
    this.pricingOverrides = opts.pricing ?? safety.pricing?.overrides;
    this.pricingDisabled = opts.pricingDisabled ?? safety.pricing?.disabled ?? false;
  }

  start() {
    this.startedAt = performance.now();
  }

  /** @param realCostUsd Provider-REPORTED cost for this record (usage.cost from
   *  the API's own usage object). When it is nonzero it is charged as-is and
   *  the price table is NOT consulted. When it is $0/omitted AND a token
   *  breakdown (`usage`) is supplied, the offline price table estimates the
   *  record instead (ledgered as estimated, never as reported). Without a
   *  breakdown the record charges $0 — a bare token count has no honest
   *  input/output split to price. The token limit still counts the `tokens`
   *  argument as given by the caller (the loop passes output-only tokens:
   *  full re-billing exhausts maxTokens early, and output tokens are the
   *  resource that scales with agent work). */
  recordTokens(tokens: number, model: string, provider = '', realCostUsd?: number, usage?: UsageBreakdown) {
    void provider; // kept for call-site stability; the table is keyed by model id
    this.usedTokens += tokens;
    let providerCost = 0;
    let estimatedCost = 0;
    if (realCostUsd !== undefined && realCostUsd > 0) {
      providerCost = realCostUsd;
      this.providerPricedCalls++;
    } else if (usage && !this.pricingDisabled) {
      const est = estimateCostUsd(model, usage, this.pricingOverrides);
      if (est) {
        estimatedCost = est.costUsd;
        this.estimatedCalls++;
      }
    }
    const cost = providerCost + estimatedCost;
    this.usedCostUsd += cost;
    this.usedProviderCostUsd += providerCost;
    this.usedEstimatedCostUsd += estimatedCost;
    // MCH-79: per-model ledger for the /usage cost breakdown.
    const e = this.byModel.get(model) ?? { tokens: 0, costUsd: 0, providerCostUsd: 0, estimatedCostUsd: 0, calls: 0 };
    e.tokens += tokens;
    e.costUsd += cost;
    e.providerCostUsd += providerCost;
    e.estimatedCostUsd += estimatedCost;
    e.calls += 1;
    this.byModel.set(model, e);
  }

  /** Record a full provider usage object. Token-limit accounting keeps the
   *  historical rule (output tokens only, falling back to total), while the
   *  price-table fallback sees the full input/output/cache split. */
  recordUsage(
    usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedTokens?: number; costUsd?: number },
    model: string,
    provider = '',
  ): void {
    const tokens = usage.completionTokens ?? usage.totalTokens ?? 0;
    const inputTokens = usage.promptTokens
      ?? (usage.totalTokens !== undefined && usage.completionTokens !== undefined
        ? Math.max(0, usage.totalTokens - usage.completionTokens)
        : undefined);
    this.recordTokens(tokens, model, provider, usage.costUsd, {
      inputTokens,
      outputTokens: usage.completionTokens,
      cacheReadTokens: usage.cachedTokens,
    });
  }

  /** Where the accumulated cost came from (see BudgetSnapshot.costSource). */
  costSource(): CostSource {
    if (this.providerPricedCalls > 0 && this.estimatedCalls > 0) return 'mixed';
    if (this.providerPricedCalls > 0) return 'provider';
    if (this.estimatedCalls > 0) return 'estimated';
    return 'none';
  }

  recordToolCall() {
    this.usedToolCalls++;
  }

  recordModelCall() {
    this.usedModelCalls++;
  }

  recordAgentStart() {
    this.usedAgents++;
  }

  recordAgentEnd() {
    this.usedAgents = Math.max(0, this.usedAgents - 1);
  }

  remainingTokens(): number {
    return Math.max(0, this.limits.maxTokens - this.usedTokens);
  }

  remainingCostUsd(): number {
    return Math.max(0, this.limits.maxCostUsd - this.usedCostUsd);
  }

  remainingDurationMs(): number {
    if (this.startedAt === 0) return this.limits.maxDurationMs;
    return Math.max(0, this.limits.maxDurationMs - (performance.now() - this.startedAt));
  }

  ratio(): number {
    // Native-first: hand the current state to the Rust core (slice 3) which
    // returns the same value the TS code below computes, but ~5x faster.
    // The fallback is the original regex-equivalent loop.
    const nat = nativeBudgetDecide(
      {
        maxTokens: Number.isFinite(this.limits.maxTokens) ? this.limits.maxTokens : Infinity,
        maxCostUsd: Number.isFinite(this.limits.maxCostUsd) ? this.limits.maxCostUsd : Infinity,
        maxDurationMs: this.limits.maxDurationMs,
        maxToolCalls: Number.isFinite(this.limits.maxToolCalls) ? this.limits.maxToolCalls : Infinity,
        maxModelCalls: Number.isFinite(this.limits.maxModelCalls) ? this.limits.maxModelCalls : Infinity,
      },
      {
        usedTokens: this.usedTokens,
        usedCostUsd: this.usedCostUsd,
        usedDurationMs: this.startedAt === 0 ? 0 : performance.now() - this.startedAt,
        usedToolCalls: this.usedToolCalls,
        usedModelCalls: this.usedModelCalls,
      },
    );
    if (nat !== null) return nat.ratio;
    const ratios: number[] = [];
    if (Number.isFinite(this.limits.maxTokens)) ratios.push(this.remainingTokens() / this.limits.maxTokens);
    if (Number.isFinite(this.limits.maxCostUsd) && this.limits.maxCostUsd > 0) ratios.push(this.remainingCostUsd() / this.limits.maxCostUsd);
    if (this.limits.maxDurationMs > 0) ratios.push(this.remainingDurationMs() / this.limits.maxDurationMs);
    if (Number.isFinite(this.limits.maxToolCalls)) ratios.push(Math.max(0, this.limits.maxToolCalls - this.usedToolCalls) / this.limits.maxToolCalls);
    if (Number.isFinite(this.limits.maxModelCalls)) ratios.push(Math.max(0, this.limits.maxModelCalls - this.usedModelCalls) / this.limits.maxModelCalls);
    if (ratios.length === 0) return 1;
    return Math.min(...ratios);
  }

  phase(): BudgetPhase {
    const r = this.ratio();
    if (r <= 0) return 'exhausted';
    if (r <= 0.05) return 'verify';
    if (r <= 0.25) return 'cheap';
    if (r <= 0.5) return 'reduced';
    return 'full';
  }

  /** Phase as a small int (0=exhausted, 1=verify, 2=cheap, 3=reduced, 4=full).
   *  Native-first; the JS phase() method above is kept for the type signature. */
  phaseCode(): number {
    const r = this.ratio();
    if (r <= 0) return 0;
    if (r <= 0.05) return 1;
    if (r <= 0.25) return 2;
    if (r <= 0.5) return 3;
    return 4;
  }

  snapshot(_model: string): BudgetSnapshot {
    return {
      usedTokens: this.usedTokens,
      usedCostUsd: this.usedCostUsd,
      usedProviderCostUsd: this.usedProviderCostUsd,
      usedEstimatedCostUsd: this.usedEstimatedCostUsd,
      costSource: this.costSource(),
      usedDurationMs: this.startedAt === 0 ? 0 : performance.now() - this.startedAt,
      usedToolCalls: this.usedToolCalls,
      usedModelCalls: this.usedModelCalls,
      usedAgents: this.usedAgents,
      remainingTokens: this.remainingTokens(),
      remainingCostUsd: this.remainingCostUsd(),
      remainingDurationMs: this.remainingDurationMs(),
      phase: this.phase(),
      ratio: this.ratio(),
      // MCH-79: ranked highest-cost-first for the summary card.
      byModel: Array.from(this.byModel.entries())
        .map(([model, e]) => ({ model, tokens: e.tokens, costUsd: e.costUsd, providerCostUsd: e.providerCostUsd, estimatedCostUsd: e.estimatedCostUsd, calls: e.calls }))
        .sort((a, b) => b.costUsd - a.costUsd),
    };
  }

  canUseTokens(tokens: number): boolean {
    return this.remainingTokens() >= tokens && this.remainingCostUsd() > 0;
  }

  canMakeModelCall(): boolean {
    if (this.phase() === 'exhausted') return false;
    if (Number.isFinite(this.limits.maxModelCalls) && this.usedModelCalls >= this.limits.maxModelCalls) return false;
    return true;
  }

  canExecuteTool(): boolean {
    // Verify phase (ratio<=0.05) is the "spend remaining budget on proving the
    // work" phase: it must still allow tool calls (especially the verify
    // tool / scoped checks). Only a truly exhausted budget vetoes tools.
    return this.remainingDurationMs() > 0 && this.phase() !== 'exhausted';
  }

  shouldUseCheaperModel(): boolean {
    return this.phase() === 'cheap' || this.phase() === 'verify';
  }
}
