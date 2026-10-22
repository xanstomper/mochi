// P4: blast-radius test selection — seeded scenarios for the closure, the
// policy guards, the cadence, and the evidence rule (a PARTIAL/targeted
// result must not satisfy any certifying consumer).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildImportGraph,
  selectBlastRadiusTests,
  planVerificationTests,
  loadSelectionState,
  recordSelectionRun,
  isTestInfraChange,
  gitDiffLines,
} from './test-selection.js';
import { selectRelatedTests } from './test-select.js';
import { isVerifiedRecord } from '../observability/trajectory.js';
import { loadSkillUsage, recordSkillOutcome } from '../skills/skills.js';
import { writeSkill } from '../skills/skill-manager.js';
import { evaluateSkillLifecycle } from '../skills/skill-curator.js';
import { verifyTool } from '../tools/verify.js';
import type { RepoInfo } from '../types.js';
import type { ToolContext, MochiConfig } from '../types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mch-tsel-'));
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

describe('blast-radius selection', () => {
  it('selects a test that reaches the changed module TRANSITIVELY (the MCH-72 gap)', () => {
    touch('src/core/deep.ts', 'export const deep = () => 1;');
    touch('src/core/mid.ts', "import { deep } from './deep.js';\nexport const mid = () => deep();");
    touch('test/feature.test.ts', "import { mid } from '../src/core/mid.js';\nmid();");
    touch('src/other.ts', 'export const other = 1;');
    touch('src/other.test.ts', "import { other } from './other.js';\nother;");

    // The legacy selector misses it: feature.test.ts imports mid, not deep.
    const legacy = selectRelatedTests(dir, ['src/core/deep.ts']);
    expect(legacy.tests).toEqual([]);

    const sel = selectBlastRadiusTests(dir, ['src/core/deep.ts']);
    expect(sel.fullRun).toBe(false);
    expect(sel.breakdown.blast).toContain('test/feature.test.ts');
    // The unrelated failing-capable test outside the radius stays out —
    // that exclusion is the known, accepted cost of narrowing.
    expect(sel.tests).not.toContain('src/other.test.ts');
  });

  it('includes mirrored tests and changed test files themselves', () => {
    touch('src/a.ts', 'export const a = 1;');
    touch('src/a.test.ts', "import { a } from './a.js';\na;");
    touch('src/b.ts', 'export const b = 1;');
    touch('src/b.test.ts', "import { b } from './b.js';\nb;");
    touch('src/c.test.ts', 'export {};');
    touch('src/d.test.ts', 'export {};');
    const sel = selectBlastRadiusTests(dir, ['src/a.ts', 'src/b.test.ts']);
    expect(sel.fullRun).toBe(false);
    expect(sel.breakdown.blast).toContain('src/a.test.ts');
    expect(sel.breakdown.changedTests).toEqual(['src/b.test.ts']);
  });

  it('seeds a deleted file’s closure from its dangling importers', () => {
    touch('src/keep.ts', 'export const keep = 1;');
    touch('src/keep.test.ts', "import { keep } from './keep.js';\nkeep;");
    touch('test/uses-gone.test.ts', "import { gone } from '../src/gone.js';\ngone;");
    // src/gone.ts is NOT on disk — it is the deleted file in the diff.
    const sel = selectBlastRadiusTests(dir, ['src/gone.ts']);
    expect(sel.fullRun).toBe(false);
    expect(sel.breakdown.blast).toContain('test/uses-gone.test.ts');
  });

  it('adds the auto-detected smoke set, and honors an explicit smoke override', () => {
    touch('src/index.test.ts', "import { it } from 'vitest';\nit('smoke', () => {});");
    touch('src/util/leaf.ts', 'export const leaf = 1;');
    touch('src/util/leaf.test.ts', "import { leaf } from './leaf.js';\nleaf;");
    touch('src/util/other.test.ts', 'export {};');
    touch('src/util/third.test.ts', 'export {};');

    const auto = selectBlastRadiusTests(dir, ['src/util/leaf.ts']);
    expect(auto.fullRun).toBe(false);
    expect(auto.breakdown.smoke).toEqual(['src/index.test.ts']);
    expect(auto.tests).toContain('src/util/leaf.test.ts');

    const override = selectBlastRadiusTests(dir, ['src/util/leaf.ts'], { smoke: ['src/util/other.test.ts'] });
    expect(override.breakdown.smoke).toEqual(['src/util/other.test.ts']);
    expect(override.tests).not.toContain('src/index.test.ts');
  });

  it('adds known-flaky tests from the flaky registry in the changed area — and only those', () => {
    touch('src/pay/charge.ts', 'export const charge = 1;');
    touch('src/pay/charge.test.ts', "import { charge } from './charge.js';\ncharge;");
    touch('src/pay/audit.test.ts', 'export {};');
    touch('src/pay/other.test.ts', 'export {};');
    touch('src/x.ts', 'export const x = 1;');
    touch('src/x.test.ts', "import { x } from './x.js';\nx;");
    const registry = {
      entries: {
        a: { id: 'src/pay/audit.test.ts > audits the ledger', command: 'npm test', score: 3, flakeEvents: 3, firstSeenAt: 1, lastSeenAt: 2, examples: [] },
        b: { id: 'src/pay/other.test.ts > shrugs', command: 'npm test', score: 1, flakeEvents: 1, firstSeenAt: 1, lastSeenAt: 2, examples: [] },
      },
    };
    const sel = selectBlastRadiusTests(dir, ['src/pay/charge.ts'], { flakyRegistry: registry });
    expect(sel.fullRun).toBe(false);
    expect(sel.breakdown.history).toEqual(['src/pay/audit.test.ts']);
    expect(sel.tests).not.toContain('src/pay/other.test.ts');
  });
});

