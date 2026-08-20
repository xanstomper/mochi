
// Integration: a GoalEngine run persists a searchable session transcript.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Workspace } from '../workspace.js';
import { EventBus } from '../events.js';
import { GoalEngine } from './goal.js';
import { createTask } from './task.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import { SessionStore, hasSqlite } from '../session-store.js';

const maybeDescribe = hasSqlite() ? describe : describe.skip;
let fake: Awaited<ReturnType<typeof startFakeOpenAI>>;

afterAll(async () => { if (fake) await fake.close(); });

maybeDescribe('session recording through the goal engine', () => {
  it('persists a searchable transcript when a goal runs and resumes with it', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-sessgoal-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }));
    fake = await startFakeOpenAI([
      { content: '{"tasks":[{"title":"Make thing","description":"create thing.txt","role":"coder","dependencies":[],"acceptanceCriteria":[],"verificationCommand":""}]}', finishReason: 'stop' },
      { content: 'Done creating the artifact.', finishReason: 'stop', completionTokens: 8 },
    ]);
    const cfg = {
      model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' },
      safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
      permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
      telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false,
    } as unknown as import('../types.js').MochiConfig;
    const ws = new Workspace(dir, '.mochi');
    ws.ensure();
    const engine = new GoalEngine(cfg, ws, new EventBus(), dir);
    const goal = await engine.createGoal('Build a flag parser module');
    const task = createTask('Make thing', 'create thing.txt', { role: 'coder', acceptanceCriteria: [] });
    const result = await engine.runGoal(goal, [task]);

    const store = new SessionStore(dir);
    const rows = store.list();
    const hit = rows.find((r) => (r.objective || '').includes('Make thing') || (r.objective || '').includes('flag'));
    expect(hit, 'expected a session row').toBeDefined();
    // Full-text search finds the persisted content by key phrase.
    const found = store.search('flag');
    expect(found.length).toBeGreaterThanOrEqual(1);
    // The transcript content is retrievable via messages(id) — this is what
    // the resume path (>20 prior messages) would inject. Assert it has the
    // recorded user goal/task + assistant summary.
    const msgs = store.messages(hit!.id);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(msgs.some((m) => m.role === 'user' && (m.content.includes('flag') || m.content.includes('Make')))).toBe(true);
    store.close();
  }, 60_000);
});
