import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_ROUTING_MIN_SAMPLES,
  MAX_ROUTING_ESCALATIONS_PER_RUN,
  chooseEscalationTarget,
  chooseStartModel,
  deriveRoutingTable,
  escalationBudgetBlock,
  loadRoutingTable,
  resolveRoutingSettings,
  routingTablePath,
  type RoutingTable,
} from './routing-table.js';

function table(cells: RoutingTable['cells'], minSamples = 1): RoutingTable {
  return { version: 1, derivedAt: Date.now(), minSamples, cells };
}

describe('measured routing (observability/routing-table.ts)', () => {
  beforeEach(() => {
    delete process.env.MOCHI_ROUTING;
    delete process.env.MOCHI_ROUTING_MIN_SAMPLES;
  });

  it('resolves settings with env kill switch and default min samples', () => {
    expect(resolveRoutingSettings()).toEqual({ enabled: true, minSamples: DEFAULT_ROUTING_MIN_SAMPLES });
    expect(resolveRoutingSettings({ enabled: false }).enabled).toBe(false);
    expect(resolveRoutingSettings({ minSamples: 9 }).minSamples).toBe(9);
    process.env.MOCHI_ROUTING = '0';
    expect(resolveRoutingSettings().enabled).toBe(false);
  });

  it('chooses the cheapest expected cost per SOLVE among sufficient cells', () => {
    const t = table([
      { taskKind: 'fix', model: 'strong', runs: 10, solved: 9, solveRate: 0.9, totalCostUsd: 9, costPerSolveUsd: 1.0, sufficient: true },
      { taskKind: 'fix', model: 'cheap', runs: 10, solved: 8, solveRate: 0.8, totalCostUsd: 1.6, costPerSolveUsd: 0.2, sufficient: true },
      { taskKind: 'fix', model: 'weak', runs: 10, solved: 1, solveRate: 0.1, totalCostUsd: 0.1, costPerSolveUsd: 0.1, sufficient: true },
      { taskKind: 'fix', model: 'unproven', runs: 2, solved: 2, solveRate: 1, totalCostUsd: 0, costPerSolveUsd: 0, sufficient: false },
    ]);
    expect(chooseStartModel(t, 'fix', [])?.model).toBe('cheap');
    expect(chooseStartModel(t, 'fix', ['strong'])?.model).toBe('strong');
    expect(chooseStartModel(t, 'implement', [])).toBeNull();
  });

  it('escalates only to a measurably better, unattempted model in the pool', () => {
    const t = table([
      { taskKind: 'fix', model: 'weak', runs: 10, solved: 4, solveRate: 0.4, totalCostUsd: 0.8, costPerSolveUsd: 0.2, sufficient: true },
      { taskKind: 'fix', model: 'strong', runs: 10, solved: 9, solveRate: 0.9, totalCostUsd: 9, costPerSolveUsd: 1, sufficient: true },
      { taskKind: 'fix', model: 'other', runs: 10, solved: 7, solveRate: 0.7, totalCostUsd: 3, costPerSolveUsd: 0.43, sufficient: true },
    ]);
    expect(chooseEscalationTarget(t, 'fix', 'weak', ['weak', 'strong'], new Set(['weak']))?.model).toBe('strong');
    // Already attempted → no repeat.
    expect(chooseEscalationTarget(t, 'fix', 'weak', [], new Set(['weak', 'strong', 'other']))).toBeNull();
    // Out of the candidate pool → unreachable.
    expect(chooseEscalationTarget(t, 'fix', 'weak', ['weak'], new Set(['weak']))).toBeNull();
  });

  it('blocks escalation when the budget cannot pay for it', () => {
    expect(escalationBudgetBlock(undefined)).toBeNull();
    expect(escalationBudgetBlock({ phase: () => 'full', ratio: () => 0.1, remainingCostUsd: () => 5 })).toBeNull();
    expect(escalationBudgetBlock({ phase: () => 'exhausted', ratio: () => 1, remainingCostUsd: () => 0 })).toContain('exhausted');
    expect(escalationBudgetBlock({ phase: () => 'full', ratio: () => 0.9, remainingCostUsd: () => 5 })).toContain('90%');
    expect(escalationBudgetBlock({ phase: () => 'cheap', ratio: () => 0.2, remainingCostUsd: () => 5 })).toContain('cheap');
  });

  it('derives cells from exported trajectories + per-run trace model attribution', () => {
    const ws = mkdtempSync(join(tmpdir(), 'mochi-routing-'));
    mkdirSync(join(ws, 'exports'), { recursive: true });
    mkdirSync(join(ws, 'traces'), { recursive: true });
    const record = {
      schemaVersion: 1,
      runId: 'run-1',
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      task: { title: 'fix a bug' },
      steps: [],
      skills: [],
      taskKind: 'fix',
      verification: { status: 'PASS', verdict: 'pass' },
      outcome: { completed: true },
      usage: { totalTokens: 100, costUsd: 0.5 },
      failureTaxonomy: [],
    };
    writeFileSync(join(ws, 'exports', 'trajectory-run-1.jsonl'), JSON.stringify(record) + '\n');
    writeFileSync(join(ws, 'traces', 'run-1.jsonl'),
      JSON.stringify({ t: 1, kind: 'usage:updated', model: 'model-a' }) + '\n');

    const t = deriveRoutingTable(ws, { minSamples: 1 });
    expect(t.cells).toHaveLength(1);
    const cell = t.cells[0]!;
    expect(cell).toMatchObject({ taskKind: 'fix', model: 'model-a', runs: 1, solved: 1, solveRate: 1, costPerSolveUsd: 0.5, sufficient: true });
    // Persisted and reloadable.
    expect(loadRoutingTable(ws)?.cells[0]?.model).toBe('model-a');
    expect(routingTablePath(ws)).toContain(join('state', 'routing-table.json'));
  });

  it('cold start is null, not a fabricated table', () => {
    const ws = mkdtempSync(join(tmpdir(), 'mochi-routing-cold-'));
    expect(loadRoutingTable(ws)).toBeNull();
    expect(deriveRoutingTable(ws, { write: false }).cells).toEqual([]);
  });

  it('caps escalations per run', () => {
    expect(MAX_ROUTING_ESCALATIONS_PER_RUN).toBe(2);
  });
});
