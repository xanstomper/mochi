// Failure curriculum v1 (D10) — proving tests.
// Everything runs on small fixture repos in temp dirs with a plain
// `node run-tests.mjs` verifier (PASS/FAIL lines, exit code) — no model,
// no network. The core falsifiable property from the brief: injecting into
// a fixture repo yields a task whose verifier FAILS pre-fix and PASSES
// with the original code restored, and the source repo is never touched.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  CurriculumError, applyBugToWorkdir, assertCurriculumTargetAllowed,
  createIsolatedCopy, createShellTestRunner, enumerateMutationCandidates,
  evaluateProgress, generateCurriculum, generateCurriculumTask,
  isFrozenPath, isMastered, isTestPath, loadBlockedIds, loadCurriculumTask,
  parseTestIds, restoreOriginalInWorkdir, runPracticeAttempt,
  saveCurriculumTask, verifyWorkdir, CurriculumProgress,
  type CurriculumTask,
} from './curriculum.js';

const CALC = [
  'export function add(a, b) { return a + b; }',
  'export function clampPositive(x) { return x > 0 ? x : 0; }',
  'export function isEqual(a, b) { return a === b; }',
  '',
].join('\n');

const RUN_TESTS = [
  "import { add, clampPositive, isEqual } from './calc.mjs';",
  'const cases = [',
  "  ['add-basic', () => add(2, 3) === 5],",
  "  ['add-neg', () => add(-1, 1) === 0],",
  "  ['clamp-pos', () => clampPositive(5) === 5],",
  "  ['clamp-neg', () => clampPositive(-3) === 0],",
  "  ['eq-true', () => isEqual(2, 2) === true],",
  "  ['eq-false', () => isEqual(2, 3) === false],",
  '];',
  'let failed = 0;',
  'for (const [id, fn] of cases) {',
  '  let ok = false;',
  '  try { ok = fn() === true; } catch { ok = false; }',
  "  console.log(`${ok ? 'PASS' : 'FAIL'} ${id}`);",
  '  if (!ok) failed++;',
  '}',
  'process.exit(failed ? 1 : 0);',
  '',
].join('\n');

let roots: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

/** A minimal passing fixture repo: calc.mjs + run-tests.mjs. */
function makeFixtureRepo(calcContent = CALC): string {
  const dir = tmp('mochi-curr-repo-');
  writeFileSync(join(dir, 'calc.mjs'), calcContent);
  writeFileSync(join(dir, 'run-tests.mjs'), RUN_TESTS);
  return dir;
}

function snapshotTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, rel: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      try {
        const inner = readdirSync(p);
        void inner;
        walk(p, r);
      } catch {
        out.set(r, createHash('sha256').update(readFileSync(p)).digest('hex'));
      }
    }
  };
  walk(dir, '');
  return out;
}

