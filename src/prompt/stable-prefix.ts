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

// ── Volatile-field lint ───────────────────────────────────────────────────
// The stable head must not carry fields that move per run/machine — a single
// drifting byte in the head reprices every subsequent turn (the whole point
// of the stable tier). lintStablePrefix flags the known volatile field
// classes in composed head text so the prefix-cache test (and humans) can
// catch a leak the moment it lands.

const VOLATILE_FIELD_PATTERNS: Array<{ re: RegExp; message: string }> = [
  {
    message: 'ISO-8601 datetime — renders differently every run; belongs in the volatile tier',
    re: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/g,
  },
  {
    message: 'UUID — per-run/session identifier; belongs in the volatile tier',
    re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
  },
  {
    message: 'live free-memory figure — drifts between runs; the stable tier renders the static total only',
    re: /\b\d+(?:\.\d+)?\s*[GM]i?B\s+free\b/g,
  },
];

/**
 * Flag volatile fields (timestamps, UUIDs, live memory figures) present in
 * composed STABLE-tier text. One human-readable finding per offending match
 * (empty array when the head is clean). Pure; the prefix-cache test pins the
 * real rendered head against this lint.
 */
export function lintStablePrefix(text: string): string[] {
  const findings: string[] = [];
  for (const { message, re } of VOLATILE_FIELD_PATTERNS) {
    for (const m of text.matchAll(re)) {
      findings.push(`${message} (matched: ${m[0]})`);
    }
  }
  return findings;
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

// ─── Volatile-field lint ─────────────────────────────────────────────────

const VOLATILE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, label: 'ISO-8601 datetime' },
  { re: /\b\d{4}-\d{2}-\d{2}\b/, label: 'calendar date (YYYY-MM-DD)' },
  { re: /\b\d{2}:\d{2}:\d{2}\b/, label: 'wall-clock time (HH:MM:SS)' },
  { re: /\b\d{13}\b/, label: 'epoch milliseconds' },
  { re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, label: 'UUID' },
  { re: /\b\d+(?:\.\d+)?\s*GB free\b/i, label: 'live free-memory figure' },
  { re: /\bfree \/ [\d.]+ GB total\b/i, label: 'live free/total memory figure' },
];

/** Lint a stable-head candidate: returns one finding per volatile pattern
 *  present (empty = clean). Used by tests to prove the real head is clean
 *  and to prove the lint itself has teeth on injected volatility. */
export function lintStablePrefix(text: string): string[] {
  const findings: string[] = [];
  for (const { re, label } of VOLATILE_PATTERNS) {
    const m = text.match(re);
    if (m) findings.push(`${label}: "${m[0]}"`);
  }
  return findings;
}
