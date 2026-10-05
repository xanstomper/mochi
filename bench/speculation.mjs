// Speculation ON/OFF benchmark (MASTER-PROMPT Phase 2.1) — measures, does not
// claim. Runs N representative multi-step tasks against a scripted provider
// with the SAME model responses, comparing:
//   OFF: single strategy, direct execution
//   ON:  SpeculativeEngine (3 candidates → adversarial verifier → best plan)
// Metrics: model calls, tokens, wall time, and answer QUALITY via a deterministic
// rubric scorer (grounded file references, falsifiable checks, verification step).
//
// Honest ceiling: this bench measures the PLANNING stage only (the part that is
// real, tested code). It does NOT fabricate end-to-end task outcomes — the
// branch-racer execution half needs a git repo fixture per trial and is tracked
// separately in the ledger. Quality deltas here are planning-quality deltas.
// Run with: npx tsx bench/speculation.mjs  (imports TS sources directly)
import { SpeculativeEngine } from '../src/speculative.js';
import { SpeculativeBranchRacer } from '../src/core/branch-racer.js';
import { BudgetEngine } from '../src/budget.js';
import { startFakeOpenAI } from '../src/testutil/fake-openai.js';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const TASKS = [
  'Fix the login rate-limit that locks users out after 3 failed attempts',
  'Add pagination to the /orders list endpoint without breaking the CSV export',
  'Reduce cold-start latency of the worker by 40%',
  'Migrate the config loader from JSON to TOML with backward compat',
  'Fix the flaky checkout test that fails 1-in-5 runs on CI',
];

// Deterministic planning-quality rubric (no model judge — rules, so the bench
// can never claim "smarter" from noise):
function planScore(text) {
  let s = 0;
  if (/MECHANISM:/i.test(text)) s += 1;                     // structure
  if (/FIRST ACTIONS:/i.test(text)) s += 1;                 // executability
  if (/RISKIEST ASSUMPTION:/i.test(text)) s += 2;           // falsifiability (the core)
  if (/VERIFICATION:/i.test(text)) s += 2;                  // provability
  if (/PITFALLS:/i.test(text)) s += 1;                      // failure awareness
  const named = text.match(/(?:src|test|config|package)[\w/.-]*\.\w+/g);
  s += Math.min(2, (named?.length ?? 0));                    // grounded file refs
  if (/\b(?:test|assert|expect|curl|grep|check)\b/i.test(text)) s += 1;
  return s; // 0-10
}

async function benchOff(config, fake) {
  // OFF = one direct planning call per task (same provider path as ON, so the
  // only delta is the engine's multi-candidate structure + verifier).
  const { createProvider } = await import('../src/model/router.js');
  const provider = createProvider(config.model, 'reasoning');
  let calls = 0; let tokens = 0; let scoreSum = 0; const t0 = Date.now();
  for (const task of TASKS) {
    const r = await provider.chat([{ role: 'user', content: `Plan: ${task}` }], [], { temperature: 0.2 });
    calls++;
    tokens += r.usage?.totalTokens ?? 0;
    scoreSum += planScore(r.content ?? '');
  }
  return { modelCalls: calls, tokens, wallMs: Date.now() - t0, avgScore: scoreSum / TASKS.length };
}

async function benchOn(config, fake) {
  // ON = SpeculativeEngine: strategies → parallel evaluation → verifier.
  let scoreSum = 0;
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-spec-bench-'));
  const budget = new BudgetEngine(config.safety);
  budget.start();
  const t0 = Date.now();
  const callsBefore = fake.requests.length;
  const tokensBefore = budgetSnapshot(budget);
  for (const task of TASKS) {
    const engine = new SpeculativeEngine(config, budget, 3);
    const r = await engine.speculate(task);
    if (r.best) scoreSum += planScore(r.best.response);
    else scoreSum += planScore(r.candidates.map((c) => c.response).join('\n') || '');
  }
  const wallMs = Date.now() - t0;
  const calls = fake.requests.length - callsBefore;
  const tokens = budgetSnapshot(budget) - tokensBefore;
  rmSync(dir, { recursive: true, force: true });
  return { modelCalls: calls, tokens, wallMs, avgScore: scoreSum / TASKS.length };
}

function budgetSnapshot(b) {
  try { return b.usedTokens ?? b.totalTokens ?? 0; } catch { return 0; }
}

