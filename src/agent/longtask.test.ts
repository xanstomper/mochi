// Long-task milestone strategy — loop-level proof (Wave R2).
//
// Deterministic fixture: a 5-stage project task on a fixture repo, driven
// by a scripted fake model that reads the CURRENT MILESTONE brief out of
// the request and does exactly what the brief says (write the named file
// with the named content, then claim). Each milestone's check is a real
// harness-run command (`node check.js <stage> <file> <expected>`) that
// appends to checks.log on every execution — so check executions, and
// any re-execution of a closed milestone, are exactly countable.
//
// Scenarios:
//  (i) clean run — completes milestone-by-milestone, checks pass
//  (ii) kill mid-milestone-3 → resume restarts at the milestone-3
//       boundary; milestones 1–2 are NOT re-executed (checks.log proof)
//  (iii) a milestone whose check contradicts its own detail (wrong
//       assumption) → evidence-gated re-plan of the remaining
//       milestones → run completes
//  (iv) the same fixture WITHOUT the strategy layer (baseline) —
//       turns/tokens logged for RESULT.md comparison
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { readJournalEntries, type JournalStepEntry } from './run-journal.js';
import { milestoneStateRelPath, type MilestoneInput } from './milestones.js';
import { startFakeOpenAI, type FakeScriptResponse } from '../testutil/fake-openai.js';
import type { MochiConfig } from '../types.js';

const CHECK_JS = `'use strict';
const fs = require('fs');
const [stage, file, expected] = process.argv.slice(2);
fs.appendFileSync('checks.log', stage + ':' + expected + '\\n');
let ok = false;
try { ok = fs.readFileSync(file, 'utf8').trim() === expected; } catch { ok = false; }
process.exit(ok ? 0 : 1);
`;

const TASK_TITLE = 'Build the five-stage fixture project';
const TASK_DESC = 'Create stage-1.txt through stage-5.txt, each containing its stage marker.';
const STAGE_FILES = ['stage-1.txt', 'stage-2.txt', 'stage-3.txt', 'stage-4.txt', 'stage-5.txt'];

const VERIFY_ALL_JS = `'use strict';
const fs = require('fs');
let bad = [];
for (let k = 1; k <= 5; k++) {
  let c = null;
  try { c = fs.readFileSync('stage-' + k + '.txt', 'utf8').trim(); } catch { c = null; }
  if (c !== 'stage-' + k) bad.push('stage-' + k + '.txt');
}
if (bad.length) { console.error('wrong or missing: ' + bad.join(', ')); process.exit(1); }
console.log('all five stage files OK');
`;

function makeRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-longtask-'));
  // The repo HAS a real test (verify-all.js) so the loop's task-level
  // verify gate has a repo check to judge the finished work in every
  // session — a fresh run AND a resumed one (where the stage files
  // already exist, so the task no longer classifies as greenfield and
  // the gate rightly demands real coverage). MILESTONE verdicts still
  // come from the per-milestone checks (check.js), not from this test.
  writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'lt-fixture', version: '1.0.0', scripts: { test: 'node verify-all.js' } }));
  writeFileSync(resolve(dir, 'verify-all.js'), VERIFY_ALL_JS);
  writeFileSync(resolve(dir, 'check.js'), CHECK_JS);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@mochi.agent'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Mochi Test'], { cwd: dir });
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: dir });
  return dir;
}

