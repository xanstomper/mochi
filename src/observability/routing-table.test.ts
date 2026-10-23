// Cost-per-solve routing table (B22): the stats pass must attribute runs to
// their STARTING model, price them with the same joins the trajectory
// exporter uses, refuse dollar figures whose coverage is incomplete, and
// the policy must never route on insufficient data, an unpriced model, or
// a model this install cannot run. These tests pin those rules with
// hand-built traces — they fail if any of the honesty rules is relaxed.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  computeRoutingTable, computeRoutingTableFromFacts, collectRoutingFacts,
  chooseEscalationTarget, chooseStartModel, escalationBudgetBlock,
  extractRunRoutingFacts, loadRoutingTable, refreshRoutingTable,
  resolveRoutingSettings, type RunRoutingFacts,
} from './routing-table.js';
import type { TraceEntry } from './trace.js';

const AGENT = 'agent-1';

function usage(model: string, costUsd: number, t: number): TraceEntry {
  return {
    t, kind: 'usage:updated', agentId: AGENT, model,
    inputTokens: 1000, outputTokens: 200, cacheTokens: 0, totalTokens: 1200, costUsd,
  } as TraceEntry;
}

function runEntries(opts: {
  kind: string; model: string; costPerCall: number; calls?: number;
  status: 'PASS' | 'FAIL'; escalatedTo?: string; trigger?: string;
}): TraceEntry[] {
  const entries: TraceEntry[] = [
    { t: 1, kind: 'task:started', agentId: AGENT, task: { title: 't' } } as TraceEntry,
  ];
  let t = 2;
  const calls = opts.calls ?? 3;
  for (let i = 0; i < calls; i++) entries.push(usage(opts.model, opts.costPerCall, t++));
  if (opts.escalatedTo) {
    entries.push({
      t: t++, kind: 'routing:escalated', agentId: AGENT, taskKind: opts.kind,
      fromModel: opts.model, toModel: opts.escalatedTo, trigger: opts.trigger ?? 'verify_failures',
    } as TraceEntry);
    for (let i = 0; i < 2; i++) entries.push(usage(opts.escalatedTo, opts.costPerCall * 3, t++));
  }
  entries.push({
    t: t++, kind: 'skills:attributed', agentId: AGENT, skills: [],
    verifyStatus: opts.status, taskKind: opts.kind,
  } as TraceEntry);
  entries.push({ t: t++, kind: opts.status === 'PASS' ? 'task:completed' : 'task:failed', agentId: AGENT } as TraceEntry);
  return entries;
}

