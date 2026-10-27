// Item 15: the blast-radius gate (src/core/gate.ts) — seeded scenarios for
// the DEFAULT-gate policy: a leaf change selects its tests; shared/core
// surface and fan-out force the full suite; selection failure / timeout
// forces full; empty + undeterminable change sets; forced-full overrides;
// merge-base committed diffs; and the rationale output (present + accurate
// on every plan).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  planGateTests,
  formatGateRationale,
  determineChangeSet,
  mergeBaseOf,
  gateEnvFull,
  resolveAlwaysRun,
  isCoreSurface,
} from './gate.js';
import type { ImportGraph } from './test-selection.js';
import { verifyTool } from '../tools/verify.js';
import type { RepoInfo } from '../types.js';
import type { ToolContext, MochiConfig } from '../types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mch-gate-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function touch(rel: string, content = ''): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const repoStub = { testCommand: 'npm test' } as RepoInfo;

function fixtureRepo(): void {
  // A tiny vitest repo: leaf.ts (leaf module) and unrelated.test.ts (imports
  // nothing changed).
  touch('package.json', JSON.stringify({
    name: 'fixture',
    private: true,
    scripts: { test: 'vitest run' },
    devDependencies: { vitest: '^5.0.3' },
  }));
  touch('src/leaf.ts', 'export const double = (n: number) => n * 2;');
  touch('src/leaf.test.ts', "import { it, expect } from 'vitest';\nimport { double } from './leaf.js';\nit('doubles', () => { expect(double(2)).toBe(4); });");
  touch('src/unrelated.test.ts', "import { it, expect } from 'vitest';\nit('unrelated', () => { expect(1).toBe(1); });");
}

function gitInit(): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });
}

describe('blast-radius gate: selection is the default', () => {
  it('a leaf change selects its tests and the rationale is present and accurate', async () => {
    fixtureRepo();
    const plan = await planGateTests(dir, repoStub, { changedFiles: ['src/leaf.ts'] });
    expect(plan.mode).toBe('selected');
    expect(plan.command).toBeDefined();
    expect(plan.rationale.rule).toBe('blast-radius');
    expect(plan.rationale.changedFiles).toEqual(['src/leaf.ts']);
    expect(plan.rationale.selectedTests).toContain('src/leaf.test.ts');
    expect(plan.rationale.selectedTests).not.toContain('src/unrelated.test.ts');
    expect(plan.rationale.totalTestFiles).toBe(2);
    // The command IS the repo's own runner over the selected files only.
    expect(plan.command).toContain('vitest run');
    expect(plan.command).toContain('src/leaf.test.ts');
    expect(plan.command).not.toContain('unrelated.test.ts');

    // Rationale output: changed files, selected set + counts, always-run set,
    // and WHY — all in the printed block, not a side log.
    const printed = formatGateRationale(plan.rationale);
    expect(printed).toContain('[GATE-SELECTED]');
    expect(printed).toContain('1/2 test files');
    expect(printed).toContain('rule: blast-radius');
    expect(printed).toContain('src/leaf.ts');
    expect(printed).toContain('src/leaf.test.ts');
    expect(printed).toContain('always-run core set (0)');
    expect(printed).toContain('reverse-import closure of 1 changed file(s)');
  });

  it('a transitive change (through a barrel) selects the importing test', async () => {
    fixtureRepo();
    // barrel/index.ts re-exports leaf; a test imports the barrel only.
    touch('src/barrel/index.ts', "export * from '../leaf.js';");
    touch('src/barrel.test.ts', "import { double } from './barrel/index.js';\nimport { it, expect } from 'vitest';\nit('via barrel', () => { expect(double(2)).toBe(4); });");
    const plan = await planGateTests(dir, repoStub, { changedFiles: ['src/leaf.ts'] });
    expect(plan.mode).toBe('selected');
    expect(plan.rationale.selectedTests).toContain('src/barrel.test.ts');
  });

  it('an empty change set runs only the always-run core set; with none, full', async () => {
    fixtureRepo();
    // No always-run files on disk → full (fail-safe).
    const empty = await planGateTests(dir, repoStub, { changedFiles: [] });
    expect(empty.mode).toBe('full');
    expect(empty.rationale.rule).toBe('empty-change-set');

    // With the standing-gate suite present → selected, core set only.
    touch('src/core/test-selection.test.ts', "import { it } from 'vitest';\nit('core', () => {});");
    const plan = await planGateTests(dir, repoStub, { changedFiles: [] });
    expect(plan.mode).toBe('selected');
    expect(plan.rationale.rule).toBe('empty-change-set');
    expect(plan.rationale.selectedTests).toEqual(['src/core/test-selection.test.ts']);
    expect(plan.command).toContain('src/core/test-selection.test.ts');
  });

  it('a REAL clean tree (git) selects only the always-run core set', async () => {
    fixtureRepo();
    touch('src/core/test-selection.test.ts', "import { it } from 'vitest';\nit('core', () => {});");
    gitInit();
    const cs = await determineChangeSet(dir);
    expect(cs).not.toBeNull();
    expect(cs!.files).toEqual([]);
    const plan = await planGateTests(dir, repoStub, {});
    expect(plan.mode).toBe('selected');
    expect(plan.rationale.rule).toBe('empty-change-set');
    expect(plan.rationale.changedFiles).toEqual([]);
    expect(plan.rationale.selectedTests).toEqual(['src/core/test-selection.test.ts']);
  });

  it('the always-run core set joins every selected run (AAIF conformance)', async () => {
    fixtureRepo();
    touch('src/skills/aaif-conformance.test.ts', "import { it } from 'vitest';\nit('aaif', () => {});");
    const plan = await planGateTests(dir, repoStub, { changedFiles: ['src/leaf.ts'] });
    expect(plan.mode).toBe('selected');
    // Blast + always-run in ONE command; the core set is never dropped.
    expect(plan.rationale.selectedTests).toEqual(['src/leaf.test.ts', 'src/skills/aaif-conformance.test.ts']);
    expect(plan.rationale.alwaysRun).toEqual(['src/skills/aaif-conformance.test.ts']);
    expect(plan.rationale.blastTests).toEqual(['src/leaf.test.ts']);
    expect(plan.command).toContain('src/skills/aaif-conformance.test.ts');
    expect(resolveAlwaysRun(dir)).toContain('src/skills/aaif-conformance.test.ts');
  });
});

