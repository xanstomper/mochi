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

  it('executes flash mode deterministically with zero tokens', async () => {
    const engine = new ChameleonEngine(config);
    const r = await engine.enhance({ task: 'quick', mode: 'flash' });
    expect(r.mode).toBe('flash');
    expect(r.tokensUsed).toBe(0);
    expect(r.context).toContain('LAZY CHAMELEON DENSE SYNTHETIC DATASET');
  });

  it('maps mode to a real strategy tier (flash vs deep)', async () => {
    const engine = new ChameleonEngine(config);
    const flash = await engine.enhance({ task: 'x', mode: 'flash' });
    expect(flash.mode).toBe('flash');
    expect(flash.strategies.length).toBe(3);
    expect(flash.tokensUsed).toBe(0);
  });
});