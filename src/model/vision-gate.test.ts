// Wave H3: modelSupportsVision is the gate that decides whether a computer
// screenshot is inlined into a tool result. It must be conservative: a false
// positive can hard-fail a text-only endpoint mid-run; a false negative just
// degrades to the pre-H3 path-only result.
import { describe, it, expect } from 'vitest';
import { modelSupportsVision } from './model-manager.js';

describe('modelSupportsVision', () => {
  it('accepts known vision families', () => {
    const vision: Array<[string, string]> = [
      ['claude-sonnet-4-5', 'anthropic'],
      ['anthropic/claude-opus-4-5', 'openrouter'],
      ['gpt-4o', 'openai'],
      ['gpt-4.1', 'openai'],
      ['gpt-5.2', 'openai'],
      ['o4-mini', 'openai'],
      ['o3', 'openai'],
      ['gemini-2.5-pro', 'gemini'],
      ['gemini-3-flash', 'antigravity'],
      ['qwen2.5-vl-32b', 'openrouter'],
      ['qwen3-vl-235b', 'openrouter'],
      ['llama-4-scout', 'groq'],
      ['llama-3.2-vision', 'ollama'],
      ['moonshot-v1-128k-vision-preview', 'moonshot'],
      ['some-future-model', 'anthropic'], // provider catalogs that are vision-only
      ['some-future-model', 'gemini'],
    ];
    for (const [model, provider] of vision) {
      expect(modelSupportsVision(model, provider), `${model} via ${provider}`).toBe(true);
    }
  });

  it('rejects text-only and unknown models (path-only degradation)', () => {
    const textOnly: Array<[string, string]> = [
      ['deepseek-chat', 'deepseek'],
      ['deepseek-v4-pro', 'freeinference'],
      ['glm-5.3', 'openrouter'],
      ['gpt-oss-120b', 'freeinference'],
      ['llama-3.3-70b-versatile', 'groq'],
      ['qwen2.5-coder-32b', 'openrouter'],
      ['qwen3-coder', 'openrouter'],
      ['o3-mini', 'openai'], // o3-mini is text-only despite the o-series name
      ['local-model', 'ollama'],
      ['fake-model', 'openai'],
      ['', ''],
    ];
    for (const [model, provider] of textOnly) {
      expect(modelSupportsVision(model, provider), `${model} via ${provider}`).toBe(false);
    }
  });
});
