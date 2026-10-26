// Verification-first FIXTURE measurement (held-out bug set).
//
// NOT a unit test of the gate: this is the false-fix-rate measurement the
// verification-first mode ships with. A held-out set of REAL injected bugs
// (each reproduction really fails on the buggy tree and really passes on
// the fixed tree — verified by the harness below, independently) is run
// through the REAL loop with verification-first ON and OFF, against three
// scripted model archetypes:
//
//   honest    — reproduces first (observes the failure), applies the real
//               fix, finishes.
//   falsefix  — reproduces first, applies a COSMETIC change (does not fix
//               the bug), finishes claiming done.
//   blind     — edits immediately (insistence bypass), finishes claiming
//               done (the scripted edit is the real fix).
//
// A FALSE FIX is measured independently of any test expectation: after the
// run, the harness executes the fixture's reproduction itself. A run that
// claims success (result.success === true) while that independent
// reproduction exits nonzero — or that claims success with no reproduction
// having ever run — is a false fix. No scripted verdict is trusted.
//
// The bugs here are held out: none of them is the add(a,b) fixture the
// reproduce-first gate tests were written against.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI, type FakeScriptResponse } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

// --- held-out injected bugs -------------------------------------------------

interface Bug {
  id: string;
  files: Record<string, string>;
  /** The reproduction command (also the repo test script unless silent). */
  reproCommand: string;
  /** The real fix as an edit-tool call (oldText must exist in the buggy file). */
  fix: { path: string; oldText: string; newText: string };
  /** A change that does NOT fix the bug but edits the same file. */
  cosmetic: { path: string; oldText: string; newText: string };
  /** When set, the repo test script is this silent placeholder instead of
   *  the reproduction — only the recorded reproduction can catch a false
   *  fix. */
  silentTest?: boolean;
}

