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
const report = {
  date: new Date().toISOString(),
  tasks: TASKS.length,
  off, on,
  qualityDelta: +(on.avgScore - off.avgScore).toFixed(2),
  callOverhead: on.modelCalls - off.modelCalls,
  verdict: '',
};
report.verdict = report.qualityDelta > 0
  ? `Speculation adds +${report.qualityDelta} rubric points avg for ${report.callOverhead} extra model calls — structure + verifier selection add measurable planning quality at identical per-call response quality.`
  : report.qualityDelta === 0 && report.callOverhead > 0
  ? `PARITY at ${report.callOverhead} extra calls (+0 rubric): on an identical-quality provider, the engine's 3-candidate + verifier structure adds COST, not quality — diversity only pays when candidate responses actually differ (real models, not a scripted constant). Honest verdict: planning-quality gain UNPROVEN; the branch-racer execution half (killing bad branches before they touch the tree) is the remaining unmeasured source of value.`
  : `No planning-quality gain detected (${report.qualityDelta}) for ${report.callOverhead} extra calls — NOT yet worth it; the engine needs the branch-racer execution half measured before claiming task-level value.`;
writeFileSync('.mochi-audit/speculation-bench.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await fake.close();
