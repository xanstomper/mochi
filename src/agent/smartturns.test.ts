// Wave S4 — smarter per token: scripted waste fixtures (fake provider).
//
// Each scenario scripts a model exhibiting one ORDINARY waste pattern and
// measures it: provider turns, prompt chars (≈tokens at ~4 chars/token),
// and the exact tool-result chars re-injected. The same fixtures are the
// before/after proof: assertions encode the post-fix behavior, so a
// pre-fix run of this file IS the waste audit (failures + MEASURE lines).
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI, type FakeScriptResponse } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

const MATH_BUGGY = 'function add(a, b) { return a - b; }\nmodule.exports = { add };\n';
const REPRO_JS = 'const { add } = require("./math.js");\nif (add(2, 3) !== 5) { console.log("WRONG: add(2,3)=" + add(2, 3)); process.exit(1); }\nconsole.log("OK");\n';
const NOTES_JS = '// scratch notes\nconst x = 1;\nconst y = 2;\nconsole.log(x + y);\n';
// A meatier file: a repeat read/outline of THIS is where re-injection costs.
const LIB_JS = Array.from({ length: 60 }, (_, i) => `function helper${i}(x) { return x + ${i}; }`).join('\n') + '\nmodule.exports = {};\n';

const FIX_TITLE = 'Fix the bug in math.js: add() returns the wrong result';
const FIX_DESC = 'Make npm test pass. add(a, b) in math.js subtracts instead of adding, so the repro fails. Correct the arithmetic in the existing code.';
const CHECKLIST_LINE = 'The failure was reproduced (or observed) before the fix and is gone after it';
const CRITERION = 'node repro.js prints OK';

