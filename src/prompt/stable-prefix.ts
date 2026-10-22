// Cache-aware prompt shaping (Wave P5): the stable prefix as an explicit,
// measured artifact.
//
// Provider prompt caches (Anthropic cache_control blocks, OpenAI/DeepSeek
// automatic prefix caching, Gemini implicit caching) bill a byte-stable
// leading prefix at a fraction of fresh-input price — but only when the
// bytes actually repeat. Before this module the "stable tier" was a
// convention in comments; nothing hashed it, nothing detected a break, and
// volatile content (live free-memory figures, probe results that flap
// under load, task-selected rule blocks) silently leaked into it.
//
// This module defines:
//  - the segment model buildSystemPrompt composes from (stable head vs
//    session tail), so a prefix change can be attributed to ONE segment;
//  - sha256 hashing for the head/system (the local proxy metric: a hash
//    change mid-run is a guaranteed provider cache break);
//  - a lint that flags volatile content (timestamps, ids, live counters)
//    inside the stable head — the guard that keeps tomorrow's feature
//    from re-introducing churn.

import { createHash } from 'node:crypto';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** One named slice of the composed system prompt. The stable head is the
 *  leading run of task-independent segments; everything after the first
 *  task/store-dependent segment is the session tail. */
export interface PrefixSegment {
  name: string;
  text: string;
}

/** Segments that form the stable head, in composition order. The head is
 *  what forked children inherit byte-for-byte and what the lint guards. */
export const STABLE_HEAD_SEGMENTS = ['core', 'rulesRoot', 'repo'] as const;

/** All segment names buildSystemPrompt emits, in order. */
export const PROMPT_SEGMENTS = [
  'core', 'rulesRoot', 'repo', 'rulesModular', 'skills', 'contract', 'memory', 'feedback',
] as const;

export type PromptSegmentName = (typeof PROMPT_SEGMENTS)[number];

/** One recorded prefix break: the composed wire prefix (system prompt
 *  bytes, or the history under them) changed mid-run. `cause` is the
 *  first differing segment name for system changes, or a history-rewrite
 *  label ('compaction' | 'tool-output-shrink'). Breaks are EXPECTED for
 *  history rewrites — they are labeled, never hidden. */
export interface PrefixBreak {
  cause: string;
  /** buildPacket count at the time the break was observed. */
  packet: number;
}

export interface PrefixStats {
  /** sha256 of the stable head from the latest packet (null pre-packet). */
  stableHash: string | null;
  /** sha256 of the full system prompt from the latest packet. */
  systemHash: string | null;
  /** Packets built by this engine. */
  packets: number;
  /** Every mid-run prefix break, in order, with its cause. */
  breaks: PrefixBreak[];
  breakCount: number;
}

/** Patterns that must never appear in the stable head: each one is a
 *  value that changes without any content changing (time, identity of
 *  the run, live machine counters), i.e. a guaranteed cache break.
 *  Deliberately tight — legitimate prose (years in instructions, version
 *  numbers) must not false-positive. */
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

/** First segment whose hash differs between two renders (the break
 *  cause), or null when the segment lists are byte-equivalent. */
export function firstChangedSegment(
  prev: ReadonlyArray<{ name: string; hash: string }>,
  next: ReadonlyArray<{ name: string; hash: string }>,
): string | null {
  const n = Math.max(prev.length, next.length);
  for (let i = 0; i < n; i++) {
    if (prev[i]?.hash !== next[i]?.hash) return (next[i] ?? prev[i]).name;
  }
  return null;
}

/** Cache-hit ratio for one run, from provider-reported usage.
 *  Returns null (UNMEASURED) when no call in the run carried a provider
 *  cache figure — a fabricated 0 would read as "cache never hits" and a
 *  fabricated ratio would be worse. Only measured calls enter either
 *  side of the fraction. */
export function cacheHitRatio(calls: ReadonlyArray<{
  promptTokens: number;
  cachedTokens?: number;
}>): { ratio: number | null; measuredCalls: number; promptTokens: number; cachedTokens: number } {
  let prompt = 0;
  let cached = 0;
  let measured = 0;
  for ( const c of calls) {
    if (c.cachedTokens === undefined) continue; // provider reported nothing
    measured++;
    prompt += c.promptTokens;
    cached += c.cachedTokens;
  }
  return {
    ratio: measured > 0 && prompt > 0 ? cached / prompt : null,
    measuredCalls: measured,
    promptTokens: prompt,
    cachedTokens: cached,
  };
}
