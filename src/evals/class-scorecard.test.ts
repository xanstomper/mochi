// Class scorecard tests: end-to-end dry-run over the real in-tree sets,
// fixture discrimination (every checker fails unsolved / passes solved),
// contamination refusal, UNMEASURED honesty, inbox ingestion, and the
// append-only history guarantee.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ClassError, appendHistory, assertNoContentOverlap, currentStateSummaries,
  readHistory, renderScorecardTable, runScorecard, summarizeInbox, classDef,
  type ScorecardRecord,
} from './class-scorecard.js';
import { loadFrozenSet } from './regression-gate.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLASSES_DIR = join(REPO_ROOT, 'bench', 'classes');

let scratch: string;
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), 'mochi-classes-test-')); });
afterAll(() => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });

/** Run a task's verifier directly in a prepared workdir (the gate core does
 *  the same via a copied probe name; resolution is identical). */
function verifyIn(workdir: string): number {
  const r = spawnSync('node', ['verify.mjs'], { cwd: workdir, encoding: 'utf8', timeout: 60_000 });
  return r.status ?? 1;
}

function prepareWorkdir(taskDir: string, withSolution: boolean): string {
  const wd = mkdtempSync(join(tmpdir(), 'mochi-fixture-'));
  const files = join(taskDir, 'files');
  if (existsSync(files)) cpSync(files, wd, { recursive: true });
  if (withSolution) {
    const sol = join(taskDir, 'solution');
    if (existsSync(sol)) cpSync(sol, wd, { recursive: true });
  }
  cpSync(join(taskDir, 'verify.mjs'), join(wd, 'verify.mjs'));
  return wd;
}

describe('in-tree fixture sets load through the gate loader', () => {
  it('short has 12 tasks, medium has 8, hashes verified', () => {
    expect(loadFrozenSet(join(CLASSES_DIR, 'short')).tasks).toHaveLength(12);
    expect(loadFrozenSet(join(CLASSES_DIR, 'medium')).tasks).toHaveLength(8);
  });
});

describe('fixture discrimination (the honesty backbone)', () => {
  for (const cls of ['short', 'medium'] as const) {
    it(`every ${cls} checker fails on files/ and passes with solution/`, () => {
      const set = loadFrozenSet(join(CLASSES_DIR, cls));
      for (const task of set.tasks) {
        const unsolved = prepareWorkdir(task.absDir, false);
        try { expect(verifyIn(unsolved), `${task.id} must FAIL unsolved`).not.toBe(0); }
        finally { rmSync(unsolved, { recursive: true, force: true }); }
        const solved = prepareWorkdir(task.absDir, true);
        try { expect(verifyIn(solved), `${task.id} must PASS with its canned solution`).toBe(0); }
        finally { rmSync(solved, { recursive: true, force: true }); }
      }
    });
  }
});

describe('end-to-end scorecard run (dry-run, real tree)', () => {
  it('measures short/medium/complex, leaves browser UNMEASURED, appends history', async () => {
    const historyPath = join(scratch, 'history.jsonl');
    const record = await runScorecard({
      repoRoot: REPO_ROOT, k: 1, dryRun: true,
      classIds: ['short', 'medium', 'complex', 'browser'],
      historyPath,
    });
    const byId = new Map(record.classes.map((c) => [c.classId, c]));
    expect(byId.get('short')).toMatchObject({ status: 'measured', taskCount: 12, passRate: 1 });
    expect(byId.get('medium')).toMatchObject({ status: 'measured', taskCount: 8, passRate: 1 });
    expect(byId.get('complex')).toMatchObject({ status: 'measured', taskCount: 24, passRate: 1 });
    expect(byId.get('browser')).toMatchObject({ status: 'unmeasured', passRate: null });
    // Dry-run economics are present but labelled synthetic.
    const short = byId.get('short')!;
    expect(short.costPerSolveUsd).not.toBeNull();
    expect(short.costSynthetic).toBe(true);
    expect(short.medianTurns).not.toBeNull();
    expect(short.medianTokens).not.toBeNull();
    // The rendered table carries the honest vocabulary.
    const table = renderScorecardTable(record.classes);
    expect(table).toContain('Short tasks');
    expect(table).toContain('UNMEASURED');
    expect(table).toContain('synth');
    // History: exactly one record, and it round-trips.
    const history = readHistory(historyPath);
    expect(history).toHaveLength(1);
    expect(history[0].ts).toBe(record.ts);
  });
});