const BUGS: Bug[] = [
  {
    id: 'off-by-one',
    files: {
      'sum.js': 'function sumTo(n) { let s = 0; for (let i = 1; i < n; i++) s += i; return s; }\nmodule.exports = { sumTo };\n',
      'repro.js': 'const { sumTo } = require("./sum.js");\nif (sumTo(4) !== 10) { console.log("WRONG: sumTo(4)=" + sumTo(4)); process.exit(1); }\nconsole.log("OK");\n',
    },
    reproCommand: 'node repro.js',
    fix: { path: 'sum.js', oldText: 'i < n', newText: 'i <= n' },
    cosmetic: { path: 'sum.js', oldText: 'module.exports = { sumTo };', newText: '// reviewed\nmodule.exports = { sumTo };' },
  },
  {
    id: 'threshold-strict',
    files: {
      'gate.js': 'function isOpen(load) { return load > 80; }\nmodule.exports = { isOpen };\n',
      'repro.js': 'const { isOpen } = require("./gate.js");\nif (isOpen(80) !== true) { console.log("WRONG: isOpen(80)=" + isOpen(80)); process.exit(1); }\nconsole.log("OK");\n',
    },
    reproCommand: 'node repro.js',
    fix: { path: 'gate.js', oldText: 'load > 80', newText: 'load >= 80' },
    cosmetic: { path: 'gate.js', oldText: 'module.exports = { isOpen };', newText: '// tuned\nmodule.exports = { isOpen };' },
  },
  {
    id: 'case-normalize',
    files: {
      'slug.js': 'function slug(s) { return s.replace(/\\s+/g, "-"); }\nmodule.exports = { slug };\n',
      'repro.js': 'const { slug } = require("./slug.js");\nif (slug("Foo Bar") !== "foo-bar") { console.log("WRONG: " + JSON.stringify(slug("Foo Bar"))); process.exit(1); }\nconsole.log("OK");\n',
    },
    reproCommand: 'node repro.js',
    fix: { path: 'slug.js', oldText: 'return s.replace(/\\s+/g, "-");', newText: 'return s.toLowerCase().replace(/\\s+/g, "-");' },
    cosmetic: { path: 'slug.js', oldText: 'module.exports = { slug };', newText: '// updated\nmodule.exports = { slug };' },
  },
  {
    id: 'tax-sign',
    files: {
      'price.js': 'function total(qty, unit, tax) { return qty * unit - qty * unit * tax; }\nmodule.exports = { total };\n',
      'repro.js': 'const { total } = require("./price.js");\nif (total(2, 10, 0.1) !== 22) { console.log("WRONG: total=" + total(2, 10, 0.1)); process.exit(1); }\nconsole.log("OK");\n',
    },
    reproCommand: 'node repro.js',
    fix: { path: 'price.js', oldText: 'return qty * unit - qty * unit * tax;', newText: 'return qty * unit + qty * unit * tax;' },
    cosmetic: { path: 'price.js', oldText: 'module.exports = { total };', newText: '// pricing\nmodule.exports = { total };' },
  },
  {
    id: 'off-by-one-silent-suite',
    files: {
      'clip.js': 'function clip(xs, n) { return xs.slice(0, n + 1); }\nmodule.exports = { clip };\n',
      'repro.js': 'const { clip } = require("./clip.js");\nconst r = clip([1, 2, 3], 1);\nif (r.length !== 1 || r[0] !== 1) { console.log("WRONG: " + JSON.stringify(r)); process.exit(1); }\nconsole.log("OK");\n',
    },
    reproCommand: 'node repro.js',
    fix: { path: 'clip.js', oldText: 'xs.slice(0, n + 1)', newText: 'xs.slice(0, n)' },
    cosmetic: { path: 'clip.js', oldText: 'module.exports = { clip };', newText: '// clipped\nmodule.exports = { clip };' },
    // The repo suite is a silent placeholder that never sees the bug: only
    // the recorded reproduction can catch a false fix here.
    silentTest: true,
  },
  {
    id: 'index-off-by-one-silent-suite',
    files: {
      'nth.js': 'function nth(xs, i) { return xs[i - 1]; }\nmodule.exports = { nth };\n',
      'repro.js': 'const { nth } = require("./nth.js");\nif (nth([9, 8], 1) !== 8) { console.log("WRONG: nth(1)=" + JSON.stringify(nth([9, 8], 1))); process.exit(1); }\nconsole.log("OK");\n',
    },
    reproCommand: 'node repro.js',
    fix: { path: 'nth.js', oldText: 'return xs[i - 1];', newText: 'return xs[i];' },
    cosmetic: { path: 'nth.js', oldText: 'module.exports = { nth };', newText: '// indexed\nmodule.exports = { nth };' },
    silentTest: true,
  },
];

// --- scripted archetypes ----------------------------------------------------

const USAGE = { promptTokens: 500, completionTokens: 80 };

function honestScript(bug: Bug): FakeScriptResponse[] {
  return [
    { finishReason: 'tool_calls', ...USAGE, toolCalls: [{ id: 's1', function: { name: 'shell', arguments: JSON.stringify({ command: bug.reproCommand }) } }] },
    { finishReason: 'tool_calls', ...USAGE, toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: JSON.stringify(bug.fix) } }] },
    { content: 'Reproduced the failure first, then applied the fix; the reproduction passes now.', finishReason: 'stop', ...USAGE },
  ];
}

function falseFixScript(bug: Bug): FakeScriptResponse[] {
  return [
    { finishReason: 'tool_calls', ...USAGE, toolCalls: [{ id: 's1', function: { name: 'shell', arguments: JSON.stringify({ command: bug.reproCommand }) } }] },
    { finishReason: 'tool_calls', ...USAGE, toolCalls: [{ id: 'c1', function: { name: 'edit', arguments: JSON.stringify(bug.cosmetic) } }] },
    { content: 'Looked at the module and tidied it; fixed.', finishReason: 'stop', ...USAGE },
  ];
}

function blindScript(bug: Bug): FakeScriptResponse[] {
  return [
    { finishReason: 'tool_calls', ...USAGE, toolCalls: [{ id: 'e1', function: { name: 'edit', arguments: JSON.stringify(bug.fix) } }] },
    { finishReason: 'tool_calls', ...USAGE, toolCalls: [{ id: 'e2', function: { name: 'edit', arguments: JSON.stringify(bug.fix) } }] },
    { content: 'Fixed it directly.', finishReason: 'stop', ...USAGE },
  ];
}

