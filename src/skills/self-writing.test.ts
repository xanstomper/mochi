// Self-writing skills with a held-out test gate (item 16) — the gate tests.
// Each test pins one non-negotiable from the item spec:
//   - a pattern needs ≥3 DISTINCT source tasks (2-task and single-task
//     patterns are rejected at detection; invented examples are impossible
//     by construction — the detector only consumes provided history);
//   - a held-out PASS installs;
//   - a held-out FAIL does NOT install and the draft stays visible;
//   - an AAIF-nonconforming draft does NOT install;
//   - uninstall restores prior behavior;
//   - curator caps are respected.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { discoverSkills, loadProjectSkills } from './skills.js';
import { argShapeOf } from '../core/tool-sequence.js';
import {
  detectRepeatedPatterns, pickHeldOut, evaluateHeldOutGate, runSelfWritingPass,
  installProvenSkill, uninstallSelfWrittenSkill, listSelfWrittenSkills,
  loadProposalLedger, saveProposalLedger, spineHash,
  type HeldOutRunner,
} from './self-writing.js';
import type { TrajectoryRecord, TrajectoryStep } from '../observability/trajectory.js';

// ─── Fixtures ──────────────────────────────────────────────────────────────

let clock = 1_000;
function step(tool: string, args: unknown, i: number): TrajectoryStep {
  return { index: i, tool, args, argShape: argShapeOf(args), ok: true, outputSnippet: '' };
}

/** A gate-verified, completed run record (the only admitted history shape). */
function traj(runId: string, title: string, taskKind: string, steps: Array<[string, unknown]>, endedAt?: number): TrajectoryRecord {
  return {
    schemaVersion: 2,
    runId,
    taskKind,
    verified: true,
    cost: null,
    startedAt: 1_000_000,
    endedAt: endedAt ?? ++clock,
    durationMs: 1_000,
    task: { title },
    steps: steps.map(([tool, args], i) => step(tool, args, i)),
    skills: [],
    verification: { status: 'PASS', verdict: 'pass' },
    outcome: { completed: true, stopReason: 'done' },
    usage: null,
    failureTaxonomy: [],
  };
}

const reportSteps = (id: string): Array<[string, unknown]> => [
  ['read_file', { path: `src/report-${id}.txt` }],
  ['write_file', { path: `report-${id}.txt`, content: `report ${id}` }],
  ['run', { cmd: `node verify.js report-${id}.txt` }],
];

const reportFixture = (): TrajectoryRecord[] => [
  traj('run-1', 'R1', 'report', reportSteps('1'), 1),
  traj('run-2', 'R2', 'report', reportSteps('2'), 2),
  traj('run-3', 'R3', 'report', reportSteps('3'), 3),
  traj('run-4', 'R4 held-out', 'report', reportSteps('4'), 4),
];

let proj: string;
let savedEnv: string | undefined;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'mchi-selfwriting-'));
  savedEnv = process.env.MOCHI_SKILLS_PROBATION;
  delete process.env.MOCHI_SKILLS_PROBATION;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.MOCHI_SKILLS_PROBATION;
  else process.env.MOCHI_SKILLS_PROBATION = savedEnv;
  rmSync(proj, { recursive: true, force: true });
});

// ─── Detection: the evidence gate ──────────────────────────────────────────

