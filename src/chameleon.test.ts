import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChameleonEngine } from './chameleon.js';
import { startFakeOpenAI, type FakeOpenAI } from './testutil/fake-openai.js';
import type { MochiConfig } from './types.js';

let fake: FakeOpenAI;
let config: MochiConfig;

beforeAll(async () => {
  fake = await startFakeOpenAI([
    // multi-pass: medium = 2 model passes -> 2 scripted responses
    { content: 'Pass one: decompose the reducer type mismatch.', finishReason: 'stop', completionTokens: 12 },
    { content: 'Pass two: corrected reasoning with explicit generic accumulator.', finishReason: 'stop', completionTokens: 16 },
  ]);
  config = {
    model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' },
    safety: {
      mode: 'auto',
      commandTimeoutSeconds: 10,
      maxIterations: 10,
      maxRuntimeMinutes: 10,
      maxConcurrentAgents: 2,
      contextBudgetTokens: 1000,
      maxModelCalls: 10,
    },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
    telemetry: false,
    projectDir: '.mochi',
    configDir: '/tmp',
    quiet: true,
    verbose: false,
    debug: false,
  } as unknown as MochiConfig;
});

afterAll(async () => { await fake.close(); });

describe('ChameleonEngine (internal, agent-own provider)', () => {
  it('generates real enhancement context through the actual provider path', async () => {
    const engine = new ChameleonEngine(config);
    const r = await engine.enhance({ task: 'Fix the mixed-array reduce type error', mode: 'medium' });
    // Uses the agent's own provider, so it must yield the real final pass.
    expect(r.context).toContain('corrected');
    expect(r.context).toContain('generic accumulator');
    expect(r.strategies.length).toBeGreaterThan(0);
    expect(r.strategies.length).toBeLessThanOrEqual(6);
    expect(r.tokensUsed).toBeGreaterThan(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('grades into more/less multi-pass compute by mode', async () => {
    const fake2 = await startFakeOpenAI([
      { content: 'flash pass', finishReason: 'stop', completionTokens: 4 },
    ]);
    const cfg2 = { ...config, model: { provider: 'openai', baseUrl: fake2.url, model: 'fake-model' } } as unknown as MochiConfig;
    const r = await new ChameleonEngine(cfg2).enhance({ task: 'quick', mode: 'flash' });
    expect(r.mode).toBe('flash');
    expect(r.context).toBe('flash pass');
    await fake2.close();
  });

  it('maps mode to a real strategy tier (flash < deep)', async () => {
    const engine = new ChameleonEngine(config);
    const flash = await engine.enhance({ task: 'x', mode: 'flash' });
    const deep = await engine.enhance({ task: 'x', mode: 'deep' });
    expect(flash.mode).toBe('flash');
    expect(deep.mode).toBe('deep');
    // flash runs 1 strategy, deep runs 5 — validates the real tier mapping.
    expect(flash.strategies.length).toBe(1);
    expect(deep.strategies.length).toBe(5);
  });
});