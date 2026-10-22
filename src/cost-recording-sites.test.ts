// FIX 2 (Wave G): the model-calling subsystems that recorded spend through
// BudgetEngine.recordTokens WITHOUT a token breakdown — speculative,
// verification's judge, chameleon, termix — could never price a $0-reporting
// call live: the record charged $0 and only an offline trace pass could
// estimate it later. They now record through recordUsage, so the price-table
// fallback lands the spend in the budget's ESTIMATED split at record time.
//
// Each test drives the real subsystem against the fake OpenAI wire with a
// priced model (gpt-4o, pinned in pricing.ts) whose responses report tokens
// but NO cost, and asserts the budget's estimated ledger moved. On the
// pre-fix recordTokens calls every one of these budgets stays at $0
// estimated, so each test fails pre-fix.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SpeculativeEngine } from './agent/speculative.js';
import { VerifierEngine } from './verification.js';
import { ChameleonEngine } from './cognitive/chameleon.js';
import { termix } from './tui/termix.js';
import { BudgetEngine } from './budget.js';
import { Workspace } from './workspace.js';
import { EventBus } from './events.js';
import { createTask } from './goals/task.js';
import { startFakeOpenAI } from './testutil/fake-openai.js';
import type { MochiConfig } from './types.js';

// One scripted call's usage: 10k in / 1k out on gpt-4o ($2.50/$10 per 1M)
// estimates to $0.035 through the price table.
const USAGE = { promptTokens: 10_000, completionTokens: 1_000 };

function makeConfig(url: string, model = 'gpt-4o'): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model },
    safety: {
      mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10,
      maxRuntimeMinutes: 10, maxConcurrentAgents: 2, contextBudgetTokens: 8000,
      maxModelCalls: 50,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
    telemetry: false, projectDir: '.mochi', configDir: tmpdir(), quiet: true,
  } as unknown as MochiConfig;
}

function makeBudget(config: MochiConfig): BudgetEngine {
  const budget = new BudgetEngine(config.safety);
  budget.start();
  return budget;
}

describe('recordUsage adoption at model-call sites (FIX 2)', () => {
  it('speculative engine: $0-reporting calls land in the estimated split', async () => {
    const strategies = ['inspect types', 'reproduce with logging', 'check dependencies'];
    const fake = await startFakeOpenAI([{
      sticky: true,
      respondFn: (body) => {
        const text = JSON.stringify(body?.messages ?? body);
        if (text.includes('Candidate 1:')) {
          return { content: '{"index":1,"reason":"most direct","scores":[9,5,4]}', ...USAGE };
        }
        for (const s of strategies) {
          if (text.includes(s)) return { content: `Developed plan for: ${s}.`, ...USAGE };
        }
        return { content: JSON.stringify(strategies), ...USAGE };
      },
    }]);
    try {
      const config = makeConfig(fake.url);
      const budget = makeBudget(config);
      const engine = new SpeculativeEngine(config, budget, 3);
      const result = await engine.speculate('Why does the parser drop the last token?');
      expect(result.candidates.length).toBeGreaterThan(0);
      const snap = budget.snapshot('gpt-4o');
      // 5 calls (generate + 3 evaluations + choose) × $0.035 estimated.
      expect(snap.usedProviderCostUsd).toBe(0);
      expect(snap.usedEstimatedCostUsd).toBeGreaterThan(0.1);
      expect(snap.costSource).toBe('estimated');
    } finally {
      await fake.close();
    }
  }, 60_000);

  it('verifier judge: the judging call is priced live into the estimated split', async () => {
    const fake = await startFakeOpenAI([
      { content: '{"status":"PASS","passed":["criteria met"],"failed":[],"recommendation":"Complete"}', finishReason: 'stop', ...USAGE },
    ]);
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-costfix-verify-'));
    try {
      writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
      const config = makeConfig(fake.url);
      const budget = makeBudget(config);
      const workspace = new Workspace(dir, '.mochi');
      workspace.ensure();
      const verifier = new VerifierEngine({ cwd: dir, workspace, config, events: new EventBus(), budget });
      const task = createTask('Add feature', 'Implement', { acceptanceCriteria: ['feature works'] });
      const result = await verifier.verify(task, 'Implemented feature');
      expect(result.status).toBe('PASS');
      const snap = budget.snapshot('gpt-4o');
      expect(snap.usedProviderCostUsd).toBe(0);
      expect(snap.usedEstimatedCostUsd).toBeGreaterThan(0.03); // ≥ 1 judge call × $0.035
      expect(snap.costSource).toBe('estimated');
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('chameleon: enhancement passes are priced live into the estimated split', async () => {
    const fake = await startFakeOpenAI([
      { content: 'Dense execution guidance with invariants and edge cases.', finishReason: 'stop', ...USAGE },
    ]);
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-costfix-chameleon-'));
    try {
      const config = makeConfig(fake.url);
      const budget = makeBudget(config);
      const engine = new ChameleonEngine(config);
      const result = await engine.enhance({ task: 'harden the parser', mode: 'medium', maxRuns: 1, budget, cwd: dir });
      expect(result.tokensUsed).toBeGreaterThan(0);
      const snap = budget.snapshot('gpt-4o');
      expect(snap.usedProviderCostUsd).toBe(0);
      expect(snap.usedEstimatedCostUsd).toBeGreaterThan(0.03); // 1 pass × $0.035
      expect(snap.costSource).toBe('estimated');
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('termix: session cost reports the effective (estimated) spend, not a flattering $0', async () => {
    const fake = await startFakeOpenAI([
      { content: 'x'.repeat(300), finishReason: 'stop', sticky: true, ...USAGE },
    ]);
    try {
      const config = makeConfig(fake.url);
      const run = await termix({ mode: 'separate', sessions: 1, task: 'fix the build', config });
      expect(run.results.length).toBe(1);
      expect(run.results[0].error).toBeUndefined();
      expect(run.results[0].steps).toBe(8); // long output never breaks the loop early
      // 8 calls × $0.035 of estimated spend now surface in the session cost;
      // pre-fix the result accumulated provider-reported cost only ($0).
      expect(run.results[0].costUsd).toBeGreaterThan(0.2);
      expect(run.costUsd).toBeGreaterThan(0.2);
    } finally {
      await fake.close();
    }
  }, 60_000);
});
