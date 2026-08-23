import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Runtime } from './runtime.js';
import { startFakeOpenAI, type FakeOpenAI } from './testutil/fake-openai.js';
import type { MochiConfig } from './types.js';

function makeRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-runtime-'));
  execSync('git init -q && git config user.email d@d && git config user.name d && git commit -q --allow-empty -m init', { cwd: dir, shell: '/bin/sh' });
  process.env.MOCHI_CONFIG_PATH = resolve(dir, 'config.json');
  return dir;
}

function baseConfig(): MochiConfig {
  return {
    model: { provider: 'openai', baseUrl: 'http://x', model: 'fake' },
    safety: {
      mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 5,
      maxConcurrentAgents: 1, contextBudgetTokens: 4000,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false, projectDir: '.mochi', configDir: '/tmp', quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

async function fakeServer(): Promise<FakeOpenAI> {
  return startFakeOpenAI([
    { content: '[HIGH] src/auth.ts:9 SQL injection\n[MEDIUM] src/util.ts:12 no rate limit', finishReason: 'stop', completionTokens: 20 },
  ]);
}

describe('Runtime setMode', () => {
  it('sets config.mode and returns the instruction for non-normal modes', () => {
    const rt = Runtime.create({ cwd: makeRepo() });
    const out = rt.setMode('spec');
    expect(out).toContain('SPEC MODE');
    expect(rt.config.mode).toBe('spec');
    rmSync(rt.cwd, { recursive: true, force: true });
  });

  it('rejects unknown modes with the allowed list', () => {
    const rt = Runtime.create({ cwd: makeRepo() });
    const out = rt.setMode('banana');
    expect(out).toMatch(/Unknown mode/);
    expect(out).toContain('spec');
    rmSync(rt.cwd, { recursive: true, force: true });
  });

  it('returns normal for normal mode and applies planMode from codemod', () => {
    const rt = Runtime.create({ cwd: makeRepo() });
    expect(rt.setMode('normal')).toBe('normal');
    rt.setMode('codemod');
    expect(rt.config.planMode).toBe(true);
    rmSync(rt.cwd, { recursive: true, force: true });
  });
});

describe('Runtime review/fix (pipe composability)', () => {
  it('runtime.review returns a reviewer summary over piped input', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-rt-review-'));
    execSync('git init -q && git config user.email d@d && git config user.name d && git commit -q --allow-empty -m init', { cwd: dir, shell: '/bin/sh' });
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const fake = await fakeServer();
    const rt = new Runtime({
      cwd: dir,
      config: {
        ...baseConfig(),
        model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' },
      } as any,
    });
    // Reviewer is read-only: fake returns a findings block.
    const summary = await rt.review('[HIGH] src/auth.ts:9 SQL injection\n[MEDIUM] src/util.ts:12 no rate limit\n');
    expect(summary).toBeTruthy();
    expect(summary).toContain('[HIGH]');
    // Fake server observed the input in the user message.
    const inputs = fake.requests.map((r: any) => JSON.stringify(r.body ?? '')).join('\n');
    expect(inputs).toContain('auth.ts');
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it('runtime.fix runs a fix task with piped context', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-rt-fix-'));
    execSync('git init -q && git config user.email d@d && git config user.name d && git commit -q --allow-empty -m init', { cwd: dir, shell: '/bin/sh' });
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }));
    const fake = await fakeServer();
    const rt = new Runtime({
      cwd: dir,
      config: {
        ...baseConfig(),
        model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' },
      } as any,
    });
    const summary = await rt.fix('TypeError: Cannot read properties of undefined (reading "map") at src/index.ts:12');
    expect(summary).toBeTruthy();
    const inputs = fake.requests.map((r: any) => JSON.stringify(r.body ?? '')).join('\n');
    expect(inputs).toContain('src/index.ts:12');
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Runtime abort + interrupt', () => {
  it('aborts before the goal starts and does not hang on an aborted signal', async () => {
    const rt = Runtime.create({ cwd: makeRepo() });
    rt.abort('test abort');
    // runGoal receives the aborted signal; a goal whose tasks never start
    // should terminate (abort is checked at the top of each agent loop).
    const result = await rt.goals.runGoal(
      { id: 'abort-test', objective: 'x', status: 'pending', progress: 0, createdAt: Date.now(), updatedAt: Date.now(), tasks: [] } as any,
      [],
      [],
      rt['abortSignal'],
    );
    // With no tasks scheduled, runGoal completes quickly and records nothing.
    expect(result.summary).toBeDefined();
    rmSync(rt.cwd, { recursive: true, force: true });
  });

  it('exposes abort and a signal that flips on abort()', () => {
    const rt = Runtime.create({ cwd: makeRepo() });
    const signal = rt['abortSignal'] as AbortSignal;
    expect(signal.aborted).toBe(false);
    rt.abort('stop');
    expect(signal.aborted).toBe(true);
    rmSync(rt.cwd, { recursive: true, force: true });
  });

  it('adjusts reasoning mode with setReasoning and getReasoning', () => {
    delete process.env.MOCHI_REASONING;
    const rt = Runtime.create({ cwd: makeRepo(), config: { reasoning: 'medium' } });
    expect(rt.getReasoning()).toBe('medium');
    const desc = rt.setReasoning('high');
    expect(rt.getReasoning()).toBe('high');
    expect(desc).toContain('Deep cognitive analysis');
    expect(process.env.MOCHI_REASONING).toBe('high');

    rt.setReasoning('max');
    expect(rt.getReasoning()).toBe('max');

    rt.setReasoning('low');
    expect(rt.getReasoning()).toBe('low');

    rt.newSession();
    expect(rt.activeSessionId).toBeUndefined();
    rmSync(rt.cwd, { recursive: true, force: true });
    delete process.env.MOCHI_REASONING;
  });

  it('defaults reasoning to max upon model initialization unless user changes it', () => {
    delete process.env.MOCHI_REASONING;
    const rt = Runtime.create({ cwd: makeRepo() });
    expect(rt.getReasoning()).toBe('max');
    rmSync(rt.cwd, { recursive: true, force: true });
  });
});