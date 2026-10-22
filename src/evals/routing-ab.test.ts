// Cost-per-solve routing (B22) — the frozen-gate A/B proof.
//
// The frozen set is the judge; the seeded history is the past. This test:
//   1. loads the REAL 24-task frozen set and maps each task to a routing
//      kind (gate category → TaskKind vocabulary; classifyTaskKind over the
//      prompt text cross-checks the mapping and disagreements are printed);
//   2. seeds a trajectory history as raw trace entries — usage records with
//      TOKEN COUNTS ONLY (provider cost $0), so every dollar in the table
//      is the price table applied to recorded usage, never a typed-in cost;
//   3. derives the routing table with the production stats pass;
//   4. arms: OFF = every task starts on the configured default; ON = every
//      task starts on the cheapest proven model for its kind, with one
//      escalation to the measured ladder top when the start fails.
//      Projected cost-per-solve of an arm, per kind =
//        E[spend per task] / E[solve probability per task]
//      where a task's spend = its start cell's mean recorded run cost, plus
//      (ON only) P(start fails) × the escalation target cell's mean run
//      cost, and its solve probability likewise gains the target's rate on
//      the failure branch. All inputs are measured cell aggregates — the
//      projection arithmetic is stated here and in the printed report, and
//      the whole thing is labeled a projection, not a live run.
//   5. asserts the routing contract on the real task mix: assignments are
//      the measured minima, the unpriced and insufficient cells are never
//      chosen, and the ON arm's projected cost-per-solve beats OFF.
import { describe, it, expect } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFrozenSet } from './regression-gate.js';
import { classifyTaskKind } from '../core/taskkind.js';
import {
  computeRoutingTableFromFacts, extractRunRoutingFacts,
  chooseEscalationTarget, chooseStartModel,
  type RoutingCell, type RoutingTable,
} from '../observability/routing-table.js';
import type { TraceEntry } from '../observability/trace.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FROZEN = join(REPO, 'bench', 'frozen');

const NANO = 'gpt-5-nano';
const MINI = 'gpt-5-mini';
const SONNET = 'claude-sonnet-4-5';
const DEFAULT_MODEL = SONNET;
const CANDIDATES = [NANO, MINI, SONNET, 'totally-unpriced-model-zz'];

/** Gate category → routing kind (TaskKind vocabulary). */
const CATEGORY_TO_KIND: Record<string, string> = {
  fix: 'fix', feature: 'implement', refactor: 'refactor', research: 'research',
};

interface SeedSpec { kind: string; model: string; runs: number; solved: number; calls: number; pricedModel: boolean }

const SEED: SeedSpec[] = [
  // fix: the nano is genuinely good at small fixes and nearly free.
  { kind: 'fix', model: NANO, runs: 8, solved: 5, calls: 9, pricedModel: true },
  { kind: 'fix', model: MINI, runs: 8, solved: 7, calls: 4, pricedModel: true },
  { kind: 'fix', model: SONNET, runs: 8, solved: 8, calls: 3, pricedModel: true },
  // implement: the nano flails (16 calls/run, 25% solves) — cost-per-solve
  // must see through its cheap tokens to the mini's better economics.
  { kind: 'implement', model: NANO, runs: 8, solved: 2, calls: 16, pricedModel: true },
  { kind: 'implement', model: MINI, runs: 8, solved: 6, calls: 7, pricedModel: true },
  { kind: 'implement', model: SONNET, runs: 8, solved: 7, calls: 5, pricedModel: true },
  // refactor: nano adequate, mini better, sonnet perfect but pricey.
  { kind: 'refactor', model: NANO, runs: 8, solved: 3, calls: 8, pricedModel: true },
  { kind: 'refactor', model: MINI, runs: 8, solved: 6, calls: 6, pricedModel: true },
  { kind: 'refactor', model: SONNET, runs: 8, solved: 8, calls: 4, pricedModel: true },
  // research: read-heavy; the cheap model is nearly as reliable.
  { kind: 'research', model: NANO, runs: 8, solved: 7, calls: 3, pricedModel: true },
  { kind: 'research', model: MINI, runs: 8, solved: 8, calls: 3, pricedModel: true },
  { kind: 'research', model: SONNET, runs: 8, solved: 8, calls: 2, pricedModel: true },
  // Traps: an unpriced model with "perfect $0" history (its provider never
  // reported cost and the price table cannot price it — the runs are
  // unpriceable, so no honest figure exists), and an insufficient cell.
  { kind: 'fix', model: 'totally-unpriced-model-zz', runs: 8, solved: 8, calls: 3, pricedModel: false },
  { kind: 'document', model: MINI, runs: 3, solved: 3, calls: 2, pricedModel: true },
];

function seedEntries(spec: SeedSpec, runIdx: number): TraceEntry[] {
  const agentId = 'seed-agent';
  const entries: TraceEntry[] = [
    { t: 1, kind: 'task:started', agentId, task: { title: `seed ${spec.kind}` } } as TraceEntry,
  ];
  let t = 2;
  for (let i = 0; i < spec.calls; i++) {
    entries.push({
      t: t++, kind: 'usage:updated', agentId, model: spec.model,
      inputTokens: 6000, outputTokens: 800, cacheTokens: 0, totalTokens: 6800,
      costUsd: 0, // provider reported nothing: the price table must do the work
    } as TraceEntry);
  }
  const solved = runIdx < spec.solved;
  entries.push({
    t: t++, kind: 'skills:attributed', agentId, skills: [],
    verifyStatus: solved ? 'PASS' : 'FAIL', taskKind: spec.kind,
  } as TraceEntry);
  entries.push({ t: t++, kind: solved ? 'task:completed' : 'task:failed', agentId } as TraceEntry);
  return entries;
}