describe('blast-radius gate: fail-safe rules force the FULL suite', () => {
  it('a core-surface change (loop/runtime/executor/router/config) forces full', async () => {
    fixtureRepo();
    touch('src/loop.ts', 'export const step = () => 1;');
    const plan = await planGateTests(dir, repoStub, { changedFiles: ['src/loop.ts'] });
    expect(plan.mode).toBe('full');
    expect(plan.rationale.rule).toBe('core-surface');
    expect(plan.rationale.reason).toContain('src/loop.ts');
    expect(formatGateRationale(plan.rationale)).toContain('[GATE-FULL]');
    // The portable basename rule matches this repo's real hubs too.
    expect(isCoreSurface('src/agent/loop.ts', process.cwd())).toBe(true);
    expect(isCoreSurface('src/model/router.ts', process.cwd())).toBe(true);
    expect(isCoreSurface('src/runtime.ts', process.cwd())).toBe(true);
    expect(isCoreSurface('src/config.ts', process.cwd())).toBe(true);
    expect(isCoreSurface('src/clarify.ts', process.cwd())).toBe(false);
  });

  it('a file whose reverse-dependency fan-out exceeds the threshold forces full', async () => {
    fixtureRepo();
    // hub.ts imported by 2 files; threshold overridden to 1 → fan-out 2 > 1.
    touch('src/hub.ts', 'export const hub = 1;');
    touch('src/a.ts', "import { hub } from './hub.js';\nexport const a = hub;");
    touch('src/b.ts', "import { hub } from './hub.js';\nexport const b = hub;");
    touch('src/a.test.ts', "import { it } from 'vitest';\nit('a', () => {});");
    const plan = await planGateTests(dir, repoStub, { changedFiles: ['src/hub.ts'], maxFanIn: 1 });
    expect(plan.mode).toBe('full');
    expect(plan.rationale.rule).toBe('core-fan-out');
    expect(plan.rationale.reason).toContain('fan-out 2 > threshold 1');
  });

  it('a selection computation failure forces full', async () => {
    fixtureRepo();
    const poisoned = {
      get files(): string[] {
        throw new Error('graph exploded');
      },
      testFiles: [],
      importersOf: new Map(),
      importsOf: new Map(),
      danglingImporters: new Map(),
    } as unknown as ImportGraph;
    const plan = await planGateTests(dir, repoStub, { changedFiles: ['src/leaf.ts'], graph: poisoned });
    expect(plan.mode).toBe('full');
    expect(plan.rationale.rule).toBe('selection-failed');
    expect(plan.rationale.reason).toContain('graph exploded');
  });

  it('a selection timeout forces full', async () => {
    fixtureRepo();
    const plan = await planGateTests(dir, repoStub, { changedFiles: ['src/leaf.ts'], selectionTimeoutMs: -1 });
    expect(plan.mode).toBe('full');
    expect(plan.rationale.rule).toBe('selection-timeout');
    expect(plan.rationale.reason).toContain('time budget');
  });

  it('an undeterminable change set forces full', async () => {
    // dir is a plain temp directory: no git repo, so the change set cannot
    // be determined — full suite by fail-safe, never an empty-set alias.
    const plan = await planGateTests(dir, repoStub, {});
    expect(plan.mode).toBe('full');
    expect(plan.rationale.rule).toBe('change-set-undetermined');
  });

  it('the selector declining (non-code change) surfaces as a full run with its reason', async () => {
    fixtureRepo();
    touch('README.md', '# fixture');
    const plan = await planGateTests(dir, repoStub, { changedFiles: ['README.md'] });
    expect(plan.mode).toBe('full');
    expect(plan.rationale.rule).toBe('selection-declined');
    expect(plan.rationale.reason).toContain('non-code change');
    expect(formatGateRationale(plan.rationale)).toContain('README.md');
  });

  it('MOCHI_GATE_FULL=1 forces full; the flag and before-merge paths too', async () => {
    fixtureRepo();
    const prev = process.env.MOCHI_GATE_FULL;
    try {
      process.env.MOCHI_GATE_FULL = '1';
      expect(gateEnvFull()).toBe(true);
      const envPlan = await planGateTests(dir, repoStub, { changedFiles: ['src/leaf.ts'] });
      expect(envPlan.mode).toBe('full');
      expect(envPlan.rationale.rule).toBe('forced-full-env');
    } finally {
      if (prev === undefined) delete process.env.MOCHI_GATE_FULL;
      else process.env.MOCHI_GATE_FULL = prev;
    }
    const flagPlan = await planGateTests(dir, repoStub, { changedFiles: ['src/leaf.ts'], full: true });
    expect(flagPlan.mode).toBe('full');
    expect(flagPlan.rationale.rule).toBe('forced-full-flag');

    const mergePlan = await planGateTests(dir, repoStub, { changedFiles: ['src/leaf.ts'], beforeMerge: true });
    expect(mergePlan.mode).toBe('full');
    expect(mergePlan.rationale.rule).toBe('before-merge');
  });
});

