import { describe, it, expect } from 'vitest';
import { DualModelDispatcher } from './dual-dispatch.js';
import type { ModelConfig } from '../types.js';

describe('DualModelDispatcher', () => {
  const config: ModelConfig = {
    provider: 'opencode-zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    model: 'opencode/deepseek-v4-flash',
    profiles: {
      coding: 'opencode/deepseek-v4-flash',
      reasoning: 'opencode/deepseek-v4-flash',
      fast: 'opencode/deepseek-v4-flash-free',
      review: 'opencode/deepseek-v4-flash',
    },
  };

  it('instantiates both frontier and fast tier providers', () => {
    const dispatcher = new DualModelDispatcher(config);
    expect(dispatcher).toBeDefined();
    expect(typeof dispatcher.runFast).toBe('function');
    expect(typeof dispatcher.streamFrontier).toBe('function');
    expect(typeof dispatcher.chatFrontier).toBe('function');
  });
});
