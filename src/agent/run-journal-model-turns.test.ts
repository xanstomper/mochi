// Wave H1: model-turn replay in the durable run journal.
//
// Phase C6 journaled completed TOOL steps (replayed on resume instead of
// re-executing) but the loop never recorded or replayed MODEL turns — a
// resumed run re-drove and re-billed every turn from scratch. H1 closes
// that: each completed model turn is journaled with a fingerprint of the
// exact request that produced it; on resume, a request whose fingerprint
// matches the next journaled turn (in sequence) is served the recorded
// response, its usage accounted exactly once. The first mismatch ends
// model-turn replay for the session; the run continues live.
//
// Loop-level cases (scripted counting fake = ground truth):
//   (a) kill-and-resume — ZERO provider calls for the journaled prefix,
//       tool steps not re-executed, total billed == single-run total.
//   (b) divergent resume (extra steer message) — replay stops at turn 1,
//       provider drives live from there.
//   (c) opt-out (option / env / journal disabled) — nothing recorded,
//       nothing replayed, behavior identical to pre-H1.
//   (d) rails — corrupted journal (wholesale + mid-chain) and the
//       module-level version-skew / divergence rails: no response is
//       ever served past a rail.
// Module-level cases pin the chain semantics: sequence-strict claims,
// permanent latch on mismatch, chains spanning sessions, failed /
// truncated turns sealing the chain at load.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI, type FakeOpenAI, type FakeScriptResponse } from '../testutil/fake-openai.js';
import { RunJournal, journalFilePath, modelTurnFingerprint, readJournalEntries } from './run-journal.js';
import type { MochiConfig } from '../types.js';
import type { Tool } from '../tools/types.js';

// Speculative preflight could issue extra provider calls; exact request
// counting is the ground truth here, so pin it off (same as the G1
// usage-accounting tests).
const prevPreflight = process.env.MOCHI_SPECULATIVE_PREFLIGHT;
beforeAll(() => { process.env.MOCHI_SPECULATIVE_PREFLIGHT = '0'; });
afterAll(() => {
  if (prevPreflight === undefined) delete process.env.MOCHI_SPECULATIVE_PREFLIGHT;
  else process.env.MOCHI_SPECULATIVE_PREFLIGHT = prevPreflight;
});

function makeConfig(dir: string, url: string, maxIterations: number): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 10,
      maxIterations,
      maxRuntimeMinutes: 5,
      maxConcurrentAgents: 1,
      contextBudgetTokens: 4000,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true,
    verbose: false,
    debug: false,
  } as unknown as MochiConfig;
}

/** Three-turn script: count a, count b, final answer. Distinct per-turn
 *  usage so billing totals are exact: single-run total is
 *  330 input / 33 output / $0.06. */
function script(idPrefix: string): FakeScriptResponse[] {
  return [
    {
      content: 'Counting a.',
      toolCalls: [{ id: `${idPrefix}-1`, type: 'function', function: { name: 'count_step', arguments: JSON.stringify({ label: 'a' }) } }],
      finishReason: 'tool_calls', promptTokens: 100, completionTokens: 10, costUsd: 0.01,
    },
    {
      content: 'Counting b.',
      toolCalls: [{ id: `${idPrefix}-2`, type: 'function', function: { name: 'count_step', arguments: JSON.stringify({ label: 'b' }) } }],
      finishReason: 'tool_calls', promptTokens: 110, completionTokens: 11, costUsd: 0.02,
    },
    {
      content: 'The counter total is two steps: a and b.',
      finishReason: 'stop', promptTokens: 120, completionTokens: 12, costUsd: 0.03,
    },
  ];
}

interface UsageEvent { inputTokens: number; outputTokens: number; costUsd?: number }

function makeCountTool(counter: { calls: number; labels: string[] }): Tool {
  return {
    def: {
      name: 'count_step',
      description: 'Counts one step execution (test side-effect tool).',
      parameters: [{ name: 'label', type: 'string', description: 'Step label', required: true }],
    },
    execute: async (args) => {
      counter.calls++;
      counter.labels.push(String(args.label));
      return `counted ${String(args.label)}: execution #${counter.calls}`;
    },
  };
}

interface RunOpts {
  maxIterations?: number;
  journalModelTurns?: boolean;
  journalEnabled?: boolean;
  /** Mutate the fresh context before the run (e.g. inject a steer). */
  prepareContext?: (context: ContextEngine) => void;
}

