// model-router.ts: multi-tier model selection + rate-limit failover.
import { describe, it, expect } from 'vitest';
import { classifyTaskTier, resolveModel, withFailover } from './model-router.js';
import type { ModelConfig } from '../types.js';

const base = (): ModelConfig => ({
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  profiles: { fast: 'fast-model', coding: 'coding-model', reasoning: 'reasoning-model', review: 'review-model' },
});

describe('classifyTaskTier', () => {
  it('classifies background tasks as fast', () => {
    expect(classifyTaskTier('summarize the changes', 'coder')).toBe('fast');
    expect(classifyTaskTier('extract memory facts')).toBe('fast');
  });
  it('classifies complex tasks as reasoning', () => {
    expect(classifyTaskTier('design the auth architecture', 'architect')).toBe('reasoning');
    expect(classifyTaskTier('security audit')).toBe('reasoning');
  });
  it('defaults to standard', () => {
    expect(classifyTaskTier('add a rate limiter')).toBe('standard');
  });
});

describe('resolveModel', () => {
  it('maps tiers to model profiles', () => {
    const cfg = base();
    expect(resolveModel(cfg, 'fast')).toBe('fast-model');
    expect(resolveModel(cfg, 'standard')).toBe('coding-model');
    expect(resolveModel(cfg, 'reasoning')).toBe('reasoning-model');
  });
  it('falls back to the primary model without profiles', () => {
    const cfg: ModelConfig = { provider: 'openai', baseUrl: 'x', model: 'gpt-4o' };
    expect(resolveModel(cfg, 'reasoning')).toBe('gpt-4o');
  });
});

describe('withFailover', () => {
  it('returns the first successful call', async () => {
    const calls: Array<[string, string]> = [];
    const out = await withFailover(base(), 'standard', async (cfg, model) => {
      calls.push([cfg.provider, model]);
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(calls).toEqual([['openai', 'coding-model']]);
  });

  it('cascades to a failover provider after rate limits', async () => {
    let tries = 0;
    const cfg = { ...base(), failover: [{ provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b' }] } as ModelConfig;
    const out = await withFailover(cfg, 'reasoning', async (c) => {
      tries++;
      if (c.provider === 'openai') { const e: any = new Error('rate limited'); e.status = 429; throw e; }
      return `from-${c.provider}`;
    }, { maxRetries: 1, initialDelayMs: 1 });
    expect(out).toBe('from-groq');
    expect(tries).toBeGreaterThanOrEqual(2);
  });

  it('propagates non-rate-limit errors from the last provider', async () => {
    const cfg = { ...base(), failover: [{ provider: 'groq', baseUrl: 'x', model: 'm' }] } as ModelConfig;
    await expect(withFailover(cfg, 'standard', async () => { throw new Error('auth failed'); }, { maxRetries: 0 })).rejects.toThrow('auth failed');
  });
});