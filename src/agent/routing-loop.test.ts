// Cost-per-solve routing (B22) — loop integration. These drive a real Agent
// against the fake OpenAI wire with a hand-built routing table in workspace
// state, the discipline-loop repo shape (git + package.json test + repro),
// and assert the routing contract end to end:
//   - a run STARTS on the cheapest proven model for its kind;
//   - insufficient data (or no table at all) keeps the configured default;
//   - a user-pinned model is never overridden;
//   - escalation fires on verifier FAIL evidence, never on PASS;
//   - a budget that forbids the switch degrades to a noted continuation.
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from './loop.js';
import { BudgetEngine } from '../budget.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { saveRoutingTable, type RoutingTable } from '../observability/routing-table.js';
import { startFakeOpenAI, type FakeOpenAI, type FakeScriptResponse } from '../testutil/fake-openai.js';
import type { MochiConfig, MochiEvent } from '../types.js';

const CHEAP = 'gpt-5-mini';
const STRONG = 'claude-sonnet-4-5';
const FIX_TITLE = 'Fix the bug in math.js: add() returns the wrong result';
const FIX_DESC = 'Make npm test pass. add(a, b) in math.js subtracts instead of adding, so the repro fails. Correct the arithmetic in the existing code.';

const MATH = (version: number, fixed: boolean) => `// VERSION = ${version}\nfunction add(a, b) { return a ${fixed ? '+' : '-'} b; }\nmodule.exports = { add };\n`;
const REPRO = `const { add } = require('./math.js');\nif (add(2, 3) !== 5) { console.error('add broken: got ' + add(2, 3)); process.exit(1); }\nconsole.log('add ok');\n`;

function makeRepo(fixed: boolean): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-routing-'));
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node repro.js' } }));
  writeFileSync(resolve(dir, 'math.js'), MATH(1, fixed));
  writeFileSync(resolve(dir, 'repro.js'), REPRO);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@mochi.agent'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Mochi Test'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

/** The seeded history: for `fix`, CHEAP is proven and cheap (CPS $0.12,
 *  solve rate 50%), STRONG is proven and reliable (CPS $0.90, rate 100%). */
function seededTable(miniRuns = 8, sonnetRuns = 8): RoutingTable {
  const cell = (model: string, runs: number, solved: number, total: number) => ({
    kind: 'fix', model, runs, solvedRuns: solved,
    totalCostUsd: total, reportedCostUsd: total, estimatedCostUsd: 0,
    costPerSolveUsd: solved > 0 ? total / solved : null,
    solveRate: runs > 0 ? solved / runs : 0,
    escalatedRuns: 0, routingEscalations: 0, triggers: {},
    sufficient: runs >= 5, priced: true, costIncomplete: false,
  });
  return {
    version: 1, derivedAt: Date.now(), minSamples: 5, runsConsidered: miniRuns + sonnetRuns, runsSkipped: 0,
    cells: [cell(CHEAP, miniRuns, Math.min(4, miniRuns), 0.48 * (miniRuns / 8)), cell(STRONG, sonnetRuns, sonnetRuns, 7.20 * (sonnetRuns / 8))],
  };
}

function makeConfig(url: string, opts: { pinned?: boolean } = {}): MochiConfig {
  return {
    model: {
      provider: 'openai', baseUrl: url, model: STRONG,
      profiles: { fast: CHEAP, coding: STRONG, reasoning: STRONG, review: STRONG },
      speculative: { preflight: false },
      ...(opts.pinned ? { modelPinned: true } : {}),
    },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

interface RunOut {
  result: { success: boolean; stopReason?: string };
  modelsOnWire: string[];
  routingEvents: Array<Record<string, unknown>>;
}

async function runScripted(
  dir: string,
  script: FakeScriptResponse[],
  opts: { table?: RoutingTable | null; pinned?: boolean; budget?: BudgetEngine; fileScope?: string[] } = {},
): Promise<RunOut> {
  const fake: FakeOpenAI = await startFakeOpenAI(script);
  try {
    const config = makeConfig(fake.url, { pinned: opts.pinned });
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    if (opts.table) saveRoutingTable(workspace.dir, opts.table);
    const context = new ContextEngine(config, dir);
    context.setGoal(FIX_TITLE);
    const bus = new EventBus();
    const routingEvents: Array<Record<string, unknown>> = [];
    bus.onAll((e: MochiEvent) => {
      if (e.type.startsWith('routing:')) routingEvents.push(e as unknown as Record<string, unknown>);
    });
    const agent = new Agent({
      role: 'coder', config, workspace, events: bus, cwd: dir, context,
      ...(opts.budget ? { budget: opts.budget } : {}),
    });
    const result = await agent.run(createTask(FIX_TITLE, FIX_DESC, { ...(opts.fileScope ? { fileScope: opts.fileScope } : {}) }));
    return {
      result: result as RunOut['result'],
      modelsOnWire: fake.requests.map((r) => String(r.body.model)),
      routingEvents,
    };
  } finally {
    await fake.close();
  }
}

const edit = (id: string, oldText: string, newText: string): FakeScriptResponse => ({
  finishReason: 'tool_calls',
  toolCalls: [{ id, type: 'function', function: { name: 'edit', arguments: JSON.stringify({ path: 'math.js', oldText, newText }) } }],
});
const claim = (content: string): FakeScriptResponse => ({ content, finishReason: 'stop' });
/** The repro-first gate vetoes a fix task's first mutation until the failure
 *  has been reproduced — every script opens with the repro, like the
 *  discipline-loop scenarios. */
const repro = (id = 's1'): FakeScriptResponse => ({
  finishReason: 'tool_calls',
  toolCalls: [{ id, type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'node repro.js' }) } }],
});

