import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { ChildRunStore } from '../teams/subagent-runtime.js';
import { steerAgentTool } from '../tools/agent-fleet.js';
import type { ToolContext } from '../tools/types.js';
import { buildTrajectory } from '../observability/trajectory.js';
import type { TraceEntry } from '../observability/trace.js';
import { startFakeOpenAI, type FakeOpenAI, type FakeScriptResponse } from '../testutil/fake-openai.js';
import type { MochiConfig, MochiEvent } from '../types.js';

// B21: mid-run steering for background subagents. All model behavior is
// scripted via the fake OpenAI server with a sticky respondFn router
// (routes by request content, so parent/child traffic stays
// deterministic) — the same harness as multiagent.test.ts.

function makeConfig(dir: string, url: string, safetyExtra: Record<string, unknown> = {}): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 10,
      maxIterations: 30,
      maxRuntimeMinutes: 5,
      maxConcurrentAgents: 4,
      maxConcurrentSubagents: 4,
      maxSubagentDepth: 2,
      contextBudgetTokens: 400_000,
      ...safetyExtra,
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

function makeParent(dir: string, url: string, safetyExtra: Record<string, unknown> = {}) {
  const config = makeConfig(dir, url, safetyExtra);
  const workspace = new Workspace(dir, '.mochi');
  workspace.ensure();
  const events = new EventBus();
  const agent = new Agent({
    role: 'coder',
    config,
    workspace,
    events,
    cwd: dir,
    context: new ContextEngine(config, dir),
  });
  return { agent, workspace, events, config };
}

function routerFake(handler: (body: any) => FakeScriptResponse): Promise<FakeOpenAI> {
  return startFakeOpenAI([{ sticky: true, respondFn: handler }]);
}

