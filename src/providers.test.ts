import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PROVIDERS, providerById, providerByName } from './providers.js';
import { setProvider, login } from './model-manager.js';
import { createProvider } from './model/router.js';
import type { MochiConfig } from './types.js';

const base = {
  model: {
    provider: 'opencode-zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    model: 'opencode/deepseek-v4-flash-free',
  },
  safety: {
    mode: 'auto',
    commandTimeoutSeconds: 1,
    maxIterations: 1,
    maxRuntimeMinutes: 1,
    maxConcurrentAgents: 1,
    contextBudgetTokens: 100,
  },
  permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
  projectDir: '.mochi',
  configDir: '/tmp/mochi-test',
} as unknown as MochiConfig;

describe('providers', () => {
  let tmpPath: string;
  beforeEach(() => {
    tmpPath = resolve(mkdtempSync(resolve(tmpdir(), 'mochi-provd')), 'config.json');
    process.env.MOCHI_CONFIG_PATH = tmpPath;
  });
  afterEach(() => {
    delete process.env.MOCHI_CONFIG_PATH;
  });

  it('contains a majority of major providers', () => {
    expect(PROVIDERS.length).toBeGreaterThanOrEqual(18);
    for (const id of ['openai', 'anthropic', 'gemini', 'openrouter', 'deepseek', 'groq', 'mistral', 'xai', 'openrouter']) {
      expect(providerById(id)).toBeDefined();
    }
  });

  it('resolves by name', () => {
    expect(providerByName('OpenAI')?.id).toBe('openai');
    expect(providerById('ollama')?.kind).toBe('openai');
  });

  it('sets provider without clobbering unrelated config', () => {
    const cfg = setProvider(base, { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'k' });
    expect(cfg.model.provider).toBe('deepseek');
    expect(cfg.model.apiKey).toBe('k');
    expect(cfg.permissions.read).toBe(true);
  });

  it('routs anthropic and gemini providers to their adapters', () => {
    const anc = createProvider({ ...base.model, provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-3-5-sonnet' });
    expect(typeof anc.chat).toBe('function');
    const gem = createProvider({ ...base.model, provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash' });
    expect(typeof gem.chat).toBe('function');
  });

  it('login stores default model when none given', () => {
    const cfg = login({ ...base }, 'groq', 'gk');
    expect(cfg.model.provider).toBe('groq');
    expect(cfg.model.model).toBe('llama-3.3-70b-versatile');
  });
});