describe('pattern detection needs 3+ distinct source tasks', () => {
  it('finds a 3-step sequence recurring across 3 distinct verified tasks, with evidence', () => {
    const records = [
      traj('run-1', 'Regen report 1', 'report', reportSteps('1')),
      traj('run-2', 'Regen report 2', 'report', reportSteps('2')),
      traj('run-3', 'Regen report 3', 'report', reportSteps('3')),
    ];
    const pats = detectRepeatedPatterns(records);
    expect(pats.length).toBe(1);
    expect(pats[0].spine).toEqual(['read_file', 'write_file', 'run']);
    expect(pats[0].support).toBe(3);
    expect(pats[0].sourceRunIds.sort()).toEqual(['run-1', 'run-2', 'run-3']);
    expect(pats[0].sourceTasks.map((t) => t.title)).toContain('Regen report 1');
    expect(pats[0].stepVariation.length).toBe(3);
  });

  it('(gate) a 2-task pattern is rejected — nothing detected, nothing drafted', async () => {
    const records = [
      traj('run-1', 'Regen report 1', 'report', reportSteps('1')),
      traj('run-2', 'Regen report 2', 'report', reportSteps('2')),
      // A third task of a DIFFERENT shape does not rescue the 2-task pattern.
      traj('run-3', 'Something else', 'report', [['edit_file', { path: 'x' }], ['run', { cmd: 'y' }], ['read_file', { path: 'z' }]]),
    ];
    expect(detectRepeatedPatterns(records)).toEqual([]);
    const runner: HeldOutRunner = () => ({ success: true, timeMs: 1 });
    const out = await runSelfWritingPass(proj, { records, runner, skipCatalogDedup: true });
    expect(out.patternsDetected).toBe(0);
    expect(out.candidates).toEqual([]);
    expect(out.installed).toEqual([]);
    expect(loadProposalLedger(proj)).toEqual([]);
  });

  it('a pattern repeating within ONE task does not count as distinct support', () => {
    const twice = [...reportSteps('9'), ...reportSteps('9')];
    const records = [
      traj('run-1', 'Double occurrence', 'report', twice),
      traj('run-2', 'Regen report 2', 'report', reportSteps('2')),
    ];
    expect(detectRepeatedPatterns(records)).toEqual([]);
  });

  it('unverified or incomplete runs are never admitted as evidence', () => {
    const a = traj('run-1', 'A', 'report', reportSteps('1'));
    const b = traj('run-2', 'B', 'report', reportSteps('2'));
    const c = traj('run-3', 'C', 'report', reportSteps('3'));
    const unverified = { ...a, verified: false, verification: null } as TrajectoryRecord;
    const incomplete = { ...b, outcome: { completed: false, stopReason: 'veto' } } as TrajectoryRecord;
    expect(detectRepeatedPatterns([unverified, incomplete, c])).toEqual([]);
  });

  it('a single task — however complex — can never seed a draft', () => {
    const solo = traj('run-1', 'Solo', 'report', reportSteps('1'));
    expect(detectRepeatedPatterns([solo])).toEqual([]);
  });

  it('later same-kind tasks are held-out material, never source evidence', () => {
    const records = reportFixture();
    const pats = detectRepeatedPatterns(records);
    expect(pats.length).toBe(1);
    expect(pats[0].sourceRunIds).toEqual(['run-1', 'run-2', 'run-3']);
    expect(pats[0].additionalVerifiedOccurrences).toBe(1);
    const held = pickHeldOut(records, pats[0]);
    expect(held?.runId).toBe('run-4');
  });

  it('pickHeldOut returns null when every matching task is already a source', () => {
    const records = [
      traj('run-1', 'R1', 'report', reportSteps('1')),
      traj('run-2', 'R2', 'report', reportSteps('2')),
      traj('run-3', 'R3', 'report', reportSteps('3')),
    ];
    const pats = detectRepeatedPatterns(records);
    expect(pickHeldOut(records, pats[0])).toBeNull();
  });

  it('content-addressed ids are stable and collision-free across step splits', () => {
    expect(spineHash(['a', 'b'])).toBe(spineHash(['a', 'b']));
    expect(spineHash(['ab'])).not.toBe(spineHash(['a', 'b']));
  });
});

// ─── The gate decision rule ────────────────────────────────────────────────