describe('policy guards — low confidence means FULL', () => {
  it('forces a full run when test infrastructure changes', () => {
    touch('src/a.ts', 'export const a = 1;');
    touch('src/a.test.ts', 'export {};');
    touch('src/b.test.ts', 'export {};');
    for (const infra of ['src/testutil/helper.ts', 'vitest.config.ts', 'src/__mocks__/api.ts', 'src/setup.ts']) {
      const sel = selectBlastRadiusTests(dir, ['src/a.ts', infra]);
      expect(sel.fullRun, infra).toBe(true);
      expect(sel.reasons[0]).toContain('test-infrastructure');
    }
    expect(isTestInfraChange('src/core/flaky.ts')).toBe(false);
    expect(isTestInfraChange('src/contest.ts')).toBe(false);
  });

  it('forces a full run for a high fan-in core module', () => {
    touch('src/hub.ts', 'export const hub = 1;');
    touch('src/hub.test.ts', 'export {};');
    for (let i = 0; i < 26; i++) {
      touch(`src/u${i}.ts`, "import { hub } from './hub.js';\nhub;");
    }
    const sel = selectBlastRadiusTests(dir, ['src/hub.ts']);
    expect(sel.fullRun).toBe(true);
    expect(sel.reasons[0]).toContain('imported by 26 files');
  });

  it('forces a full run when a changed file has no covering test (unmappable)', () => {
    touch('src/orphan.ts', 'export const orphan = 1;');
    touch('src/a.ts', 'export const a = 1;');
    touch('src/a.test.ts', "import { a } from './a.js';\na;");
    const sel = selectBlastRadiusTests(dir, ['src/orphan.ts']);
    expect(sel.fullRun).toBe(true);
    expect(sel.reasons[0]).toContain('no test covers src/orphan.ts');
  });

  it('selector still maps a suite-wide blast radius; the PLANNER declines to substitute it', async () => {
    touch('src/shared.ts', 'export const shared = 1;');
    for (const n of ['a', 'b', 'c']) {
      touch(`src/${n}.ts`, "import { shared } from './shared.js';\nshared;");
      touch(`src/${n}.test.ts`, `import { shared } from './shared.js';\nshared;`);
    }
    // Mapping is exact (3/3) — high confidence, NOT a selector-level full.
    const sel = selectBlastRadiusTests(dir, ['src/shared.ts']);
    expect(sel.fullRun).toBe(false);
    expect(sel.tests).toHaveLength(3);
    // Substitution consumer (verify tool, cadence on): narrowing buys nothing.
    const sub = await planVerificationTests(dir, repoStub, 'npx vitest run', {
      changedFiles: ['src/shared.ts'],
      diffLines: 3,
    });
    expect(sub.scope).toBe('full');
    expect(sub.reason).toContain('blast radius covers 3/3');
    // Fail-fast consumer (cadence off): the subset is an ordering device and
    // is delivered regardless of coverage.
    const gate = await planVerificationTests(dir, repoStub, 'npx vitest run', {
      changedFiles: ['src/shared.ts'],
      diffLines: 3,
      cadence: false,
    });
    expect(gate.scope).toBe('targeted');
    expect(gate.files).toHaveLength(3);
  });

  it('forces a full run on non-code changes and oversized change lists', () => {
    touch('src/a.ts', 'export const a = 1;');
    touch('src/a.test.ts', 'export {};');
    expect(selectBlastRadiusTests(dir, ['src/a.ts', 'package.json']).fullRun).toBe(true);
    const many = Array.from({ length: 31 }, (_, i) => `src/f${i}.ts`);
    expect(selectBlastRadiusTests(dir, many).reasons[0]).toContain('31 changed files');
  });
});

