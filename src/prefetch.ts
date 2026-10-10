// MCH-50: predictive prefetch fusion. Combines three independent signals into
// a single ranked prefetch list:
//   1. STRUCTURAL — repo-map PageRank (MCH-49): which files the codebase
//      depends on most.
//   2. TEMPORAL — co-change history (MCH-43): which files change together.
//   3. RUNTIME — read-cache telemetry (MCH-48): which files the model
//      actually reads every session.
// A file hit by two or more signals is a near-certain next read; warming it
// before the model asks saves a full disk round-trip per prediction.
//
// Best-effort everywhere: any signal failure just drops that component.
import { repoMap } from './repo-map.js';
import { predictNextFiles } from './speculative.js';
import { loadReadCache } from './read-cache-store.js';
import { statSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

export interface PrefetchEntry {
  file: string;      // relative path
  score: number;     // fused 0..1
  signals: string[]; // which signals fired: 'structure' | 'cochange' | 'cache'
}

/** Normalize any path form (abs, ./x, x) to a repo-relative slash path. */
function normRel(workspaceDir: string, p: string): string | null {
  try {
    const abs = resolve(workspaceDir, p);
    const rel = relative(workspaceDir, abs);
    if (rel.startsWith('..') || rel === '') return null;
    return rel.split('\\').join('/');
  } catch {
    return null;
  }
}

// MCH-61: prefetch effectiveness ledger. MCH-50's fusion weights are static —
// but signal quality differs per repo (a monorepo's co-change graph may be
// noise while PageRank is gold). Track, per signal, how often a prefetched
// file was ACTUALLY read during the run; persist to .mochi/prefetch-stats.json
// and use hit-rates to reweight the fusion on the next task. Best-effort.

const STATS_FILE = 'prefetch-stats.json';
const DEFAULT_WEIGHTS: Record<string, number> = { structure: 1, cochange: 1, cache: 1 };

interface PrefetchStats {
  // signal -> { predicted, hit } cumulative counts
  [signal: string]: { predicted: number; hit: number };
}

function statsPath(workspaceDir: string): string {
  return join(workspaceDir, '.mochi', STATS_FILE);
}

function loadStats(workspaceDir: string): PrefetchStats {
  try {
    const raw = readFileSync(statsPath(workspaceDir), 'utf8');
    const parsed = JSON.parse(raw) as PrefetchStats;
    return typeof parsed === 'object' && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function saveStats(workspaceDir: string, stats: PrefetchStats): void {
  try {
    writeFileSync(statsPath(workspaceDir), JSON.stringify(stats));
  } catch { /* stats must never break the run */ }
}

/** Record which prefetched files the run actually read. Call once at finish.
 *  files = the prediction list entries; actuallyRead = absolute paths read. */
export function recordPrefetchOutcome(
  workspaceDir: string,
  entries: PrefetchEntry[],
  actuallyReadAbs: Iterable<string>,
): void {
  try {
    const readSet = new Set(Array.from(actuallyReadAbs).map((p) => resolve(p)));
    const stats = loadStats(workspaceDir);
    for (const e of entries) {
      const hit = readSet.has(resolve(workspaceDir, e.file)) ? 1 : 0;
      for (const sig of e.signals) {
        const s = stats[sig] ?? { predicted: 0, hit: 0 };
        s.predicted += 1;
        s.hit += hit;
        stats[sig] = s;
      }
    }
    saveStats(workspaceDir, stats);
  } catch { /* never throw */ }
}

/** Signal weights from observed hit-rates (Laplace-smoothed, clamped 0.4..1.6,
 *  shrunk toward 1 when data is thin: weight = 1 + (rate - 0.3) * min(n/20, 1) * 2). */
export function prefetchSignalWeights(workspaceDir: string): Record<string, number> {
  try {
    const stats = loadStats(workspaceDir);
    const out: Record<string, number> = { ...DEFAULT_WEIGHTS };
    for (const [sig, s] of Object.entries(stats)) {
      if (s.predicted < 5) continue; // too thin to trust
      const rate = s.hit / s.predicted;
      const conf = Math.min(s.predicted / 20, 1);
      out[sig] = Math.max(0.4, Math.min(1.6, 1 + (rate - 0.3) * 2 * conf));
    }
    return out;
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

/**
 * MCH-69: compact prefetch-health badge for the TUI status bar, e.g.
 * "⇉ 62%" — prefetch ledger hit-rate (predicted files actually read).
 * Returns '' when the ledger is too thin (<5 predictions) or missing.
 */
export function prefetchBadge(workspaceDir: string): string {
  try {
    const stats = loadStats(workspaceDir);
    let predicted = 0;
    let hit = 0;
    for (const s of Object.values(stats)) {
      predicted += s.predicted;
      hit += s.hit;
    }
    if (predicted < 5) return '';
    return `⇉ ${Math.round((hit / predicted) * 100)}%`;
  } catch {
    return '';
  }
}

/**
 * Fuse the three signals into a ranked prefetch list.
 * Score = max(signal strengths) + 0.15 per additional signal (fusion bonus),
 * capped at 1. Structural rank is 0..1 by rank value; co-change and cache
 * signals are 0.6 baseline (they're binary "this fired") scaled by count rank.
 */
export function prefetchFiles(
  workspaceDir: string,
  recentlyTouched: string[] = [],
  limit = 8,
): PrefetchEntry[] {
  const scores = new Map<string, { score: number; signals: Set<string> }>();
  const bump = (raw: string, base: number, signal: string): void => {
    const rel = normRel(workspaceDir, raw);
    if (!rel) return;
    const cur = scores.get(rel) ?? { score: 0, signals: new Set<string>() };
    // Keep the strongest signal score, add the signal tag.
    cur.score = Math.max(cur.score, base);
    cur.signals.add(signal);
    scores.set(rel, cur);
  };

  // MCH-61: per-signal weights from the observed hit-rate ledger (defaults 1).
  const weights = prefetchSignalWeights(workspaceDir);
  // 1. Structural: repo-map ranks (already 0..1).
  try {
    for (const e of repoMap(workspaceDir, 20)) bump(e.file, e.rank * (weights.structure ?? 1), 'structure');
  } catch { /* no codegraph */ }

  // 2. Temporal: co-change predictions for recently touched files.
  try {
    const co = predictNextFiles(workspaceDir, recentlyTouched, 10);
    co.forEach((f, i) => bump(f, Math.max(0.3, 0.75 - i * 0.05) * (weights.cochange ?? 1), 'cochange'));
  } catch { /* no git */ }

  // 3. Runtime: files repeatedly read across sessions (cross-session cache).
  try {
    const cache = loadReadCache(workspaceDir);
    // More hits (entries) = more valuable; scale by entry size rank.
    const entries = Array.from(cache.entries()).sort((a, b) => (b[1].content?.length ?? 0) - (a[1].content?.length ?? 0));
    entries.forEach(([f], i) => bump(f, Math.max(0.2, 0.6 - i * 0.04) * (weights.cache ?? 1), 'cache'));
  } catch { /* no cache */ }

  // Fusion bonus: each additional agreeing signal adds 0.15.
  const ranked: PrefetchEntry[] = [];
  for (const [file, v] of Array.from(scores)) {
    const bonus = (v.signals.size - 1) * 0.15;
    ranked.push({ file, score: Math.min(1, v.score + bonus), signals: Array.from(v.signals) });
  }
  ranked.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  // Only files that exist and are currently readable.
  const out: PrefetchEntry[] = [];
  for (const e of ranked) {
    if (out.length >= limit) break;
    try {
      const abs = resolve(workspaceDir, e.file);
      if (!existsSync(abs)) continue;
      const st = statSync(abs);
      if (!st.isFile() || st.size > 1_500_000) continue;
      out.push(e);
    } catch { /* vanished */ }
  }
  return out;
}

/** Compact text block for injection at task start. */
export function prefetchText(workspaceDir: string, recentlyTouched: string[] = []): string {
  const entries = prefetchFiles(workspaceDir, recentlyTouched, 8);
  if (entries.length === 0) return '';
  const lines = entries.map((e) => `- ${e.file}  [${e.signals.join('+')}]`);
  return `PREFETCHED CONTEXT (likely-next files, fused signals: structural PageRank + co-change history + cross-session read telemetry — read these proactively if your task touches them):\n${lines.join('\n')}`;
}

/**
 * MCH-51: physically warm a ReadCache with the predicted files' contents.
 * Entries use the same (mtimeMs, size) validation contract as the read tool,
 * so a warmed entry behaves exactly like a first-hand read: if the file
 * changes, the cache misses and the tool re-reads from disk. Never throws.
 */
export function warmReadCache(
  workspaceDir: string,
  cache: Map<string, { mtimeMs: number; size: number; content: string }>,
  recentlyTouched: string[] = [],
  limit = 8,
): number {
  try {
    let warmed = 0;
    for (const e of prefetchFiles(workspaceDir, recentlyTouched, limit)) {
      try {
        const abs = resolve(workspaceDir, e.file);
        const st = statSync(abs);
        if (!st.isFile() || st.size > 1_500_000) continue;
        if (cache.has(abs)) continue;
        cache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, content: readFileSync(abs, 'utf8') });
        warmed++;
      } catch { /* per-file: skip */ }
    }
    return warmed;
  } catch {
    return 0;
  }
}