describe('held-out gate decision rule', () => {
  const ON = { success: true, timeMs: 400, costUsd: 0.01 };
  const OFF = { success: true, timeMs: 800, costUsd: 0.03 };

  it('passes when the skill succeeds faster/cheaper than skill-off', () => {
    expect(evaluateHeldOutGate(ON, OFF).pass).toBe(true);
  });
  it('fails when the held-out task fails WITH the skill', () => {
    const v = evaluateHeldOutGate({ ...ON, success: false, notes: 'wrote csv, needed json' }, OFF);
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toContain('FAILED with the skill');
  });
  it('fails on a time regression (strict default: no worse than skill-off)', () => {
    const v = evaluateHeldOutGate({ ...ON, timeMs: 900 }, OFF);
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toContain('time regression');
  });
  it('fails on a cost regression', () => {
    const v = evaluateHeldOutGate({ ...ON, costUsd: 0.05 }, OFF);
    expect(v.pass).toBe(false);
    expect(v.reasons[0]).toContain('cost regression');
  });
  it('a configurable regression budget is honored (explicit, never silent)', () => {
    expect(evaluateHeldOutGate({ ...ON, timeMs: 850 }, OFF, { maxTimeRegressionPct: 0.1 }).pass).toBe(true);
    expect(evaluateHeldOutGate({ ...ON, timeMs: 950 }, OFF, { maxTimeRegressionPct: 0.1 }).pass).toBe(false);
  });
  it('skill-on succeeding where skill-off failed is an improvement (pass)', () => {
    expect(evaluateHeldOutGate(ON, { ...OFF, success: false }).pass).toBe(true);
  });
  it('no skill-off comparison (null) still requires skill-on success', () => {
    expect(evaluateHeldOutGate(ON, null).pass).toBe(true);
    expect(evaluateHeldOutGate({ ...ON, success: false }, null).pass).toBe(false);
  });
});

// ─── End-to-end: pass/fail installs ────────────────────────────────────────

/** Deterministic runner: with a skill it skips exploration (faster, cheaper);
 *  without one it explores first. Success/time/cost come from the per-task
 *  script only — the runner never looks at which pattern a task belongs to. */
function scriptedRunner(perTask: Record<string, { on?: Partial<{ success: boolean; timeMs: number; costUsd: number; notes: string }>; off?: Partial<{ success: boolean; timeMs: number; costUsd: number; notes: string }> }>): HeldOutRunner {
  const defaults: Record<'on' | 'off', { success: boolean; timeMs: number; costUsd: number; notes?: string }> = {
    on: { success: true, timeMs: 400, costUsd: 0.01 },
    off: { success: true, timeMs: 800, costUsd: 0.03 },
  };
  return (task, skill) => {
    const spec = perTask[task.runId] ?? {};
    const mode = skill ? 'on' : 'off';
    const merged = { ...defaults[mode], ...spec[mode] };
    return { success: merged.success, timeMs: merged.timeMs, costUsd: merged.costUsd, ...(merged.notes ? { notes: merged.notes } : {}) };
  };
}

const PASS4 = { maxPatternsPerPass: 4 };

describe('end-to-end pass: install on held-out PASS', () => {
  it('held-out pass installs; the skill is discoverable; evidence cites its sources', async () => {
    const records = reportFixture();
    const out = await runSelfWritingPass(proj, { records, runner: scriptedRunner({}), config: PASS4 });
    expect(out.installed.length).toBe(1);
    const name = out.installed[0];
    const [proposal] = loadProposalLedger(proj);
    expect(proposal.status).toBe('installed');
    expect(proposal.evaluation?.heldOutRunId).toBe('run-4');
    expect(proposal.evaluation?.gate.pass).toBe(true);
    // Skill-on strictly better than skill-off on this task:
    expect(proposal.evaluation?.skillOn.timeMs).toBeLessThan(proposal.evaluation!.skillOff.timeMs);
    // The installed skill is in the discovered catalog:
    const discovered = discoverSkills(join(proj, '.mochi', 'skills')).skills.map((s) => s.name);
    expect(discovered).toContain(name);
    // Evidence cites exactly the source tasks:
    expect(proposal.pattern.sourceRunIds).toEqual(['run-1', 'run-2', 'run-3']);
    // The installed draft cites its sources (no invented examples) and its
    // held-out provenance:
    const raw = readFileSync(proposal.installedPath!, 'utf8');
    expect(raw).toContain('run-1');
    expect(raw).toContain('held-out test on a task it was NOT drafted from');
    // Listing shows it with proof:
    const rows = listSelfWrittenSkills(proj);
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('installed');
    expect(rows[0].heldOut?.pass).toBe(true);
  });
});

