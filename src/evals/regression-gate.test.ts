// Frozen regression gate — proving tests (a)–(f) from the design brief.
// Everything runs on fake runners + the REAL frozen seed set copied into a
// temp dir, so the real hash machinery, real verifiers, and real blocklist
// matcher are all exercised. No live model, no network.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GateError, assertNoBlocklistOverlap, diffRiskChecklist, loadFrozenSet,
  runGate, scanRunTraces, updateBaseline,
  type AgentStepResult, type TaskRunner,
} from './regression-gate.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_FROZEN = join(REPO, 'bench', 'frozen');
const REAL_BLOCKLIST = join(REPO, 'bench', 'external', 'eval_blocklist.json');

let root: string;
let frozenDir: string;
let reportsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mochi-gate-test-'));
  frozenDir = join(root, 'frozen');
  mkdirSync(frozenDir, { recursive: true });
  cpSync(join(REAL_FROZEN, 'manifest.json'), join(frozenDir, 'manifest.json'));
  cpSync(join(REAL_FROZEN, 'tasks'), join(frozenDir, 'tasks'), { recursive: true });
  reportsDir = join(root, 'reports');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Fake agent step: applies the task's canned solution (so the real pinned
 *  verifier passes) with a fixed token count. */
function solutionRunner(tokensPerTrial: number, sabotageTaskId?: string): TaskRunner {
  return async (task, _trial, workdir) => {
    if (task.id === sabotageTaskId) {
      // Planted regression: the "challenger" does the task badly — writes a
      // plausible-but-wrong artifact the verifier must reject.
      writeFileSync(join(workdir, 'sum.js'), 'function sum(arr){ return 42; }\nmodule.exports={sum};\n');
      writeFileSync(join(workdir, 'run.js'), 'const {sum}=require("./sum.js"); console.log(sum([1,2,3,4]));\n');
      const step: AgentStepResult = { exitCode: 0, timedOut: false, tokens: tokensPerTrial, costUsd: null, failureClass: null, traceIds: [], detail: 'fake sabotage' };
      return step;
    }
    if (task.absSolutionDir && existsSync(task.absSolutionDir)) {
      cpSync(task.absSolutionDir, workdir, { recursive: true });
    }
    return { exitCode: 0, timedOut: false, tokens: tokensPerTrial, costUsd: null, failureClass: null, traceIds: [], detail: 'fake pass' };
  };
}

const baseOpts = () => ({ repoRoot: root, frozenDir, blocklistPath: REAL_BLOCKLIST, reportsDir, writeReport: false });

describe('frozen set integrity', () => {
  it('(a) hash tamper → loadFrozenSet refuses loudly', () => {
    expect(() => loadFrozenSet(frozenDir)).not.toThrow();
    const promptPath = join(frozenDir, 'tasks', 'arena-b1-bugfix-off-by-one', 'prompt.txt');
    writeFileSync(promptPath, `${readFileSync(promptPath, 'utf8')} (tampered)`);
    expect(() => loadFrozenSet(frozenDir)).toThrowError(GateError);
    expect(() => loadFrozenSet(frozenDir)).toThrowError(/hash mismatch/);
  });

  it('(a) tamper also blocks a full gate run before any trial executes', async () => {
    await updateBaseline({ ...baseOpts(), runner: solutionRunner(1000) });
    const promptPath = join(frozenDir, 'tasks', 'arena-f1-feature-add-test', 'prompt.txt');
    writeFileSync(promptPath, 'tampered prompt');
    await expect(runGate({ ...baseOpts(), runner: solutionRunner(1000) })).rejects.toThrowError(/hash mismatch/);
  });

  it('(b) blocklist overlap → hard error', async () => {
    // A blocklist whose expanded instance ids include a frozen task id.
    const blDir = join(root, 'bl');
    cpSync(join(REPO, 'bench', 'external', 'blocklist.mjs'), join(blDir, 'blocklist.mjs'));
    const data = {
      kind: 'mochi-eval-blocklist', version: 1,
      datasets: [{ id: 'synthetic-eval', name: 'Synthetic', split: 'test', instance_ids: ['arena-f1-feature-add-test'], base_commits: [], repos: [] }],
      extra_blocked: { instance_ids: [], base_commits: [], repo_commit_pairs: [] },
    };
    writeFileSync(join(blDir, 'eval_blocklist.json'), JSON.stringify(data));
    const set = loadFrozenSet(frozenDir);
    await expect(assertNoBlocklistOverlap(set, join(blDir, 'eval_blocklist.json'))).rejects.toThrowError(/blocklist/);
    await expect(runGate({ ...baseOpts(), blocklistPath: join(blDir, 'eval_blocklist.json'), runner: solutionRunner(1000) }))
      .rejects.toThrowError(/blocklist/);
  });

  it('shipped seed blocklist does NOT overlap the shipped frozen set', async () => {
    const set = loadFrozenSet(frozenDir);
    await expect(assertNoBlocklistOverlap(set, REAL_BLOCKLIST)).resolves.toBeUndefined();
  });
});