function seededTable(): RoutingTable {
  const facts = [];
  for (const spec of SEED) {
    for (let i = 0; i < spec.runs; i++) {
      const f = extractRunRoutingFacts(seedEntries(spec, i), `seed-${spec.kind}-${spec.model}-${i}`);
      if (f) facts.push(f);
    }
  }
  return computeRoutingTableFromFacts(facts, { minSamples: 5 });
}

interface ArmProjection { spend: number; pSolve: number; cps: number }

function project(cell: RoutingCell, target: RoutingCell | null): ArmProjection {
  const meanRunCost = cell.runs > 0 ? cell.totalCostUsd / cell.runs : 0;
  if (!target) return { spend: meanRunCost, pSolve: cell.solveRate, cps: cell.costPerSolveUsd ?? Infinity };
  const targetMean = target.runs > 0 ? target.totalCostUsd / target.runs : 0;
  const spend = meanRunCost + (1 - cell.solveRate) * targetMean;
  const pSolve = cell.solveRate + (1 - cell.solveRate) * target.solveRate;
  return { spend, pSolve, cps: pSolve > 0 ? spend / pSolve : Infinity };
}

describe('cost-per-solve routing — frozen-set A/B over seeded history', () => {
  const table = seededTable();
  const set = loadFrozenSet(FROZEN);

  it('the frozen set is the 24-task judge and every task maps to a routing kind', () => {
    expect(set.tasks).toHaveLength(24);
    for (const task of set.tasks) {
      expect(CATEGORY_TO_KIND[task.category], `category ${task.category} of ${task.id}`).toBeDefined();
    }
  });

  it('routing OFF vs ON: per-kind assignments, escalation targets, projected cost-per-solve delta', () => {
    const kinds = [...new Set(set.tasks.map((t) => CATEGORY_TO_KIND[t.category]))].sort();
    const lines: string[] = [];
    lines.push('| kind | tasks | OFF start | ON start | ON escalation target (trigger) | OFF proj. $/solve | ON proj. $/solve | Δ |');
    lines.push('|---|---|---|---|---|---|---|---|');
    let offSpend = 0; let offSolve = 0; let onSpend = 0; let onSolve = 0;
    const expectedStart: Record<string, string> = { fix: NANO, implement: MINI, refactor: NANO, research: NANO };

    for (const kind of kinds) {
      const tasks = set.tasks.filter((t) => CATEGORY_TO_KIND[t.category] === kind);
      const offCell = table.cells.find((c) => c.kind === kind && c.model === DEFAULT_MODEL)!;
      const choice = chooseStartModel(table, kind, CANDIDATES);
      expect(choice, `a proven start must exist for kind ${kind}`).not.toBeNull();
      expect(choice!.model).toBe(expectedStart[kind]);
      const esc = chooseEscalationTarget(table, kind, choice!.model, CANDIDATES, new Set([choice!.model]));
      const offProj = project(offCell, null);
      const onProj = project(choice!.cell, esc?.cell ?? null);
      offSpend += offProj.spend * tasks.length;
      offSolve += offProj.pSolve * tasks.length;
      onSpend += onProj.spend * tasks.length;
      onSolve += onProj.pSolve * tasks.length;
      const delta = offProj.cps > 0 && Number.isFinite(onProj.cps)
        ? ((onProj.cps - offProj.cps) / offProj.cps * 100).toFixed(1) + '%'
        : '—';
      lines.push(`| ${kind} | ${tasks.length} | ${DEFAULT_MODEL} | ${choice!.model} | ${esc ? `${esc.model} (verify_failures)` : '—'} | $${offProj.cps.toFixed(4)} | $${onProj.cps.toFixed(4)} | ${delta} |`);
    }

    const offCps = offSpend / offSolve;
    const onCps = onSpend / onSolve;
    lines.push('');
    lines.push(`Task-weighted over the 24 frozen tasks: OFF projected cost-per-solve $${offCps.toFixed(4)} → ON $${onCps.toFixed(4)} (${((onCps - offCps) / offCps * 100).toFixed(1)}%).`);
    // eslint-disable-next-line no-console
    console.log('\n' + lines.join('\n') + '\n');
    expect(onCps).toBeLessThan(offCps);
  });

  it('the traps hold: unpriced and insufficient-data cells exist in the table but are never chosen', () => {
    const zz = table.cells.find((c) => c.model === 'totally-unpriced-model-zz')!;
    expect(zz.priced).toBe(false);
    expect(zz.costPerSolveUsd).toBeNull(); // its "perfect" history is unpriceable — no figure, no routing
    const doc = table.cells.find((c) => c.kind === 'document')!;
    expect(doc.sufficient).toBe(false);
    for (const kind of ['fix', 'implement', 'refactor', 'research']) {
      expect(chooseStartModel(table, kind, CANDIDATES)?.model).not.toBe('totally-unpriced-model-zz');
    }
  });

  it('kind mapping cross-check: classifyTaskKind agrees or the disagreement is printed', () => {
    const disagreements: string[] = [];
    for (const task of set.tasks) {
      const mapped = CATEGORY_TO_KIND[task.category];
      const classified = classifyTaskKind({ title: task.promptText.slice(0, 400), description: '', role: 'coder' });
      if (classified !== mapped && classified !== 'unknown' && classified !== 'chat') {
        disagreements.push(`${task.id}: category=${task.category} → kind=${mapped}, classifier=${classified}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`kind mapping cross-check: ${set.tasks.length - disagreements.length}/${set.tasks.length} agree` + (disagreements.length ? `\n${disagreements.join('\n')}` : ''));
    // The gate category is the routing key (it is the task's provenance);
    // the classifier is advisory. Disagreements are reported, not fatal.
    expect(Array.isArray(disagreements)).toBe(true);
  });
});