describe('blast-radius gate: change-set determination (real git)', () => {
  it('includes uncommitted AND committed-since-merge-base files', async () => {
    fixtureRepo();
    gitInit();

    // Committed change on a FEATURE branch (clean status) + an uncommitted
    // one; the merge base against main is the base commit.
    execFileSync('git', ['checkout', '-qb', 'feature'], { cwd: dir, stdio: 'pipe' });
    touch('src/leaf.ts', 'export const double = (n: number) => n * 3;');
    execFileSync('git', ['add', 'src/leaf.ts'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'change leaf'], { cwd: dir, stdio: 'pipe' });
    touch('src/unrelated.test.ts', "import { it, expect } from 'vitest';\nit('changed on the working tree', () => {});");

    const cs = await determineChangeSet(dir);
    expect(cs).not.toBeNull();
    expect(cs!.mergeBase).not.toBeNull();
    expect(cs!.uncommitted).toContain('src/unrelated.test.ts');
    expect(cs!.committed).toContain('src/leaf.ts');
    expect(cs!.files).toEqual(['src/leaf.ts', 'src/unrelated.test.ts']);

    const plan = await planGateTests(dir, repoStub, {});
    expect(plan.mode).toBe('selected');
    expect(plan.rationale.changedFiles).toEqual(['src/leaf.ts', 'src/unrelated.test.ts']);
    expect(plan.rationale.selectedTests).toContain('src/leaf.test.ts');
  });

  it('mergeBaseOf returns null when no base ref exists', async () => {
    fixtureRepo();
    gitInit();
    // An orphan branch with no main/master and no upstream: no merge base.
    execFileSync('git', ['checkout', '-q', '--orphan', 'solo'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['branch', '-D', 'main'], { cwd: dir, stdio: 'pipe' });
    expect(await mergeBaseOf(dir)).toBeNull();
  });
});

describe('blast-radius gate: forced-full surfaces (verify tool + env)', () => {
  it('the verify tool honors full:true over selection', async () => {
    fixtureRepo();
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    gitInit();
    // Uncommitted leaf change — selection WOULD narrow without the override.
    touch('src/leaf.ts', 'export const double = (n: number) => n * 2;');
    const ctx: ToolContext = {
      cwd: dir,
      workspace: { dir, root: dir } as unknown as ToolContext['workspace'],
      config: {} as MochiConfig,
      events: {} as ToolContext['events'],
      agentId: 'test',
    };
    const out = await verifyTool.execute({ command: 'test', full: true }, ctx);
    expect(out).toContain('[FULL]');
    expect(out).toContain('full parameter');
    expect(out).not.toContain('[PARTIAL]');
  });

  it('the verify tool honors MOCHI_GATE_FULL=1 over selection', async () => {
    fixtureRepo();
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    gitInit();
    touch('src/leaf.ts', 'export const double = (n: number) => n * 2;');
    const prev = process.env.MOCHI_GATE_FULL;
    process.env.MOCHI_GATE_FULL = '1';
    try {
      const ctx: ToolContext = {
        cwd: dir,
        workspace: { dir, root: dir } as unknown as ToolContext['workspace'],
        config: {} as MochiConfig,
        events: {} as ToolContext['events'],
        agentId: 'test',
      };
      const out = await verifyTool.execute({ command: 'test' }, ctx);
      expect(out).toContain('[FULL]');
      expect(out).toContain('MOCHI_GATE_FULL=1');
      expect(out).not.toContain('[PARTIAL]');
    } finally {
      if (prev === undefined) delete process.env.MOCHI_GATE_FULL;
      else process.env.MOCHI_GATE_FULL = prev;
    }
  });
});
