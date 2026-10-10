// MCH-47: plan cache. When a task finishes successfully, its accepted plan
// (from accept_plan or prose fallback) is persisted keyed by a normalized task
// signature. On a later similar task, the prior successful plan is surfaced as
// a warm-start hint — same "don't repeat dead ends" mechanism as the autopsy
// warm-start, but for SUCCESSES instead of failures.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface PlanCacheEntry {
  signature: string;
  plan: string;
  taskTitle: string;
  savedAt: number;
}

const MAX_ENTRIES = 50;

function cachePath(projectDir: string): string {
  return join(projectDir, 'plan-cache.json');
}

/**
 * Normalize a task into a comparable signature: lowercase, strip numbers,
 * paths, and stopwords, keep the significant words sorted. Two tasks about
 * "add retry logic to fetchUser" and "add retry to fetchUser()" collide —
 * that's the point.
 */
export function planSignature(title: string, description = ''): string {
  const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'for', 'and', 'or', 'on', 'with', 'it', 'is', 'be', 'this', 'that', 'add', 'make', 'fix']);
  const text = `${title} ${description}`
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  return Array.from(new Set(text)).sort().join(' ');
}

export function loadPlanCache(projectDir: string): PlanCacheEntry[] {
  const p = cachePath(projectDir);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return Array.isArray(parsed) ? (parsed as PlanCacheEntry[]) : [];
  } catch {
    return [];
  }
}

export function savePlanCache(projectDir: string, entries: PlanCacheEntry[]): void {
  const dir = join(projectDir, 'plan-cache.json');
  try {
    mkdirSync(join(dir, '..'), { recursive: true });
  } catch {
    /* best effort */
  }
  writeFileSync(cachePath(projectDir), JSON.stringify(entries.slice(0, MAX_ENTRIES), null, 2));
}

/** Record a successful plan. Same signature → most recent plan wins. */
export function recordPlanSuccess(projectDir: string, title: string, description: string, plan: string): void {
  const trimmed = plan.trim();
  if (!trimmed) return;
  const sig = planSignature(title, description);
  if (!sig) return;
  const entries = loadPlanCache(projectDir).filter((e) => e.signature !== sig);
  entries.unshift({ signature: sig, plan: trimmed, taskTitle: title, savedAt: Date.now() });
  savePlanCache(projectDir, entries);
}

/**
 * Find a prior successful plan for a similar task. Exact signature match
 * first; otherwise highest word-overlap ratio ≥ 0.6.
 */
export function findPriorPlan(projectDir: string, title: string, description = ''): PlanCacheEntry | null {
  const entries = loadPlanCache(projectDir);
  if (entries.length === 0) return null;
  const sig = planSignature(title, description);
  if (!sig) return null;
  const exact = entries.find((e) => e.signature === sig);
  if (exact) return exact;
  const want = new Set(sig.split(' '));
  let best: PlanCacheEntry | null = null;
  let bestOverlap = 0;
  for (const e of entries) {
    const words = e.signature.split(' ').filter(Boolean);
    if (words.length === 0) continue;
    const overlap = words.filter((w) => want.has(w)).length / words.length;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = e;
    }
  }
  return bestOverlap >= 0.6 ? best : null;
}