describe('end-to-end pass: rejection paths', () => {
  it('held-out FAIL does NOT install; draft + verdict stay visible', async () => {
    const records = reportFixture();
    const runner = scriptedRunner({ 'run-4': { on: { success: false, notes: 'skill pinned the wrong variant' } } });
    const out = await runSelfWritingPass(proj, { records, runner, config: PASS4 });
    expect(out.installed).toEqual([]);
    expect(out.rejected.length).toBe(1);
    expect(out.rejected[0].reason).toContain('held-out gate failed');
    expect(out.rejected[0].reason).toContain('FAILED with the skill');
    const [proposal] = loadProposalLedger(proj);
    expect(proposal.status).toBe('rejected');
    expect(proposal.evaluation?.gate.pass).toBe(false);
    // The draft is NOT in the catalog but IS on disk for inspection:
    const discovered = discoverSkills(join(proj, '.mochi', 'skills')).skills.map((s) => s.name);
    expect(discovered).not.toContain(proposal.name);
    expect(existsSync(proposal.draftPath)).toBe(true);
    expect(existsSync(proposal.evidencePath)).toBe(true);
  });

  it('an AAIF-nonconforming draft never installs (conformance gate at draft time)', async () => {
    // A legacy tool with XXX in its name produces a draft body that trips the
    // house no-placeholders lint (part of the AAIF composition).
    const junkSteps = (id: string): Array<[string, unknown]> => [
      ['XXX-scan', { path: `a-${id}` }],
      ['write_file', { path: `b-${id}` }],
      ['run', { cmd: `verify ${id}` }],
    ];
    const records = [
      traj('run-1', 'J1', 'junk', junkSteps('1'), 1),
      traj('run-2', 'J2', 'junk', junkSteps('2'), 2),
      traj('run-3', 'J3', 'junk', junkSteps('3'), 3),
      traj('run-4', 'J4 held-out', 'junk', junkSteps('4'), 4),
    ];
    const out = await runSelfWritingPass(proj, { records, runner: scriptedRunner({}), config: PASS4 });
    expect(out.installed).toEqual([]);
    expect(out.rejected.length).toBe(1);
    expect(out.rejected[0].reason).toContain('conformance gate');
    expect(out.rejected[0].reason).toContain('no-placeholders');
    const [proposal] = loadProposalLedger(proj);
    expect(proposal.status).toBe('rejected');
    // Draft visible for inspection, never installed:
    expect(existsSync(proposal.draftPath)).toBe(true);
    expect(discoverSkills(join(proj, '.mochi', 'skills')).skills.map((s) => s.name)).not.toContain(proposal.name);
  });

  it('install re-checks the FILE: a tampered AAIF-violating draft is refused', async () => {
    const records = reportFixture();
    await runSelfWritingPass(proj, { records, runner: scriptedRunner({}), config: PASS4 });
    const [proposal] = loadProposalLedger(proj);
    expect(proposal.status).toBe('installed');
    uninstallSelfWrittenSkill(proj, proposal.name);
    // Tamper the staged file with an unknown frontmatter field: the body and
    // description stay valid, so HOUSE lint passes, but the AAIF spec gate
    // must refuse (unknown-field). The ledger is rewound to 'drafted' so the
    // call reaches the file re-check (never trusts the ledger's own copy).
    const raw = readFileSync(proposal.draftPath, 'utf8');
    writeFileSync(proposal.draftPath, raw.replace('---\n', '---\nbogus-field: nope\n'), 'utf8');
    const rewound = loadProposalLedger(proj).map((p) => ({ ...p, status: 'drafted' as const }));
    saveProposalLedger(proj, rewound);
    const r2 = installProvenSkill(proj, proposal.name);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('AAIF');
    expect(r2.error).toContain('unknown-field');
    // And the refusal is recorded, not silent:
    const [after] = loadProposalLedger(proj);
    expect(after.status).toBe('rejected');
    expect(after.reason).toContain('AAIF');
  });

  it('no held-out task available → rejected, nothing installed', async () => {
    const records = [
      traj('run-1', 'R1', 'orphan', reportSteps('1'), 1),
      traj('run-2', 'R2', 'orphan', reportSteps('2'), 2),
      traj('run-3', 'R3', 'orphan', reportSteps('3'), 3),
    ];
    const out = await runSelfWritingPass(proj, { records, runner: scriptedRunner({}), config: PASS4 });
    expect(out.installed).toEqual([]);
    expect(out.rejected[0].reason).toContain('no held-out task');
  });

  it('no runner configured → conservative rejection, nothing installs; a later pass with a runner retries', async () => {
    const records = reportFixture();
    const out = await runSelfWritingPass(proj, { records, config: PASS4 });
    expect(out.installed).toEqual([]);
    expect(out.rejected[0].reason).toContain('no held-out runner');
    expect(loadProposalLedger(proj)[0].status).toBe('rejected');
    // The runner arrives: the transient rejection is retried (attempt 2) and
    // the held-out pass installs.
    const second = await runSelfWritingPass(proj, { records, runner: scriptedRunner({}), config: PASS4 });
    expect(second.installed.length).toBe(1);
    const ledger = loadProposalLedger(proj);
    expect(ledger.length).toBe(2);
    expect(ledger.map((p) => p.attempt).sort()).toEqual([1, 2]);
    expect(ledger.find((p) => p.status === 'installed')?.attempt).toBe(2);
  });

  it('identical evidence is never re-drafted (no spam); fresh evidence may retry as attempt 2', async () => {
    const records = [
      traj('run-1', 'R1', 'orphan', reportSteps('1'), 1),
      traj('run-2', 'R2', 'orphan', reportSteps('2'), 2),
      traj('run-3', 'R3', 'orphan', reportSteps('3'), 3),
    ];
    const runner = scriptedRunner({});
    const first = await runSelfWritingPass(proj, { records, runner, config: PASS4 });
    expect(first.rejected[0].reason).toContain('no held-out task');
    const second = await runSelfWritingPass(proj, { records, runner, config: PASS4 });
    expect(second.candidates[0].outcome).toBe('skipped');
    expect(second.candidates[0].reason).toContain('already drafted from this evidence');
    // A FOURTH task appears: fresh source evidence AND a held-out candidate.
    const grown = [...records, traj('run-4', 'R4 held-out', 'orphan', reportSteps('4'), 4)];
    const third = await runSelfWritingPass(proj, { records: grown, runner, config: PASS4 });
    expect(third.installed.length).toBe(1);
    expect(loadProposalLedger(proj).length).toBe(2);
    expect(loadProposalLedger(proj).map((p) => p.attempt).sort()).toEqual([1, 2]);
  });
});