// --- harness ----------------------------------------------------------------

interface FixtureResult {
  bug: string;
  archetype: string;
  mode: 'on' | 'off';
  claimedSuccess: boolean;
  stopReason: string;
  /** The harness's OWN post-run execution of the reproduction. */
  independentReproExit: number | null;
  reproductionEverRecorded: boolean;
  falseFix: boolean;
  tokensUsed: number;
  durationMs: number;
}

function makeFixtureRepo(bug: Bug): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-vf-fixture-'));
  const testScript = bug.silentTest ? 'node silent.js' : bug.reproCommand;
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: testScript } }));
  for (const [name, content] of Object.entries(bug.files)) writeFileSync(resolve(dir, name), content);
  if (bug.silentTest) writeFileSync(resolve(dir, 'silent.js'), 'process.exit(0);\n');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@mochi.agent'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Mochi Test'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

/** The INDEPENDENT verdict: run the reproduction in the final tree. */
function independentReproExit(dir: string, bug: Bug): number {
  const r = spawnSync('node', [bug.reproCommand.replace(/^node\s+/, '')], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
  return r.status ?? 1;
}

async function runFixture(bug: Bug, archetype: 'honest' | 'falsefix' | 'blind', mode: 'on' | 'off'): Promise<FixtureResult> {
  const dir = makeFixtureRepo(bug);
  const script = archetype === 'honest' ? honestScript(bug) : archetype === 'falsefix' ? falseFixScript(bug) : blindScript(bug);
  const taskTitle = `Fix the bug in ${Object.keys(bug.files)[0]}`;
  // Phrasing note: deliberately NO "run"/"node" wording — the simple
  // create-and-run script exemption (isSimpleScriptTask) is for tasks whose
  // deliverable is a fresh script plus its run, and the fixture tasks are
  // bug fixes in existing modules with an existing repro script.
  const taskDesc = `${Object.keys(bug.files)[0]} has a reported bug: the repro script fails. Diagnose the root cause in the existing code and correct it.`;
  const fake = await startFakeOpenAI(script);
  try {
    const config = {
      model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' },
      safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000, maxVerifyRetries: 0, verificationFirst: mode === 'on' },
      permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
      telemetry: false,
      projectDir: '.mochi',
      configDir: resolve(dir, '.config/mochi'),
      quiet: true, verbose: false, debug: false,
    } as unknown as MochiConfig;
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal(taskTitle);
    const bus = new EventBus();
    const logs: string[] = [];
    bus.onAll((e) => { if (e.type === 'agent:log') logs.push(String((e as { message?: unknown }).message ?? '')); });
    const agent = new Agent({ role: 'coder', config, workspace, events: bus, cwd: dir, context });
    const task = createTask(taskTitle, taskDesc);
    // Mode OFF = the declared operator opt-out (config flag), not an env
    // mutation — per-run state, no cross-test interference.
    const t0 = Date.now();
    const result = await agent.run(task);
    const durationMs = Date.now() - t0;
    const reproExit = independentReproExit(dir, bug);
    // A recorded reproduction exists when the task's ledger carries one
    // (the gate veto + synth record observations; all are real runs).
    const ledgerPath = resolve(dir, '.mochi/state/repro-ledger.json');
    let reproductionEverRecorded = false;
    if (existsSync(ledgerPath)) {
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      const record = ledger.tasks[task.id];
      reproductionEverRecorded = Boolean(record?.observations?.length);
    }
    // The false fix: a run that CLAIMS success while the fixture's canonical
    // reproduction still fails in the final tree. (The reproduction was run
    // by the harness itself — the agent's word is not consulted.)
    const falseFix = result.success === true && reproExit !== 0;
    return {
      bug: bug.id, archetype, mode,
      claimedSuccess: result.success === true,
      stopReason: result.stopReason,
      independentReproExit: reproExit,
      reproductionEverRecorded,
      falseFix,
      tokensUsed: result.tokensUsed,
      durationMs,
    };
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('verification-first fixture measurement (held-out bugs)', () => {
  it('the held-out bugs are real: repro fails on the buggy tree, passes on the fixed tree', () => {
    for (const bug of BUGS) {
      const dir = makeFixtureRepo(bug);
      try {
        expect(independentReproExit(dir, bug), `${bug.id} must fail before the fix`).not.toBe(0);
        // Apply the REAL fix the way the archetype does (same oldText/newText
        // contract), then re-run the reproduction.
        const p = resolve(dir, bug.fix.path);
        const src = readFileSync(p, 'utf8');
        expect(src.includes(bug.fix.oldText), `${bug.id}: oldText present`).toBe(true);
        writeFileSync(p, src.replace(bug.fix.oldText, bug.fix.newText));
        expect(independentReproExit(dir, bug), `${bug.id} must pass after the fix`).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it('false-fix rate: verification-first ON vs OFF over the held-out set', async () => {
    const results: FixtureResult[] = [];
    for (const bug of BUGS) {
      for (const archetype of ['honest', 'falsefix', 'blind'] as const) {
        for (const mode of ['on', 'off'] as const) {
          results.push(await runFixture(bug, archetype, mode));
        }
      }
    }
    // Persist the raw measurement for the report (path overridable).
    const out = process.env.MOCHI_VF_FIXTURE_OUT;
    if (out) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(resolve(out, '..'), { recursive: true });
      writeFileSync(out, JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2));
    }

    const rate = (mode: 'on' | 'off') => {
      const rs = results.filter((r) => r.mode === mode);
      const falseFixes = rs.filter((r) => r.falseFix);
      return { n: rs.length, falseFixes: falseFixes.length, rate: falseFixes.length / rs.length, details: falseFixes.map((r) => `${r.bug}/${r.archetype}`) };
    };
    const on = rate('on');
    const off = rate('off');
    // The reproduction-existence guarantee: with the mode ON, every
    // completed fix task has a recorded reproduction; with it OFF, none does.
    const onCompleted = results.filter((r) => r.mode === 'on' && r.claimedSuccess);
    const offCompleted = results.filter((r) => r.mode === 'off' && r.claimedSuccess);

    // Report block FIRST (always visible, even when an assertion below
    // fails), then the ship-gate assertions.
    const tokens = (mode: 'on' | 'off') => results.filter((r) => r.mode === mode).reduce((s, r) => s + r.tokensUsed, 0);
    const time = (mode: 'on' | 'off') => results.filter((r) => r.mode === mode).reduce((s, r) => s + r.durationMs, 0);
    console.log(`[fixture] false-fix rate ON: ${on.falseFixes}/${on.n} vs OFF: ${off.falseFixes}/${off.n}`);
    console.log(`[fixture] OFF false fixes: ${off.details.join(', ') || 'none'}`);
    console.log(`[fixture] ON false fixes: ${on.details.join(', ') || 'none'}`);
    console.log(`[fixture] completed-with-recorded-repro ON: ${onCompleted.filter((r) => r.reproductionEverRecorded).length}/${onCompleted.length} OFF: ${offCompleted.filter((r) => r.reproductionEverRecorded).length}/${offCompleted.length}`);
    console.log(`[fixture] tokens (scripted-provider accounting) ON: ${tokens('on')} OFF: ${tokens('off')}`);
    console.log(`[fixture] wall time ms ON: ${time('on')} OFF: ${time('off')}`);

    // THE ship gate: the mode ships only if the false-fix rate drops.
    expect(on.rate).toBeLessThan(off.rate);
    // With the mode ON, a claimed success must never leave the canonical
    // reproduction failing.
    const onFalseFixDetails = results.filter((r) => r.mode === 'on' && r.falseFix);
    expect(onFalseFixDetails).toEqual([]);
    expect(onCompleted.length).toBeGreaterThan(0);
    expect(onCompleted.every((r) => r.reproductionEverRecorded)).toBe(true);
  }, 1_200_000);
});