describe('gate verdicts (§5.3 thresholds)', () => {
  it('(c) planted regression → BLOCKED with the regressed category named', async () => {
    await updateBaseline({ ...baseOpts(), runner: solutionRunner(1000) });
    const report = await runGate({ ...baseOpts(), runner: solutionRunner(1000, 'arena-b1-bugfix-off-by-one') });
    expect(report.verdict).toBe('BLOCKED');
    expect(report.comparison.checks.categoriesOk).toBe(false);
    const named = report.comparison.failures.join('\n');
    expect(named).toContain('category "fix"');
    expect(report.comparison.brokenCount).toBe(1);
  });

  it('(d) equal pass at ≥10% lower cost-per-solve → PASS via the efficiency path', async () => {
    await updateBaseline({ ...baseOpts(), runner: solutionRunner(1000) });
    const report = await runGate({ ...baseOpts(), runner: solutionRunner(800) });
    expect(report.comparison.checks.efficiency).toBe(true);
    // DBG(flake): a full-suite-only 0.2111-vs-0.2 failure was observed twice.
    // Dump trial-level data so the next occurrence is diagnosable instead of
    // a bare number.
    if (Math.abs((report.comparison.costReduction ?? 0) - 0.2) > 1e-6) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(`/tmp/reggate-flake-${Date.now()}.json`, JSON.stringify({
        costReduction: report.comparison.costReduction,
        baseRun: report.baseline?.results ?? null,
        chalRun: report.results ?? null,
      }, null, 2));
      console.error('DBG costReduction', report.comparison.costReduction, 'dumped to /tmp/reggate-flake-*.json');
    }
    expect(report.comparison.costReduction).toBeCloseTo(0.2, 5);
    expect(report.comparison.deltaPp).toBe(0);
    expect(report.verdict).toBe('PASS');
  });

  it('equal pass at equal cost → BLOCKED (no §5.3 path met; the gate is a promotion gate, not a no-op stamp)', async () => {
    await updateBaseline({ ...baseOpts(), runner: solutionRunner(1000) });
    const report = await runGate({ ...baseOpts(), runner: solutionRunner(1000) });
    expect(report.verdict).toBe('BLOCKED');
    expect(report.comparison.failures.join('\n')).toContain('neither §5.3 path');
  });

  it('(f) baseline is never auto-updated by a gate run', async () => {
    const baselinePath = join(frozenDir, 'baseline.json');
    await updateBaseline({ ...baseOpts(), runner: solutionRunner(1000) });
    const before = readFileSync(baselinePath, 'utf8');
    await runGate({ ...baseOpts(), runner: solutionRunner(1000, 'arena-b1-bugfix-off-by-one') });
    await runGate({ ...baseOpts(), runner: solutionRunner(800) });
    expect(readFileSync(baselinePath, 'utf8')).toBe(before);
  });

  it('dry-run/live mode mismatch between baseline and run is refused', async () => {
    await updateBaseline({ ...baseOpts(), runner: solutionRunner(1000) }); // live-mode baseline (dryRun false)
    await expect(runGate({ ...baseOpts(), dryRun: true })).rejects.toThrowError(/dry-run/);
  });

  it('missing baseline is a loud error naming the fix', async () => {
    await expect(runGate({ ...baseOpts(), runner: solutionRunner(1000) })).rejects.toThrowError(/mochi gate baseline/);
  });
});