beforeEach(() => { roots = []; });
afterEach(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

const TEST_CMD = 'node run-tests.mjs';

describe('parseTestIds + shell runner', () => {
  it('parses TAP, PASS/FAIL and vitest-ish lines', () => {
    const out = [
      'ok 1 - alpha', 'not ok 2 - beta', 'PASS gamma', 'FAIL delta',
      '✓ epsilon', '× zeta', 'noise line',
    ].join('\n');
    const { passedIds, failedIds } = parseTestIds(out);
    expect(passedIds).toEqual(['alpha', 'gamma', 'epsilon']);
    expect(failedIds).toEqual(['beta', 'delta', 'zeta']);
  });

  it('shell runner reports green on the pristine fixture', async () => {
    const repo = makeFixtureRepo();
    const outcome = await createShellTestRunner(TEST_CMD)(repo);
    expect(outcome.passed).toBe(true);
    expect(outcome.failedTestIds).toEqual([]);
    expect(outcome.passedTestIds).toContain('add-basic');
  });
});

describe('mutation candidates', () => {
  it('enumerates distinct candidates in source order with difficulty tiers', () => {
    const cands = enumerateMutationCandidates(CALC);
    expect(cands.length).toBeGreaterThanOrEqual(3);
    const idx = cands.map((c) => c.index);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(new Set(cands.map((c) => `${c.index}:${c.from}`)).size).toBe(cands.length);
    const plus = cands.find((c) => c.from === '+');
    expect(plus?.difficulty).toBe('easy');
    expect(plus?.mutatedSource).toContain('a - b');
    const eq = cands.find((c) => c.from === '===');
    expect(eq?.difficulty).toBe('hard');
  });

  it('is deterministic', () => {
    expect(enumerateMutationCandidates(CALC)).toEqual(enumerateMutationCandidates(CALC));
  });
});

describe('guards (hard rules)', () => {
  it('isFrozenPath / isTestPath classify correctly', () => {
    expect(isFrozenPath('bench/frozen/tasks/x/prompt.txt')).toBe(true);
    expect(isFrozenPath('src/bench/frozen.ts')).toBe(false);
    expect(isFrozenPath('bench/frozen')).toBe(true);
    expect(isTestPath('calc.test.mjs')).toBe(true);
    expect(isTestPath('test_calc.py')).toBe(true);
    expect(isTestPath('calc.mjs')).toBe(false);
  });

  it('refuses a target under bench/frozen', async () => {
    const root = tmp('mochi-curr-frozen-');
    mkdirSync(join(root, 'bench', 'frozen'), { recursive: true });
    writeFileSync(join(root, 'bench', 'frozen', 'x.mjs'), CALC);
    await expect(generateCurriculumTask({ repoRoot: root, sourceFile: 'bench/frozen/x.mjs', testCommand: TEST_CMD }))
      .rejects.toMatchObject({ name: 'CurriculumError', code: 'guard' });
  });

  it('refuses a blocklisted instance id and base commit', () => {
    const root = tmp('mochi-curr-bl-');
    const blPath = join(root, 'eval_blocklist.json');
    writeFileSync(blPath, JSON.stringify({
      kind: 'mochi-eval-blocklist', version: 1,
      datasets: [{ id: 'synthetic', instance_ids: ['blocked-inst'], base_commits: ['deadbeef'], repo_commit_pairs: [{ repo: 'a/b', base_commit: 'cafe' }] }],
      extra_blocked: { instance_ids: ['frozen-task-1'], base_commits: [], repo_commit_pairs: [] },
    }));
    const blocked = loadBlockedIds([blPath]);
    expect(blocked.instanceIds.has('blocked-inst')).toBe(true);
    expect(blocked.instanceIds.has('frozen-task-1')).toBe(true);
    expect(() => assertCurriculumTargetAllowed({ repoRoot: root, sourceFile: 'calc.mjs', instanceId: 'blocked-inst', blocklistPaths: [blPath] }))
      .toThrowError(/eval blocklist/);
    expect(() => assertCurriculumTargetAllowed({ repoRoot: root, sourceFile: 'calc.mjs', baseCommit: 'DEADBEEF', blocklistPaths: [blPath] }))
      .toThrowError(/eval blocklist/);
    expect(() => assertCurriculumTargetAllowed({ repoRoot: root, sourceFile: 'calc.mjs', repo: 'a/b', baseCommit: 'cafe', blocklistPaths: [blPath] }))
      .toThrowError(/eval blocklist/);
    expect(() => assertCurriculumTargetAllowed({ repoRoot: root, sourceFile: 'calc.mjs', instanceId: 'clean-inst', blocklistPaths: [blPath] }))
      .not.toThrow();
  });

  it('refuses test files as mutation targets', async () => {
    const repo = makeFixtureRepo();
    writeFileSync(join(repo, 'calc.test.mjs'), CALC);
    await expect(generateCurriculumTask({ repoRoot: repo, sourceFile: 'calc.test.mjs', testCommand: TEST_CMD }))
      .rejects.toMatchObject({ code: 'bad-target' });
  });

  it('refuses a target escaping the repo root', async () => {
    const repo = makeFixtureRepo();
    await expect(generateCurriculumTask({ repoRoot: repo, sourceFile: '../outside.mjs', testCommand: TEST_CMD }))
      .rejects.toMatchObject({ code: 'guard' });
  });
});

describe('generation — the falsifiable property', () => {
  it('injecting into a fixture repo yields a task: verifier red pre-fix, green with original restored, source untouched', async () => {
    const repo = makeFixtureRepo();
    const before = snapshotTree(repo);
    const task = await generateCurriculumTask({ repoRoot: repo, sourceFile: 'calc.mjs', testCommand: TEST_CMD });

    // Task shape + FAIL_TO_PASS evidence.
    expect(task.kind).toBe('mochi-curriculum-task');
    expect(task.sourceFile).toBe('calc.mjs');
    expect(task.mutatedContent).not.toBe(task.originalContent);
    expect(task.failToPass.length).toBeGreaterThan(0);
    expect(task.candidatesTried).toBeGreaterThanOrEqual(1);
    expect(task.prompt).toContain('FAIL_TO_PASS');
    expect(task.prompt).toContain('calc.mjs');

    // Materialize the buggy state in an isolated copy: verifier must FAIL.
    const dest = join(tmp('mochi-curr-practice-'), 'copy');
    const iso = await createIsolatedCopy(repo, dest);
    try {
      applyBugToWorkdir(task, iso.path);
      const buggy = await verifyWorkdir(task, iso.path);
      expect(buggy.passed).toBe(false);
      for (const id of task.failToPass) expect(buggy.failedTestIds).toContain(id);

      // Restore the original code: verifier must PASS (the fix exists and
      // is exactly the pre-injection state).
      restoreOriginalInWorkdir(task, iso.path);
      const fixed = await verifyWorkdir(task, iso.path);
      expect(fixed.passed).toBe(true);
      expect(fixed.failedTestIds).toEqual([]);
    } finally {
      await iso.cleanup();
    }

    // Hard rule 2: the source repo is byte-identical, no new files.
    expect(snapshotTree(repo)).toEqual(before);
  });

  it('skips non-flipping candidates until one validates', async () => {
    // deadEq's === is never exercised by the tests; add's + is. The first
    // enumerated candidate (=== in deadEq) must be tried and skipped.
    const src = [
      'export function deadEq(a, b) { return a === b; }',
      'export function add(a, b) { return a + b; }',
      'export function clampPositive(x) { return x > 0 ? x : 0; }',
      'export function isEqual(a, b) { return a === b; }',
      '',
    ].join('\n');
    const repo = makeFixtureRepo(src);
    const task = await generateCurriculumTask({ repoRoot: repo, sourceFile: 'calc.mjs', testCommand: TEST_CMD });
    expect(task.candidatesTried).toBeGreaterThan(1);
    // The validated bug flips at least one real test.
    expect(task.failToPass.length).toBeGreaterThan(0);
    expect(task.failToPass).not.toContain('dead');
  });

  it('refuses a source whose baseline is not green', async () => {
    const repo = makeFixtureRepo();
    writeFileSync(join(repo, 'run-tests.mjs'), 'process.exit(1);\n');
    await expect(generateCurriculumTask({ repoRoot: repo, sourceFile: 'calc.mjs', testCommand: TEST_CMD }))
      .rejects.toMatchObject({ code: 'not-green' });
  });

  it('refuses a module where no mutation flips a test', async () => {
    const repo = makeFixtureRepo('export function noop() { return 42; }\n');
    writeFileSync(join(repo, 'run-tests.mjs'), "console.log('PASS anything');\n");
    await expect(generateCurriculumTask({ repoRoot: repo, sourceFile: 'calc.mjs', testCommand: TEST_CMD }))
      .rejects.toBeInstanceOf(CurriculumError);
  });

  it('batch generation collects skips but rethrows guard violations', async () => {
    const repo = makeFixtureRepo();
    writeFileSync(join(repo, 'plain.mjs'), 'export const x = 1;\n');
    const { tasks, skipped } = await generateCurriculum({
      repoRoot: repo, sourceFiles: ['calc.mjs', 'plain.mjs', 'missing.mjs'], testCommand: TEST_CMD,
    });
    expect(tasks.length).toBe(1);
    expect(tasks[0].sourceFile).toBe('calc.mjs');
    expect(skipped.map((s) => s.sourceFile).sort()).toEqual(['missing.mjs', 'plain.mjs']);

    await expect(generateCurriculum({
      repoRoot: repo, sourceFiles: ['bench/frozen/x.mjs'], testCommand: TEST_CMD,
    })).rejects.toMatchObject({ code: 'guard' });
  });
});

describe('persistence', () => {
  it('save/load round-trips and tampering is detected', async () => {
    const repo = makeFixtureRepo();
    const task = await generateCurriculumTask({ repoRoot: repo, sourceFile: 'calc.mjs', testCommand: TEST_CMD });
    const outDir = tmp('mochi-curr-store-');
    const path = saveCurriculumTask(task, outDir);
    expect(existsSync(path)).toBe(true);
    const loaded = loadCurriculumTask(path);
    expect(loaded).toEqual(task);

    const tampered = { ...task, mutatedContent: task.mutatedContent + '\n// tampered\n' };
    const badPath = join(outDir, 'bad.json');
    writeFileSync(badPath, JSON.stringify(tampered));
    expect(() => loadCurriculumTask(badPath)).toThrowError(/hash mismatch/);
  });
});

describe('practice runs — isolated + token-capped', () => {
  async function fixtureTask(): Promise<{ repo: string; task: CurriculumTask }> {
    const repo = makeFixtureRepo();
    const task = await generateCurriculumTask({ repoRoot: repo, sourceFile: 'calc.mjs', testCommand: TEST_CMD, tokenCap: 1_000 });
    return { repo, task };
  }

  it('an agent that fixes the bug within cap passes; source repo untouched', async () => {
    const { repo, task } = await fixtureTask();
    const before = snapshotTree(repo);
    const result = await runPracticeAttempt({
      task,
      agent: async (t, workdir) => {
        restoreOriginalInWorkdir(t, workdir);
        return { tokensUsed: 500, detail: 'restored original' };
      },
    });
    expect(result.status).toBe('passed');
    expect(result.verifier?.passed).toBe(true);
    expect(snapshotTree(repo)).toEqual(before);
  });

  it('an agent that does nothing fails verification', async () => {
    const { task } = await fixtureTask();
    const result = await runPracticeAttempt({ task, agent: async () => ({ tokensUsed: 10 }) });
    expect(result.status).toBe('failed');
    expect(result.verifier?.passed).toBe(false);
  });

  it('over-cap attempts are discarded even when the fix is correct', async () => {
    const { task } = await fixtureTask();
    const result = await runPracticeAttempt({
      task,
      agent: async (t, workdir) => {
        restoreOriginalInWorkdir(t, workdir);
        return { tokensUsed: 1_001 };
      },
    });
    expect(result.status).toBe('over-cap');
    expect(result.verifier).toBeUndefined();
    expect(result.tokensUsed).toBe(1_001);
  });

  it('practice workdir is cleaned up afterwards', async () => {
    const { task } = await fixtureTask();
    let seenDir = '';
    const result = await runPracticeAttempt({
      task,
      agent: async (_t, workdir) => { seenDir = workdir; return { tokensUsed: 1 }; },
    });
    expect(result.status).toBe('failed');
    expect(seenDir).not.toBe('');
    expect(existsSync(seenDir)).toBe(false);
    expect(dirname(seenDir)).not.toBe(task.repoRoot);
  });

  it('refuses a practice dir inside the source repo', async () => {
    const repo = makeFixtureRepo();
    await expect(createIsolatedCopy(repo, join(repo, 'practice-copy')))
      .rejects.toMatchObject({ code: 'guard' });
  });
});

describe('progress gate', () => {
  const rec = (difficulty: 'easy' | 'medium' | 'hard', status: 'passed' | 'failed' | 'over-cap') =>
    ({ taskId: 't', difficulty, status, tokensUsed: 10, at: '2026-10-22T00:00:00.000Z' });

  it('holds with too little evidence, advances at high pass rate, retreats at low', () => {
    expect(evaluateProgress([rec('easy', 'passed')], 'easy').recommendation).toBe('hold');

    const strong = Array.from({ length: 4 }, () => rec('easy', 'passed'));
    const adv = evaluateProgress(strong, 'easy');
    expect(adv.recommendation).toBe('advance');
    expect(adv.passRate).toBe(1);

    const weak = [rec('hard', 'failed'), rec('hard', 'failed'), rec('hard', 'failed'), rec('hard', 'passed')];
    expect(evaluateProgress(weak, 'hard').recommendation).toBe('retreat');

    const mid = [rec('medium', 'passed'), rec('medium', 'passed'), rec('medium', 'failed'), rec('medium', 'failed')];
    expect(evaluateProgress(mid, 'medium').recommendation).toBe('hold');
  });

  it('over-cap attempts never count as evidence either way', () => {
    const records = [rec('easy', 'over-cap'), rec('easy', 'over-cap'), rec('easy', 'over-cap'), rec('easy', 'over-cap')];
    const ev = evaluateProgress(records, 'easy');
    expect(ev.attempts).toBe(0);
    expect(ev.recommendation).toBe('hold');
  });

  it('ledger records attempts, answers mastery, and round-trips JSON', () => {
    const progress = new CurriculumProgress();
    progress.record(
      { taskId: 'curr-a', status: 'passed', tokensUsed: 42, tokenCap: 100, detail: '', durationMs: 1 },
      'easy',
    );
    expect(progress.mastered('curr-a')).toBe(true);
    expect(isMastered(progress.records, 'curr-a')).toBe(true);
    expect(progress.mastered('curr-b')).toBe(false);
    const restored = CurriculumProgress.fromJSON(JSON.parse(JSON.stringify(progress.toJSON())));
    expect(restored.records).toEqual(progress.records);
    expect(restored.evaluate('easy').attempts).toBe(1);
  });
});