function fact(partial: Partial<RunRoutingFacts> & { kind: string; startModel: string }): RunRoutingFacts {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 9)}`,
    verified: false, costUsd: 0.3, reportedCostUsd: 0.3, estimatedCostUsd: 0,
    modelsUsed: [partial.startModel], routingEscalations: 0, triggers: {},
    ...partial,
  };
}

describe('extractRunRoutingFacts', () => {
  it('attributes a run to its starting model and counts routing escalations with triggers', () => {
    const f = extractRunRoutingFacts(
      runEntries({ kind: 'fix', model: 'gpt-5-mini', costPerCall: 0.01, status: 'PASS', escalatedTo: 'claude-sonnet-4-5', trigger: 'same_failure' }),
      'r1',
    );
    expect(f).not.toBeNull();
    expect(f!.kind).toBe('fix');
    expect(f!.startModel).toBe('gpt-5-mini');
    expect(f!.modelsUsed).toEqual(['gpt-5-mini', 'claude-sonnet-4-5']);
    expect(f!.verified).toBe(true);
    expect(f!.routingEscalations).toBe(1);
    expect(f!.triggers).toEqual({ same_failure: 1 });
    // Total run cost INCLUDES the post-escalation calls: 3*0.01 + 2*0.03.
    expect(f!.costUsd).toBeCloseTo(0.09, 10);
  });

  it('returns null for a trace with no usage records', () => {
    const entries = [
      { t: 1, kind: 'task:started', agentId: AGENT, task: { title: 'x' } } as TraceEntry,
      { t: 2, kind: 'skills:attributed', agentId: AGENT, skills: [], verifyStatus: 'PASS', taskKind: 'fix' } as TraceEntry,
    ];
    expect(extractRunRoutingFacts(entries, 'r0')).toBeNull();
  });

  it('marks FAIL runs unverified but still prices them (failures burn money)', () => {
    const f = extractRunRoutingFacts(runEntries({ kind: 'fix', model: 'gpt-5-mini', costPerCall: 0.02, status: 'FAIL' }), 'r2');
    expect(f!.verified).toBe(false);
    expect(f!.costUsd).toBeCloseTo(0.06, 10);
  });
});

describe('computeRoutingTableFromFacts', () => {
  it('cost-per-solve = total recorded cost of ALL runs in the cell / solved runs', () => {
    const facts: RunRoutingFacts[] = [];
    for (let i = 0; i < 4; i++) facts.push(fact({ kind: 'fix', startModel: 'gpt-5-mini', verified: true, costUsd: 0.10, reportedCostUsd: 0.10 }));
    for (let i = 0; i < 4; i++) facts.push(fact({ kind: 'fix', startModel: 'gpt-5-mini', verified: false, costUsd: 0.20, reportedCostUsd: 0.20 }));
    const table = computeRoutingTableFromFacts(facts, { minSamples: 5 });
    const cell = table.cells.find((c) => c.kind === 'fix')!;
    expect(cell.runs).toBe(8);
    expect(cell.solvedRuns).toBe(4);
    expect(cell.totalCostUsd).toBeCloseTo(4 * 0.10 + 4 * 0.20, 10);
    expect(cell.costPerSolveUsd).toBeCloseTo((4 * 0.10 + 4 * 0.20) / 4, 10);
    expect(cell.solveRate).toBeCloseTo(0.5, 10);
    expect(cell.sufficient).toBe(true);
  });

  it('marks cells below the sample threshold INSUFFICIENT-DATA (sufficient=false)', () => {
    const facts = Array.from({ length: 4 }, () => fact({ kind: 'fix', startModel: 'gpt-5-mini', verified: true }));
    const table = computeRoutingTableFromFacts(facts, { minSamples: 5 });
    expect(table.cells[0].sufficient).toBe(false);
    expect(table.cells[0].costPerSolveUsd).not.toBeNull(); // measured, just not actionable
  });

  it('refuses the dollar figure when a SOLVED run has incomplete cost coverage', () => {
    const facts: RunRoutingFacts[] = [
      ...Array.from({ length: 5 }, () => fact({ kind: 'fix', startModel: 'gpt-5-mini', verified: true, costUsd: 0.1 })),
      fact({ kind: 'fix', startModel: 'gpt-5-mini', verified: true, costUsd: null, reportedCostUsd: 0, estimatedCostUsd: 0 }),
    ];
    const table = computeRoutingTableFromFacts(facts, { minSamples: 5 });
    const cell = table.cells[0];
    expect(cell.solvedRuns).toBe(6);
    expect(cell.costPerSolveUsd).toBeNull();
    expect(cell.costIncomplete).toBe(true);
  });

  it('a cell with runs but zero solves has no cost-per-solve and cannot be proven', () => {
    const facts = Array.from({ length: 6 }, () => fact({ kind: 'fix', startModel: 'gpt-5-nano', verified: false, costUsd: 0.05 }));
    const table = computeRoutingTableFromFacts(facts, { minSamples: 5 });
    expect(table.cells[0].costPerSolveUsd).toBeNull();
    expect(table.cells[0].solveRate).toBe(0);
  });
});

describe('policy: chooseStartModel', () => {
  function tableWith(kindModels: Array<{ model: string; runs: number; solved: number; cost: number }>) {
    const facts: RunRoutingFacts[] = [];
    for (const km of kindModels) {
      for (let i = 0; i < km.runs; i++) {
        facts.push(fact({
          kind: 'fix', startModel: km.model,
          verified: i < km.solved, costUsd: km.cost / km.runs,
          reportedCostUsd: km.cost / km.runs,
        }));
      }
    }
    return computeRoutingTableFromFacts(facts, { minSamples: 5 });
  }

  it('picks the cheapest PROVEN model for the kind', () => {
    const table = tableWith([
      { model: 'claude-sonnet-4-5', runs: 8, solved: 8, cost: 7.20 },  // CPS 0.90
      { model: 'gpt-5-mini', runs: 8, solved: 6, cost: 0.72 },         // CPS 0.12
    ]);
    const choice = chooseStartModel(table, 'fix', ['claude-sonnet-4-5', 'gpt-5-mini']);
    expect(choice?.model).toBe('gpt-5-mini');
    expect(choice?.cell.costPerSolveUsd).toBeCloseTo(0.12, 10);
  });

  it('never routes on an insufficient-data cell, even a cheaper one', () => {
    const table = tableWith([
      { model: 'claude-sonnet-4-5', runs: 8, solved: 8, cost: 7.20 },
      { model: 'gpt-5-nano', runs: 3, solved: 3, cost: 0.03 },          // CPS 0.01 but n=3
    ]);
    const choice = chooseStartModel(table, 'fix', ['claude-sonnet-4-5', 'gpt-5-nano']);
    expect(choice?.model).toBe('claude-sonnet-4-5');
  });

  it('returns null when no candidate has a proven cell (cold start keeps the default)', () => {
    const table = tableWith([{ model: 'gpt-5-mini', runs: 8, solved: 6, cost: 0.72 }]);
    expect(chooseStartModel(table, 'fix', ['claude-sonnet-4-5'])).toBeNull(); // mini not installed here
    expect(chooseStartModel(table, 'refactor', ['gpt-5-mini'])).toBeNull();   // no refactor data at all
  });

  it('never picks an unpriced model, however good its recorded numbers look', () => {
    const table = tableWith([
      { model: 'totally-unpriced-model-zz', runs: 8, solved: 8, cost: 0.08 }, // CPS 0.01, but no price entry
      { model: 'gpt-5-mini', runs: 8, solved: 6, cost: 0.72 },
    ]);
    const unpriced = table.cells.find((c) => c.model === 'totally-unpriced-model-zz')!;
    expect(unpriced.priced).toBe(false);
    const choice = chooseStartModel(table, 'fix', ['totally-unpriced-model-zz', 'gpt-5-mini']);
    expect(choice?.model).toBe('gpt-5-mini');
  });
});

describe('policy: chooseEscalationTarget', () => {
  function tableWith(kindModels: Array<{ model: string; runs: number; solved: number; cost: number }>) {
    const facts: RunRoutingFacts[] = [];
    for (const km of kindModels) {
      for (let i = 0; i < km.runs; i++) {
        facts.push(fact({
          kind: 'fix', startModel: km.model,
          verified: i < km.solved, costUsd: km.cost / km.runs,
          reportedCostUsd: km.cost / km.runs,
        }));
      }
    }
    return computeRoutingTableFromFacts(facts, { minSamples: 5 });
  }
  const CANDS = ['gpt-5-mini', 'claude-sonnet-4-5', 'gpt-5'];

  it('escalates from a weak proven cell to the strongest proven model', () => {
    const table = tableWith([
      { model: 'gpt-5-mini', runs: 8, solved: 4, cost: 0.48 },       // rate .5
      { model: 'claude-sonnet-4-5', runs: 8, solved: 8, cost: 7.20 }, // rate 1.0
      { model: 'gpt-5', runs: 8, solved: 6, cost: 2.40 },              // rate .75
    ]);
    const target = chooseEscalationTarget(table, 'fix', 'gpt-5-mini', CANDS, new Set(['gpt-5-mini']));
    expect(target?.model).toBe('claude-sonnet-4-5');
  });

  it('requires STRICTLY better evidence than the incumbent: equal rate at higher cost is not a target', () => {
    const table = tableWith([
      { model: 'gpt-5', runs: 8, solved: 6, cost: 1.20 },              // rate .75, CPS 0.20
      { model: 'claude-sonnet-4-5', runs: 8, solved: 6, cost: 5.40 },  // rate .75, CPS 0.90
    ]);
    expect(chooseEscalationTarget(table, 'fix', 'gpt-5', CANDS, new Set(['gpt-5']))).toBeNull();
  });

  it('equal solve rate at LOWER cost-per-solve is a legitimate target (cheaper and just as reliable)', () => {
    const table = tableWith([
      { model: 'claude-sonnet-4-5', runs: 8, solved: 6, cost: 5.40 },
      { model: 'gpt-5', runs: 8, solved: 6, cost: 1.20 },
    ]);
    const target = chooseEscalationTarget(table, 'fix', 'claude-sonnet-4-5', CANDS, new Set(['claude-sonnet-4-5']));
    expect(target?.model).toBe('gpt-5');
  });

  it('an unproven incumbent can be escalated away from: its failures are the evidence', () => {
    const table = tableWith([
      { model: 'claude-sonnet-4-5', runs: 8, solved: 8, cost: 7.20 },
    ]);
    const target = chooseEscalationTarget(table, 'fix', 'gpt-5-nano', CANDS, new Set(['gpt-5-nano']));
    expect(target?.model).toBe('claude-sonnet-4-5');
  });

  it('never re-offers a model already attempted this run', () => {
    const table = tableWith([
      { model: 'gpt-5-mini', runs: 8, solved: 4, cost: 0.48 },
      { model: 'claude-sonnet-4-5', runs: 8, solved: 8, cost: 7.20 },
    ]);
    const attempted = new Set(['gpt-5-mini', 'claude-sonnet-4-5']);
    expect(chooseEscalationTarget(table, 'fix', 'gpt-5-mini', CANDS, attempted)).toBeNull();
  });

  it('never targets an unpriced or insufficient-data model', () => {
    const table = tableWith([
      { model: 'gpt-5-mini', runs: 8, solved: 4, cost: 0.48 },
      { model: 'totally-unpriced-model-zz', runs: 8, solved: 8, cost: 0.80 },
      { model: 'gpt-5', runs: 2, solved: 2, cost: 0.10 }, // insufficient
    ]);
    expect(chooseEscalationTarget(table, 'fix', 'gpt-5-mini', [...CANDS, 'totally-unpriced-model-zz'], new Set(['gpt-5-mini']))).toBeNull();
  });
});

describe('escalationBudgetBlock', () => {
  it('no budget engine = no opinion', () => {
    expect(escalationBudgetBlock(undefined)).toBeNull();
  });
  it('blocks when the model-call cap is hit', () => {
    expect(escalationBudgetBlock({ canMakeModelCall: () => false, remainingCostUsd: () => 5 })).toMatch(/budget/);
  });
  it('blocks when the cost cap is reached', () => {
    expect(escalationBudgetBlock({ canMakeModelCall: () => true, remainingCostUsd: () => 0 })).toMatch(/budget/);
  });
  it('allows a healthy budget', () => {
    expect(escalationBudgetBlock({ canMakeModelCall: () => true, remainingCostUsd: () => 5 })).toBeNull();
  });
});

describe('stats pass over a traces directory (storage round-trip)', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('derives, persists, and reloads the table; traces without usage are skipped and counted', () => {
    dir = mkdtempSync(resolve(tmpdir(), 'mochi-routing-'));
    const traces = resolve(dir, 'traces');
    mkdirSync(traces, { recursive: true });
    for (let i = 0; i < 6; i++) {
      const entries = runEntries({ kind: 'fix', model: 'gpt-5-mini', costPerCall: 0.01, status: i < 5 ? 'PASS' : 'FAIL' });
      writeFileSync(resolve(traces, `run-${i}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
    writeFileSync(resolve(traces, 'no-usage.jsonl'), JSON.stringify({ t: 1, kind: 'task:started', agentId: AGENT, task: { title: 'x' } }) + '\n');

    const { facts, skipped } = collectRoutingFacts(dir);
    expect(facts).toHaveLength(6);
    expect(skipped).toBe(1);

    const table = refreshRoutingTable(dir, { minSamples: 5, now: 1234 });
    expect(table.derivedAt).toBe(1234);
    expect(table.runsConsidered).toBe(6);
    expect(table.runsSkipped).toBe(1);
    const cell = table.cells.find((c) => c.kind === 'fix' && c.model === 'gpt-5-mini')!;
    expect(cell.solvedRuns).toBe(5);
    expect(cell.costPerSolveUsd).toBeCloseTo((6 * 3 * 0.01) / 5, 10);

    const loaded = loadRoutingTable(dir);
    expect(loaded?.cells).toHaveLength(1);
    expect(computeRoutingTable(dir, { minSamples: 5 }).cells).toHaveLength(1);
  });

  it('loadRoutingTable returns null on a fresh workspace (cold start)', () => {
    dir = mkdtempSync(resolve(tmpdir(), 'mochi-routing-'));
    expect(loadRoutingTable(dir)).toBeNull();
  });
});

describe('resolveRoutingSettings', () => {
  it('defaults on; MOCHI_ROUTING=0 and config enabled:false both kill it', () => {
    expect(resolveRoutingSettings(undefined, {} as NodeJS.ProcessEnv).enabled).toBe(true);
    expect(resolveRoutingSettings(undefined, { MOCHI_ROUTING: '0' } as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(resolveRoutingSettings({ enabled: false }, {} as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(resolveRoutingSettings({ minSamples: 9 }, {} as NodeJS.ProcessEnv).minSamples).toBe(9);
    expect(resolveRoutingSettings(undefined, {} as NodeJS.ProcessEnv).minSamples).toBe(5);
  });
});
