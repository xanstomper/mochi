// targets.test.mjs — contract tests for the TB 4.0 / SWE-bench Pro V2
// adapters. Everything runs offline against the fixtures in ./fixtures:
//   - TOML format parser round-trip on a real-format fixture task.toml
//   - TB4 enumeration + validation (incl. rejection of a tests-less task)
//   - TB4 oracle dry-run THROUGH the existing terminalbench.mjs harness
//   - Pro V2 validation, string-encoded list coercion, Hard-split selection
//     (field signal, ids-file signal, and refusal when neither exists)
//   - normalization drops the gold patch; eval-purpose guard fails closed
//   - blocklist cross-check detects a blocked instance
// Run: node --test bench/external/targets.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseToml, stringifyToml, enumerateTb4, loadTb4Task, materializeTb4Shadow, runTb4,
  emitProV2Dataset, selectProV2Split, proV2SplitOf, validateProV2Record,
  assertEvalPurpose, checkAgainstBlocklist, TB4_TARGET, PRO_V2_TARGET,
} from './targets.mjs';
import { createBlocklist, readRecordsFile } from './blocklist.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TB4_FIXTURES = join(HERE, 'fixtures', 'tb4');
const TB4_INVALID = join(HERE, 'fixtures', 'tb4-invalid');
const PRO_FIXTURE = join(HERE, 'fixtures', 'swebench-pro-v2.jsonl');
const HARD_IDS = join(HERE, 'fixtures', 'swebench-pro-v2-hard-ids.txt');

test('TOML parser round-trips a Harbor-format task.toml', () => {
  const text = readFileSync(join(TB4_FIXTURES, 'fix-csv-sum', 'task.toml'), 'utf8');
  const once = parseToml(text);
  assert.equal(once.task.name, 'mochi-fixtures/fix-csv-sum');
  assert.equal(once.agent.timeout_sec, 600);
  assert.deepEqual(once.metadata.tags, ['csv', 'shell', 'fixture']);
  const twice = parseToml(stringifyToml(once));
  assert.deepEqual(twice, once);
});

test('TB4 enumeration parses and validates the fixture tasks', () => {
  const { tasks, invalid, warnings } = enumerateTb4(TB4_FIXTURES);
  assert.equal(invalid.length, 0);
  assert.equal(tasks.length, 2);
  const csv = tasks.find((t) => t.task_id === 'fix-csv-sum');
  assert.equal(csv.target, TB4_TARGET);
  assert.equal(csv.eval_only, true);
  assert.equal(csv.difficulty, 'easy');
  assert.deepEqual(csv.tags, ['csv', 'shell', 'fixture']);
  assert.equal(csv.agent_timeout_sec, 600);
  assert.equal(csv.verifier_timeout_sec, 120);
  assert.equal(csv.needs_docker, true); // ships a Dockerfile
  assert.equal(csv.has_solution, true);
  assert.match(csv.instruction, /data\.csv/);
  const report = tasks.find((t) => t.task_id === 'env-report');
  assert.equal(report.needs_docker, false);
  assert.equal(report.has_solution, false);
  assert.equal(warnings.length, 0);
});

test('TB4 task without tests/test.sh is rejected with a named error', () => {
  const { descriptor, errors } = loadTb4Task(join(TB4_INVALID, 'missing-tests'));
  assert.equal(descriptor, null);
  assert.ok(errors.some((e) => /tests\/test\.sh/.test(e)), `errors should name tests/test.sh: ${errors}`);
  const { tasks, invalid } = enumerateTb4(TB4_INVALID);
  assert.equal(tasks.length, 0);
  assert.equal(invalid.length, 1);
});

