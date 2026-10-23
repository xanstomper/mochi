// Effort calibration per task kind (Wave S4 — smarter per token).
//
// The waste this kills: the per-kind reasoning tier was a static table
// (fix -> high, implement -> max, …) that never learned. A kind that
// reliably solves at medium kept paying for high on every run forever;
// a kind failing at its static tier never got more depth by default.
//
// This module keeps a small outcome table — (task kind x base tier) ->
// {runs, solved} — persisted at .mochi/state/effort-stats.json, fed at
// run finish from the GATE's verdict (pass = solved; the same evidence
// standard as cost-per-solve, never the model's self-report), and read
// when the loop resolves the auto base tier. The rules are deliberately
// conservative, mirroring the routing wave's data thresholds:
//
//   - LOWER one rung only when the rung BELOW the static tier has
//     >= MIN_SAMPLES runs AND a >= 80% verified solve rate there
//     (proof the kind does not need the higher tier).
//   - RAISE one rung only when the static tier itself has
//     >= MIN_SAMPLES runs AND a < 50% solve rate (proof it is starved).
//   - Never more than one rung from the static default, never outside
//     [low, max], and never applied to a user-pinned tier (the caller
//     only consults this on the 'auto' path).
//
// Kill-switch: MOCHI_EFFORT_CALIBRATION=0.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mochiStateDir } from '../core/mochi-dir.js';

export type EffortTier = 'low' | 'medium' | 'high' | 'max';
export const EFFORT_RUNGS: readonly EffortTier[] = ['low', 'medium', 'high', 'max'];

export const EFFORT_MIN_SAMPLES = 8;
export const EFFORT_LOWER_SOLVE_RATE = 0.8;
export const EFFORT_RAISE_SOLVE_RATE = 0.5;

const MAX_KINDS = 24;
const COUNTER_CAP = 4096;

export interface TierStat {
  runs: number;
  solved: number;
}
export interface EffortStats {
  version: 1;
  kinds: Record<string, { tiers: Partial<Record<EffortTier, TierStat>> }>;
}

export function isEffortTier(v: string): v is EffortTier {
  return (EFFORT_RUNGS as readonly string[]).includes(v);
}

export function effortStatsPath(workspaceDir: string): string {
  // House layout (mirrors skill-kind-stats.json): callers pass either the
  // project root or Workspace.dir (which already IS the .mochi dir) —
  // mochiStateDir normalizes both to the .mochi dir.
  return join(mochiStateDir(workspaceDir), 'state', 'effort-stats.json');
}

function emptyStats(): EffortStats {
  return { version: 1, kinds: {} };
}

function parseStats(raw: string): EffortStats {
  try {
    const parsed = JSON.parse(raw) as Partial<EffortStats>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.kinds !== 'object' || parsed.kinds === null) return emptyStats();
    const out = emptyStats();
    for (const [kind, entry] of Object.entries(parsed.kinds)) {
      const tiers: Partial<Record<EffortTier, TierStat>> = {};
      for (const tier of EFFORT_RUNGS) {
        const s = (entry as { tiers?: Partial<Record<EffortTier, TierStat>> })?.tiers?.[tier];
        if (s && Number.isFinite(s.runs) && Number.isFinite(s.solved)) {
          tiers[tier] = { runs: Math.max(0, Math.floor(s.runs)), solved: Math.max(0, Math.floor(s.solved)) };
        }
      }
      out.kinds[kind] = { tiers };
    }
    return out;
  } catch {
    return emptyStats();
  }
}

const readCache = new Map<string, { mtimeNs: bigint; stats: EffortStats }>();

/** Load the outcome table (mtime-cached; corrupt/missing -> empty).
 *  Cache key uses NANOSECOND mtime (bigint stat): tests and fast writers
 *  rewrite the file within the same millisecond, and an ms-resolution key
 *  served stale stats (calibration silently ignored a fresh seed). ns
 *  precision makes same-ms rewrites a cache miss, not a stale hit. */
export function loadEffortStats(workspaceDir: string): EffortStats {
  const path = effortStatsPath(workspaceDir);
  try {
    if (!existsSync(path)) return emptyStats();
    const mtimeNs = statSync(path, { bigint: true }).mtimeNs;
    const cached = readCache.get(path);
    if (cached && cached.mtimeNs === mtimeNs) return cached.stats;
    const stats = parseStats(readFileSync(path, 'utf8'));
    readCache.set(path, { mtimeNs, stats });
    return stats;
  } catch {
    return emptyStats();
  }
}

/** Record one finished run's outcome. Best-effort: never throws. */
export function recordEffortOutcome(workspaceDir: string, kind: string, tier: string, solved: boolean): void {
  if (!kind || !isEffortTier(tier)) return;
  try {
    const path = effortStatsPath(workspaceDir);
    const stats = existsSync(path) ? parseStats(readFileSync(path, 'utf8')) : emptyStats();
    if (!stats.kinds[kind]) {
      if (Object.keys(stats.kinds).length >= MAX_KINDS) return;
      stats.kinds[kind] = { tiers: {} };
    }
    const entry = (stats.kinds[kind].tiers[tier] ??= { runs: 0, solved: 0 });
    entry.runs += 1;
    if (solved) entry.solved += 1;
    if (entry.runs > COUNTER_CAP) {
      entry.runs = Math.ceil(entry.runs / 2);
      entry.solved = Math.ceil(entry.solved / 2);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(stats, null, 2));
    try {
      readCache.set(path, { mtimeNs: statSync(path, { bigint: true }).mtimeNs, stats });
    } catch { /* cache refresh is best-effort */ }
  } catch { /* calibration data must never affect a run */ }
}

export interface CalibratedTier {
  tier: EffortTier;
  /** Set when the tier moved — the human-readable evidence for the move. */
  reason?: string;
}

/** The calibrated base tier for (kind, staticTier). One rung max, and
 *  only on threshold-clearing evidence (see header). */
export function calibratedBaseTier(workspaceDir: string, kind: string, staticTier: EffortTier): CalibratedTier {
  if (process.env.MOCHI_EFFORT_CALIBRATION === '0') return { tier: staticTier };
  const idx = EFFORT_RUNGS.indexOf(staticTier);
  const tiers = loadEffortStats(workspaceDir).kinds[kind]?.tiers ?? {};

  // Lower: the rung below has PROVEN it solves this kind.
  if (idx > 0) {
    const lower = EFFORT_RUNGS[idx - 1];
    const s = tiers[lower];
    if (s && s.runs >= EFFORT_MIN_SAMPLES && s.solved / s.runs >= EFFORT_LOWER_SOLVE_RATE) {
      return {
        tier: lower,
        reason: `${kind} solves ${s.solved}/${s.runs} at ${lower} (>=${EFFORT_MIN_SAMPLES} runs, >=${EFFORT_LOWER_SOLVE_RATE * 100}% solved)`,
      };
    }
  }
  // Raise: the static tier itself is demonstrably starved.
  const cur = tiers[staticTier];
  if (idx < EFFORT_RUNGS.length - 1 && cur && cur.runs >= EFFORT_MIN_SAMPLES && cur.solved / cur.runs < EFFORT_RAISE_SOLVE_RATE) {
    const higher = EFFORT_RUNGS[idx + 1];
    return {
      tier: higher,
      reason: `${kind} solves only ${cur.solved}/${cur.runs} at ${staticTier} (>=${EFFORT_MIN_SAMPLES} runs, <${EFFORT_RAISE_SOLVE_RATE * 100}% solved)`,
    };
  }
  return { tier: staticTier };
}
