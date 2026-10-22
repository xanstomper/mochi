// Run-scoped read-only result cache (Wave S4 — smarter per token).
//
// The waste this kills: within one run, the model re-issues an identical
// read-only call (outline / search / read / find_callers / …) a few turns
// later and the harness re-executes it and re-injects the FULL result into
// the context — paying the same tokens again for information the model
// already has. The pieces that existed before were all narrower:
//   - ExecutionRegistry dedupes only inside a 1500 ms window (and even then
//     replays the full output — same token cost),
//   - the read tool stubs only an IMMEDIATELY repeated read,
//   - the search tool caches execution but still returns the full result.
//
// This cache is consulted by the loop BEFORE a read-only call executes.
// An entry stays valid only while nothing that could change the result
// has happened: any non-read-only tool completion bumps the mutation
// epoch, and any history rewrite (compaction / digest) bumps the
// generation — a stub must never point at content compaction dropped.
//
// Serving shape: small results (<= VERBATIM_MAX chars) replay verbatim
// (byte-identical semantics, zero re-execution cost); larger results are
// served as a short stub naming where the content lives (earlier in this
// same context). The cache is deliberately conservative — a stale stub
// costs a confused model far more than a re-execution costs tokens.

import { argsKey } from '../core/execution-registry.js';

/** Results at or below this size replay byte-for-byte (no stub). */
export const RESULT_CACHE_VERBATIM_MAX = 600;
/** Results larger than this are never stored (archiving owns them). */
export const RESULT_CACHE_STORE_MAX = 65_536;
const MAX_ENTRIES = 256;

interface Entry {
  output: string;
  epoch: number;
  gen: number;
}

export type ResultCacheLookup =
  | { kind: 'verbatim'; output: string }
  | { kind: 'stub'; text: string; savedChars: number }
  | undefined;

export class RunResultCache {
  private entries = new Map<string, Entry>();
  private epoch = 0;
  private gen = 0;
  readonly stats = { hits: 0, verbatimHits: 0, misses: 0, stores: 0, skippedLarge: 0, savedChars: 0 };

  private key(tool: string, args: Record<string, unknown>): string {
    return `${tool}\u0000${argsKey(args)}`;
  }

  /** Consult before executing a read-only call. */
  lookup(tool: string, args: Record<string, unknown>): ResultCacheLookup {
    const key = this.key(tool, args);
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }
    if (entry.epoch !== this.epoch || entry.gen !== this.gen) {
      // Something that could change the result happened since the store —
      // the entry is a liability, not an asset. Drop it.
      this.entries.delete(key);
      this.stats.misses++;
      return undefined;
    }
    this.stats.hits++;
    if (entry.output.length <= RESULT_CACHE_VERBATIM_MAX) {
      this.stats.verbatimHits++;
      return { kind: 'verbatim', output: entry.output };
    }
    const savedChars = entry.output.length;
    this.stats.savedChars += savedChars;
    return {
      kind: 'stub',
      savedChars,
      text:
        `[result-cache] This exact \`${tool}\` call already completed earlier in this run, and nothing that could change its result has happened since (no edits or other mutations, no compaction). ` +
        `Its full result (${savedChars} chars) is already in the context above — reuse it instead of re-asking. ` +
        `If you genuinely need the bytes again, vary the arguments (a narrower query/path) or re-issue after an edit.`,
    };
  }

  /** Store a successful read-only result for later identical calls. */
  store(tool: string, args: Record<string, unknown>, output: string): void {
    if (output.length > RESULT_CACHE_STORE_MAX) {
      this.stats.skippedLarge++;
      return;
    }
    const key = this.key(tool, args);
    // Refresh insertion order so drop-oldest evicts genuinely old entries.
    this.entries.delete(key);
    this.entries.set(key, { output, epoch: this.epoch, gen: this.gen });
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.stats.stores++;
  }

  /** A non-read-only tool completed: any stored result may be stale. */
  noteMutation(): void {
    this.epoch++;
  }

  /** History was rewritten (compaction / digest): a stub's "already in the
   *  context above" claim may no longer hold, and even verbatim replays
   *  should be re-earned against the new transcript. */
  noteHistoryRewrite(): void {
    this.gen++;
  }

  clear(): void {
    this.entries.clear();
    this.epoch = 0;
    this.gen = 0;
  }

  get size(): number {
    return this.entries.size;
  }
}