// ─── Uninstall restores prior behavior ─────────────────────────────────────

describe('uninstall', () => {
  it('removes the skill from the catalog, archives it, restores prior behavior', async () => {
    const records = reportFixture();
    await runSelfWritingPass(proj, { records, runner: scriptedRunner({}), config: PASS4 });
    const [proposal] = loadProposalLedger(proj);
    const before = loadProjectSkills(proj, join(proj, '.mochi', 'no-user-skills')).skills.map((s) => s.name);
    expect(before).toContain(proposal.name);
    const r = uninstallSelfWrittenSkill(proj, proposal.name);
    expect(r.ok).toBe(true);
    const after = loadProjectSkills(proj, join(proj, '.mochi', 'no-user-skills')).skills.map((s) => s.name);
    expect(after).not.toContain(proposal.name);
    expect(after.sort()).toEqual(before.filter((n) => n !== proposal.name).sort());
    // Archived (recoverable), never hard-deleted:
    expect(existsSync(join(proj, '.mochi', 'skills', '.archive', proposal.name, 'SKILL.md'))).toBe(true);
    // Ledger keeps the full history:
    const [row] = listSelfWrittenSkills(proj);
    expect(row.status).toBe('uninstalled');
    expect(row.heldOut?.pass).toBe(true); // proof history retained
  });
});