describe('independent analyser (deterministic floor)', () => {
  const deletionDiff = [
    'diff --git a/src/foo.test.ts b/src/foo.test.ts',
    'deleted file mode 100644',
    '--- a/src/foo.test.ts',
    '+++ /dev/null',
    '@@ -1,3 +0,0 @@',
    '-import { x } from "./foo.js";',
    '-test("x works", () => {});',
  ].join('\n');

  it('(e) with no model configured, the checklist flags a test-file deletion as a high objection', () => {
    const objections = diffRiskChecklist(deletionDiff);
    const hit = objections.find((o) => o.claim.includes('test file deleted'));
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('high');
    expect(hit!.source).toBe('checklist');
  });

  it('critical-path objections are grouped per area, not per file', () => {
    const diff = [
      'diff --git a/bench/a.mjs b/bench/a.mjs', '+++ b/bench/a.mjs', '+x',
      'diff --git a/bench/b.mjs b/bench/b.mjs', '+++ b/bench/b.mjs', '+y',
      'diff --git a/src/security/auth.ts b/src/security/auth.ts', '+++ b/src/security/auth.ts', '+z',
    ].join('\n');
    const objections = diffRiskChecklist(diff);
    expect(objections.filter((o) => o.claim.includes('evaluation instrument'))).toHaveLength(1);
    expect(objections.filter((o) => o.claim.includes('security path'))).toHaveLength(1);
  });

  it('(e) objections downgrade a passing gate to PASS-WITH-OBJECTIONS (promotion blocked)', async () => {
    await updateBaseline({ ...baseOpts(), runner: solutionRunner(1000) });
    const report = await runGate({ ...baseOpts(), runner: solutionRunner(800), diffText: deletionDiff });
    expect(report.comparison.checks.efficiency).toBe(true); // criteria met…
    expect(report.objections.length).toBeGreaterThan(0);    // …but the analyst objected
    expect(report.verdict).toBe('PASS-WITH-OBJECTIONS');
  });
});

describe('trace scanning (usage + failure classes)', () => {
  it('sums usage:updated tokens and detects an F7 identical-call loop', () => {
    const dir = join(root, 'wd');
    const traces = join(dir, '.mochi', 'traces');
    mkdirSync(traces, { recursive: true });
    const lines: Record<string, unknown>[] = [
      { t: 1, kind: 'usage:updated', totalTokens: 120, costUsd: 0.01 },
      { t: 2, kind: 'usage:updated', totalTokens: 80, costUsd: 0.02 },
    ];
    for (let i = 0; i < 6; i++) lines.push({ t: 3 + i, kind: 'tool:called', tool: 'shell', args: { cmd: 'npm test' } });
    writeFileSync(join(traces, 'run1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const scan = scanRunTraces(dir);
    expect(scan.tokens).toBe(200);
    expect(scan.costUsd).toBeCloseTo(0.03, 10);
    expect(scan.failureClass).toBe('F7');
    expect(scan.traceIds).toEqual(['run1']);
  });

  it('C5: $0 provider cost with model + token split → price-table estimate makes cost-per-solve computable', () => {
    const dir = join(root, 'wd3');
    const traces = join(dir, '.mochi', 'traces');
    mkdirSync(traces, { recursive: true });
    const lines = [
      // usage:updated: input is non-cached, cache bills on top.
      // gpt-4o: 800k*2.5 + 200k*1.25 + 100k*10 per 1M = $3.25.
      { t: 1, kind: 'usage:updated', model: 'gpt-4o', inputTokens: 800_000, outputTokens: 100_000, cacheTokens: 200_000, totalTokens: 1_100_000, costUsd: 0 },
    ];
    writeFileSync(join(traces, 'run3.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const scan = scanRunTraces(dir);
    expect(scan.tokens).toBe(1_100_000);
    expect(scan.costUsd).toBeCloseTo(3.25, 8);
    expect(scan.costEstimated).toBe(true);
    // An explicit override changes the scanned estimate.
    const overridden = scanRunTraces(dir, { pricing: { 'gpt-4o': { output: 20 } } });
    expect(overridden.costUsd).toBeCloseTo(4.25, 8);
  });

  it('partial cost data → $ reported unavailable, tokens still summed', () => {
    const dir = join(root, 'wd2');
    const traces = join(dir, '.mochi', 'traces');
    mkdirSync(traces, { recursive: true });
    const lines = [
      { t: 1, kind: 'usage:updated', totalTokens: 50, costUsd: 0.01 },
      { t: 2, kind: 'usage:updated', totalTokens: 50 }, // provider did not report cost
    ];
    writeFileSync(join(traces, 'run2.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const scan = scanRunTraces(dir);
    expect(scan.tokens).toBe(100);
    expect(scan.costUsd).toBeNull();
  });
});
