import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  extractCandidate,
  failureSignature,
  loadReproPair,
  reproSynthEnabled,
  synthesizeRepro,
  type FailureRecord,
} from './repro-synth.js';
import { attachRepro, loadOrCreateAutopsy } from './autopsy.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'mochi-repro-synth-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Run a command in the fixture and capture its authentic output. */
function capture(cwd: string, argv: string[]): { status: number | null; output: string } {
  const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', timeout: 20_000 });
  return { status: r.status, output: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
}

// ---------------------------------------------------------------------------
// Scenario (a): failing test + noisy JSON fixture → isolate, shrink, pair
// ---------------------------------------------------------------------------

const TALLY_SRC = `export function tally(records) {
  let total = 0;
  for (const r of records) {
    if (typeof r.amount !== 'number') throw new TypeError('amount must be a number');
    total += r.amount;
  }
  return total;
}
`;
const TALLY_FIXED = `export function tally(records) {
  let total = 0;
  for (const r of records) {
    if (typeof r.amount !== 'number') continue;
    total += r.amount;
  }
  return total;
}
`;
const TALLY_TEST = `import { readFileSync } from 'node:fs';
import { tally } from '../src/tally.mjs';
const records = JSON.parse(readFileSync('./test/fixture.json', 'utf8'));
const expected = records.reduce((s, r) => s + (typeof r.amount === 'number' ? r.amount : 0), 0);
try {
  const got = tally(records);
  if (got !== expected) {
    console.error('FAIL tally sums records');
    console.error(\`AssertionError: expected \${got} to be \${expected}\`);
    process.exit(1);
  }
  console.log('PASS tally sums records');
} catch (e) {
  console.error('FAIL tally sums records');
  console.error(\`\${e.constructor.name}: \${e.message}\`);
  process.exit(1);
}
`;

function seedTallyRepo(dir: string): void {
  const w = (rel: string, content: string) => {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  w('src/tally.mjs', TALLY_SRC);
  w('test/tally.test.mjs', TALLY_TEST);
  const records = Array.from({ length: 24 }, (_, i) => ({ id: i + 1, amount: (i % 7) + 1 }));
  (records[13] as { amount: unknown }).amount = 'oops';
  w('test/fixture.json', JSON.stringify(records, null, 2) + '\n');
}

describe('repro synthesis — scenario (a): test failure with noisy fixture', () => {
  it('isolates the test, shrinks the fixture to the bad record, validates both directions, emits a pair', async () => {
    seedTallyRepo(root);
    const run = capture(root, ['node', 'test/tally.test.mjs']);
    expect(run.status).toBe(1);
    const record: FailureRecord = {
      repoRoot: root,
      text: `$ node test/tally.test.mjs\n${run.output}`,
      source: 'test-output',
      fixedFiles: { 'src/tally.mjs': TALLY_FIXED },
    };
    const outDir = join(root, 'pairs-out');
    const result = await synthesizeRepro(record, { outDir, scratchBase: tmpdir() });
    if (result.outcome !== 'validated') throw new Error(`expected validated, got ${result.outcome}: ${JSON.stringify(result)}`);
    expect(result.candidate.command).toBe('node test/tally.test.mjs');
    expect(result.candidate.implicatedFile).toBe('test/tally.test.mjs');
    expect(result.validation.baseExitCode).toBe(1);
    expect(result.validation.baseSignatureMatched).toBe(true);
    expect(result.validation.fixedPassed).toBe(true);
    // Shrinking: 24 records → exactly the one bad record, proven 1-minimal.
    expect(result.shrink).toBeDefined();
    expect(result.shrink!.granularity).toBe('json-elements');
    expect(result.shrink!.beforeUnits).toBe(24);
    expect(result.shrink!.afterUnits).toBe(1);
    expect(result.shrink!.afterBytes).toBeLessThan(result.shrink!.beforeBytes / 4);
    expect(result.shrink!.oneMinimal).toBe(true);
    expect(result.shrink!.oracleCalls).toBeGreaterThan(0);
    // The pair: FAIL_TO_PASS shape, loadable, tamper-checked.
    expect(result.pair).toBeDefined();
    expect(result.pair!.failToPass).toEqual(['node test/tally.test.mjs']);
    expect(result.pairPath).toBeDefined();
    expect(existsSync(result.pairPath!)).toBe(true);
    const loaded = loadReproPair(result.pairPath!);
    expect(loaded.id).toBe(result.pair!.id);
    const shrunkRecords = JSON.parse(loaded.inputAfter!) as Array<{ amount: unknown }>;
    expect(shrunkRecords).toHaveLength(1);
    expect(shrunkRecords[0].amount).toBe('oops');
  }, 60_000);

  it('in-place mode validates the base direction only — no shrink, no pair', async () => {
    seedTallyRepo(root);
    const run = capture(root, ['node', 'test/tally.test.mjs']);
    const result = await synthesizeRepro({
      repoRoot: root,
      text: `$ node test/tally.test.mjs\n${run.output}`,
      source: 'test-output',
      fixedFiles: { 'src/tally.mjs': TALLY_FIXED },
    }, { inPlace: true });
    if (result.outcome !== 'validated') throw new Error(`expected validated, got ${result.outcome}`);
    expect(result.shrink).toBeUndefined();
    expect(result.pair).toBeUndefined();
    expect(result.validation.fixedPassed).toBeUndefined();
    // In-place mode must not write anything into the real tree.
    expect(existsSync(join(root, '.mochi'))).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Scenario (b): stack-trace script error → minimal script repro
// ---------------------------------------------------------------------------

describe('repro synthesis — scenario (b): stack-trace script error', () => {
  it('reduces the entry call and shrinks the CSV to the load-bearing rows', async () => {
    write('lib/stats.mjs', `export function average(values) {
  if (values.length === 0) throw new RangeError('average of empty series');
  let sum = 0;
  for (const v of values) {
    if (v === null) throw new TypeError('null reading in series');
    sum += v;
  }
  return sum / values.length;
}
`);
    write('tools/report.mjs', `import { readFileSync } from 'node:fs';
import { average } from '../lib/stats.mjs';
const rows = readFileSync('./data/rows.csv', 'utf8').trim().split('\\n').slice(1);
const values = rows.map((line) => {
  const raw = line.split(',')[1];
  return raw === '' ? null : Number(raw);
});
console.log('average', average(values));
`);
    const rows = ['sensor,value', ...Array.from({ length: 12 }, (_, i) => `s${i + 1},${10 + i}`)];
    rows[7] = 's7,';
    write('data/rows.csv', rows.join('\n') + '\n');

    const run = capture(root, ['node', 'tools/report.mjs']);
    expect(run.status).toBe(1);
    expect(run.output).toContain('TypeError: null reading in series');
    const result = await synthesizeRepro({
      repoRoot: root,
      text: run.output,
      source: 'stack-trace',
      entryCommand: 'node tools/report.mjs',
    }, { scratchBase: tmpdir() });
    if (result.outcome !== 'validated') throw new Error(`expected validated, got ${result.outcome}: ${JSON.stringify(result)}`);
    expect(result.candidate.kind).toBe('script');
    expect(result.candidate.command).toBe('node tools/report.mjs');
    // Throw site (first in-tree stack frame) is implicated, not the entry.
    expect(result.candidate.implicatedFile).toBe('lib/stats.mjs');
    expect(result.pair).toBeUndefined(); // no fix supplied → no pair
    expect(result.shrink).toBeDefined();
    expect(result.shrink!.granularity).toBe('lines');
    expect(result.shrink!.beforeUnits).toBe(13);
    expect(result.shrink!.afterUnits).toBeLessThanOrEqual(3);
    expect(result.shrink!.afterBytes).toBeLessThan(result.shrink!.beforeBytes);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Scenario (c): non-reproducing failure → explicit NO-REPRO, no pair
// ---------------------------------------------------------------------------

describe('repro synthesis — scenario (c): transient failure', () => {
  it('returns no-repro with diagnostics and writes nothing to the curriculum', async () => {
    write('test/flaky.test.mjs', `console.log('PASS health endpoint');\n`);
    const outDir = join(root, 'pairs-out');
    const result = await synthesizeRepro({
      repoRoot: root,
      text: 'FAIL test/flaky.test.mjs > health endpoint\nAssertionError: expected 200 to be 503',
      source: 'test-output',
    }, { outDir, scratchBase: tmpdir() });
    expect(result.outcome).toBe('no-repro');
    if (result.outcome === 'no-repro') {
      expect(result.stage).toBe('base');
      expect(result.diagnostics).toContain('did not reproduce');
    }
    expect(existsSync(outDir)).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Scenario (d): frozen / blocklist-derived failures → refused
// ---------------------------------------------------------------------------

describe('repro synthesis — scenario (d): eval-hygiene guard', () => {
  it('refuses a failure whose implicated file is under bench/frozen', async () => {
    write('bench/frozen/tasks/demo/verify.mjs', `throw new Error('frozen verifier exploded');\n`);
    const run = capture(root, ['node', 'bench/frozen/tasks/demo/verify.mjs']);
    expect(run.status).toBe(1);
    const result = await synthesizeRepro({
      repoRoot: root,
      text: run.output,
      source: 'stack-trace',
      entryCommand: 'node bench/frozen/tasks/demo/verify.mjs',
    }, { scratchBase: tmpdir() });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.reason).toContain('bench/frozen');
  }, 60_000);

  it('refuses a failure whose instance id is on the eval blocklist', async () => {
    seedTallyRepo(root);
    write('bench/frozen/blocklist-additions.json', JSON.stringify({
      extra_blocked: { instance_ids: ['swe-bench-xyz-123'] },
    }));
    const run = capture(root, ['node', 'test/tally.test.mjs']);
    const result = await synthesizeRepro({
      repoRoot: root,
      text: `$ node test/tally.test.mjs\n${run.output}`,
      source: 'test-output',
      instanceId: 'swe-bench-xyz-123',
    }, { scratchBase: tmpdir() });
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.reason).toContain('blocklist');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Units: signature, extraction, kill-switch, autopsy attachment
// ---------------------------------------------------------------------------

describe('repro synthesis — units', () => {
  it('extracts failure signatures from common shapes', () => {
    expect(failureSignature('x\nTypeError: amount must be a number\n at f')).toBe('TypeError: amount must be a number');
    expect(failureSignature('AssertionError: expected 3 to be 4')).toContain('expected 3 to be 4');
    expect(failureSignature('all quiet here')).toBeUndefined();
  });

  it('extracts nothing from anchorless material', () => {
    const r = extractCandidate({ repoRoot: root, text: 'the thing is broken somehow', source: 'task-text' });
    expect('reason' in r).toBe(true);
  });

  it('honours the MOCHI_REPRO_SYNTH=0 kill-switch', () => {
    expect(reproSynthEnabled({})).toBe(true);
    expect(reproSynthEnabled({ MOCHI_REPRO_SYNTH: '0' })).toBe(false);
    expect(reproSynthEnabled({ MOCHI_REPRO_SYNTH: '1' })).toBe(true);
  });

  it('attaches a synthesis result to the autopsy record', () => {
    const ws = join(root, 'ws');
    mkdirSync(ws, { recursive: true });
    let a = loadOrCreateAutopsy(ws, 'task-repro-1', 'agent-1', 'Fix tally');
    a = attachRepro(ws, a, {
      outcome: 'validated',
      command: 'node test/tally.test.mjs',
      pairId: 'repro-abc123',
      shrinkRatio: 0.1,
      note: 'isolated failing test file test/tally.test.mjs',
    });
    expect(a.repro?.command).toBe('node test/tally.test.mjs');
    const reloaded = loadOrCreateAutopsy(ws, 'task-repro-1', 'agent-1', 'Fix tally');
    expect(reloaded.repro?.pairId).toBe('repro-abc123');
    const files = readdirSync(join(ws, 'autopsies'));
    expect(files).toContain('task-repro-1.json');
  });
});
