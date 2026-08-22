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

export const DEFAULT_COST_PER_TOKEN: Record<string, { prompt: number; completion: number } | number> = {
  'gpt-4o': { prompt: 0.0000025, completion: 0.00001 },
  'gpt-4o-mini': { prompt: 0.00000015, completion: 0.0000006 },
  'gpt-4.1': { prompt: 0.000002, completion: 0.000008 },
  'gpt-4.1-mini': { prompt: 0.0000004, completion: 0.0000016 },
  'gpt-5': { prompt: 0.000003, completion: 0.000012 },
  'claude-3-7-sonnet': { prompt: 0.000003, completion: 0.000015 },
  'claude-3-5-sonnet': { prompt: 0.000003, completion: 0.000015 },
  'claude-3-5-haiku': { prompt: 0.0000008, completion: 0.000004 },
  'deepseek-v4-flash': { prompt: 0.00000014, completion: 0.00000028 },
  'deepseek-v4-flash-free': 0,
  'deepseek-chat': { prompt: 0.00000014, completion: 0.00000028 },
  'deepseek-reasoner': { prompt: 0.00000055, completion: 0.00000219 },
  'deepseek-r1': { prompt: 0.00000055, completion: 0.00000219 },
  'deepseek-v3': { prompt: 0.00000014, completion: 0.00000028 },
  'gemini-2.0-flash': { prompt: 0.0000001, completion: 0.0000004 },
  'gemini-1.5-pro': { prompt: 0.00000125, completion: 0.000005 },
  'qwen': { prompt: 0.0000002, completion: 0.0000006 },
  'zen': { prompt: 0.00000014, completion: 0.00000028 },
  'opencode': { prompt: 0.00000014, completion: 0.00000028 },
};

export function estimateCostUsd(tokens: number | { promptTokens?: number; completionTokens?: number }, model: string): number {
  if (model.toLowerCase().includes('free')) return 0;
  const mLower = model.toLowerCase();
  const key = Object.keys(DEFAULT_COST_PER_TOKEN).find((k) => mLower.includes(k.toLowerCase()));
  if (!key) {
    const rate = 0.0000005;
    if (typeof tokens === 'number') return tokens * rate;
    return ((tokens.promptTokens ?? 0) + (tokens.completionTokens ?? 0)) * rate;
  }
  const pricing = DEFAULT_COST_PER_TOKEN[key];
  if (typeof pricing === 'number') {
    if (typeof tokens === 'number') return tokens * pricing;
    return ((tokens.promptTokens ?? 0) + (tokens.completionTokens ?? 0)) * pricing;
  }
  if (typeof tokens === 'number') {
    return tokens * ((pricing.prompt + pricing.completion) / 2);
  }
  return (tokens.promptTokens ?? 0) * pricing.prompt + (tokens.completionTokens ?? 0) * pricing.completion;
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