describe('planner: labels, cadence, diff-size guard', () => {
  function fixture(): void {
    touch('src/index.test.ts', "import { it } from 'vitest';\nit('smoke', () => {});");
    touch('src/util/leaf.ts', 'export const leaf = 1;');
    touch('src/util/leaf.test.ts', "import { leaf } from './leaf.js';\nleaf;");
    touch('src/util/other.test.ts', 'export {};');
    touch('src/util/third.test.ts', 'export {};');
  }

  it('returns a PARTIAL, non-certifying plan for a narrow diff', async () => {
    fixture();
    const plan = await planVerificationTests(dir, repoStub, 'npx vitest run', {
      changedFiles: ['src/util/leaf.ts'],
      diffLines: 12,
    });
    expect(plan.scope).toBe('targeted');
    expect(plan.label).toBe('PARTIAL');
    expect(plan.certifying).toBe(false);
    expect(plan.command).toContain('vitest run');
    expect(plan.command).toContain('src/util/leaf.test.ts');
    expect(plan.reason).toContain('PARTIAL');
  });

  it('forces a full run after the cadence of targeted runs, and resets on a full run', async () => {
    fixture();
    const opts = { changedFiles: ['src/util/leaf.ts'], diffLines: 5 };
    for (let i = 0; i < 5; i++) recordSelectionRun(dir, 'targeted');
    expect(loadSelectionState(dir).targetedSinceFull).toBe(5);
    const forced = await planVerificationTests(dir, repoStub, 'npx vitest run', opts);
    expect(forced.scope).toBe('full');
    expect(forced.certifying).toBe(true);
    expect(forced.reason).toContain('cadence');

    recordSelectionRun(dir, 'full');
    const after = await planVerificationTests(dir, repoStub, 'npx vitest run', opts);
    expect(after.scope).toBe('targeted');

    // Gate paths opt out of cadence entirely (they always run full after).
    for (let i = 0; i < 5; i++) recordSelectionRun(dir, 'targeted');
    const gatePath = await planVerificationTests(dir, repoStub, 'npx vitest run', { ...opts, cadence: false });
    expect(gatePath.scope).toBe('targeted');
  });

  it('forces a full run on a large diff even when selection is confident', async () => {
    fixture();
    const plan = await planVerificationTests(dir, repoStub, 'npx vitest run', {
      changedFiles: ['src/util/leaf.ts'],
      diffLines: 5000,
    });
    expect(plan.scope).toBe('full');
    expect(plan.reason).toContain('diff is 5000 lines');
  });

  it('builds a usable import graph (sanity)', () => {
    fixture();
    const g = buildImportGraph(dir);
    expect(g.testFiles.length).toBe(4);
    expect(g.importersOf.get('src/util/leaf.ts')?.has('src/util/leaf.test.ts')).toBe(true);
  });
});

