import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fastLaneSummary,
  loadFastLaneStats,
  recordFastLaneEntry,
  recordFastLaneEscalation,
  recordFastLaneOutcome,
} from './fastlane-stats.js';

function ws() {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-fl-stats-'));
  return { stateDir: join(dir, 'state') };
}

describe('fast-lane ledger (core/fastlane-stats.ts)', () => {
  it('records entries, reasons and outcomes; never throws on a cold dir', () => {
    const w = ws();
    const empty = loadFastLaneStats(w);
    expect(empty.entries).toEqual({});

    recordFastLaneEntry(w, 'fix');
    recordFastLaneEntry(w, 'fix');
    recordFastLaneEscalation(w, 'edits-exceeded');
    recordFastLaneOutcome(w, 'completed-after-escalation');

    const stats = loadFastLaneStats(w);
    expect(stats.entries.fix).toBe(2);
    expect(stats.escalations['edits-exceeded']).toBe(1);
    expect(stats.outcomes['completed-after-escalation']).toBe(1);
    expect(stats.updatedAt).toBeGreaterThan(0);
  });

  it('derives the false-short rate from measured counts only', () => {
    const w = ws();
    recordFastLaneEntry(w, 'fix');
    recordFastLaneEntry(w, 'test');
    recordFastLaneEntry(w, 'fix');
    recordFastLaneEntry(w, 'fix');
    recordFastLaneEscalation(w, 'reads-exceeded');
    recordFastLaneOutcome(w, 'completed-in-lane');
    recordFastLaneOutcome(w, 'completed-in-lane');
    recordFastLaneOutcome(w, 'failed-in-lane');
    recordFastLaneOutcome(w, 'completed-after-escalation');
    const s = fastLaneSummary(loadFastLaneStats(w));
    expect(s.entries).toBe(4);
    expect(s.escalations).toBe(1);
    expect(s.escalationRate).toBeCloseTo(0.25, 10);
    expect(s.inLaneSuccessRate).toBeCloseTo(2 / 3, 10);
    expect(s.postEscalationSuccessRate).toBe(1);
  });
});
