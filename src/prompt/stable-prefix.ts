// Stable-prefix accounting (P5).
//
// Providers cache the LEADING BYTES of a prompt: the system prompt, then the
// earliest history. Every byte that changes invalidates the cache from that
// point on — so a mid-run system-prompt drift (a new tool schema, a memory
// digest that ticks, a repo-map refresh) silently reprices every subsequent
// turn. This module owns the primitives the ContextEngine and the loop use to
// make that visible instead of invisible:
//
//   - `sha256Hex`             content hash for segments / prompts
//   - `firstChangedSegment`   which composed segment broke the prefix
//   - `cacheHitRatio`         measured cache-hit share across model calls
//   - `PrefixSegment`         one named slice of the system prompt
//   - `PrefixBreak`           one attributed mid-run prefix break
//   - `PrefixStats`           the per-run snapshot surfaced in AgentResult
//
// Nothing here talks to a provider. It is pure bookkeeping, deliberately
// allocation-light (the loop calls it on every model call).

import { createHash } from 'node:crypto';

/** One named slice of the composed system prompt, in wire order. */
export interface PrefixSegment {
  /** Stable identifier used in break attribution ('core', 'rulesRoot', …). */
  name: string;
  /** The exact text this segment contributes to the prompt. */
  text: string;
}

/** One attributed prefix break: what changed, and after how many packets. */
export interface PrefixBreak {
  /** Segment name, or a history-rewrite label ('compaction', 'tool-output-shrink'). */
  cause: string;
  /** Number of prompt packets composed before the break was recorded. */
  packet: number;
}

/** Per-run prefix-cache snapshot, surfaced in the run result. */
export interface PrefixStats {
  /** Hash of the stable head (core + root rules + repo info) as last rendered. */
  stableHash: string | null;
  /** Hash of the full composed system prompt as last rendered. */
  systemHash: string | null;
  /** How many times the system prompt was composed this run. */
  packets: number;
  /** Every attributed mid-run prefix break, in order. */
  breaks: PrefixBreak[];
  /** Convenience: `breaks.length`. */
  breakCount: number;
}

/** One model call's prompt/cache accounting, as the provider reported it. */
export interface CacheCall {
  promptTokens: number;
  /** Prompt tokens the provider served from cache. Undefined when the
   *  provider reported no cache figure at all — such calls are excluded
   *  from `measuredCalls` rather than counted as zero hits. */
  cachedTokens?: number;
}

export interface CacheRatio {
  /** cachedTokens / promptTokens across measured calls; null when no call
   *  reported a cache figure (unmeasured is not 0%). */
  ratio: number | null;
  /** Calls that carried a cache figure. */
  measuredCalls: number;
  /** Sum of prompt tokens across measured calls. */
  promptTokens: number;
  /** Sum of cached tokens across measured calls. */
  cachedTokens: number;
}

/** SHA-256 of a string, lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * First segment whose hash differs between two compositions, or `null` when
 * the segment list is identical. A segment that appeared or disappeared is
 * attributed to that segment's name (the prefix changed at its boundary).
 */
export function firstChangedSegment(
  prev: ReadonlyArray<{ name: string; hash: string }>,
  next: ReadonlyArray<{ name: string; hash: string }>,
): string | null {
  const byName = new Map(prev.map((s) => [s.name, s.hash]));
  for (const seg of next) {
    if (byName.get(seg.name) !== seg.hash) return seg.name;
  }
  // Every surviving segment matched, but a segment vanished.
  const nextNames = new Set(next.map((s) => s.name));
  for (const seg of prev) if (!nextNames.has(seg.name)) return seg.name;
  return null;
}

/**
 * Measured cache-hit share across calls. Only calls that reported a cache
 * figure participate: treating "provider said nothing" as "zero cached"
 * would understate real caching, and treating it as "fully cached" would
 * invent savings. No measured calls → ratio null.
 */
export function cacheHitRatio(calls: readonly CacheCall[]): CacheRatio {
  let measured = 0;
  let prompt = 0;
  let cached = 0;
  for (const c of calls) {
    if (typeof c.cachedTokens !== 'number' || !Number.isFinite(c.cachedTokens)) continue;
    if (!Number.isFinite(c.promptTokens) || c.promptTokens <= 0) continue;
    measured++;
    prompt += c.promptTokens;
    // Defensive: some gateways report cached > prompt on bad accounting.
    cached += Math.min(Math.max(0, c.cachedTokens), c.promptTokens);
  }
  return {
    ratio: prompt > 0 ? cached / prompt : null,
    measuredCalls: measured,
    promptTokens: prompt,
    cachedTokens: cached,
  };
}
