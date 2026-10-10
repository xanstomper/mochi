// MCH-48: cross-session read-cache persistence. The per-run read cache dies
// with the agent, so every fresh session re-reads the same hot files from disk.
// This persists the cache (bounded) to .mochi/read-cache.json on agent finish
// and rehydrates (mtime-validated) on agent start — a warm start for file reads.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { ReadCache, ReadCacheEntry } from './tools/types.js';

const MAX_ENTRIES = 200;

function storePath(projectDir: string): string {
  return join(projectDir, 'read-cache.json');
}

/** Persist the current read cache (largest-content first, bounded). Best-effort. */
export function saveReadCache(projectDir: string, cache: ReadCache): void {
  try {
    const entries = Array.from(cache.entries())
      .filter(([, e]) => e.content.length > 0)
      .sort((a, b) => b[1].content.length - a[1].content.length)
      .slice(0, MAX_ENTRIES);
    writeFileSync(storePath(projectDir), JSON.stringify(Object.fromEntries(entries)));
  } catch { /* persistence must never affect the run */ }
}

/**
 * Rehydrate a persisted read cache into a fresh Map, validating each entry
 * against the filesystem (mtime + size must match; stale entries dropped).
 */
export function loadReadCache(projectDir: string): ReadCache {
  const out: ReadCache = new Map();
  const p = storePath(projectDir);
  if (!existsSync(p)) return out;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, ReadCacheEntry>;
    for (const [path, entry] of Object.entries(raw)) {
      if (typeof entry?.mtimeMs !== 'number' || typeof entry?.content !== 'string') continue;
      try {
        const st = statSync(path);
        if (st.mtimeMs === entry.mtimeMs && st.size === entry.size) {
          out.set(path, entry);
        }
      } catch { /* file gone — drop */ }
      if (out.size >= MAX_ENTRIES) break;
    }
  } catch { /* corrupt store — cold start */ }
  return out;
}