describe('disjointness guard', () => {
  function writeSet(dir: string, tasks: { id: string; prompt: string; verifier: string; extra?: string }[]): void {
    mkdirSync(dir, { recursive: true });
    const entries = tasks.map((t) => {
      const td = join(dir, 'tasks', t.id);
      mkdirSync(td, { recursive: true });
      writeFileSync(join(td, 'prompt.txt'), t.prompt);
      writeFileSync(join(td, 'verify.mjs'), t.verifier);
      if (t.extra) writeFileSync(join(td, 'extra.txt'), t.extra);
      return {
        id: t.id, source: 'test', provenance: 'test', category: 'fix',
        prompt: `tasks/${t.id}/prompt.txt`, verifier: `tasks/${t.id}/verify.mjs`, hash: '',
      };
    });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
      kind: 'mochi-frozen-gate-set', version: 1, frozenAt: '2026-10-22', setHash: '', tasks: entries,
    }, null, 2));
  }

  it('refuses a class task copied from another set (same prompt + verifier)', () => {
    const a = join(scratch, 'setA');
    const b = join(scratch, 'setB');
    writeSet(a, [{ id: 'orig-task', prompt: 'fix the thing', verifier: '// checks the thing' }]);
    writeSet(b, [{ id: 'copied-task', prompt: 'fix the thing', verifier: '// checks the thing', extra: 'padding' }]);
    expect(() => assertNoContentOverlap([{ setId: 'a', dir: a }, { setId: 'b', dir: b }])).toThrow(ClassError);
  });

  it('refuses a subset copy via content containment (prompt differs, files contained)', () => {
    const a = join(scratch, 'setA2');
    const b = join(scratch, 'setB2');
    // A's carrier task happens to contain, among its files, byte copies of
    // BOTH of B's task files (B's prompt text as a data file, B's verifier).
    writeSet(a, [{ id: 'carrier', prompt: 'carrier prompt', verifier: 'shared verifier', extra: 'shared prompt content' }]);
    writeSet(b, [{ id: 'subset-task', prompt: 'shared prompt content', verifier: 'shared verifier' }]);
    // Prompts differ, so only the containment rule can fire here.
    expect(() => assertNoContentOverlap([{ setId: 'a', dir: a }, { setId: 'b', dir: b }])).toThrow(/overlap/);
  });

  it('allows a single shared boilerplate file between different tasks', () => {
    const a = join(scratch, 'setA3');
    const b = join(scratch, 'setB3');
    writeSet(a, [{ id: 'task-a', prompt: 'do alpha', verifier: '// alpha checks', extra: 'shared boilerplate' }]);
    writeSet(b, [{ id: 'task-b', prompt: 'do beta', verifier: '// beta checks', extra: 'shared boilerplate' }]);
    expect(() => assertNoContentOverlap([{ setId: 'a', dir: a }, { setId: 'b', dir: b }])).not.toThrow();
  });
});

