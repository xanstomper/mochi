// Provider model selection: selectModel + resolveProvider profile routing.
import { describe, it, expect } from 'vitest';
import { selectModel, resolveProvider } from './router.js';
import type { ModelConfig } from '../types.js';

describe('selectModel (profile routing)', () => {
  it('uses the profile-specific model when present', () => {
    const cfg: ModelConfig = {
      provider: 'freeinference',
      baseUrl: 'https://freeinference.org/v1',
      model: 'deepseek-v4-flash',
      profiles: { fast: 'deepseek-v4-flash', coding: 'kimi-k2.7-code', reasoning: 'glm-5.2', review: 'glm-5.1' },
    };
    expect(selectModel(cfg, 'coding')).toBe('kimi-k2.7-code');
    expect(selectModel(cfg, 'reasoning')).toBe('glm-5.2');
    expect(selectModel(cfg, 'fast')).toBe('deepseek-v4-flash');
    expect(selectModel(cfg, 'review')).toBe('glm-5.1');
  });

  it('falls back to the primary model when a profile is unset', () => {
    const cfg: ModelConfig = { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' };
    for (const p of ['fast', 'coding', 'reasoning', 'review'] as const) {
      expect(selectModel(cfg, p)).toBe('gpt-4o-mini');
    }
  });

  it('strips opencode prefixes for opencode endpoints in profile routing', () => {
    const cfg: ModelConfig = {
      provider: 'opencode-zen',
      baseUrl: 'https://opencode.ai/zen/v1',
      model: 'opencode/deepseek-v4-flash-free',
      profiles: { fast: 'opencode/deepseek-v4-flash-free', coding: 'opencode/deepseek-v4-flash', reasoning: 'opencode/opencode-zen-3.5', review: 'opencode/gpt-5.4-nano' },
    };
    expect(selectModel(cfg, 'reasoning')).toBe('opencode-zen-3.5');
    expect(selectModel(cfg, 'coding')).toBe('deepseek-v4-flash');
  });

  it('resolveProvider applies alias default model when model/config is empty', () => {
    const cfg = resolveProvider({ provider: 'openai', baseUrl: '', model: '' });
    expect(cfg.providerName).toBe('openai');
    // baseUrl defaults to the openai-compatible fallback; model to gpt-4o-mini
    expect(cfg.model).toBeTruthy();
  });
});