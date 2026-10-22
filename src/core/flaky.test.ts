// Flaky-test quarantine: parser, bounded re-run classification, registry
// scoring/decay, and the anti-gaming partition. All deterministic — the
// analyzer takes an injected runner, so no real test suites execute here.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  analyzeFailure, applyFlakyDecay, commandFlakeId, emptyFlakyRegistry, flakeCommandKey,
  flakeFileOf, isKnownFlaky, isKnownFlakyCommand, knownFlakyCommandKeys, loadFlakyRegistry,
  parseFailingTests, partitionFlakes, quarantinedEntries, recordCleanPass, recordFlakes,
  saveFlakyRegistry, FLAKE_DECAY_MS, KNOWN_FLAKE_SCORE, type FlakeRunResult,
} from './flaky.js';
import { Workspace } from '../workspace.js';

const VITEST_FAIL = [
  ' ❯ test/counter.test.js (2 tests | 1 failed)',
  '   × counter increments',
  ' FAIL  test/counter.test.js > counter increments',
  'AssertionError: expected 1 to be 2',
].join('\n');

describe('parseFailingTests', () => {
  it('extracts vitest FAIL chains and file banners without duplicates', () => {
    const ids = parseFailingTests(VITEST_FAIL);
    expect(ids).toContain('test/counter.test.js > counter increments');
    expect(ids).toContain('test/counter.test.js');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('extracts pytest, go, TAP, cargo, and jest shapes', () => {
    expect(parseFailingTests('FAILED tests/test_x.py::test_y - AssertionError: boom')).toContain('tests/test_x.py::test_y');
    expect(parseFailingTests('--- FAIL: TestAdd (0.01s)')).toContain('TestAdd');
    expect(parseFailingTests('not ok 12 - adds numbers')).toContain('adds numbers');
    expect(parseFailingTests('test math::tests::it_adds ... FAILED')).toContain('math::tests::it_adds');
    expect(parseFailingTests('● math › adds')).toContain('math › adds');
    expect(parseFailingTests('● Console')).toEqual([]);
    expect(parseFailingTests('everything is fine\n2 passed')).toEqual([]);
  });
});

describe('analyzeFailure', () => {
  const fail = (output: string): FlakeRunResult => ({ exitCode: 1, output });
  const pass: FlakeRunResult = { exitCode: 0, output: 'all green' };

  it('resolves a fail-then-pass as flaky with bounded attempts', async () => {
    let runs = 0;
    const a = await analyzeFailure('npm test', fail(VITEST_FAIL), async () => { runs++; return pass; });
    expect(a.eligible).toBe(true);
    expect(a.resolved).toBe(true);
    expect(a.attempts).toBe(2);
    expect(runs).toBe(1);
    expect(a.flakyIds).toContain('test/counter.test.js > counter increments');
    expect(a.consistentIds).toEqual([]);
  });

  it('classifies a consistent failure after exactly 1 + MAX reruns', async () => {
    let runs = 0;
    const a = await analyzeFailure('npm test', fail(VITEST_FAIL), async () => { runs++; return fail(VITEST_FAIL); });
    expect(a.resolved).toBe(false);
    expect(a.attempts).toBe(3); // first + 2 bounded re-runs, never more
    expect(runs).toBe(2);
    expect(a.consistentIds).toContain('test/counter.test.js > counter increments');
    expect(a.flakyIds).toEqual([]);
  });

  it('splits partial flakes from consistent failures per-test', async () => {
    const first = fail(' FAIL  test/a.test.js > alpha\n FAIL  test/b.test.js > beta');
    const later = fail(' FAIL  test/b.test.js > beta');
    const a = await analyzeFailure('npm test', first, async () => later);
    expect(a.resolved).toBe(false); // no green run observed — gate cannot certify
    expect(a.flakyIds).toEqual(['test/a.test.js > alpha']);
    expect(a.consistentIds).toEqual(['test/b.test.js > beta']);
  });

  it('refuses to re-run a wholesale-broken suite (failing set too large)', async () => {
    const big = fail(Array.from({ length: 6 }, (_, i) => ` FAIL  test/t${i}.test.js > case ${i}`).join('\n'));
    let runs = 0;
    const a = await analyzeFailure('npm test', big, async () => { runs++; return pass; });
    expect(a.eligible).toBe(false);
    expect(a.attempts).toBe(1);
    expect(runs).toBe(0);
  });

  it('treats the command as the flake unit when no ids parse (one extra attempt)', async () => {
    let runs = 0;
    const opaque = fail('something exploded, no test names here');
    const a = await analyzeFailure('node check.js', opaque, async () => { runs++; return pass; });
    expect(a.resolved).toBe(true);
    expect(a.flakyIds).toEqual([commandFlakeId('node check.js')]);
    const b = await analyzeFailure('node check.js', opaque, async () => { runs++; return opaque; });
    expect(b.resolved).toBe(false);
    expect(b.attempts).toBe(2); // unparsed: exactly one extra attempt
  });
});

describe('registry scoring + decay', () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

  function tmpWorkspace(): Workspace {
    dir = mkdtempSync(resolve(tmpdir(), 'mochi-flaky-'));
    const ws = new Workspace(dir, '.mochi');
    ws.ensure();
    return ws;
  }

  it('accumulates scores, persists atomically, and reloads', () => {
    const ws = tmpWorkspace();
    const reg = loadFlakyRegistry(ws, 1_000);
    recordFlakes(reg, 'npm test', ['test/a.test.js > alpha'], 'FAIL test/a.test.js > alpha\nAssertionError: x', 1_000);
    recordFlakes(reg, 'npm test', ['test/a.test.js > alpha'], 'FAIL again', 2_000);
    saveFlakyRegistry(ws, reg);
    expect(existsSync(resolve(dir!, '.mochi', 'state', 'flaky-tests.json'))).toBe(true);
    const reloaded = loadFlakyRegistry(ws, 2_500);
    const entry = reloaded.entries['test/a.test.js > alpha'];
    expect(entry.score).toBe(2);
    expect(entry.flakeEvents).toBe(2);
    expect(isKnownFlaky(reloaded, 'test/a.test.js > alpha')).toBe(true);
    expect(isKnownFlakyCommand(reloaded, 'npm test')).toBe(true);
    expect(knownFlakyCommandKeys(reloaded)).toEqual(['npm test']);
    expect(quarantinedEntries(reloaded).map((e) => e.id)).toEqual(['test/a.test.js > alpha']);
    // Example snippets are stored for triage.
    expect(entry.examples.join(' ')).toContain('AssertionError');
  });

  it('redacts secret-shaped text in stored examples', () => {
    // Built by concatenation: no literal secret-shaped string in this file.
    const secret = 'sk-ant-' + 'api03-' + 'A'.repeat(20);
    const reg = emptyFlakyRegistry(0);
    recordFlakes(reg, 'npm test', ['t1'], `Error: token ${secret} rejected`, 0);
    expect(reg.entries['t1'].examples[0]).not.toContain(secret);
    expect(reg.entries['t1'].examples[0]).toContain('[secret-redacted]');
  });

  it('decays scores by half per 14-day period and drops sub-threshold entries', () => {
    const reg = emptyFlakyRegistry(0);
    recordFlakes(reg, 'npm test', ['strong'], 'x', 0);
    recordFlakes(reg, 'npm test', ['strong'], 'x', 0);
    recordFlakes(reg, 'npm test', ['weak'], 'x', 0);
    reg.lastDecayAt = 0;
    expect(applyFlakyDecay(reg, FLAKE_DECAY_MS - 1)).toBe(false); // no full period yet
    expect(applyFlakyDecay(reg, FLAKE_DECAY_MS + 1)).toBe(true);
    expect(reg.entries['strong'].score).toBe(1);   // 2 → halved once
    expect(reg.entries['weak'].score).toBe(0.5);   // 1 → halved; 0.5 is not below the drop line
    applyFlakyDecay(reg, 2 * FLAKE_DECAY_MS + 2); // second period
    expect(reg.entries['weak']).toBeUndefined();  // 0.5 → 0.25 < 0.5 → cleared
    expect(reg.entries['strong'].score).toBe(0.5);
    expect(KNOWN_FLAKE_SCORE).toBe(2);
  });

  it('halves a command’s scores on a clean first-attempt pass', () => {
    const reg = emptyFlakyRegistry(0);
    recordFlakes(reg, 'npm test', ['a'], 'x', 0);
    recordFlakes(reg, 'npm test', ['a'], 'x', 0);
    recordFlakes(reg, 'npm run build', ['b'], 'x', 0);
    expect(recordCleanPass(reg, 'npm test')).toBe(true);
    expect(reg.entries['a'].score).toBe(1);
    expect(reg.entries['b'].score).toBe(1); // other command untouched
    expect(recordCleanPass(reg, 'npm test')).toBe(true);
    expect(reg.entries['a'].score).toBe(0.5); // still tracked at the boundary
    expect(recordCleanPass(reg, 'npm test')).toBe(true);
    expect(reg.entries['a']).toBeUndefined(); // 0.25 < 0.5 → cleared
    expect(recordCleanPass(reg, 'npm test')).toBe(false); // nothing left to change
  });

  it('normalizes command keys (cd prefix is not part of identity)', () => {
    expect(flakeCommandKey('cd sub && npm test')).toBe('npm test');
    expect(commandFlakeId('cd sub && npm test')).toBe('cmd:npm test');
  });
});

describe('partitionFlakes (anti-gaming)', () => {
  it('denies flakes in files the run changed, flags own targets, excuses the rest', () => {
    const ids = [
      'test/own.test.js > edited case',
      'test/target.test.js > target case',
      'test/other.test.js > unrelated case',
      'TestNameOnly',
    ];
    const parts = partitionFlakes(ids, ['test/own.test.js'], ['test/target.test.js']);
    expect(parts.ownEdit).toEqual(['test/own.test.js > edited case']);
    expect(parts.excused).toContain('test/target.test.js > target case');
    expect(parts.ownTarget).toEqual(['test/target.test.js > target case']);
    expect(parts.excused).toContain('test/other.test.js > unrelated case');
    expect(parts.excused).toContain('TestNameOnly'); // no file → cannot be own-edit
  });

  it('flakeFileOf extracts files from vitest chains and pytest node ids only', () => {
    expect(flakeFileOf('test/a.test.js > case')).toBe('test/a.test.js');
    expect(flakeFileOf('tests/test_x.py::test_y')).toBe('tests/test_x.py');
    expect(flakeFileOf('TestAdd')).toBeUndefined();
    expect(flakeFileOf('cmd:npm test')).toBeUndefined();
  });
});