describe('missing fixture set → UNMEASURED, not zero, not an error', () => {
  it('runScorecard over a root without class sets reports short/browser as unmeasured', async () => {
    const root = join(scratch, 'bare-root');
    mkdirSync(join(root, 'bench', 'external'), { recursive: true });
    cpSync(join(REPO_ROOT, 'bench', 'frozen'), join(root, 'bench', 'frozen'), { recursive: true });
    for (const f of ['eval_blocklist.json', 'blocklist.mjs']) {
      cpSync(join(REPO_ROOT, 'bench', 'external', f), join(root, 'bench', 'external', f));
    }
    const record = await runScorecard({
      repoRoot: root, k: 1, dryRun: true,
      classIds: ['short', 'browser'],
      historyPath: join(scratch, 'bare-history.jsonl'),
      inboxRoot: join(root, 'bench', 'classes', 'inbox'),
    });
    const byId = new Map(record.classes.map((c) => [c.classId, c]));
    expect(byId.get('short')).toMatchObject({ status: 'unmeasured', passRate: null, taskCount: 0 });
    expect(byId.get('short')!.note).toMatch(/not present/);
    expect(byId.get('browser')).toMatchObject({ status: 'unmeasured', passRate: null });
    const table = renderScorecardTable(record.classes);
    expect(table).toContain('UNMEASURED');
    expect(table).not.toContain('0.0%');
  });

  it('currentStateSummaries marks fixture classes unmeasured without running anything', () => {
    const summaries = currentStateSummaries(REPO_ROOT, join(scratch, 'no-inbox'));
    const short = summaries.find((s) => s.classId === 'short')!;
    expect(short.status).toBe('unmeasured');
    expect(short.passRate).toBeNull();
  });
});

describe('inbox ingestion', () => {
  function inboxWith(file: unknown, name = 'run.json'): string {
    const root = join(scratch, `inbox-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, 'browser'), { recursive: true });
    writeFileSync(join(root, 'browser', name), typeof file === 'string' ? file : JSON.stringify(file));
    return root;
  }
  const valid = {
    kind: 'mochi-class-result', class: 'browser', source: 'test pack', mode: 'live',
    model: 'test/model', ts: '2026-10-22T12:00:00.000Z',
    tasks: [
      { id: 't1', trials: 4, passes: 3, medianTurns: 8, medianTokens: 40000, costPerSolveUsd: 0.5 },
      { id: 't2', trials: 2, passes: 2, medianTurns: 5, medianTokens: 20000, costPerSolveUsd: 0.25 },
    ],
  };

  it('ingests a valid result file with pass@1 + passes-weighted cost', () => {
    const s = summarizeInbox(classDef('browser'), inboxWith(valid));
    expect(s.status).toBe('measured');
    expect(s.passRate).toBeCloseTo((0.75 + 1) / 2, 10);
    expect(s.passes).toBe(5);
    expect(s.costPerSolveUsd).toBeCloseTo((0.5 * 3 + 0.25 * 2) / 5, 10);
    expect(s.costSynthetic).toBe(false);
    expect(s.model).toBe('test/model');
  });

  it('an empty inbox directory is UNMEASURED', () => {
    const root = join(scratch, 'inbox-empty');
    mkdirSync(join(root, 'browser'), { recursive: true });
    expect(summarizeInbox(classDef('browser'), root).status).toBe('unmeasured');
  });

  it('rejects malformed evidence loudly', () => {
    expect(() => summarizeInbox(classDef('browser'), inboxWith('{not json'))).toThrow(ClassError);
    expect(() => summarizeInbox(classDef('browser'), inboxWith({ ...valid, class: 'swe' }))).toThrow(/declares class/);
    expect(() => summarizeInbox(classDef('browser'), inboxWith({
      ...valid, tasks: [{ id: 'x', trials: 1, passes: 2 }],
    }))).toThrow(/passes exceeds trials/);
  });
});

describe('history is append-only', () => {
  it('appends records without rewriting earlier lines', () => {
    const path = join(scratch, 'append-history.jsonl');
    const rec = (ts: string): ScorecardRecord => ({
      kind: 'mochi-class-scorecard-run', ts, gitHead: 'abc', mode: 'dry-run', k: 1, classes: [],
    });
    appendHistory(path, rec('2026-10-22T00:00:00.000Z'));
    const afterFirst = readFileSync(path, 'utf8');
    appendHistory(path, rec('2026-10-22T01:00:00.000Z'));
    const afterSecond = readFileSync(path, 'utf8');
    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(afterSecond.trim().split('\n')).toHaveLength(2);
    expect(readHistory(path).map((r) => r.ts)).toEqual([
      '2026-10-22T00:00:00.000Z', '2026-10-22T01:00:00.000Z',
    ]);
  });
});