function makeConfig(dir: string, url: string): MochiConfig {
  return {
    // preflight: false — the speculative preflight makes its OWN provider
    // calls, which would consume router responses meant for the main loop.
    model: { provider: 'openai', baseUrl: url, model: 'fake-model', speculative: { preflight: false } },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 40, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 8000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

function stagePlan(): MilestoneInput[] {
  return [1, 2, 3, 4, 5].map((k) => ({
    id: `stage${k}`,
    title: `Stage ${k} file`,
    detail: `Write stage-${k}.txt containing exactly: stage-${k}`,
    check: { kind: 'command' as const, command: `node check.js stage${k} stage-${k}.txt stage-${k}` },
  }));
}

function makeTask(taskId?: string) {
  return createTask(TASK_TITLE, TASK_DESC, {
    ...(taskId ? { id: taskId } : {}),
    fileScope: STAGE_FILES,
    acceptanceCriteria: ['All five stage files exist with their exact stage contents.'],
  });
}

/** The last milestone brief in the transcript, if any: which milestone
 *  the harness is currently briefing, plus the file/content its detail
 *  names ("Write <file> containing exactly: <content>"). */
function lastBrief(body: unknown): { index: number; file: string; expected: string } | null {
  const b = body as { messages?: Array<{ content?: unknown }> };
  let found: { index: number; file: string; expected: string } | null = null;
  for (const m of b.messages ?? []) {
    const content = typeof m.content === 'string' ? m.content : '';
    let idx = content.lastIndexOf('CURRENT MILESTONE ');
    const resumedIdx = content.lastIndexOf('RESUMED AT MILESTONE ');
    idx = Math.max(idx, resumedIdx);
    if (idx < 0) continue;
    const tail = content.slice(idx);
    const head = /(?:CURRENT MILESTONE|RESUMED AT MILESTONE) (\d+)\/\d+/.exec(tail);
    const detail = /Write ([\w.-]+) containing exactly: ([\w-]+)/.exec(tail);
    if (head && detail) found = { index: Number(head[1]), file: detail[1], expected: detail[2] };
  }
  return found;
}

function readChecks(dir: string): string[] {
  const p = resolve(dir, 'checks.log');
  return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
}

function fileContent(dir: string, name: string): string | null {
  const p = resolve(dir, name);
  return existsSync(p) ? readFileSync(p, 'utf8').trim() : null;
}

const TOKENS = { promptTokens: 120, completionTokens: 40 };
let callSeq = 0;
function toolCall(name: string, args: Record<string, unknown>): FakeScriptResponse {
  return {
    finishReason: 'tool_calls',
    toolCalls: [{ id: `tc-${++callSeq}`, function: { name, arguments: JSON.stringify(args) } }],
    ...TOKENS,
  };
}
const claim = (content: string): FakeScriptResponse => ({ content, finishReason: 'stop', ...TOKENS });

interface WorkerOpts {
  /** After writing milestone 2's file, run its check via shell instead of claiming. */
  shellCloseMilestone2?: boolean;
  /** Write 'wip' content for milestone 3 and never finish it (kill scenario). */
  stallAt3?: boolean;
}

/** The scripted worker: follow the current milestone brief; with no
 *  brief in the transcript (baseline arm), write the next missing stage
 *  file directly. */
function makeWorker(dir: string, opts: WorkerOpts = {}): (body: unknown) => FakeScriptResponse {
  return (body) => {
    const brief = lastBrief(body);
    if (!brief) {
      for (let k = 1; k <= 5; k++) {
        if (fileContent(dir, `stage-${k}.txt`) !== `stage-${k}`) {
          return toolCall('write', { path: `stage-${k}.txt`, content: `stage-${k}` });
        }
      }
      return claim('All five stage files are written.');
    }
    if (opts.stallAt3 && brief.index === 3) {
      if (fileContent(dir, brief.file) === null) return toolCall('write', { path: brief.file, content: 'wip' });
      // Park on a read-only call; the test aborts the run mid-milestone.
      return toolCall('read', { path: brief.file });
    }
    if (fileContent(dir, brief.file) !== brief.expected) {
      return toolCall('write', { path: brief.file, content: brief.expected });
    }
    if (opts.shellCloseMilestone2 && brief.index === 2 && !readChecks(dir).some((l) => l.startsWith('stage2:'))) {
      return toolCall('shell', { command: 'node check.js stage2 stage-2.txt stage-2' });
    }
    return claim(`Milestone ${brief.index} complete.`);
  };
}

function wireBus(): { bus: EventBus; logs: string[] } {
  const bus = new EventBus();
  const logs: string[] = [];
  bus.onAll((e) => {
    if (e.type === 'agent:log') logs.push(String((e as { message?: unknown }).message ?? ''));
  });
  return { bus, logs };
}

function makeAgent(
  dir: string,
  url: string,
  bus: EventBus,
  extra: Record<string, unknown> = {},
) {
  const config = makeConfig(dir, url);
  const workspace = new Workspace(dir, '.mochi');
  workspace.ensure();
  const context = new ContextEngine(config, dir);
  context.setGoal(TASK_TITLE);
  const agent = new Agent({
    role: 'coder', config, workspace, events: bus, cwd: dir, context, ...extra,
  } as never);
  return agent;
}

function milestoneEntries(dir: string, taskId: string): JournalStepEntry[] {
  const ws = new Workspace(dir, '.mochi');
  return readJournalEntries(ws.dir, taskId)
    .filter((e): e is JournalStepEntry => e.kind === 'step' && e.toolName === 'milestone');
}

function readState(dir: string, taskId: string) {
  return JSON.parse(readFileSync(resolve(dir, '.mochi', milestoneStateRelPath(taskId)), 'utf8'));
}

describe('long-task milestone strategy (loop fixture)', () => {
  let dir: string;
  beforeEach(() => { dir = makeRepo(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('(i) clean run: completes milestone-by-milestone with harness-run checks', async () => {
    const fake = await startFakeOpenAI([{ sticky: true, respondFn: makeWorker(dir, { shellCloseMilestone2: true }) }]);
    try {
      const task = makeTask();
      const { bus, logs } = wireBus();
      const agent = makeAgent(dir, fake.url, bus, { milestonePlan: stagePlan() });
      const result = await agent.run(task);
      expect(result.success).toBe(true);
      expect(result.stopReason).toBe('completed');
      const checks = readChecks(dir);
      // Claim-closed milestones: their check ran exactly once (harness-side).
      expect(checks.filter((l) => l === 'stage1:stage-1')).toHaveLength(1);
      expect(checks.filter((l) => l === 'stage3:stage-3')).toHaveLength(1);
      expect(checks.filter((l) => l === 'stage4:stage-4')).toHaveLength(1);
      expect(checks.filter((l) => l === 'stage5:stage-5')).toHaveLength(1);
      // Stage 2 was closed via the shell-check path: the model's own run
      // of the check command + the harness's verification re-run.
      expect(checks.filter((l) => l === 'stage2:stage-2')).toHaveLength(2);
      // Checks executed in milestone order.
      expect(checks.map((l) => l.split(':')[0])).toEqual(['stage1', 'stage2', 'stage2', 'stage3', 'stage4', 'stage5']);
      // Journal evidence: one plan event + one passed event per milestone.
      const entries = milestoneEntries(dir, task.id);
      expect(entries.filter((e) => e.args?.event === 'passed')).toHaveLength(5);
      expect(entries.filter((e) => e.args?.event === 'plan')).toHaveLength(1);
      expect(logs.filter((l) => l.includes('[longtask] milestone PASSED'))).toHaveLength(5);
      // Persisted plan: fully passed.
      const state = readState(dir, task.id);
      expect(state.milestones.every((m: { status: string }) => m.status === 'passed')).toBe(true);
      // eslint-disable-next-line no-console
      console.log(`[longtask-bench] strategy-arm requests=${fake.requests.length} tokensUsed=${result.tokensUsed}`);
    } finally {
      await fake.close();
    }
  }, 120_000);

  it('(iv) baseline: same fixture without the strategy layer (for comparison)', async () => {
    const fake = await startFakeOpenAI([{ sticky: true, respondFn: makeWorker(dir) }]);
    try {
      const task = makeTask();
      const { bus } = wireBus();
      const agent = makeAgent(dir, fake.url, bus); // no milestonePlan / planner
      const result = await agent.run(task);
      expect(result.success).toBe(true);
      expect(readChecks(dir)).toHaveLength(0); // no milestone checks exist to run
      expect(existsSync(resolve(dir, '.mochi', milestoneStateRelPath(task.id)))).toBe(false);
      // eslint-disable-next-line no-console
      console.log(`[longtask-bench] baseline-arm requests=${fake.requests.length} tokensUsed=${result.tokensUsed}`);
    } finally {
      await fake.close();
    }
  }, 120_000);

  it('(ii) kill mid-milestone-3 → resume restarts at the milestone-3 boundary', async () => {
    const task = makeTask('lt-kill-task');
    const ac = new AbortController();
    const fake1 = await startFakeOpenAI([{ sticky: true, respondFn: makeWorker(dir, { stallAt3: true }) }]);
    const poll = setInterval(() => {
      if (fileContent(dir, 'stage-3.txt') === 'wip') ac.abort();
    }, 25);
    try {
      const { bus } = wireBus();
      const agent = makeAgent(dir, fake1.url, bus, { milestonePlan: stagePlan(), abortSignal: ac.signal });
      const run1 = await agent.run(task);
      expect(run1.success).toBe(false);
      const checksAfterKill = readChecks(dir);
      expect(checksAfterKill.filter((l) => l === 'stage1:stage-1')).toHaveLength(1);
      expect(checksAfterKill.filter((l) => l === 'stage2:stage-2')).toHaveLength(1);
      // Milestone 3 never passed in run 1 (its file held 'wip').
      const stateAfterKill = readState(dir, task.id);
      expect(stateAfterKill.milestones.map((m: { status: string }) => m.status))
        .toEqual(['passed', 'passed', 'active', 'pending', 'pending']);
    } finally {
      clearInterval(poll);
      await fake1.close();
    }

    // Resume: a brand-new agent over the same workspace + task.
    const fake2 = await startFakeOpenAI([{ sticky: true, respondFn: makeWorker(dir) }]);
    try {
      const { bus, logs } = wireBus();
      const agent2 = makeAgent(dir, fake2.url, bus);
      const run2 = await agent2.run(task);
      expect(run2.success).toBe(true);
      // The resume brief names the milestone-3 boundary explicitly.
      const firstBodies = fake2.requests.slice(0, 3).map((r) => JSON.stringify(r.body)).join('\n');
      expect(firstBodies).toContain('RESUMED AT MILESTONE 3/5');
      expect(logs.some((l) => l.includes('[longtask] resuming milestone plan at 3/5'))).toBe(true);
      // Milestones 1–2 were NOT re-executed: still exactly one check each.
      const checks = readChecks(dir);
      expect(checks.filter((l) => l === 'stage1:stage-1')).toHaveLength(1);
      expect(checks.filter((l) => l === 'stage2:stage-2')).toHaveLength(1);
      expect(checks.filter((l) => l === 'stage3:stage-3')).toHaveLength(1);
      expect(checks.filter((l) => l === 'stage5:stage-5')).toHaveLength(1);
      // Journal: exactly one 'passed' event per milestone across both runs.
      const passed = milestoneEntries(dir, task.id).filter((e) => e.args?.event === 'passed');
      expect(passed.map((e) => e.args?.milestone).sort())
        .toEqual(['stage1', 'stage2', 'stage3', 'stage4', 'stage5']);
    } finally {
      await fake2.close();
    }
  }, 180_000);

  it('(iii) impossible check (wrong assumption) → evidence-gated re-plan → completes', async () => {
    let plannerCalls = 0;
    const planner = async (req: { replan: boolean }) => {
      plannerCalls++;
      if (!req.replan) {
        return [
          { id: 'stage1', title: 'Stage 1 file', detail: 'Write stage-1.txt containing exactly: stage-1', check: { kind: 'command' as const, command: 'node check.js stage1 stage-1.txt stage-1' } },
          // The wrong assumption, baked into the CHECK: the detail (and
          // the task) say the file must contain "stage-2", but the check
          // asserts "stage-two". No amount of correct work can pass it.
          { id: 'stage2', title: 'Stage 2 file', detail: 'Write stage-2.txt containing exactly: stage-2', check: { kind: 'command' as const, command: 'node check.js stage2 stage-2.txt stage-two' } },
          { id: 'stage3', title: 'Stage 3 file', detail: 'Write stage-3.txt containing exactly: stage-3', check: { kind: 'command' as const, command: 'node check.js stage3 stage-3.txt stage-3' } },
          { id: 'stage4', title: 'Stage 4 file', detail: 'Write stage-4.txt containing exactly: stage-4', check: { kind: 'command' as const, command: 'node check.js stage4 stage-4.txt stage-4' } },
          { id: 'stage5', title: 'Stage 5 file', detail: 'Write stage-5.txt containing exactly: stage-5', check: { kind: 'command' as const, command: 'node check.js stage5 stage-5.txt stage-5' } },
        ];
      }
      // Re-plan from evidence: the corrected check, then the rest.
      return [
        { id: 'stage2', title: 'Stage 2 file', detail: 'Write stage-2.txt containing exactly: stage-2', check: { kind: 'command' as const, command: 'node check.js stage2 stage-2.txt stage-2' } },
        { id: 'stage3', title: 'Stage 3 file', detail: 'Write stage-3.txt containing exactly: stage-3', check: { kind: 'command' as const, command: 'node check.js stage3 stage-3.txt stage-3' } },
        { id: 'stage4', title: 'Stage 4 file', detail: 'Write stage-4.txt containing exactly: stage-4', check: { kind: 'command' as const, command: 'node check.js stage4 stage-4.txt stage-4' } },
        { id: 'stage5', title: 'Stage 5 file', detail: 'Write stage-5.txt containing exactly: stage-5', check: { kind: 'command' as const, command: 'node check.js stage5 stage-5.txt stage-5' } },
      ];
    };
    const fake = await startFakeOpenAI([{ sticky: true, respondFn: makeWorker(dir) }]);
    try {
      const task = makeTask();
      const { bus, logs } = wireBus();
      const agent = makeAgent(dir, fake.url, bus, { milestonePlanner: planner });
      const result = await agent.run(task);
      expect(result.success).toBe(true);
      expect(plannerCalls).toBe(2); // initial decomposition + exactly one re-plan
      const checks = readChecks(dir);
      // The impossible check failed twice (two claim attempts), which
      // produced the evidence; the corrected check then passed once.
      expect(checks.filter((l) => l === 'stage2:stage-two')).toHaveLength(2);
      expect(checks.filter((l) => l === 'stage2:stage-2')).toHaveLength(1);
      const state = readState(dir, task.id);
      expect(state.replans).toHaveLength(1);
      expect(state.replans[0].trigger).toContain('milestone check failed');
      expect(state.milestones.every((m: { status: string }) => m.status === 'passed')).toBe(true);
      expect(logs.some((l) => l.includes('[longtask] plan REVISED'))).toBe(true);
    } finally {
      await fake.close();
    }
  }, 120_000);
});