function makeConfig(dir: string, url: string, budgetTokens = 100_000): MochiConfig {
  return {
    // Model id 'gpt-4o' (the fake server ignores it). NOTE: the loop clamps
    // the working budget by the LEARNED window store (~/.mochi/window-
    // limits.json) — a global on-box file that other suites' tests have
    // poisoned with tiny "rejectedAt" records, which crushes every tool
    // result to ~360 chars and drowns the waste being measured. runScripted
    // isolates the store per fixture via MOCHI_WINDOW_LIMITS_PATH. A5 opts
    // into a small budget explicitly to force real compaction.
    model: { provider: 'openai', baseUrl: url, model: 'gpt-4o', speculative: { preflight: false } },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 60, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: budgetTokens },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

function makeRepo(extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-smartturns-'));
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node repro.js' } }));
  writeFileSync(resolve(dir, 'math.js'), MATH_BUGGY);
  writeFileSync(resolve(dir, 'repro.js'), REPRO_JS);
  writeFileSync(resolve(dir, 'notes.js'), NOTES_JS);
  writeFileSync(resolve(dir, 'lib.js'), LIB_JS);
  for (const [name, content] of Object.entries(extra)) writeFileSync(resolve(dir, name), content);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@mochi.agent'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Mochi Test'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

function wireBus(): { bus: EventBus; logs: string[] } {
  const bus = new EventBus();
  const logs: string[] = [];
  bus.onAll((e) => {
    if (e.type === 'agent:log') logs.push(String((e as { message?: unknown }).message ?? ''));
  });
  (bus as unknown as { __logs: string[] }).__logs = logs;
  return { bus, logs };
}

interface RunOut {
  success: boolean;
  result?: unknown;
  messages: string[];
  toolById: Map<string, string>;
  bodies: any[];
  logs: string[];
}

async function runScripted(
  dir: string,
  script: FakeScriptResponse[],
  bus: EventBus,
  opts: { budgetTokens?: number; criteria?: string[] } = {},
): Promise<RunOut> {
  const fake = await startFakeOpenAI(script);
  // Isolate the learned-window store (see makeConfig note): a fresh
  // per-fixture path means no learned clamp — the configured budget rules.
  process.env.MOCHI_WINDOW_LIMITS_PATH = resolve(dir, 'window-limits.json');
  try {
    const config = makeConfig(dir, fake.url, opts.budgetTokens);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal(FIX_TITLE);
    const agent = new Agent({ role: 'coder', config, workspace, events: bus, cwd: dir, context });
    const task = createTask(FIX_TITLE, FIX_DESC, opts.criteria ? { acceptanceCriteria: opts.criteria } : {});
    const result = await agent.run(task);
    const raw = context.getMessages();
    const bodies = fake.requests.map((r) => r.body);
    // Tool results AS SERVED to the model: the first request body that
    // carries each tool_call_id. (The final context is the wrong place to
    // measure — the loop's shrink/digest passes rewrite old outputs.)
    const toolById = new Map<string, string>();
    for (const b of bodies) {
      for (const m of (b?.messages ?? []) as any[]) {
        if (m?.role === 'tool' && m?.tool_call_id && !toolById.has(m.tool_call_id)) {
          toolById.set(m.tool_call_id, String(m.content ?? ''));
        }
      }
    }
    return {
      success: result.success,
      result,
      messages: raw.map((m) => String(m.content ?? '')),
      toolById,
      bodies,
      logs: (bus as unknown as { __logs?: string[] }).__logs ?? [],
    };
  } finally {
    await fake.close();
  }
}

function measure(tag: string, out: RunOut, extra: Record<string, number | string> = {}) {
  const promptChars = out.bodies.reduce((n, b) => n + JSON.stringify(b?.messages ?? []).length, 0);
  console.log(`[MEASURE] ${tag} turns=${out.bodies.length} promptChars=${promptChars} approxTokens=${Math.round(promptChars / 4)} success=${out.success} ${Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (process.env.SMART_DEBUG) {
    console.log(`[DEBUG] ${tag} result=${JSON.stringify(out.result ?? {}).slice(0, 500)}`);
    console.log(`[DEBUG] ${tag} logs=${JSON.stringify(out.logs.slice(-12)).slice(0, 1500)}`);
    console.log(`[DEBUG] ${tag} lastMessages=${JSON.stringify(out.messages.slice(-4)).slice(0, 1200)}`);
    for (const [id, c] of out.toolById) console.log(`[DEBUG] ${tag} served ${id} len=${c.length} full=${JSON.stringify(c.slice(0, 600))}`);
  }
  return { promptChars };
}

const tc = (id: string, name: string, args: Record<string, unknown>): FakeScriptResponse => ({
  finishReason: 'tool_calls',
  toolCalls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
});
const claim = (content: string): FakeScriptResponse => ({ content, finishReason: 'stop' });
const editFix = (id: string, oldText: string, newText: string) => tc(id, 'edit', { path: 'math.js', oldText, newText });
// The loop's reproduce-first gate vetoes the first mutating call on a fix
// task until a reproduction has been attempted — every scenario starts
// with the repro run (it fails; that IS the reproduction).
const repro = (id: string) => tc(id, 'shell', { command: 'node repro.js' });

describe('smartturns waste fixtures', () => {
  let dir: string | undefined;
  afterEach(() => {
    delete process.env.MOCHI_EFFORT_CALIBRATION;
    delete process.env.MOCHI_WINDOW_LIMITS_PATH;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('A1: a non-adjacent repeat read of an unchanged file is stubbed, not re-injected in full', async () => {
    dir = makeRepo();
    const { bus } = wireBus();
    const out = await runScripted(dir, [
      repro('s0'),
      tc('r1', 'read', { path: 'lib.js' }),
      tc('r2', 'read', { path: 'notes.js' }),
      // Identical repeat, NOT adjacent. The 2s provider delay puts the
      // repeat outside the ExecutionRegistry's 1500 ms anti-thrash
      // window (which replays sub-window duplicates in full by design);
      // real model turns take longer than that window, and the waste
      // class measured here is the cross-turn repeat.
      { ...tc('r3', 'read', { path: 'lib.js' }), delayMs: 2000 },
      editFix('e1', 'return a - b', 'return a + b'),
      claim('Fixed add() to return a + b.'),
    ], bus);
    const secondRead = out.toolById.get('r3') ?? '';
    measure('A1 repeat-read', out, { firstReadChars: (out.toolById.get('r1') ?? '').length, secondReadChars: secondRead.length });
    expect(out.success).toBe(true);
    expect(secondRead.length).toBeLessThan(320);
    expect(secondRead).toMatch(/unchanged|not re-sent|identical/);
  }, 180_000);

  it('A2: a repeated read-only tool call with unchanged workspace is served a short stub', async () => {
    dir = makeRepo();
    const { bus } = wireBus();
    // Three identical searches: if the first is spec-executed mid-stream
    // it bypasses the loop's store site (spec executions only register
    // with the ExecutionRegistry), so the SECOND executes normally and
    // stores — the third is then stubbed on either path.
    const out = await runScripted(dir, [
      repro('s0'),
      tc('o1', 'search', { query: 'helper' }),
      tc('r1', 'read', { path: 'notes.js' }),
      tc('o2', 'search', { query: 'helper' }), // identical repeat, no mutation between
      tc('r2', 'read', { path: 'repro.js' }),
      tc('o3', 'search', { query: 'helper' }), // identical repeat again
      editFix('e1', 'return a - b', 'return a + b'),
      claim('Fixed add() to return a + b.'),
    ], bus);
    const last = out.toolById.get('o3') ?? '';
    measure('A2 repeat-search', out, { firstSearchChars: (out.toolById.get('o1') ?? '').length, secondSearchChars: (out.toolById.get('o2') ?? '').length, lastSearchChars: last.length });
    expect(out.success).toBe(true);
    expect((out.toolById.get('o1') ?? '').length).toBeGreaterThan(1200);
    expect(last.length).toBeLessThan(500);
    expect(last).toMatch(/result-cache|unchanged/);
  }, 180_000);

  it('A3: the retry after a verifier rejection carries the structured objection — and the stub model provably uses it', async () => {
    dir = makeRepo();
    const { bus, logs } = wireBus();
    let stage = 0;
    const router: FakeScriptResponse = {
      sticky: true,
      respondFn: (body: any) => {
        const text = JSON.stringify(body?.messages ?? []);
        if (stage === 0) { stage = 1; return repro('s0'); }
        if (stage === 1) { stage = 2; return editFix('e1', 'return a - b', 'return a * b'); }
        if (stage === 2) { stage = 3; return claim('I believe the fix is in.'); }
        // The first verify has now failed. A retry that USES the objection
        // (it names the failing expectation add(2,3)=-1) fixes the bug; a
        // retry that ignores it guesses another wrong operator.
        const usesObjection = text.includes('VERIFIER OBJECTION') && text.includes('add(2,3)=-1');
        if (stage === 3) {
          if (usesObjection) { stage = 4; return editFix('e2', 'return a * b', 'return a + b'); }
          stage = 90; return editFix('e2', 'return a * b', 'return a / b');
        }
        stage = 5;
        return claim('Fixed add() to return a + b.');
      },
    };
    const out = await runScripted(dir, [router], bus);
    (out as RunOut).logs = logs;
    const objectionBodies = out.bodies.filter((b) => JSON.stringify(b?.messages ?? []).includes('VERIFIER OBJECTION'));
    // Known-errors state re-send: worst per-request length of the state line.
    let maxKnownErr = 0;
    for (const b of out.bodies) {
      for (const m of (b?.messages ?? []) as any[]) {
        const c = String(m?.content ?? '');
        const idx = c.indexOf('Known errors:');
        if (idx >= 0) maxKnownErr = Math.max(maxKnownErr, c.slice(idx).split('\n')[0].length);
      }
    }
    measure('A3 objection-retry', out, { objectionBodies: objectionBodies.length, maxKnownErrorsLineChars: maxKnownErr });
    expect(out.success).toBe(true);
    expect(objectionBodies.length).toBeGreaterThan(0);
    const firstObjection = JSON.stringify(objectionBodies[0]?.messages ?? []);
    expect(firstObjection).toContain('npm test');
    expect(firstObjection).toContain('add(2,3)=-1');
    // Exactly ONE objection block survives in the final context, marked closed.
    const blocks = out.messages.filter((m) => m.includes('VERIFIER OBJECTION'));
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toContain('CLOSED');
  }, 180_000);

  it('A4: effort calibration — proven-low kinds stop paying for high effort; the run records its outcome', async () => {
    // Seeded history: kind=fix solves 10/10 at MEDIUM. Static default is high.
    dir = makeRepo();
    const statsPath = resolve(dir, '.mochi/state/effort-stats.json');
    mkdirSync(resolve(dir, '.mochi/state'), { recursive: true });
    writeFileSync(statsPath, JSON.stringify({ version: 1, kinds: { fix: { tiers: { medium: { runs: 10, solved: 10 } } } } }));
    const { bus, logs } = wireBus();
    const out = await runScripted(dir, [
      repro('s0'),
      tc('r1', 'read', { path: 'repro.js' }),
      editFix('e1', 'return a - b', 'return a + b'),
      claim('Fixed add() to return a + b.'),
    ], bus);
    (out as RunOut).logs = logs;
    measure('A4 effort-seeded', out, { effortLogs: logs.filter((l) => l.includes('[effort-calibration]')).length });
    expect(out.success).toBe(true);
    expect(logs.some((l) => l.includes('[effort-calibration]') && l.includes('high -> medium'))).toBe(true);
    expect(out.bodies.some((b) => b?.reasoning_effort === 'medium')).toBe(true);

    // Unseeded run: the outcome is recorded against the tier actually used.
    const dir2 = makeRepo();
    try {
      const w2 = wireBus();
      const out2 = await runScripted(dir2, [
        repro('s0'),
        tc('r1', 'read', { path: 'repro.js' }),
        editFix('e1', 'return a - b', 'return a + b'),
        claim('Fixed add() to return a + b.'),
      ], w2.bus);
      expect(out2.success).toBe(true);
      const statsFile = resolve(dir2, '.mochi/state/effort-stats.json');
      expect(existsSync(statsFile)).toBe(true);
      const stats = JSON.parse(readFileSync(statsFile, 'utf8'));
      expect(stats.kinds.fix.tiers.high.runs).toBeGreaterThanOrEqual(1);
      expect(stats.kinds.fix.tiers.high.solved).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  }, 240_000);

  it('A5: task obligations (contract checklist + acceptance criteria) survive compaction', async () => {
    // Distinct big files, one read each: the loop's re-read guard counts
    // reads per PATH (any range), so re-reading one file at many offsets
    // gets vetoed as spam long before compaction can fire.
    const bigFiles: Record<string, string> = {};
    for (let f = 1; f <= 6; f++) {
      bigFiles[`big${f}.js`] = Array.from({ length: 400 }, (_, i) => `function filler${f}x${i}() { return 'aaaa bbbb cccc dddd ${f} ${i}'; }`).join('\n') + '\n';
    }
    dir = makeRepo(bigFiles);
    const { bus } = wireBus();
    let n = 0;
    const router: FakeScriptResponse = {
      sticky: true,
      respondFn: () => {
        n++;
        if (n === 1) return repro('s0');
        if (n <= 7) return tc(`b${n}`, 'read', { path: `big${n - 1}.js`, limit: 200 });
        if (n === 8) return editFix('e1', 'return a - b', 'return a + b');
        return claim('Fixed add() to return a + b.');
      },
    };
    const out = await runScripted(dir, [router], bus, { budgetTokens: 6000, criteria: [CRITERION] });
    const bodyText = out.bodies.map((b) => JSON.stringify(b?.messages ?? []));
    const firstCompact = bodyText.findIndex((t) => t.includes('Earlier in this session (compacted)'));
    const post = firstCompact >= 0 ? bodyText.slice(firstCompact) : [];
    measure('A5 compaction-obligations', out, {
      compactedAtRequest: firstCompact,
      postBodies: post.length,
      postWithChecklist: post.filter((t) => t.includes(CHECKLIST_LINE)).length,
      postWithCriterion: post.filter((t) => t.includes(CRITERION)).length,
    });
    expect(out.success).toBe(true);
    expect(firstCompact).toBeGreaterThanOrEqual(0);
    expect(post.length).toBeGreaterThan(0);
    for (const t of post) {
      expect(t).toContain(CHECKLIST_LINE);
      expect(t).toContain(CRITERION);
    }
  }, 240_000);
});
