import type { SafetyConfig } from './types.js';

export interface BudgetLimits {
  maxTokens: number;
  maxCostUsd: number;
  maxDurationMs: number;
  maxToolCalls: number;
  maxModelCalls: number;
  maxAgents: number;
}

export type BudgetPhase = 'full' | 'reduced' | 'cheap' | 'verify' | 'exhausted';

export interface BudgetSnapshot {
  usedTokens: number;
  usedCostUsd: number;
  usedDurationMs: number;
  usedToolCalls: number;
  usedModelCalls: number;
  usedAgents: number;
  remainingTokens: number;
  remainingCostUsd: number;
  remainingDurationMs: number;
  phase: BudgetPhase;
  ratio: number;
}

export const DEFAULT_COST_PER_TOKEN: Record<string, number> = {
  'gpt-4o': 0.000005,
  'gpt-4o-mini': 0.00000015,
  'gpt-4.1': 0.000004,
  'gpt-4.1-mini': 0.0000004,
  'gpt-5': 0.000005,
  'claude-3-5-sonnet': 0.000003,
  'claude-3-5-haiku': 0.000001,
  'deepseek-v4-flash': 0.00000014,
  'deepseek-v4-flash-free': 0,
};

export function estimateCostUsd(tokens: number, model: string): number {
  if (model.toLowerCase().includes('free')) return 0;
  const key = Object.keys(DEFAULT_COST_PER_TOKEN).find((k) => model.toLowerCase().includes(k));
  if (!key) return 0;
  return tokens * DEFAULT_COST_PER_TOKEN[key];
}

export class BudgetEngine {
  private limits: BudgetLimits;
  private startedAt = 0;
  private usedTokens = 0;
  private usedCostUsd = 0;
  private usedToolCalls = 0;
  private usedModelCalls = 0;
  private usedAgents = 0;

  constructor(safety: SafetyConfig) {
    this.limits = {
      maxTokens: safety.maxTokens ?? Number.POSITIVE_INFINITY,
      maxCostUsd: safety.maxCostUsd ?? Number.POSITIVE_INFINITY,
      maxDurationMs: safety.maxRuntimeMinutes * 60_000,
      maxToolCalls: safety.maxToolCalls ?? Number.POSITIVE_INFINITY,
      maxModelCalls: safety.maxModelCalls ?? Number.POSITIVE_INFINITY,
      maxAgents: safety.maxConcurrentAgents,
    };
  }

  start() {
    this.startedAt = performance.now();
  }

  recordTokens(tokens: number, model: string) {
    this.usedTokens += tokens;
    this.usedCostUsd += estimateCostUsd(tokens, model);
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

  snapshot(model: string): BudgetSnapshot {
    return {
      usedTokens: this.usedTokens,
      usedCostUsd: this.usedCostUsd,
      usedDurationMs: this.startedAt === 0 ? 0 : performance.now() - this.startedAt,
      usedToolCalls: this.usedToolCalls,
      usedModelCalls: this.usedModelCalls,
      usedAgents: this.usedAgents,
      remainingTokens: this.remainingTokens(),
      remainingCostUsd: this.remainingCostUsd(),
      remainingDurationMs: this.remainingDurationMs(),
      phase: this.phase(),
      ratio: this.ratio(),
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
    return this.remainingDurationMs() > 0 && (this.phase() === 'full' || this.phase() === 'reduced' || this.phase() === 'cheap');
  }

  shouldUseCheaperModel(): boolean {
    return this.phase() === 'cheap' || this.phase() === 'verify';
  }
}