describe('THE EVIDENCE RULE — a PARTIAL result cannot certify', () => {
  it('trajectory consumer: isVerifiedRecord rejects PARTIAL, accepts PASS', () => {
    expect(isVerifiedRecord({ verification: { status: 'PARTIAL', verdict: 'partial' }, verified: undefined })).toBe(false);
    expect(isVerifiedRecord({ verification: { status: 'PASS', verdict: 'pass' }, verified: undefined })).toBe(true);
  });

  it('skill promotion consumer: 3 PARTIAL outcomes never promote; 3 PASS outcomes do', () => {
    const body = [
      '## When to use',
      'Use when maintaining a project workflow after a reproducible failure.',
      '## Procedure',
      '1. Reproduce the failure and record the exact diagnostic.',
      '2. Inspect the affected implementation and its callers.',
      '3. Apply a minimal repair while preserving existing behavior.',
      '4. Confirm the repair with the recorded diagnostic.',
      '## Pitfalls',
      'Do not suppress diagnostics or remove assertions to conceal failures.',
      '## Verification',
      'Run the focused regression tests and require successful exits.',
    ].join('\n');
    const w = writeSkill(dir, {
      name: 'partial-proof-skill',
      description: 'Reusable procedure for repairing the worker deployment pipeline safely',
      body,
    });
    expect(w.ok).toBe(true);
    expect(w.state).toBe('probation');

    // A run whose verification only ever ran a targeted subset lands in the
    // attribution vocabulary as 'partial'. Feed three of those — the exact
    // count promotion requires — and the gate must still refuse.
    for (let i = 0; i < 3; i++) recordSkillOutcome(dir, 'partial-proof-skill', 'partial');
    let rec = loadSkillUsage(dir).get('partial-proof-skill');
    expect(rec?.verifiedPasses ?? 0).toBe(0);
    expect(rec?.verifiedPartials ?? 0).toBe(3);
    expect(rec?.passesInState ?? 0).toBe(0);
    expect(evaluateSkillLifecycle(dir).promoted).not.toContain('partial-proof-skill');

    // The same count of genuine full-run PASS verdicts promotes.
    for (let i = 0; i < 3; i++) recordSkillOutcome(dir, 'partial-proof-skill', 'pass');
    rec = loadSkillUsage(dir).get('partial-proof-skill');
    expect(rec?.verifiedPasses ?? 0).toBe(3);
    expect(evaluateSkillLifecycle(dir).promoted).toContain('partial-proof-skill');
  });
});

describe('verify tool: PARTIAL labeling end-to-end (real git repo, real vitest)', () => {
  function git(args: string[]): void {
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  }

  it('labels a narrowed pass PARTIAL, records cadence, and never prints a bare [PASS]', async () => {
    touch('package.json', JSON.stringify({
      name: 'fixture',
      private: true,
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '^5.0.3' },
    }));
    touch('src/leaf.ts', 'export const double = (n: number) => n * 2;');
    touch('src/leaf.test.ts', "import { it, expect } from 'vitest';\nimport { double } from './leaf.js';\nit('doubles', () => { expect(double(2)).toBe(4); });");
    touch('src/other.test.ts', "import { it, expect } from 'vitest';\nit('unrelated', () => { expect(1).toBe(1); });");
    symlinkSync(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    git(['init', '-q']);
    git(['add', '-A']);
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });

    // Uncommitted change to leaf.ts — the diff the planner sees.
    touch('src/leaf.ts', 'export const double = (n: number) => n * 2 + 0;');
    expect(await gitDiffLines(dir, ['src/leaf.ts'])).toBeGreaterThanOrEqual(1);

    const ctx: ToolContext = {
      cwd: dir,
      workspace: { dir, root: dir } as unknown as ToolContext['workspace'],
      config: {} as MochiConfig,
      events: {} as ToolContext['events'],
      agentId: 'test',
    };
    const out = await verifyTool.execute({ command: 'test' }, ctx);
    expect(out).toContain('[PARTIAL]');
    expect(out).toContain('[PARTIAL PASS]');
    expect(out).toContain('PASSED');
    expect(out).not.toContain('[PASS] Verification');
    expect(loadSelectionState(dir).targetedSinceFull).toBe(1);

    // Break it: the failing subset result is a real FAIL, still PARTIAL-labeled.
    touch('src/leaf.ts', 'export const double = (n: number) => n * 3;');
    const out2 = await verifyTool.execute({ command: 'test' }, ctx);
    expect(out2).toContain('[PARTIAL]');
    expect(out2).toContain('[FAIL]');
    expect(loadSelectionState(dir).targetedSinceFull).toBe(2);
  }, 120_000);
});