// ─── Caps ──────────────────────────────────────────────────────────────────

describe('curator caps', () => {
  const fixtureSet = (): TrajectoryRecord[] => [
    // Pattern A: report kind
    traj('a-1', 'A1', 'report', reportSteps('1'), 1),
    traj('a-2', 'A2', 'report', reportSteps('2'), 2),
    traj('a-3', 'A3', 'report', reportSteps('3'), 3),
    traj('a-4', 'A4 held-out', 'report', reportSteps('4'), 4),
    // Pattern B: fixture kind (different spine)
    ...[5, 6, 7, 8].map((n) => traj(`b-${n}`, `B${n}`, 'fixture', [['run', { cmd: `init ${n}` }], ['write_file', { path: `f-${n}` }], ['run', { cmd: `check ${n}` }]], n)),
    // Pattern C: export kind (another distinct spine)
    ...[9, 10, 11, 12].map((n) => traj(`c-${n}`, `C${n}`, 'export', [['list_dir', { path: 'src' }], ['write_file', { path: `e-${n}` }], ['run', { cmd: `export ${n}` }]], n)),
  ];

  it('draft cap: only maxDraftsPerWindow proposals are made per window', async () => {
    const out = await runSelfWritingPass(proj, {
      records: fixtureSet(), runner: scriptedRunner({}),
      config: { maxDraftsPerWindow: 1, maxInstallsPerWindow: 5, maxPatternsPerPass: 8 },
    });
    expect(out.candidates.filter((c) => c.outcome === 'installed').length).toBe(1);
    expect(out.candidates.filter((c) => c.outcome === 'skipped' && c.reason?.includes('draft cap')).length).toBe(2);
    expect(loadProposalLedger(proj).length).toBe(1);
  });

  it('install cap: a held-out PASS beyond maxInstallsPerWindow does not install', async () => {
    const out = await runSelfWritingPass(proj, {
      records: fixtureSet(), runner: scriptedRunner({}),
      config: { maxDraftsPerWindow: 8, maxInstallsPerWindow: 1, maxPatternsPerPass: 8 },
    });
    expect(out.installed.length).toBe(1);
    const installRefusals = out.rejected.filter((r) => r.reason?.includes('install cap'));
    expect(installRefusals.length).toBe(2);
    const ledger = loadProposalLedger(proj);
    expect(ledger.filter((p) => p.status === 'installed').length).toBe(1);
    // The cap-refused proposals keep their proof + draft visible:
    const refused = ledger.filter((p) => p.status === 'rejected' && p.reason?.includes('install cap'));
    expect(refused.length).toBe(2);
    for (const p of refused) {
      expect(p.evaluation?.gate.pass).toBe(true);
      expect(existsSync(p.draftPath)).toBe(true);
    }
  });

  it('the window rolls: counters reset after windowMs', async () => {
    const runner = scriptedRunner({});
    const cfg = { maxDraftsPerWindow: 1, maxInstallsPerWindow: 5, maxPatternsPerPass: 8 };
    await runSelfWritingPass(proj, { records: fixtureSet(), runner, config: cfg, now: 1_000_000 });
    expect(loadProposalLedger(proj).length).toBe(1);
    // Same window: cap still binds (nothing new drafted).
    const sameWindow = await runSelfWritingPass(proj, { records: fixtureSet(), runner, config: cfg, now: 1_000_000 + 1000 });
    expect(sameWindow.candidates.every((c) => c.outcome === 'skipped')).toBe(true);
    expect(loadProposalLedger(proj).length).toBe(1);
    // After the window rolls, the next pattern can be drafted and installed.
    const later = await runSelfWritingPass(proj, { records: fixtureSet(), runner, config: cfg, now: 1_000_000 + 25 * 3600_000 });
    expect(later.installed.length).toBe(1);
    expect(loadProposalLedger(proj).length).toBe(2);
  });
});
