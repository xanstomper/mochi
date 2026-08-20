// Termix: parallel multi-session agent workbench.
import { describe, it, expect } from 'vitest';
import { termix, type TermixMode } from './termix.js';
import { startFakeOpenAI } from './testutil/fake-openai.js';

function makeConfig(url: string) {
  return {
    model: { provider: 'openai', baseUrl: url, model: 'fake-model' },
    safety: {
      mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 5,
      maxRuntimeMinutes: 2, maxConcurrentAgents: 1, contextBudgetTokens: 4000,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
    telemetry: false, quiet: true, verbose: false, debug: false,
  } as any;
}

describe('termix', () => {
  it('runs N isolated sessions and aggregates cost/tokens', async () => {
    const fake = await startFakeOpenAI([
      { content: 'some output', finishReason: 'stop', completionTokens: 4 },
      { content: 'some output', finishReason: 'stop', completionTokens: 4 },
    ]);
    const run = await termix({ mode: 'separate' as TermixMode, sessions: 2, task: 'fix the build', config: makeConfig(fake.url) });
    expect(run.results.length).toBe(2);
    expect(run.sessions).toBe(2);
    expect(run.results.every((r) => !r.error)).toBe(true);
    expect(run.results.every((r) => r.role.length > 0)).toBe(true);
    // Distinct personas
    expect(run.results[0].role).not.toBe(run.results[1].role);
    await fake.close();
  }, 60_000);

  it('communicate mode shares peer notes via the <broadcast> mechanism', async () => {
    const fake = await startFakeOpenAI([
      // Session 0 emits a broadcast note on turn 1.
      { content: '<broadcast>deploy pipeline uses pm2</broadcast>', finishReason: 'stop', completionTokens: 4 },
      // Session 1's first reply would see that broadcast (default replay).
      { content: 'acknowledged peer note', finishReason: 'stop', completionTokens: 4 },
      { content: 'final', finishReason: 'stop', completionTokens: 4 },
    ]);
    const run = await termix({ mode: 'communicate', sessions: 2, task: 'document the deploy', config: makeConfig(fake.url) });
    // Communication mode pushes non-error outputs to the shared broadcast at
    // the end; sessions should not have errored.
    expect(run.results.every((r) => !r.error)).toBe(true);
    expect(run.mode).toBe('communicate');
    await fake.close();
  }, 60_000);

  it('caps session count at 10', async () => {
    const fake = await startFakeOpenAI([{ content: 'x', finishReason: 'stop', completionTokens: 2 }]);
    const run = await termix({ mode: 'separate', sessions: 99, task: 't', config: makeConfig(fake.url) });
    expect(run.sessions).toBe(10);
    await fake.close();
  }, 60_000);

  it('requires a config', async () => {
    await expect(termix({ mode: 'separate', sessions: 1, task: 't' } as any)).rejects.toThrow(/config/);
  });
});