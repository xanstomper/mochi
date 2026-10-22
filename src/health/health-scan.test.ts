// Proactive repo health scan (Wave O3): the falsifiable criteria are
//   (i)   a healthy fixture repo → SHORT all-clear digest, tree untouched;
//   (ii)  a broken fixture (failing tests, TODO growth, a dead file) →
//         the digest ranks all three with evidence, tests first;
//   (iii) unchanged HEAD → the test command is NOT re-run (counting cmd);
//   (iv)  a finding whose check stops running expires instead of haunting
//         (and its project-memory fact is pruned).
// Fixtures are real git repos in tmpdirs; the test command is a counting
// node script whose pass/fail mode is controlled from OUTSIDE the repo.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import {
  runHealthScan, detectTestCommand, parseTestCounts, defaultCommandRunner, healthStatePath,
  type CommandRunner,
} from './health-scan.js';
import { createHealthScanStep } from './health-step.js';
import { defaultSleeptimeSteps, runSleeptime } from '../sleeptime/orchestrator.js';
import { loadProjectMemory } from '../memory/project-memory.js';

const COUNT_FILE = join(tmpdir(), `mochi-health-count-${process.pid}.txt`);

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.email=health@test', '-c', 'user.name=health', ...args], { cwd: dir, stdio: 'pipe' });
}

function writeRepo(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  git(dir, ['init', '-q']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
}

/** Counting test script: bumps a counter OUTSIDE the repo, prints a
 *  vitest-shaped summary, passes/fails per a mode file next to the counter. */
const RUN_TESTS = `
const fs = require('node:fs');
const countFile = process.env.MOCHI_HEALTH_COUNT_FILE;
fs.appendFileSync(countFile, 'x');
let mode = 'pass';
try { mode = fs.readFileSync(countFile + '.mode', 'utf8').trim(); } catch {}
if (mode === 'fail') { console.log('Tests  3 failed | 38 passed (41)'); process.exit(1); }
console.log('Tests  41 passed (41)');
`;

function baseFiles(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { test: 'node run-tests.js' } }, null, 2),
    'package-lock.json': JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages: {} }, null, 2),
    'run-tests.js': RUN_TESTS,
    'src/index.ts': `import { util } from './util.js';\nexport const main = () => util();\n`,
    'src/util.ts': `export const util = () => 42;\n`,
    ...extra,
  };
}

function treeHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (cur: string): void => {
    for (const name of readdirSync(cur).sort()) {
      if (name === '.git' || name === '.mochi') continue;
      const full = join(cur, name);
      if (statSync(full).isDirectory()) walk(full);
      else { h.update(full.slice(dir.length)); h.update(readFileSync(full)); }
    }
  };
  walk(dir);
  return h.digest('hex');
}

function setMode(mode: 'pass' | 'fail'): void {
  writeFileSync(COUNT_FILE + '.mode', mode);
}
function runCount(): number {
  return existsSync(COUNT_FILE) ? readFileSync(COUNT_FILE, 'utf8').length : 0;
}

let proj: string;
beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'mochi-health-'));
  rmSync(COUNT_FILE, { force: true });
  rmSync(COUNT_FILE + '.mode', { force: true });
  process.env.MOCHI_HEALTH_COUNT_FILE = COUNT_FILE;
  setMode('pass');
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
  rmSync(COUNT_FILE, { force: true });
  rmSync(COUNT_FILE + '.mode', { force: true });
  delete process.env.MOCHI_HEALTH_COUNT_FILE;
});