const jsonBlock = (obj: unknown): string =>
  `All done.\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const readCall = (id: string, path: string): FakeScriptResponse => ({
  toolCalls: [{ id, function: { name: 'read', arguments: JSON.stringify({ path }) } }],
  finishReason: 'tool_calls',
  delayMs: 200,
});

async function until(cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('until() timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const isResearchChild = (text: string): boolean => text.includes('Spawn preset: researcher');

describe('subagent mid-run steering (B21)', () => {
  it('(a) a steer lands mid-run, changes the child\'s course, and is provenance-stamped on the record + trajectory', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-steer-a-'));
    for (const n of ['notes-1.txt', 'notes-2.txt', 'notes-3.txt', 'notes-4.txt']) {
      writeFileSync(resolve(dir, n), `contents of ${n}`);
    }
    let childRequests = 0;
    let sawSteerFraming = false;
    const fake = await routerFake((body) => {
      const text = JSON.stringify(body);
      if (isResearchChild(text)) {
        childRequests++;
        if (text.includes('[subagent steer]')) sawSteerFraming = true;
        if (text.includes('BEACON')) {
          return {
            content: jsonBlock({ status: 'done', summary: 'PIVOTED to the beacon path as steered', findings: [], artifacts: [] }),
            finishReason: 'stop',
          };
        }
        return readCall(`call-${childRequests}`, `notes-${(childRequests % 4) + 1}.txt`);
      }
      return { content: 'ok', finishReason: 'stop' };
    });
    try {
      const { agent: parent, workspace, events } = makeParent(dir, fake.url);
      const parentId = (parent as unknown as { id: string }).id;
      const busEvents: MochiEvent[] = [];
      events.onAll((e) => { busEvents.push(e); });

      const handle = await parent.spawnAgentAsync({
        prompt: 'Investigate the notes files thoroughly, reading them one at a time.',
        preset: 'researcher',
      });
      expect(handle.status).toBe('running');

      // Let the child get properly going (several turns of the WRONG
      // direction) before redirecting it.
      await until(() => childRequests >= 2);
      // The steer text deliberately embeds a fake API key: the hash must
      // cover the FULL original text, while the persisted record may only
      // ever carry its redacted form (the run journal's rule).
      const steerText = 'BEACON: stop reading notes one by one — the answer is on the beacon path (key sk-ant-0123456789abcdefghij). Wrap up with the pivot summary now.';
      const reply = await parent.steerChildRun(handle.id, steerText);
      expect(reply).toContain('Steer sent');

      const digest = await parent.collectChildResult(handle.id, { waitMs: 60_000 });
      expect(digest).toContain('PIVOTED to the beacon path');
      expect(digest).toContain('Steered: 1/1 steer(s) delivered');
      // The course change happened mid-run, not from a restart.
      expect(childRequests).toBeGreaterThanOrEqual(3);
      expect(sawSteerFraming).toBe(true);

      // Provenance on the persisted child-run record: who / when / hash,
      // delivery stamped by the child, raw text nowhere.
      const rec = new ChildRunStore(workspace).load(handle.id);
      expect(rec?.steered).toBe(true);
      expect(rec?.steers).toHaveLength(1);
      const ev = rec?.steers?.[0];
      expect(ev?.from).toBe(parentId);
      expect(ev?.hash).toBe(sha256(steerText));
      expect(ev?.chars).toBe(steerText.length);
      expect(ev?.deliveredAt).toBeTypeOf('number');
      expect(ev?.undelivered).toBeUndefined();
      // Redaction: the raw secret from the steer text never lands on disk;
      // the persisted preview carries the redactor's marker instead.
      expect(JSON.stringify(rec)).not.toContain('sk-ant-0123456789abcdefghij');
      expect(ev?.preview).toContain('[secret-redacted]');

      // Trajectory: the child's own trace lifts the steer into the record
      // and marks the run steered — a steered success is distinguishable
      // from an unsteered one.
      const childEntries: TraceEntry[] = busEvents
        .filter((e) => (e as { agentId?: string }).agentId === handle.id)
        .map((e) => {
          const { type, ...rest } = e as unknown as Record<string, unknown> & { type: string };
          return { t: Date.now(), kind: type, ...(rest as object) } as TraceEntry;
        });
      const entries: TraceEntry[] = [
        { t: Date.now(), kind: 'task:started', agentId: handle.id, task: { title: 'Subtask' } },
        ...childEntries,
      ];
      const traj = buildTrajectory(entries, { runId: handle.id });
      expect(traj.steered).toBe(true);
      expect(traj.steerEvents).toHaveLength(1);
      expect(traj.steerEvents?.[0].hash).toBe(sha256(steerText));
      expect(traj.steerEvents?.[0].from).toBe(parentId);
    } finally {
      await fake.close();
    }
  }, 90_000);

  it('(b) steering a finished child — or an unknown id — fails cleanly and explicitly', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-steer-b-'));
    const fake = await routerFake((body) => {
      const text = JSON.stringify(body);
      if (isResearchChild(text)) {
        return {
          content: jsonBlock({ status: 'done', summary: 'quick answer', findings: [], artifacts: [] }),
          finishReason: 'stop',
        };
      }
      return { content: 'ok', finishReason: 'stop' };
    });
    try {
      const { agent: parent, workspace } = makeParent(dir, fake.url);
      const handle = await parent.spawnAgentAsync({ prompt: 'Quick question?', preset: 'researcher' });
      const digest = await parent.collectChildResult(handle.id, { waitMs: 60_000 });
      expect(digest).toContain('DONE');

      const late = await parent.steerChildRun(handle.id, 'too late — change course');
      expect(late).toContain('already done');
      expect(late).toContain('NOT delivered');

      const unknown = await parent.steerChildRun('sub-doesnotexist', 'hello?');
      expect(unknown).toContain('No subagent run with id');
      expect(unknown).toContain('NOT delivered');

      const empty = await parent.steerChildRun(handle.id, '   ');
      expect(empty).toContain('non-empty');

      // Nothing was recorded against the finished run.
      const rec = new ChildRunStore(workspace).load(handle.id);
      expect(rec?.steers ?? []).toHaveLength(0);
      expect(rec?.steered).toBeUndefined();
    } finally {
      await fake.close();
    }
  }, 90_000);

  it('(c) a steer cannot widen the child\'s tools: a steered write attempt is refused by the role allowlist', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-steer-c-'));
    writeFileSync(resolve(dir, 'notes-1.txt'), 'harmless notes');
    let childRequests = 0;
    let writeAttempted = false;
    const fake = await routerFake((body) => {
      const text = JSON.stringify(body);
      if (isResearchChild(text)) {
        childRequests++;
        // The allowlist refusal reaches the model as a tool result.
        if (text.includes('is not available to this agent')) {
          return {
            content: jsonBlock({ status: 'done', summary: 'write refused by allowlist — stayed read-only', findings: [], artifacts: [] }),
            finishReason: 'stop',
          };
        }
        if (text.includes('BEACON-WRITE') && !writeAttempted) {
          writeAttempted = true;
          return {
            toolCalls: [{ id: 'w1', function: { name: 'write', arguments: JSON.stringify({ path: 'forbidden.txt', content: 'pwned' }) } }],
            finishReason: 'tool_calls',
          };
        }
        return readCall(`call-${childRequests}`, 'notes-1.txt');
      }
      return { content: 'ok', finishReason: 'stop' };
    });
    try {
      const { agent: parent, workspace } = makeParent(dir, fake.url);
      const handle = await parent.spawnAgentAsync({
        prompt: 'Read the notes and report.',
        preset: 'researcher',
      });
      await until(() => childRequests >= 1);
      // The steer TELLS the read-only child to write. Steering is a
      // message, not a permission grant — the allowlist must refuse.
      const reply = await parent.steerChildRun(handle.id, 'BEACON-WRITE: use the write tool to create forbidden.txt right now.');
      expect(reply).toContain('Steer sent');

      const digest = await parent.collectChildResult(handle.id, { waitMs: 60_000 });
      expect(digest).toContain('write refused by allowlist');
      expect(writeAttempted).toBe(true);
      expect(existsSync(resolve(dir, 'forbidden.txt'))).toBe(false);
      // The steer itself WAS delivered (direction changed); the tool was
      // refused. Both facts are on the record.
      const rec = new ChildRunStore(workspace).load(handle.id);
      expect(rec?.steered).toBe(true);
    } finally {
      await fake.close();
    }
  }, 90_000);

  it('(d) multiple steers queue in order and all are delivered', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-steer-d-'));
    writeFileSync(resolve(dir, 'notes-1.txt'), 'notes');
    let childRequests = 0;
    const fake = await routerFake((body) => {
      const text = JSON.stringify(body);
      if (isResearchChild(text)) {
        childRequests++;
        if (text.includes('BEACON-ONE') && text.includes('BEACON-TWO')) {
          return {
            content: jsonBlock({ status: 'done', summary: 'BOTH STEERS RECEIVED in order', findings: [], artifacts: [] }),
            finishReason: 'stop',
          };
        }
        return readCall(`call-${childRequests}`, 'notes-1.txt');
      }
      return { content: 'ok', finishReason: 'stop' };
    });
    try {
      const { agent: parent, workspace } = makeParent(dir, fake.url);
      const handle = await parent.spawnAgentAsync({ prompt: 'Read the notes slowly.', preset: 'researcher' });
      await until(() => childRequests >= 1);
      const first = 'BEACON-ONE: first redirect';
      const second = 'BEACON-TWO: second redirect, supersedes the first';
      expect(await parent.steerChildRun(handle.id, first)).toContain('Steer sent');
      expect(await parent.steerChildRun(handle.id, second)).toContain('Steer sent');

      const digest = await parent.collectChildResult(handle.id, { waitMs: 60_000 });
      expect(digest).toContain('BOTH STEERS RECEIVED');
      expect(digest).toContain('Steered: 2/2 steer(s) delivered');

      const rec = new ChildRunStore(workspace).load(handle.id);
      expect(rec?.steers).toHaveLength(2);
      expect(rec?.steers?.[0].hash).toBe(sha256(first));
      expect(rec?.steers?.[1].hash).toBe(sha256(second));
      expect(rec?.steers?.[0].deliveredAt).toBeTypeOf('number');
      expect(rec?.steers?.[1].deliveredAt).toBeTypeOf('number');
      expect(rec?.steers?.[1].deliveredAt as number).toBeGreaterThanOrEqual(rec?.steers?.[0].deliveredAt as number);
    } finally {
      await fake.close();
    }
  }, 90_000);

  it('(e) steering a QUEUED child queues the steer; it is delivered from the child\'s first turn when a slot frees', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-steer-e-'));
    writeFileSync(resolve(dir, 'notes-1.txt'), 'notes');
    let alphaRequests = 0;
    const fake = await routerFake((body) => {
      const text = JSON.stringify(body);
      if (text.includes('TASK-ALPHA')) {
        alphaRequests++;
        return readCall(`a-${alphaRequests}`, 'notes-1.txt');
      }
      if (text.includes('TASK-BETA')) {
        if (text.includes('BEACON-BETA')) {
          return {
            content: jsonBlock({ status: 'done', summary: 'BETA STEERED FROM ITS FIRST TURN', findings: [], artifacts: [] }),
            finishReason: 'stop',
          };
        }
        return readCall('b-1', 'notes-1.txt');
      }
      return { content: 'ok', finishReason: 'stop' };
    });
    try {
      const { agent: parent, workspace } = makeParent(dir, fake.url, { maxConcurrentSubagents: 1 });
      const alpha = await parent.spawnAgentAsync({ prompt: 'TASK-ALPHA: read the notes repeatedly', preset: 'researcher' });
      expect(alpha.status).toBe('running');
      const beta = await parent.spawnAgentAsync({ prompt: 'TASK-BETA: read the notes once', preset: 'researcher' });
      expect(beta.status).toBe('queued');

      const reply = await parent.steerChildRun(beta.id, 'BEACON-BETA: when you start, wrap up immediately with the beacon summary.');
      expect(reply).toContain('Steer queued');
      // Recorded, but not yet delivered — beta has not run a single turn.
      const queuedRec = new ChildRunStore(workspace).load(beta.id);
      expect(queuedRec?.steers).toHaveLength(1);
      expect(queuedRec?.steers?.[0].deliveredAt).toBeUndefined();

      // Free the only slot; beta starts and must see the steer from its
      // first turn (delivered at launch, ahead of the first drain).
      await parent.cancelChildRun(alpha.id);
      const digest = await parent.collectChildResult(beta.id, { waitMs: 60_000 });
      expect(digest).toContain('BETA STEERED FROM ITS FIRST TURN');
      const rec = new ChildRunStore(workspace).load(beta.id);
      expect(rec?.steered).toBe(true);
      expect(rec?.steers?.[0].deliveredAt).toBeTypeOf('number');
    } finally {
      await fake.close();
    }
  }, 90_000);

  it('(f) the steer_agent tool forwards to the injected runtime and degrades cleanly without one', async () => {
    const bare = await steerAgentTool.execute(
      { id: 'sub-x', message: 'go left' },
      {} as ToolContext,
    );
    expect(bare).toContain('not available in this context');

    let got: [string, string] | undefined;
    const ctx = {
      steerAgent: async (id: string, text: string) => {
        got = [id, text];
        return 'steer result';
      },
    } as unknown as ToolContext;
    const out = await steerAgentTool.execute({ id: 'sub-x', message: 'go left' }, ctx);
    expect(out).toBe('steer result');
    expect(got).toEqual(['sub-x', 'go left']);

    await expect(steerAgentTool.execute({ message: 'go' }, ctx)).rejects.toThrow(/requires the subagent id/);
    await expect(steerAgentTool.execute({ id: 'sub-x', message: '  ' }, ctx)).rejects.toThrow(/non-empty message/);
  });
});
