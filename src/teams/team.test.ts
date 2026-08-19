import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { GoalEngine } from '../goals/goal.js';
import { Workspace } from '../workspace.js';
import { EventBus } from '../events.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import { assignTeamRoles, runTeam } from './team.js';
import type { MochiConfig } from '../types.js';

function makeConfig(url: string, dir: string): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 3, maxRuntimeMinutes: 2, maxConcurrentAgents: 2, contextBudgetTokens: 4000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false, projectDir: '.mochi', configDir: resolve(dir, '.config/mochi'), quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

function makeRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-team-'));
  execSync('git init -q && git config user.email d@d && git config user.name d && git commit -q --allow-empty -m init', { cwd: dir, shell: '/bin/sh' });
  return dir;
}

describe('assignTeamRoles', () => {
  it('routes test/review/research tasks to specialists', () => {
    const tasks = [
      { id: 'a', title: 'Write tests for math', description: 'cover add', role: 'coder', dependencies: [], acceptanceCriteria: [], attempts: [], createdAt: 1, status: 'pending' } as any,
      { id: 'b', title: 'Review the diff', description: 'verify no regressions', role: 'coder', dependencies: [], acceptanceCriteria: [], attempts: [], createdAt: 2, status: 'pending' } as any,
      { id: 'c', title: 'Investigate the API', description: 'research options', role: 'coder', dependencies: [], acceptanceCriteria: [], attempts: [], createdAt: 3, status: 'pending' } as any,
      { id: 'd', title: 'Implement core', description: 'build the thing', role: 'coder', dependencies: [], acceptanceCriteria: [], attempts: [], createdAt: 4, status: 'pending' } as any,
    ];
    const out = assignTeamRoles({} as any, tasks);
    expect(out[0].role).toBe('tester');   // "Write tests"
    expect(out[1].role).toBe('reviewer'); // "Review"
    expect(out[2].role).toBe('researcher'); // "Investigate"
    // Last non-reviewer task is upgraded to reviewer for convergence.
    expect(out[3].role).toBe('reviewer');
  });
});

describe('runTeam', () => {
  it('executes a team goal end to end with role-diverse agents', async () => {
    const dir = makeRepo();
    const fake = await startFakeOpenAI([
      // decompose -> 3 tasks
      { content: '[{"title":"Design API","description":"propose schema","role":"architect","dependencies":[],"acceptanceCriteria":["ok"],"verificationCommand":""},{"title":"Write tests","description":"cover impl","role":"coder","dependencies":[],"acceptanceCriteria":["ok"],"verificationCommand":""},{"title":"Implement parse","description":"build parser","role":"coder","dependencies":[],"acceptanceCriteria":["done"],"verificationCommand":""}]', finishReason: 'stop' },
      // agent turns (fake replays the last one when exhausted)
      { content: 'done', finishReason: 'stop' },
    ]);
    const config = makeConfig(fake.url, dir);
    const ws = new Workspace(dir, '.mochi'); ws.ensure();
    const events = new EventBus();
    const engine = new GoalEngine(config, ws, events, dir);
    const goal = await engine.createGoal('build a parser');
    const { summary, status } = await runTeam(engine, goal, {});
    expect(typeof summary).toBe('string');
    expect(['completed', 'failed', 'active']).toContain(status);
    // Tasks got real specialist roles assigned.
    const tasks = ws.loadTasks(goal.id);
    expect(tasks.length).toBeGreaterThan(0);
    console.log('TASKS', JSON.stringify(tasks.map((t)=>({title:t.title,role:t.role}))));
    const roles = new Set(tasks.map((t) => t.role));
    expect(roles.has('reviewer') || roles.has('tester')).toBe(true);
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});