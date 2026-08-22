// KV Cache TTL Tracker
// Anthropic caches prompt prefixes for 5 minutes (300 seconds). This module
// tracks when the active prefix was last seen by the API and warns when the
// TTL is about to expire (so agents can avoid cold-cache re-computation cost).
//
// Usage: call recordCacheHit() whenever the model response includes a non-zero
// cache_read_input_tokens. Call cacheStatus() to get the current state.

export type CacheState = 'warm' | 'cooling' | 'cold' | 'unknown';

export interface CacheStatus {
  state: CacheState;
  /** Seconds since last confirmed cache hit. -1 if never seen. */
  ageSecs: number;
  /** Seconds remaining before cache likely expires (5 min TTL). -1 if cold. */
  remainingSecs: number;
  /** Number of tokens saved via cache on last hit. */
  lastSavedTokens: number;
  /** Total tokens saved across all hits this session. */
  totalSavedTokens: number;
  /** Human-readable label for TUI display. */
  label: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // Anthropic 5-min TTL
const COOLING_THRESHOLD_MS = 60 * 1000; // Warn when < 1 min remaining

export class KvCacheTracker {
  private lastHitAt = -1;
  private lastSavedTokens = 0;
  private totalSavedTokens = 0;
  /** Tokens saved by the most recent cache hit (public read for usage bars). */
  get lastCacheSaved(): number { return this.lastSavedTokens; }
  /** Total tokens saved across all hits this session. */
  get totalCacheSaved(): number { return this.totalSavedTokens; }
  /** Total prompt tokens sent this session (for cost estimation). */
  private totalInputTokens = 0;

  /** Call this after each model response. */
  recordUsage(usage: {
    promptTokens?: number;
    completionTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }): void {
    if (usage.promptTokens) this.totalInputTokens += usage.promptTokens;
    if (usage.cacheReadTokens && usage.cacheReadTokens > 0) {
      this.lastHitAt = Date.now();
      this.lastSavedTokens = usage.cacheReadTokens;
      this.totalSavedTokens += usage.cacheReadTokens;
    }
  }

  /** Record a confirmed cache hit from response metadata. */
  recordCacheHit(savedTokens: number): void {
    this.lastHitAt = Date.now();
    this.lastSavedTokens = savedTokens;
    this.totalSavedTokens += savedTokens;
  }

  status(): CacheStatus {
    if (this.lastHitAt < 0) {
      return {
        state: 'unknown', ageSecs: -1, remainingSecs: -1,
        lastSavedTokens: 0, totalSavedTokens: 0, label: 'Cache: unknown',
      };
    }
    const ageSecs = Math.round((Date.now() - this.lastHitAt) / 1000);
    const remainingMs = CACHE_TTL_MS - (Date.now() - this.lastHitAt);
    const remainingSecs = Math.max(0, Math.round(remainingMs / 1000));

    let state: CacheState;
    let label: string;
    if (remainingMs <= 0) {
      state = 'cold';
      label = '[COLD] Cache cold';
    } else if (remainingMs < COOLING_THRESHOLD_MS) {
      state = 'cooling';
      label = `[COOL] Cache cooling (${remainingSecs}s)`;
    } else {
      state = 'warm';
      label = `[WARM] Cache warm (${remainingSecs}s)`;
    }

    return { state, ageSecs, remainingSecs, lastSavedTokens: this.lastSavedTokens, totalSavedTokens: this.totalSavedTokens, label };
  }

  /** Format a compact badge for the TUI footer. */
  badge(): string {
    const s = this.status();
    if (s.state === 'unknown' || s.state === 'cold') return '';
    return `[CACHED]`;
  }

  reset(): void {
    this.lastHitAt = -1;
    this.lastSavedTokens = 0;
    this.totalSavedTokens = 0;
    this.totalInputTokens = 0;
  }
}

/** Global session-level cache tracker (singleton). */
export const kvCache = new KvCacheTracker();
