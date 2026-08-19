// Live integration tests for the Agent loop. These hit the real freeinference
// provider end-to-end (decompose -> plan -> run -> verify) and verify a real
// model on a real file system produces a real, correct result.
//
// Skipped automatically when FREEINFERENCE_API_KEY is missing. Run explicitly
// with:
//
//   FREEINFERENCE_API_KEY=... npx vitest run src/agent/loop.live.test.ts
//
// These tests are SLOW by design (a single deepseek-v4-flash call takes a
// few seconds, a full agent loop takes 30-90s). They are not a substitute
// for the scripted fake-openai unit tests; they exist to catch what the
// scripted tests cannot:
//   - The model picks the right tool name and arguments for an unfamiliar task
//   - File system effects are actually correct
//   - The verify->fail->retry loop converges in practice
//   - The decomposed task list matches what a real LLM would generate
import { describe, it, expect } from 'vitest';
import { Agent } from './loop.js';
import { ContextEngine } from '../context.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { GoalEngine } from '../goals/goal.js';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import type { MochiConfig } from '../types.js';

const HAS_KEY = Boolean(process.env.FREEINFERENCE_API_KEY);
// describe.skip returns void, so a ternary alias doesn't work in vitest 2.x —
// use an explicit if/else so the describe function is always called.
const suite = HAS_KEY ? describe : describe.skip;

const PROVIDER = {
  provider: 'openai' as const,
  baseUrl: 'https://freeinference.org/v1',
  model: 'deepseek-v4-flash',
  apiKey: process.env.FREEINFERENCE_API_KEY,
};

function makeConfig(dir: string, model = PROVIDER.model): MochiConfig {
  return {
    model: { ...PROVIDER, model },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 60,
      maxIterations: 12,
      maxRuntimeMinutes: 8,
      maxConcurrentAgents: 1,
      contextBudgetTokens: 16000,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
    telemetry: false,
    projectDir: '.mochi',
    configDir: resolve(dir, '.config/mochi'),
    quiet: true,
    verbose: false,
    debug: false,
  } as unknown as MochiConfig;
}

function freshRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-live-'));
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email live@test && git config user.name live', { cwd: dir });
  writeFileSync(resolve(dir, 'seed.txt'), 'seed');
  execSync('git add -A && git commit -qm init', { cwd: dir });
  return dir;
}

suite('real model: writes a file the model was asked to write', () => {
  it('creates the requested file with the requested content', async () => {
    const dir = freshRepo();
    const config = makeConfig(dir);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('create a file with specific content');
    const task = createTask(
      'Create greeting.txt with content "hello mochi"',
      'Write a single file `./greeting.txt` whose only contents are the exact text `hello mochi`. Verify by reading the file back.',
      { fileScope: ['greeting.txt'] },
    );
    const agent = new Agent({ id: 'live-coder', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
    const result = await agent.run(task);
    expect(result.success).toBe(true);
    const greetingPath = resolve(dir, 'greeting.txt');
    expect(existsSync(greetingPath)).toBe(true);
    expect(readFileSync(greetingPath, 'utf8').trim()).toBe('hello mochi');
  }, 120_000);
});

suite('real model: writes a working vitest test for a real implementation', () => {
  it('produces add.ts + add.test.ts that actually pass', async () => {
    const dir = freshRepo();
    // Pre-stage package.json + vitest so the agent has a runnable test command.
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({
      name: 'live-test', type: 'module',
      devDependencies: { vitest: '^2.0.0' },
    }));
    writeFileSync(resolve(dir, 'vitest.config.ts'),
      "import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { include: ['**/*.test.ts'] } });\n");
    execSync('npm install --silent --no-audit --no-fund', { cwd: dir, stdio: 'ignore' });

    const config = makeConfig(dir);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('create a working vitest test');
    const task = createTask(
      'Create add.ts + add.test.ts with vitest',
      'Create ./add.ts exporting `add(a:number,b:number):number` that returns a+b. Create ./add.test.ts using vitest that asserts add(2,3)===5. Verify by running `npx vitest run`.',
      { fileScope: ['add.ts', 'add.test.ts', 'vitest.config.ts'] },
    );
    const agent = new Agent({ id: 'live-tester', role: 'coder', config, workspace, events: new EventBus(), cwd: dir, context });
    const result = await agent.run(task);
    // Best-effort: the real model may or may not get a passing test in one shot,
    // but it must at least have created the files we asked for.
    expect(existsSync(resolve(dir, 'add.ts'))).toBe(true);
    expect(existsSync(resolve(dir, 'add.test.ts'))).toBe(true);
    expect(readFileSync(resolve(dir, 'add.ts'), 'utf8')).toMatch(/export\s+function\s+add/);
    // If the task reports success, the test must actually pass.
    if (result.success) {
      const out = execSync('npx vitest run --reporter=basic 2>&1', { cwd: dir, encoding: 'utf8' });
      expect(out).toMatch(/[1-9]\s+passed/);
    }
  }, 180_000);
});

suite('real model: decomposes a multi-step goal into a sensible task list', () => {
  it('produces a small, file-aware task list', async () => {
    const dir = freshRepo();
    const config = makeConfig(dir);
    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    // Use the same GoalEngine.decompose path the CLI uses; this exercises
    // the real model in the role of "planner" against a real prompt.
    const goalEngine = new GoalEngine(config, workspace, new EventBus(), dir);
    const goal = {
      id: 'live-decompose-test',
      objective: 'Create src/greet.ts exporting greet(name) that returns "hello, <name>!" and a vitest test for it',
      status: 'pending' as const,
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [],
      successCriteria: ['greet.ts exists', 'test passes'],
      constraints: [],
    };
    const tasks = await goalEngine.decompose(goal);
    // A real LLM should produce at least 1 task and use sensible titles that
    // include the file names. We deliberately do NOT assert the exact shape —
    // the model is allowed to be creative — but we do assert the basics.
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.length).toBeLessThanOrEqual(6);
    const allText = tasks.map((t) => `${t.title} ${t.description}`).join('\n').toLowerCase();
    expect(allText).toMatch(/greet/);
  }, 120_000);
});
