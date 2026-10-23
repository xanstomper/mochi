// Fast-lane measurement store: the classifier's report card.
//
// The fast lane's entry decision is a heuristic, and a heuristic you cannot
// price is a hope. Every lane entry, escalation (with its reason), and run
// outcome is recorded here — `.mochi/state/fastlane.json`, the same
// workspace-state pattern as the flaky registry and the tool-usage ledger —
// so the false-short rate (escalations / entries) is a measured number the
// thresholds in fastlane.ts can be tuned against, not a vibe.
//
// All record* helpers are fail-silent: telemetry must never break a run.

import type { Workspace } from '../workspace.js';
import type { FastLaneEscalationReason } from './fastlane.js';

export const FASTLANE_STATE_PATH = 'state/fastlane.json';

export type FastLaneOutcome =
  | 'completed-in-lane'
  | 'failed-in-lane'
  | 'completed-after-escalation'
  | 'failed-after-escalation';

export interface FastLaneStats {
  version: 1;
  updatedAt: number;
  /** Runs that entered the lane. */
  entries: number;
  entriesByKind: Record<string, number>;
  completedInLane: number;
  failedInLane: number;
  /** Runs that exited the lane mid-run (the false-short count). */
  escalations: number;
  escalationsByReason: Partial<Record<FastLaneEscalationReason, number>>;
  completedAfterEscalation: number;
  failedAfterEscalation: number;
}

function emptyStats(): FastLaneStats {
  return {
    version: 1,
    updatedAt: 0,
    entries: 0,
    entriesByKind: {},
    completedInLane: 0,
    failedInLane: 0,
    escalations: 0,
    escalationsByReason: {},
    completedAfterEscalation: 0,
    failedAfterEscalation: 0,
  };
}

export function loadFastLaneStats(workspace: Workspace): FastLaneStats {
  try {
    const raw = workspace.readJson<FastLaneStats | null>(FASTLANE_STATE_PATH, null);
    if (raw && typeof raw === 'object' && typeof raw.entries === 'number') {
      return { ...emptyStats(), ...raw, version: 1 };
    }
  } catch { /* unreadable → start fresh; recording must not fail */ }
  return emptyStats();
}

export function saveFastLaneStats(workspace: Workspace, stats: FastLaneStats): void {
  try {
    stats.updatedAt = Date.now();
    workspace.writeJson(FASTLANE_STATE_PATH, stats);
  } catch { /* fail-silent */ }
}

export function recordFastLaneEntry(workspace: Workspace, kind: string): void {
  try {
    const stats = loadFastLaneStats(workspace);
    stats.entries += 1;
    stats.entriesByKind[kind] = (stats.entriesByKind[kind] ?? 0) + 1;
    saveFastLaneStats(workspace, stats);
  } catch { /* fail-silent */ }
}

export function recordFastLaneEscalation(workspace: Workspace, reason: FastLaneEscalationReason): void {
  try {
    const stats = loadFastLaneStats(workspace);
    stats.escalations += 1;
    stats.escalationsByReason[reason] = (stats.escalationsByReason[reason] ?? 0) + 1;
    saveFastLaneStats(workspace, stats);
  } catch { /* fail-silent */ }
}

export function recordFastLaneOutcome(workspace: Workspace, outcome: FastLaneOutcome): void {
  try {
    const stats = loadFastLaneStats(workspace);
    switch (outcome) {
      case 'completed-in-lane': stats.completedInLane += 1; break;
      case 'failed-in-lane': stats.failedInLane += 1; break;
      case 'completed-after-escalation': stats.completedAfterEscalation += 1; break;
      case 'failed-after-escalation': stats.failedAfterEscalation += 1; break;
    }
    saveFastLaneStats(workspace, stats);
  } catch { /* fail-silent */ }
}

/**
 * The false-short rate: of the runs the classifier called short, the share
 * the run itself proved were not. null until at least one entry exists —
 * an unmeasured classifier reports null, never 0.
 */
export function falseShortRate(stats: FastLaneStats): number | null {
  if (stats.entries <= 0) return null;
  return stats.escalations / stats.entries;
}