test('TB4 shadow materialization excludes Docker files and wires the oracle stub', () => {
  const { tasks } = enumerateTb4(TB4_FIXTURES);
  const csv = tasks.find((t) => t.task_id === 'fix-csv-sum');
  const root = mkdtempSync(join(tmpdir(), 'mochi-tb4-test-'));
  try {
    const row = materializeTb4Shadow(csv, root);
    assert.ok(existsSync(join(row.task_dir, 'instruction.md')));
    assert.ok(existsSync(join(row.task_dir, 'files', 'data.csv')));
    assert.ok(!existsSync(join(row.task_dir, 'files', 'Dockerfile')), 'Dockerfile must not leak into the thin-runner shadow');
    assert.match(readFileSync(join(row.task_dir, 'tests', 'run-tests.sh'), 'utf8'), /tests\/test\.sh/);
    assert.ok(existsSync(join(row.task_dir, 'stub.sh')), 'solution/solve.sh should become the dry-run oracle stub');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('TB4 oracle dry-run passes through the existing terminalbench harness', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'mochi-tb4-run-')), 'results.jsonl');
  const r = runTb4({ tasksDir: TB4_FIXTURES, dryRun: true, out });
  assert.equal(r.status, 0, `terminalbench exited ${r.status}: ${r.stderr}`);
  const results = readFileSync(out, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const csv = results.find((x) => x.task_id === 'fix-csv-sum');
  const report = results.find((x) => x.task_id === 'env-report');
  assert.equal(csv.passed, true, `oracle solution should pass its own tests: ${JSON.stringify(csv)}`);
  assert.equal(report.passed, false, 'no stub + no agent must fail — the harness has to discriminate');
  rmSync(r.shadowRoot, { recursive: true, force: true });
});

test('Pro V2 fixtures validate; string-encoded test lists coerce', () => {
  const records = readRecordsFile(PRO_FIXTURE);
  assert.equal(records.length, 4);
  for (const rec of records) assert.deepEqual(validateProV2Record(rec), [], `fixture ${rec.instance_id} should be valid`);
  const { records: emitted } = emitProV2Dataset(records, { split: 'all' });
  const coerced = emitted.find((r) => r.instance_id === 'example__widgets-102');
  assert.deepEqual(coerced.FAIL_TO_PASS, ['tests/test_cache.py::test_expiry']);
  assert.deepEqual(coerced.PASS_TO_PASS, []);
});

test('Pro V2 normalization drops gold patches and stamps provenance', () => {
  const records = readRecordsFile(PRO_FIXTURE);
  const { records: emitted } = emitProV2Dataset(records, { split: 'all' });
  for (const rec of emitted) {
    assert.equal('patch' in rec, false, 'gold patch must never be emitted');
    assert.equal('test_patch' in rec, false);
    assert.equal(rec.target, PRO_V2_TARGET);
    assert.equal(rec.eval_only, true);
  }
});

test('Pro V2 Hard split: field signal, ids-file signal, and refusal without either', () => {
  const records = readRecordsFile(PRO_FIXTURE);
  assert.equal(proV2SplitOf(records[0]), 'hard');
  assert.equal(proV2SplitOf(records[3]), null);
  const byField = selectProV2Split(records, 'hard', {});
  assert.deepEqual(byField.records.map((r) => r.instance_id), ['example__widgets-101', 'example__widgets-102']);
  const ids = readFileSync(HARD_IDS, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const withIds = selectProV2Split(records, 'hard', { ids });
  assert.ok(withIds.records.some((r) => r.instance_id === 'example__gadgets-8'), 'ids file must add the unmarked Hard task');
  const unsignalled = records.map(({ split, ...rest }) => rest);
  assert.throws(() => selectProV2Split(unsignalled, 'hard', {}), /cannot determine Hard-split membership/);
});

test('Pro V2 invalid records are hard errors, not warnings', () => {
  const bad = [{ instance_id: 'x__y-1', repo: 'not-a-repo', base_commit: 'short', problem_statement: '', FAIL_TO_PASS: [], PASS_TO_PASS: [] }];
  assert.ok(validateProV2Record(bad[0]).length >= 3);
  assert.throws(() => emitProV2Dataset(bad, {}), /invalid SWE-bench Pro V2 record/);
});

test('eval-purpose guard fails closed for training-shaped use', () => {
  assert.doesNotThrow(() => assertEvalPurpose(TB4_TARGET, 'eval'));
  assert.throws(() => assertEvalPurpose(TB4_TARGET, 'train'), /REFUSED/);
  assert.throws(() => assertEvalPurpose(PRO_V2_TARGET, 'curriculum-generation'), /REFUSED/);
  assert.throws(() => assertEvalPurpose(PRO_V2_TARGET, undefined), /REFUSED/);
});

test('blocklist cross-check flags a blocked eval instance', () => {
  const bl = createBlocklist({ datasets: [{ id: 'synthetic', instance_ids: ['example__widgets-101'], base_commits: [], repos: [] }] });
  const records = readRecordsFile(PRO_FIXTURE);
  const hits = checkAgainstBlocklist(records, bl);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].matched, 'example__widgets-101');
});