function makeRunner(dir: string, fake: FakeOpenAI, tool: Tool, task: ReturnType<typeof createTask>) {
  return async (opts: RunOpts = {}) => {
    const config = makeConfig(dir, fake.url, opts.maxIterations ?? 10);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('Counter total');
    opts.prepareContext?.(context);
    const events = new EventBus();
    const usageEvents: UsageEvent[] = [];
    events.on('usage:updated', (e) => usageEvents.push(e as unknown as UsageEvent));
    const agent = new Agent({
      role: 'coder',
      config,
      workspace,
      events,
      cwd: dir,
      context,
      extraTools: new Map([['count_step', tool]]),
      ...(opts.journalModelTurns !== undefined ? { journalModelTurns: opts.journalModelTurns } : {}),
      ...(opts.journalEnabled !== undefined ? { journalEnabled: opts.journalEnabled } : {}),
    });
    const result = await agent.run(task);
    return { result, stats: agent.getJournalStats(), usageEvents };
  };
}

function journalStepKinds(dir: string, taskId: string): string[] {
  return readJournalEntries(resolve(dir, '.mochi'), taskId)
    .filter((e) => e.kind === 'step')
    .map((e) => (e.kind === 'step' ? e.stepKind : '?'));
}

describe('model-turn journal replay (loop level)', () => {
  it('(a) kill-and-resume: journaled prefix replays with zero provider calls and single-run billing', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-journal-turns-a-'));
    const counter = { calls: 0, labels: [] as string[] };
    // Exactly the two responses the capped first run will consume — an
    // unconsumed residue would silently serve the resume's first live
    // call and corrupt the request counting below.
    const fake = await startFakeOpenAI(script('call').slice(0, 2));
    try {
      const task = createTask('What is the counter total?', 'The counter total is the sum of the two count_step outputs for labels a and b.');
      const runOnce = makeRunner(dir, fake, makeCountTool(counter), task);

      // ── Run 1: "killed" after turn 2 by the iteration cap ────────────
      const first = await runOnce({ maxIterations: 2 });
      expect(first.result.success).toBe(false);
      expect(fake.requests.length).toBe(2); // exactly two provider calls
      expect(counter.calls).toBe(2); // both tool steps executed
      expect(first.stats?.recordedSteps).toBe(4); // 2 model turns + 2 tool steps
      expect(first.stats?.usage.inputTokens).toBe(210); // turns 1+2 only
      expect(first.stats?.usage.outputTokens).toBe(21);

      // ── Resume: only the final response is even offered ─────────────
      fake.append([script('resume')[2]!]);
      const second = await runOnce({ maxIterations: 10 });

      expect(second.result.success).toBe(true);
      // ONE live provider call in the whole resume (the final turn):
      // both journaled turns were served from the journal.
      expect(fake.requests.length).toBe(3);
      // Tool steps replayed too — the side-effect counter never moved.
      expect(counter.calls).toBe(2);
      expect(counter.labels).toEqual(['a', 'b']);
      expect(second.stats?.replayedModelTurns).toBe(2);
      expect(second.stats?.replayedSteps).toBe(4); // 2 turns + 2 tool steps
      expect(second.stats?.recordedSteps).toBe(1); // only the live final turn

      // Billed exactly once: the resume's per-call usage events sum to
      // the uninterrupted single-run total (330 in / 33 out / $0.06) —
      // replayed turns contribute their recorded usage a single time.
      const billedIn = second.usageEvents.reduce((s, e) => s + e.inputTokens, 0);
      const billedOut = second.usageEvents.reduce((s, e) => s + e.outputTokens, 0);
      const billedCost = second.usageEvents.reduce((s, e) => s + (e.costUsd ?? 0), 0);
      expect(billedIn).toBe(330);
      expect(billedOut).toBe(33);
      expect(billedCost).toBeCloseTo(0.06, 9);
      expect(second.result.costUsd).toBeCloseTo(0.06, 9);
      // Journal-wide accounting agrees: loaded + newly recorded entries,
      // replays adding nothing.
      expect(second.stats?.usage.inputTokens).toBe(330);
      expect(second.stats?.usage.outputTokens).toBe(33);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('(b) divergent resume: an extra steer message ends replay at turn 1 and the provider drives live', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-journal-turns-b-'));
    const counter = { calls: 0, labels: [] as string[] };
    const fake = await startFakeOpenAI(script('call').slice(0, 2));
    try {
      const task = createTask('What is the counter total?', 'The counter total is the sum of the two count_step outputs for labels a and b.');
      const runOnce = makeRunner(dir, fake, makeCountTool(counter), task);

      const first = await runOnce({ maxIterations: 2 });
      expect(first.result.success).toBe(false);
      expect(fake.requests.length).toBe(2);

      // Resume with a steer the original run never had: the very first
      // request now differs from the journaled turn 1, so replay must
      // stop there and everything runs live with fresh ids.
      fake.append(script('live'));
      const second = await runOnce({
        maxIterations: 10,
        prepareContext: (context) => {
          context.addMessage({ role: 'user', content: 'Steer: when you finish, also list the labels you counted.' });
        },
      });

      expect(second.result.success).toBe(true);
      expect(fake.requests.length).toBe(2 + 3); // all three turns called live
      expect(second.stats?.replayedModelTurns).toBeUndefined();
      // Tool-step replay keeps its own (C6) semantics under the live
      // model: the regenerated calls carry identical args, so both steps
      // are served by signature and the side effects are not repeated.
      expect(counter.calls).toBe(2);
      expect(second.stats?.replayedSteps).toBe(2);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('(c) opt-out via journalModelTurns=false: no model turns recorded or replayed; tool replay unchanged', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-journal-turns-c-'));
    const counter = { calls: 0, labels: [] as string[] };
    const fake = await startFakeOpenAI(script('call'));
    try {
      const task = createTask('What is the counter total?', 'The counter total is the sum of the two count_step outputs for labels a and b.');
      const runOnce = makeRunner(dir, fake, makeCountTool(counter), task);

      const first = await runOnce({ journalModelTurns: false });
      expect(first.result.success).toBe(true);
      expect(fake.requests.length).toBe(3);
      // Tool steps journaled exactly as before H1; zero model turns.
      expect(journalStepKinds(dir, task.id)).toEqual(['tool_call', 'tool_call']);
      expect(first.stats?.recordedSteps).toBe(2);

      fake.append(script('resume-call'));
      const second = await runOnce();
      expect(second.result.success).toBe(true);
      expect(fake.requests.length).toBe(3 + 3); // every turn called live
      expect(counter.calls).toBe(2); // tool steps still replayed
      expect(second.stats?.replayedSteps).toBe(2);
      expect(second.stats?.replayedModelTurns).toBeUndefined();
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('(c2) opt-out via env MOCHI_JOURNAL_MODEL_TURNS=0: no model turns recorded', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-journal-turns-c2-'));
    const counter = { calls: 0, labels: [] as string[] };
    const fake = await startFakeOpenAI(script('call'));
    const prev = process.env.MOCHI_JOURNAL_MODEL_TURNS;
    process.env.MOCHI_JOURNAL_MODEL_TURNS = '0';
    try {
      const task = createTask('What is the counter total?', 'The counter total is the sum of the two count_step outputs for labels a and b.');
      const runOnce = makeRunner(dir, fake, makeCountTool(counter), task);
      const first = await runOnce();
      expect(first.result.success).toBe(true);
      expect(journalStepKinds(dir, task.id)).toEqual(['tool_call', 'tool_call']);
    } finally {
      if (prev === undefined) delete process.env.MOCHI_JOURNAL_MODEL_TURNS;
      else process.env.MOCHI_JOURNAL_MODEL_TURNS = prev;
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('(c3) journal disabled entirely: no journal file, behavior identical to pre-journal', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-journal-turns-c3-'));
    const counter = { calls: 0, labels: [] as string[] };
    const fake = await startFakeOpenAI(script('call'));
    try {
      const task = createTask('What is the counter total?', 'The counter total is the sum of the two count_step outputs for labels a and b.');
      const runOnce = makeRunner(dir, fake, makeCountTool(counter), task);
      const first = await runOnce({ journalEnabled: false });
      expect(first.result.success).toBe(true);
      expect(fake.requests.length).toBe(3);
      expect(counter.calls).toBe(2);
      expect(existsSync(journalFilePath(resolve(dir, '.mochi'), task.id))).toBe(false);
      expect(first.stats).toBeUndefined();
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('(d) wholesale-corrupted journal: no model replay, the run completes live', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-journal-turns-d-'));
    const counter = { calls: 0, labels: [] as string[] };
    const fake = await startFakeOpenAI(script('call'));
    try {
      const task = createTask('What is the counter total?', 'The counter total is the sum of the two count_step outputs for labels a and b.');
      const runOnce = makeRunner(dir, fake, makeCountTool(counter), task);
      const first = await runOnce();
      expect(first.result.success).toBe(true);
      expect(fake.requests.length).toBe(3);

      // Corrupt every line of the journal.
      const file = journalFilePath(resolve(dir, '.mochi'), task.id);
      writeFileSync(file, readFileSync(file, 'utf8').split('\n').map((l) => (l.trim() ? '{"kind":"step",BROKEN' : l)).join('\n'));

      fake.append(script('resume-call'));
      const second = await runOnce();
      expect(second.result.success).toBe(true);
      expect(fake.requests.length).toBe(3 + 3); // all live
      expect(counter.calls).toBe(4); // nothing replayed at all
      expect(second.stats?.replayedModelTurns).toBeUndefined();
      expect(second.stats?.replayedSteps).toBe(0);
      expect(second.stats?.corruptLines).toBeGreaterThan(0);
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('(d2) mid-chain corruption: replay serves only the intact prefix, then goes live', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-journal-turns-d2-'));
    const counter = { calls: 0, labels: [] as string[] };
    const fake = await startFakeOpenAI(script('call').slice(0, 2));
    try {
      const task = createTask('What is the counter total?', 'The counter total is the sum of the two count_step outputs for labels a and b.');
      const runOnce = makeRunner(dir, fake, makeCountTool(counter), task);
      const first = await runOnce({ maxIterations: 2 });
      expect(first.result.success).toBe(false);
      expect(fake.requests.length).toBe(2);

      // Corrupt ONLY the second model turn's line: turn 1's entry stays
      // intact and claimable; the chain has a gap where turn 2 was.
      const file = journalFilePath(resolve(dir, '.mochi'), task.id);
      const lines = readFileSync(file, 'utf8').split('\n');
      let modelTurnsSeen = 0;
      const rewritten = lines.map((line) => {
        if (!line.trim()) return line;
        try {
          const parsed = JSON.parse(line) as { stepKind?: string };
          if (parsed.stepKind === 'model_turn') {
            modelTurnsSeen++;
            if (modelTurnsSeen === 2) return '{"kind":"step",BROKEN';
          }
        } catch { /* leave other lines untouched */ }
        return line;
      });
      expect(modelTurnsSeen).toBe(2);
      writeFileSync(file, rewritten.join('\n'));

      // Resume: turn 2 (fresh ids) + turn 3 are the only live responses.
      fake.append([script('live')[1]!, script('live')[2]!]);
      const second = await runOnce({ maxIterations: 10 });
      expect(second.result.success).toBe(true);
      // Turn 1 replayed; turns 2-3 live — replay stopped exactly at the
      // corrupted entry and never served anything past it.
      expect(second.stats?.replayedModelTurns).toBe(1);
      expect(fake.requests.length).toBe(2 + 2);
      // Tool steps (intact entries) still replayed by signature.
      expect(counter.calls).toBe(2);
      expect(second.stats?.replayedSteps).toBe(3); // turn 1 + tools a, b
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// ── Module-level chain semantics ──────────────────────────────────────

function fp(seed: string): string {
  return modelTurnFingerprint({
    provider: 'openai',
    model: 'fake-model',
    messages: [{ role: 'user', content: `request ${seed}` }],
    tools: [],
    temperature: 0.2,
    reasoningEffort: null,
  });
}

function recordTurn(journal: RunJournal, seed: string): void {
  journal.recordModelTurn({
    stepId: `turn-${seed}`,
    output: JSON.stringify({ content: `response ${seed}` }),
    fingerprint: fp(seed),
    usage: { inputTokens: 10, outputTokens: 2 },
  });
}

describe('model-turn chain (module level)', () => {
  it('(b2) claims are sequence-strict and the first mismatch latches replay off permanently', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-journal-chain-'));
    try {
      const first = RunJournal.open({ baseDir: dir, runId: 'chain' });
      first.beginRun({});
      recordTurn(first, 'a');
      recordTurn(first, 'b');
      recordTurn(first, 'c');

      const resumed = RunJournal.open({ baseDir: dir, runId: 'chain' });
      expect(resumed.hasClaimableModelTurns()).toBe(true);
      const claimA = resumed.claimModelTurn(fp('a'));
      expect((claimA?.payload as { content?: string })?.content).toBe('response a');
      // Next request is NOT turn b's: mismatch — replay ends here...
      expect(resumed.claimModelTurn(fp('c'))).toBeUndefined();
      // ...permanently: even the correct fingerprint is refused now.
      expect(resumed.claimModelTurn(fp('b'))).toBeUndefined();
      expect(resumed.hasClaimableModelTurns()).toBe(false);
      expect(resumed.stats().replayedModelTurns).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the chain spans sessions: turns a later session records extend the replayable prefix', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-journal-chain2-'));
    try {
      const s1 = RunJournal.open({ baseDir: dir, runId: 'multi' });
      s1.beginRun({});
      recordTurn(s1, 'a');
      recordTurn(s1, 'b');

      const s2 = RunJournal.open({ baseDir: dir, runId: 'multi' });
      expect(s2.claimModelTurn(fp('a'))).toBeDefined();
      expect(s2.claimModelTurn(fp('b'))).toBeDefined();
      // Frontier reached: nothing journaled for turn c yet.
      expect(s2.claimModelTurn(fp('c'))).toBeUndefined();
      // The session runs turn c live and records it.
      recordTurn(s2, 'c');

      const s3 = RunJournal.open({ baseDir: dir, runId: 'multi' });
      expect(s3.claimModelTurn(fp('a'))).toBeDefined();
      expect(s3.claimModelTurn(fp('b'))).toBeDefined();
      expect(s3.claimModelTurn(fp('c'))).toBeDefined();
      expect(s3.stats().replayedModelTurns).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failed model turn seals the chain at load: later turns are never served', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-journal-chain3-'));
    try {
      const s1 = RunJournal.open({ baseDir: dir, runId: 'sealed' });
      s1.beginRun({});
      recordTurn(s1, 'a');
      s1.recordStep({
        stepId: 'turn-b', toolName: 'model_turn', stepKind: 'model_turn',
        args: {}, output: JSON.stringify({ content: 'response b' }),
        error: 'provider stream died', fingerprint: fp('b'),
      });
      recordTurn(s1, 'c');

      const s2 = RunJournal.open({ baseDir: dir, runId: 'sealed' });
      expect(s2.claimModelTurn(fp('a'))).toBeDefined();
      // Turn b failed (not servable) and turn c sits behind the gap.
      expect(s2.claimModelTurn(fp('c'))).toBeUndefined();
      expect(s2.stats().replayedModelTurns).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an output-truncated model turn is audit-only and seals the chain', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-journal-chain4-'));
    try {
      const s1 = RunJournal.open({ baseDir: dir, runId: 'truncated' });
      s1.beginRun({});
      s1.recordModelTurn({
        stepId: 'turn-big',
        output: JSON.stringify({ content: 'x'.repeat(200_000) }),
        fingerprint: fp('big'),
      });
      const s2 = RunJournal.open({ baseDir: dir, runId: 'truncated' });
      expect(s2.hasClaimableModelTurns()).toBe(false);
      expect(s2.claimModelTurn(fp('big'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(d3) version skew: a newer-format line makes model turns unclaimable', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-journal-chain5-'));
    try {
      const s1 = RunJournal.open({ baseDir: dir, runId: 'skew' });
      s1.beginRun({});
      recordTurn(s1, 'a');
      // A line from a newer journal format lands in the file.
      const file = journalFilePath(dir, 'skew');
      const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
      const entry = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
      writeFileSync(file, `${lines.join('\n')}\n${JSON.stringify({ ...entry, v: 99, seq: 99 })}\n`);

      const s2 = RunJournal.open({ baseDir: dir, runId: 'skew' });
      expect(s2.stats().versionSkew).toBe(true);
      expect(s2.hasClaimableModelTurns()).toBe(false);
      expect(s2.claimModelTurn(fp('a'))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('(d4) divergence: git HEAD moved outside the journaled run — no model replay', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-journal-chain6-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    try {
      git(['init', '-q']);
      git(['config', 'user.email', 'test@mochi.agent']);
      git(['config', 'user.name', 'Mochi Test']);
      writeFileSync(resolve(dir, 'work.txt'), 'v1\n');
      git(['add', '-A']);
      git(['commit', '-qm', 'initial']);

      const baseDir = resolve(dir, '.mochi');
      const s1 = RunJournal.open({ baseDir, runId: 'diverged', cwd: dir });
      s1.beginRun({});
      recordTurn(s1, 'a'); // captures git HEAD #1

      // The world moves outside the run: a commit the journal never saw.
      writeFileSync(resolve(dir, 'work.txt'), 'v2 — edited outside the run\n');
      git(['add', '-A']);
      git(['commit', '-qm', 'outside work']);

      const s2 = RunJournal.open({ baseDir, runId: 'diverged', cwd: dir });
      expect(s2.claimModelTurn(fp('a'))).toBeUndefined();
      expect(s2.stats().diverged).toBe(true);
      expect(s2.hasClaimableModelTurns()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
