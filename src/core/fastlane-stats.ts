// Fast-lane outcome ledger.
//
// The lane (core/fastlane.ts) is only defensible if its bets are measured.
// Every entry, every escalation (with the reason), and every run outcome is
// appended here; `mochi health` / the weekly audit can then answer the two
// questions that matter:
//
//   - how often did the classifier enter the lane?            (entries)
//   - of those, how many needed escalation or failed?         (outcomes)
//
// The store is a single small JSON file under `<workspace>/state/`, written
// atomically and NEVER allowed to throw: bookkeeping must not be able to
// fail a run.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from './atomic-fs.js';
import type { Workspace } from '../workspace.js';

export type FastLaneOutcome =
  | 'completed-in-lane'
  | 'failed-in-lane'
  | 'completed-after-escalation'
  | 'failed-after-escalation';

export interface FastLaneStats {
  version: 1;
  updatedAt: number;
  /** Lane entries by task kind. */
  entries: Record<string, number>;
  /** Escalations by reason (core/fastlane.ts FastLaneEscalationReason). */
  escalations: Record<string, number>;
  /** Final run outcome for every lane run. */
  outcomes: Record<string, number>;
}

const EMPTY: FastLaneStats = { version: 1, updatedAt: 0, entries: {}, escalations: {}, outcomes: {} };

export function fastLaneStatsPath(workspace: Pick<Workspace, 'stateDir'>): string {
  return join(workspace.stateDir, 'fastlane.json');
}

export function loadFastLaneStats(workspace: Pick<Workspace, 'stateDir'>): FastLaneStats {
  const p = fastLaneStatsPath(workspace);
  if (!existsSync(p)) return { ...EMPTY, entries: {}, escalations: {}, outcomes: {} };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<FastLaneStats>;
    return {
      version: 1,
      updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
      entries: { ...(raw.entries ?? {}) },
      escalations: { ...(raw.escalations ?? {}) },
      outcomes: { ...(raw.outcomes ?? {}) },
    };
  } catch {
    return { ...EMPTY, entries: {}, escalations: {}, outcomes: {} };
  }
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function save(workspace: Pick<Workspace, 'stateDir'>, stats: FastLaneStats): void {
  try {
    stats.updatedAt = Date.now();
    atomicWriteFileSync(fastLaneStatsPath(workspace), JSON.stringify(stats, null, 2));
  } catch {
    /* measurement must never break a run */
  }
}

/** Record a lane entry for `kind`. */
export function recordFastLaneEntry(workspace: Pick<Workspace, 'stateDir'>, kind: string): void {
  try {
    const stats = loadFastLaneStats(workspace);
    bump(stats.entries, kind || 'unknown');
    save(workspace, stats);
  } catch {
    /* best-effort */
  }
}

/** Record an escalation, attributed to the predicate's reason. */
export function recordFastLaneEscalation(workspace: Pick<Workspace, 'stateDir'>, reason: string): void {
  try {
    const stats = loadFastLaneStats(workspace);
    bump(stats.escalations, reason || 'unknown');
    save(workspace, stats);
  } catch {
    /* best-effort */
  }
}

/** Record the run's final outcome (called once per lane run, at finish). */
export function recordFastLaneOutcome(workspace: Pick<Workspace, 'stateDir'>, outcome: FastLaneOutcome): void {
  try {
    const stats = loadFastLaneStats(workspace);
    bump(stats.outcomes, outcome);
    save(workspace, stats);
  } catch {
    /* best-effort */
  }
}

/** Derived rates for reports: entry/escalation counts and outcome shares. */
export function fastLaneSummary(stats: FastLaneStats): {
  entries: number;
  escalations: number;
  escalationRate: number | null;
  outcomes: number;
  inLaneSuccessRate: number | null;
  postEscalationSuccessRate: number | null;
} {
  const entries = Object.values(stats.entries).reduce((a, b) => a + b, 0);
  const escalations = Object.values(stats.escalations).reduce((a, b) => a + b, 0);
  const o = stats.outcomes;
  const inLane = (o['completed-in-lane'] ?? 0) + (o['failed-in-lane'] ?? 0);
  const escalated = (o['completed-after-escalation'] ?? 0) + (o['failed-after-escalation'] ?? 0);
  return {
    entries,
    escalations,
    escalationRate: entries > 0 ? escalations / entries : null,
    outcomes: inLane + escalated,
    inLaneSuccessRate: inLane > 0 ? (o['completed-in-lane'] ?? 0) / inLane : null,
    postEscalationSuccessRate: escalated > 0 ? (o['completed-after-escalation'] ?? 0) / escalated : null,
  };
}