describe('runHealthScan fixtures', () => {
  it('(i) healthy repo → all-clear digest, tree hash unchanged', async () => {
    writeRepo(proj, baseFiles({ 'src/util.ts': 'export const util = () => 42; // TODO: one day\n' }));
    const before = treeHash(proj);
    const r = await runHealthScan(proj, { offline: true });
    expect(r.allClear).toBe(true);
    expect(r.findings).toEqual([]);
    expect(r.digest).toContain('All clear');
    expect(r.checks.find((c) => c.id === 'tests')?.note).toContain('tests green (41 passed)');
    expect(r.testsCached).toBe(false);
    expect(runCount()).toBe(1);
    expect(treeHash(proj)).toBe(before);
    expect(existsSync(healthStatePath(proj))).toBe(true);
  }, 30_000);

  it('(ii) broken repo → failing tests, TODO growth and dead file, ranked with evidence', async () => {
    writeRepo(proj, baseFiles({
      'src/util.ts': 'export const util = () => 42; // TODO one\n// FIXME two\n',
      'src/dead.ts': 'export const dead = () => 0;\n',
    }));
    setMode('fail');
    const first = await runHealthScan(proj, { offline: true });
    const ids1 = first.findings.map((f) => f.id);
    expect(ids1).toContain('tests:failing');
    expect(first.findings[0].id).toBe('tests:failing'); // high × measured ranks first
    expect(first.findings[0].evidence).toContain('npm test');
    const dead = first.findings.find((f) => f.check === 'dead-code');
    expect(dead).toBeDefined();
    expect(dead!.evidence).toContain('src/dead.ts');
    expect(dead!.evidenceStrength).toBe('heuristic');

    // Grow the markers in the working tree; HEAD (and the test cache) stay.
    appendFileSync(join(proj, 'src/util.ts'), '// TODO a\n// TODO b\n// TODO c\n// TODO d\n// TODO e\n// TODO f\n');
    const second = await runHealthScan(proj, { offline: true });
    const ids2 = second.findings.map((f) => f.id);
    expect(ids2).toContain('tests:failing');
    expect(ids2).toContain('todos:growth');
    expect(second.findings.some((f) => f.check === 'dead-code')).toBe(true);
    expect(second.findings[0].id).toBe('tests:failing');
    expect(second.digest).toContain('Tests failing on HEAD');
    expect(second.digest).toContain('TODO/FIXME markers grew by 6');
    // The failing-tests finding is mirrored into project memory with expiry.
    const mem = loadProjectMemory(proj);
    expect(mem).toContain('[health]');
    expect(mem).toContain('Expires');
  }, 30_000);

  it('(iii) unchanged HEAD → cached, no re-run; moved HEAD → re-run', async () => {
    writeRepo(proj, baseFiles());
    const a = await runHealthScan(proj, { offline: true });
    expect(a.testsCached).toBe(false);
    expect(runCount()).toBe(1);
    const b = await runHealthScan(proj, { offline: true });
    expect(b.testsCached).toBe(true);
    expect(runCount()).toBe(1); // the counting command did NOT run again
    expect(b.checks.find((c) => c.id === 'tests')?.note).toContain('cached');

    appendFileSync(join(proj, 'src/util.ts'), 'export const more = 1;\n');
    git(proj, ['add', '-A']);
    git(proj, ['commit', '-q', '-m', 'change']);
    const c = await runHealthScan(proj, { offline: true });
    expect(c.testsCached).toBe(false);
    expect(runCount()).toBe(2);
  }, 30_000);

  it('(iv) findings expire when their check stops running; memory facts pruned', async () => {
    writeRepo(proj, baseFiles({ 'src/dead.ts': 'export const dead = () => 0;\n' }));
    const t0 = new Date();
    const first = await runHealthScan(proj, { offline: true, now: t0 });
    expect(first.findings.some((f) => f.check === 'dead-code')).toBe(true);
    expect(loadProjectMemory(proj)).toContain('[health]');

    // Remove src/ entirely → the dead-code check now skips.
    rmSync(join(proj, 'src'), { recursive: true, force: true });
    const dayMs = 24 * 60 * 60 * 1000;
    const soon = await runHealthScan(proj, { offline: true, now: new Date(t0.getTime() + dayMs) });
    expect(soon.findings.some((f) => f.check === 'dead-code')).toBe(true); // carried, not yet expired
    expect(soon.expiredCount).toBe(0);

    const later = await runHealthScan(proj, { offline: true, now: new Date(t0.getTime() + 15 * dayMs) });
    expect(later.findings.some((f) => f.check === 'dead-code')).toBe(false);
    expect(later.expiredCount).toBeGreaterThanOrEqual(1);
    expect(loadProjectMemory(proj)).not.toContain('[health]');
  }, 30_000);

  it('deps probe: network failure reports skipped-offline; outdated JSON becomes a finding', async () => {
    writeRepo(proj, baseFiles());
    const stub = (mode: 'netfail' | 'outdated'): CommandRunner => async (cmd, cwd, timeoutMs) => {
      if (cmd.includes('npm outdated')) {
        return mode === 'netfail'
          ? { code: 1, out: 'npm error code ENOTFOUND\nnpm error network getaddrinfo ENOTFOUND registry.npmjs.org', timedOut: false }
          : { code: 1, out: JSON.stringify({ leftpad: { current: '1.0.0', latest: '2.0.0' }, tiny: { current: '0.1.0', latest: '0.2.0' } }), timedOut: false };
      }
      return defaultCommandRunner(cmd, cwd, timeoutMs);
    };
    const netfail = await runHealthScan(proj, { runner: stub('netfail') });
    expect(netfail.checks.find((c) => c.id === 'deps')?.note).toContain('probe skipped: offline');
    expect(netfail.findings.some((f) => f.id === 'deps:outdated')).toBe(false);

    const outdated = await runHealthScan(proj, { runner: stub('outdated'), forceTests: true });
    const f = outdated.findings.find((x) => x.id === 'deps:outdated');
    expect(f).toBeDefined();
    expect(f!.title).toContain('2 dependencies');
    expect(f!.evidence).toContain('npm outdated');
  }, 30_000);

  it('non-git directory → git-dependent checks skip, scan still completes', async () => {
    writeRepo(proj, baseFiles());
    rmSync(join(proj, '.git'), { recursive: true, force: true });
    const r = await runHealthScan(proj, { offline: true });
    expect(r.head).toBeNull();
    expect(r.checks.find((c) => c.id === 'hotspots')?.status).toBe('skipped');
    expect(r.checks.find((c) => c.id === 'tests')?.status).toBe('ok');
  }, 30_000);
});

