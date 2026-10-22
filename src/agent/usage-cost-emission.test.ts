// FIX 1 regression (Wave G): the loop's `usage:updated` event must carry the
// PER-CALL cost delta, not the budget's cumulative total.
//
// Pre-fix, the event emitted `costUsd: costAfter` (the cumulative effective
// cost), while every trace consumer — gate scanRunTraces, trace-cost's
// costFromTraceEntries, trajectory's aggregateUsage — SUMS the per-call
// values to reconstruct the run total. A 3-call run at $0.10/call therefore
// summed 0.10 + 0.20 + 0.30 = $0.60 against a true spend of $0.30. These
// tests drive a real Agent against a fake OpenAI wire and assert the
// invariant end to end: sum(emitted costUsd) == budget effective total ==
// run-result cost == trace-derived total. They fail on the pre-fix emission.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from './loop.js';
import { BudgetEngine } from '../budget.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { costFromTraceEntries } from '../observability/trace-cost.js';
import { startFakeOpenAI, type FakeOpenAI, type FakeScriptResponse } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

interface UsageEvent {
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  totalTokens: number;
  costUsd?: number;
  model?: string;
}

const READ_A: FakeScriptResponse = {
  toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"a.txt"}' } }],
  finishReason: 'tool_calls',
};
const READ_B: FakeScriptResponse = {
  toolCalls: [{ id: 'call_2', type: 'function', function: { name: 'read', arguments: '{"path":"b.txt"}' } }],
  finishReason: 'tool_calls',
};
const DONE: FakeScriptResponse = { content: 'Done. Both files read; the answer is 42.', finishReason: 'stop' };

async function runScripted(fake: FakeOpenAI, model: string) {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-costfix-'));
  writeFileSync(resolve(dir, 'a.txt'), 'alpha\n');
  writeFileSync(resolve(dir, 'b.txt'), 'beta\n');
  const safety = {
    mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10,
    maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 8000,
  };
  const config = {
    model: { provider: 'openai', baseUrl: fake.url, model },
    safety,
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
    telemetry: false, projectDir: dir, quiet: true,
  } as unknown as MochiConfig;
  const budget = new BudgetEngine(safety as never);
  budget.start();
  const workspace = new Workspace(dir, '.mochi');
  workspace.ensure();
  const context = new ContextEngine(config, dir);
  context.setGoal('read the files and answer');
  const events = new EventBus();
  const usageEvents: UsageEvent[] = [];
  events.on('usage:updated', (e) => usageEvents.push(e as unknown as UsageEvent));
  const agent = new Agent({ id: 'costfix-agent', role: 'coder', config, workspace, events, cwd: dir, context, budget });
  const result = await agent.run({
    id: 't1', title: 'Read and answer', description: 'Read a.txt and b.txt, then give the result.',
    role: 'coder', status: 'pending', priority: 1, dependencies: [], acceptanceCriteria: [],
    attempts: [], createdAt: 0, updatedAt: 0,
  } as never);
  return { dir, result, usageEvents, budget };
}

describe('usage:updated emits per-call cost (FIX 1)', () => {
  const prevPreflight = process.env.MOCHI_SPECULATIVE_PREFLIGHT;
  beforeAll(() => { process.env.MOCHI_SPECULATIVE_PREFLIGHT = '0'; });
  afterAll(() => {
    if (prevPreflight === undefined) delete process.env.MOCHI_SPECULATIVE_PREFLIGHT;
    else process.env.MOCHI_SPECULATIVE_PREFLIGHT = prevPreflight;
  });

  it('provider-reported costs: event sum == budget total == result cost == trace total', async () => {
    const fake = await startFakeOpenAI([
      { ...READ_A, promptTokens: 100, completionTokens: 10, costUsd: 0.1 },
      { ...READ_B, promptTokens: 120, completionTokens: 10, costUsd: 0.1 },
      { ...DONE, promptTokens: 200, completionTokens: 20, costUsd: 0.1 },
    ]);
    const { dir, result, usageEvents, budget } = await runScripted(fake, 'fake-model');
    try {
      expect(result.success).toBe(true);
      expect(usageEvents.length).toBeGreaterThanOrEqual(3);
      // Per-call: every priced event is exactly one call's $0.10 — pre-fix
      // the 2nd/3rd events carried the cumulative $0.20/$0.30.
      const positives = usageEvents.map((e) => e.costUsd ?? 0).filter((c) => c > 0);
      expect(positives.length).toBeGreaterThanOrEqual(3);
      for (const c of positives) expect(c).toBeCloseTo(0.1, 9);
      const emittedSum = usageEvents.reduce((s, e) => s + (e.costUsd ?? 0), 0);
      const budgetTotal = budget.snapshot('fake-model').usedCostUsd;
      expect(budgetTotal).toBeCloseTo(0.3, 9);
      expect(emittedSum).toBeCloseTo(budgetTotal, 9);
      expect(result.costUsd).toBeCloseTo(budgetTotal, 9);
      // The trace path: fold the first three events (the scripted calls)
      // through the same consumer the gate/trajectory export use.
      const entries = usageEvents.slice(0, 3).map((e) => ({ ...e, kind: 'usage:updated' }));
      const traceCost = costFromTraceEntries(entries);
      expect(traceCost.effectiveCostUsd).not.toBeNull();
      expect(traceCost.effectiveCostUsd!).toBeCloseTo(budgetTotal, 9);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('price-table estimates: $0-reporting calls emit their per-call estimate, never a cumulative', async () => {
    const fake = await startFakeOpenAI([
      { ...READ_A, promptTokens: 10_000, completionTokens: 1_000 },
      { ...READ_B, promptTokens: 10_000, completionTokens: 1_000 },
      { ...DONE, promptTokens: 10_000, completionTokens: 1_000 },
    ]);
    const { dir, result, usageEvents, budget } = await runScripted(fake, 'gpt-4o');
    try {
      expect(result.success).toBe(true);
      expect(usageEvents.length).toBeGreaterThanOrEqual(3);
      const snap = budget.snapshot('gpt-4o');
      expect(snap.costSource).toBe('estimated');
      expect(snap.usedEstimatedCostUsd).toBeGreaterThan(0);
      // gpt-4o is pinned in pricing.ts at $2.50 in / $10 out per 1M, so each
      // 10k-in/1k-out call estimates to $0.035. The first three events are
      // the scripted calls, in order: each must be that per-call figure —
      // pre-fix they were $0.035/$0.070/$0.105 (cumulative).
      for (const e of usageEvents.slice(0, 3)) {
        expect(e.costUsd!).toBeGreaterThan(0.03);
        expect(e.costUsd!).toBeLessThan(0.04);
      }
      const emittedSum = usageEvents.reduce((s, e) => s + (e.costUsd ?? 0), 0);
      expect(emittedSum).toBeCloseTo(snap.usedCostUsd, 9);
      expect(result.costUsd).toBeCloseTo(snap.usedCostUsd, 9);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