describe('cost-per-solve routing (loop)', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  it('starts on the cheapest proven model for the kind; a PASS earns no escalation', async () => {
    dir = makeRepo(false);
    const out = await runScripted(dir, [
      repro(),
      edit('e1', 'return a - b', 'return a + b'),
      claim('Fixed the arithmetic in math.js.'),
    ], { table: seededTable() });
    expect(out.result.success).toBe(true);
    expect(out.modelsOnWire.length).toBeGreaterThan(0);
    expect(out.modelsOnWire.every((m) => m === CHEAP)).toBe(true);
    const decision = out.routingEvents.find((e) => e.type === 'routing:decision');
    expect(decision).toMatchObject({ source: 'routed', model: CHEAP, fromModel: STRONG, taskKind: 'fix' });
    expect(out.routingEvents.some((e) => e.type === 'routing:escalated')).toBe(false);
  });

  it('escalates up the measured ladder on repeated verifier FAILs — and only then', async () => {
    dir = makeRepo(false);
    const script: FakeScriptResponse[] = [repro()];
    for (let v = 1; v <= 5; v++) {
      script.push(edit(`e${v}`, `// VERSION = ${v}`, `// VERSION = ${v + 1}`));
      script.push(claim(`Adjusted the version marker (attempt ${v}).`));
    }
    // fileScope of 3 paths makes the task 'complex' from the start, so the
    // mid-run complexity promotion (its own escalation trigger) cannot
    // pre-empt the verify-failure path this scenario isolates.
    const out = await runScripted(dir, script, { table: seededTable(), fileScope: ['math.js', 'repro.js', 'package.json'] });
    expect(out.result.success).toBe(false);
    const esc = out.routingEvents.find((e) => e.type === 'routing:escalated');
    expect(esc).toMatchObject({ trigger: 'verify_failures', fromModel: CHEAP, toModel: STRONG, taskKind: 'fix' });
    const firstStrong = out.modelsOnWire.indexOf(STRONG);
    expect(firstStrong).toBeGreaterThan(0);
    expect(out.modelsOnWire.slice(0, firstStrong).every((m) => m === CHEAP)).toBe(true);
  });

  it('insufficient-data kinds stay on the configured default', async () => {
    dir = makeRepo(false);
    const out = await runScripted(dir, [
      repro(),
      edit('e1', 'return a - b', 'return a + b'),
      claim('Fixed the arithmetic in math.js.'),
    ], { table: seededTable(3, 3) });
    expect(out.result.success).toBe(true);
    expect(out.modelsOnWire.every((m) => m === STRONG)).toBe(true);
    const decision = out.routingEvents.find((e) => e.type === 'routing:decision');
    expect(decision).toMatchObject({ source: 'insufficient-data', model: STRONG });
  });

  it('no table at all: cold start is silent and the default rules (bootstrap contract)', async () => {
    dir = makeRepo(false);
    const out = await runScripted(dir, [
      repro(),
      edit('e1', 'return a - b', 'return a + b'),
      claim('Fixed the arithmetic in math.js.'),
    ], { table: null });
    expect(out.result.success).toBe(true);
    expect(out.modelsOnWire.every((m) => m === STRONG)).toBe(true);
    expect(out.routingEvents).toHaveLength(0);
  });

  it('a user-pinned model is never overridden, however strong the table', async () => {
    dir = makeRepo(false);
    const out = await runScripted(dir, [
      repro(),
      edit('e1', 'return a - b', 'return a + b'),
      claim('Fixed the arithmetic in math.js.'),
    ], { table: seededTable(), pinned: true });
    expect(out.result.success).toBe(true);
    expect(out.modelsOnWire.every((m) => m === STRONG)).toBe(true);
    const decision = out.routingEvents.find((e) => e.type === 'routing:decision');
    expect(decision).toMatchObject({ source: 'pinned', model: STRONG });
    expect(out.routingEvents.some((e) => e.type === 'routing:escalated')).toBe(false);
  });

  it('a budget that forbids the switch degrades to a noted continuation on the current model', async () => {
    dir = makeRepo(false);
    const safety = {
      mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5,
      maxConcurrentAgents: 1, contextBudgetTokens: 8000, maxCostUsd: 0.0135,
    } as never;
    const budget = new BudgetEngine(safety);
    budget.start();
    const priced = (r: FakeScriptResponse): FakeScriptResponse => ({ ...r, costUsd: 0.002, promptTokens: 4000, completionTokens: 500 });
    const script: FakeScriptResponse[] = [priced(repro())];
    for (let v = 1; v <= 5; v++) {
      script.push(priced(edit(`e${v}`, `// VERSION = ${v}`, `// VERSION = ${v + 1}`)));
      script.push(priced(claim(`Adjusted the version marker (attempt ${v}).`)));
    }
    const out = await runScripted(dir, script, { table: seededTable(), budget, fileScope: ['math.js', 'repro.js', 'package.json'] });
    const blocked = out.routingEvents.find((e) => e.type === 'routing:escalation-blocked');
    expect(blocked).toMatchObject({ fromModel: CHEAP, toModel: STRONG, trigger: 'verify_failures' });
    expect(String(blocked?.reason)).toMatch(/budget/);
    expect(out.routingEvents.some((e) => e.type === 'routing:escalated')).toBe(false);
    expect(out.modelsOnWire.every((m) => m === CHEAP)).toBe(true);
  });
});