describe('sleeptime wiring', () => {
  it('the health step is part of the default sleeptime steps and completes in a run', async () => {
    expect(defaultSleeptimeSteps().map((s) => s.id)).toContain('health');
    writeRepo(proj, baseFiles());
    const report = await runSleeptime({
      projectDir: proj, spendCapUsd: 0, now: new Date(), steps: [createHealthScanStep()],
    });
    const step = report.steps.find((s) => s.id === 'health');
    expect(step).toBeDefined();
    expect(step!.units[0].status).toBe('completed');
    expect(step!.units[0].detail).toContain('all clear');
    expect(step!.units[0].costUsd).toBe(0); // model-free: never touches the cap
  }, 30_000);
});

describe('parsers', () => {
  it('parseTestCounts handles vitest, jest and pytest shapes', () => {
    expect(parseTestCounts('Tests  2 failed | 9 passed (11)')).toEqual({ failed: 2, passed: 9 });
    expect(parseTestCounts('Tests:       3 failed, 12 passed, 15 total')).toEqual({ failed: 3, passed: 12 });
    expect(parseTestCounts('===== 4 passed in 1.2s =====')).toEqual({ passed: 4 });
    expect(parseTestCounts('no numbers here')).toEqual({});
  });
  it('detectTestCommand prefers package.json, falls back to cargo', () => {
    writeRepo(proj, baseFiles());
    expect(detectTestCommand(proj)?.cmd).toBe('npm test');
    const bare = mkdtempSync(join(tmpdir(), 'mochi-health-bare-'));
    writeFileSync(join(bare, 'Cargo.toml'), '[package]\nname="x"\n');
    expect(detectTestCommand(bare)?.cmd).toBe('cargo test');
    rmSync(bare, { recursive: true, force: true });
  });
});