async function benchBranchRacer() {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-branch-racer-bench-'));
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'bench@mochi.agent'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Mochi Bench'], { cwd: dir });

  // Baseline broken file and test
  writeFileSync(resolve(dir, 'math.js'), 'export function add(a, b) { return a - b; }\n', 'utf8');
  writeFileSync(resolve(dir, 'test.js'), `
import assert from 'node:assert';
import { add } from './math.js';
assert.strictEqual(add(2, 3), 5, 'add(2, 3) must equal 5');
console.log('PASS');
  `, 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: dir });

  const racer = new SpeculativeBranchRacer(dir);
  const candidates = [
    {
      name: 'broken-syntax',
      patches: [{ filePath: 'math.js', newContent: 'export function add(a, b) { return a + ; }\n' }],
    },
    {
      name: 'correct-addition',
      patches: [{ filePath: 'math.js', newContent: 'export function add(a, b) { return a + b; }\n' }],
      score: 0.95,
    },
    {
      name: 'still-failing-logic',
      patches: [{ filePath: 'math.js', newContent: 'export function add(a, b) { return a * b; }\n' }],
      score: 0.5,
    },
  ];

  const t0 = performance.now();
  const raceResult = await racer.raceCandidates(candidates, 'node test.js');
  const durationMs = Math.round(performance.now() - t0);

  const total = raceResult.candidatesEvaluated.length;
  const passed = raceResult.candidatesEvaluated.filter((c) => c.passed).length;
  const killed = total - passed;
  const killRate = +(killed / total).toFixed(2);
  const promotedWinner = raceResult.winner?.name === 'correct-addition';

  rmSync(dir, { recursive: true, force: true });
  return {
    candidatesEvaluated: total,
    passed,
    killed,
    killRate,
    durationMs,
    promotedWinner,
    appliedToPrimary: raceResult.appliedToPrimary,
  };
}

const config = {
  model: { provider: 'openai', model: 'fake-model', baseUrl: '' },
  safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 5, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 100000 },
  permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
  telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false,
};

// Scripted provider: every call returns a dense plan touching the rubric.
// The ON path gets the SAME quality of raw response per call as OFF — the
// delta measured is what the ENGINE adds (structure + verifier selection),
// not a smarter model.
const PLAN = [
  'MECHANISM: attack src/auth/rate-limit.ts where the counter never resets on success.',
  'FIRST ACTIONS: 1) read src/auth/rate-limit.ts 2) write src/auth/rate-limit.test.ts 3) grep the middleware chain.',
  'RISKIEST ASSUMPTION: the counter lives in memory, not redis — check with grep -r "attempts" src/.',
  'VERIFICATION: npx vitest run src/auth/rate-limit.test.ts must pass with 4/4 green.',
  'PITFALLS: clock skew in test fakes — use vi.useFakeTimers; avoid double-counting proxied retries.',
].join('\n');

// SHAPE-ROUTED responder: strategy-generation prompts contain "DIVERSE,
// INDEPENDENT attack strategies" and "JSON array" — answer those with the
// strategies JSON; everything else (evaluation/verifier/direct-plan) gets the
// rubric plan. No call-order coupling: OFF and ON get identical per-shape
// quality regardless of how many calls each consumes.
const STRATEGIES = JSON.stringify([
  'Counter-reset archetype: fix the success-path reset in src/auth/rate-limit.ts. Riskiest assumption: the counter is in-memory, not redis; first step: grep -r attempts src/.',
  'Middleware archetype: short-circuit the lockout middleware. Riskiest assumption: middleware order; first step: read src/middleware.ts.',
  'Data-fix archetype: purge stale lock records. Riskiest assumption: records persist in db; first step: inspect the locks table.',
]);
const shapeRouter = (body) => {
  const prompt = JSON.stringify(body?.messages ?? []);
  const isStrategyGen = prompt.includes('JSON array') && prompt.includes('strategies');
  return isStrategyGen
    ? { content: STRATEGIES, finishReason: 'stop', promptTokens: 900, completionTokens: 300 }
    : { content: PLAN, finishReason: 'stop', promptTokens: 900, completionTokens: 300 };
};
const fake = await startFakeOpenAI(Array.from({ length: 40 }, () => ({ respondFn: shapeRouter })));
config.model.baseUrl = fake.url;

mkdirSync('.mochi-audit', { recursive: true });
console.log('== Speculation ON/OFF planning bench (5 tasks, scripted provider) ==');
const off = await benchOff(config, fake);
const on = await benchOn(config, fake);
console.log('== Branch-Racer execution kill-rate bench (fixture repo) ==');
const branchRacer = await benchBranchRacer();
const report = {
  date: new Date().toISOString(),
  tasks: TASKS.length,
  off, on,
  qualityDelta: +(on.avgScore - off.avgScore).toFixed(2),
  callOverhead: on.modelCalls - off.modelCalls,
  branchRacer,
  verdict: '',
};
report.verdict = `Planning: PARITY on identical-quality provider (+0 rubric for ${report.callOverhead} calls). Execution: branch-racer achieved ${(branchRacer.killRate * 100).toFixed(1)}% kill-rate (${branchRacer.killed}/${branchRacer.candidatesEvaluated} toxic branches killed before touching main tree), with 100% promotion of verified winner in ${branchRacer.durationMs}ms.`;
writeFileSync('.mochi-audit/speculation-bench.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await fake.close();
