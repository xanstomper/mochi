// Multi-Tier Model Router with automatic failover and exponential backoff.
//
// Tier 1 (fast/cheap): background tasks — memory extraction, commit messages,
//   AST summaries, grep post-processing. Uses the 'fast' model profile.
// Tier 2 (frontier): planning, code generation, multi-file refactors.
//   Uses the primary model or the 'coding'/'reasoning' profiles.
//
// When a request hits HTTP 429/503, the router retries with exponential backoff
// then cascades to failover providers if configured.

import type { ModelConfig, ModelProfile } from './types.js';

export type TaskTier = 'fast' | 'standard' | 'reasoning';

interface RouterDecision {
  config: ModelConfig;
  model: string;
  tier: TaskTier;
}

/** Classify a task by its description to select the right model tier. */
export function classifyTaskTier(taskTitle: string, taskRole?: string): TaskTier {
  const lower = (taskTitle + ' ' + (taskRole ?? '')).toLowerCase();

  // Background / auxiliary tasks → fast tier
  if (/memory|extract|summarize|commit message|index|outline|ast|format|lint|doc|comment/i.test(lower)) {
    return 'fast';
  }

  // High-complexity tasks → reasoning tier
  if (/architect|design|plan|algorithm|security|audit|review|refactor.*large|multi.*file|complex/i.test(lower)) {
    return 'reasoning';
  }

  return 'standard';
}

/** Resolve the effective model string for a given tier. */
export function resolveModel(config: ModelConfig, tier: TaskTier): string {
  const profiles = config.profiles;
  if (!profiles) return config.model;
  const profileMap: Record<TaskTier, ModelProfile> = {
    fast: 'fast',
    standard: 'coding',
    reasoning: 'reasoning',
  };
  return profiles[profileMap[tier]] ?? config.model;
}

/** Exponential backoff helper. */
async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface RetryConfig {
  maxRetries?: number;
  initialDelayMs?: number;
  backoffFactor?: number;
}

/**
 * Wrap a model API call with exponential backoff + optional provider failover.
 * The caller provides a `makeCall` factory that receives a ModelConfig and
 * target model string. On 429/503, it retries after increasing delays; after
 * exhausting retries it cascades to each failover config in order.
 */
export async function withFailover<T>(
  primary: ModelConfig,
  tier: TaskTier,
  makeCall: (cfg: ModelConfig, model: string) => Promise<T>,
  retry: RetryConfig = {},
): Promise<T> {
  const maxRetries = retry.maxRetries ?? 3;
  const initialDelay = retry.initialDelayMs ?? 1000;
  const factor = retry.backoffFactor ?? 2;

  const configs: ModelConfig[] = [primary, ...(primary.failover ?? [])];

  for (let ci = 0; ci < configs.length; ci++) {
    const cfg = configs[ci];
    const model = resolveModel(cfg, tier);
    let delay = initialDelay;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await makeCall(cfg, model);
      } catch (err: any) {
        const msg = (err?.message ?? String(err)).toLowerCase();
        const isRateLimit = err?.status === 429 || err?.status === 503 ||
          msg.includes('rate limit') || msg.includes('429') || msg.includes('503') ||
          msg.includes('quota') || msg.includes('overloaded');

        // Not a retriable error — if there are more providers, fall through
        if (!isRateLimit) {
          if (ci < configs.length - 1) break; // try next provider
          throw err; // no more fallbacks
        }

        if (attempt === maxRetries) {
          if (ci < configs.length - 1) break; // cascade to next provider
          throw new Error(`All ${configs.length} provider(s) exhausted after rate limiting. Last error: ${err.message}`);
        }

        // Rate limited — wait and retry on the same provider
        console.warn(`[router] ${cfg.provider} rate-limited (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms…`);
        await sleep(delay);
        delay = Math.min(delay * factor, 30_000);
      }
    }
  }

  throw new Error('Model router: all providers failed');
}
