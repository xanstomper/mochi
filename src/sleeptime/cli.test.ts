// Production wiring for `mochi sleeptime` (audit L-01): the CLI call site
// must run the REAL D8 repair adapter and D10 curriculum adapter. Before
// the fix, cli.ts passed no ports and the orchestrator's defaults were a
// stub repair (no patch, detail admitted "STUB") and a no-op curriculum
// port (planned nothing, forever) — while the CLI help and README
// advertised both features. These tests drive the actual CLI handler on a
// fixture project and assert on the morning report it prints: with the
// old wiring the repair detail would say STUB and the curriculum step
// would plan zero units, so this file fails on the pre-fix tree.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { handleSleeptimeCommand } from './cli.js';
import type { SleeptimeReport } from './orchestrator.js';
import { loadSkillUsage, saveSkillUsage } from '../skills/skills.js';
import { writeSkill } from '../skills/skill-manager.js';

const DESC = 'Reusable procedure for repairing the worker deployment pipeline safely';
const BODY = [
  '## When to use',
  'Use when maintaining a project workflow after a reproducible failure.',
  '## Procedure',
  '1. Reproduce the failure and record the exact diagnostic.',
  '2. Inspect the affected implementation and its callers.',
  '3. Apply a minimal repair while preserving existing behavior.',
  'Detail.',
  '## Pitfalls',
  'Do not suppress diagnostics or remove assertions to conceal failures.',
  '## Verification',
  'Run the focused regression tests; require successful exits.',
].join('\n');

let proj: string;
let savedExit: number | undefined;
beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'mochi-sleeptime-cli-'));
  savedExit = process.exitCode;
});
afterEach(() => {
  process.exitCode = savedExit;
  vi.restoreAllMocks();
  rmSync(proj, { recursive: true, force: true });
});

function seedProject(): void {
  // A demoted skill with recorded failure evidence (D8 repair input).
  const r = writeSkill(proj, { name: 'broken-deploy', description: DESC, body: BODY });
  expect(r.ok).toBe(true);
  const all = loadSkillUsage(proj);
  const cur = all.get('broken-deploy') ?? { loads: 0, wins: 0 };
  all.set('broken-deploy', {
    ...cur, loads: 6, wins: 1, state: 'demoted', stateAt: Date.now(), demotionStrikes: 1,
    passesInState: 0, lastDemotionReason: 'last two verified runs that loaded it failed the gate',
  });
  saveSkillUsage(proj, all);
  // A tiny Python project whose module a failed run touched (D10 input).
  writeFileSync(join(proj, 'pyproject.toml'), '[project]\nname = "curr-fixture"\nversion = "1.0.0"\n');
  writeFileSync(join(proj, 'calc.py'), 'def add(a, b):\n    return a + b\n');
  writeFileSync(join(proj, 'test_calc.py'), 'from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n');
  writeFileSync(join(proj, 'pytest.py'), [
    'import importlib',
    'import sys',
    'import traceback',
    '',
    '',
    'def main():',
    '    failures = 0',
    '    total = 0',
    '    mod = importlib.import_module("test_calc")',
    '    for name in sorted(dir(mod)):',
    '        if not name.startswith("test_"):',
    '            continue',
    '        total += 1',
    '        try:',
    '            getattr(mod, name)()',
    '            print(f"PASS test_calc.{name}")',
    '        except Exception:',
    '            failures += 1',
    '            print(f"FAIL test_calc.{name}")',
    '            traceback.print_exc()',
    '    if total == 0:',
    '        print("no tests collected")',
    '        return 1',
    '    return 1 if failures else 0',
    '',
    '',
    'if __name__ == "__main__":',
    '    sys.exit(main())',
    '',
  ].join('\n'));
  // One exported failed run: loaded the demoted skill AND edited calc.py.
  const dir = join(proj, 'exports');
  mkdirSync(dir, { recursive: true });
  const rec = {
    schemaVersion: 1, runId: 'exp-cli-1', startedAt: 1, endedAt: 2, durationMs: 1,
    task: { title: 'Fix the worker deployment' },
    steps: [
      { index: 0, tool: 'edit', args: { path: 'calc.py' }, ok: false, outputSnippet: '', error: 'edit conflict' },
      { index: 1, tool: 'run', args: { cmd: 'python3 -m pytest -q' }, ok: false, outputSnippet: '', error: 'tests failed: expected 200, got 500' },
    ],
    skills: [{ id: 'broken-deploy', verdict: 'fail' }],
    verification: { status: 'FAIL', verdict: 'fail' },
    outcome: { completed: false }, usage: null,
    failureTaxonomy: [{ label: 'verification_failed', count: 1 }],
  };
  writeFileSync(join(dir, 'trajectory-exp-cli-1.jsonl'), JSON.stringify(rec) + '\n');
}

describe('mochi sleeptime (production wiring)', () => {
  it('runs the real D8 repair and D10 curriculum adapters — never the stub/no-op ports', async () => {
    delete process.env.MOCHI_SKILLS_PROBATION;
    seedProject();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(' '));
    });
    await handleSleeptimeCommand({
      positional: ['sleeptime'],
      flags: { json: true, night: '2026-10-22' },
      cwd: proj,
    });
    const reportJson = logs.map((l) => {
      try { return JSON.parse(l) as SleeptimeReport; } catch { return null; }
    }).find((r) => r?.kind === 'mochi-sleeptime-report');
    expect(reportJson).toBeDefined();
    const report = reportJson!;
    expect(report.steps.map((s) => s.id)).toEqual(['repair', 'curator', 'gate', 'health', 'curriculum', 'routing-stats']);

    // Repair: a real patch attempt happened (the stub's detail confessed
    // "STUB repair"; the unavailable port could not patch at all).
    const repair = report.steps[0];
    expect(repair.units).toHaveLength(1);
    expect(repair.units[0].status).toBe('completed');
    expect(repair.units[0].detail).toContain('D8 repair applied');
    expect(repair.units[0].detail).not.toContain('STUB');
    expect(loadSkillUsage(proj).get('broken-deploy')?.repairAttempts).toBe(1);

    // Curriculum: a real validated task was generated (the no-op port
    // planned [] forever).
    const curriculum = report.steps[4];
    expect(curriculum.units).toHaveLength(1);
    expect(curriculum.units[0].status).toBe('completed');
    expect(curriculum.units[0].detail).toContain('generated validated practice task');
    expect(existsSync(join(proj, '.mochi', 'curriculum'))).toBe(true);

    // Both adapters are model-free: the night spent nothing.
    expect(report.spend.usedCostUsd).toBe(0);
    expect(process.exitCode).toBe(0);
  }, 60_000);
});
