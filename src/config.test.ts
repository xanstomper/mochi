import { describe, it, expect } from 'vitest';
import { loadConfig, validateConfig } from './config.js';

describe('loadConfig', () => {
  it('loads defaults (isolated from user config)', () => {
    const cfg = loadConfig({}, '/nonexistent/nowhere.json');
    expect(cfg.model.provider).toBe('opencode-zen');
    expect(cfg.safety.mode).toBe('ask');
    expect(cfg.projectDir).toBe('.mochi');
  });

  it('applies overrides', () => {
    const cfg = loadConfig({ model: { provider: 'openai', model: 'gpt-4o' } });
    expect(cfg.model.provider).toBe('openai');
    expect(cfg.model.model).toBe('gpt-4o');
  });

  it('ignores a placeholder apiKey in a config file in favor of the real env key', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-cfg-'));
    const cfgPath = resolve(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ model: { provider: 'freeinference', model: 'deepseek-v4-flash', apiKey: 'hi' } }));
    const prior = process.env.FREEINFERENCE_API_KEY;
    process.env.FREEINFERENCE_API_KEY = 'sk-real-xxxxxxxx';
    try {
      const cfg = loadConfig({}, cfgPath);
      expect(cfg.model.apiKey).toBe('sk-real-xxxxxxxx'); // env wins over "hi"
      expect(cfg.model.apiKey).not.toBe('hi');
    } finally {
      if (prior === undefined) delete process.env.FREEINFERENCE_API_KEY;
      else process.env.FREEINFERENCE_API_KEY = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a real config apiKey when no env key is present', () => {
    const prior = process.env.FREEINFERENCE_API_KEY;
    delete process.env.FREEINFERENCE_API_KEY;
    try {
      const cfg = loadConfig({ model: { provider: 'freeinference', model: 'deepseek-v4-flash', apiKey: 'sk-real-1234567890abcdef' } });
      expect(cfg.model.apiKey).toBe('sk-real-1234567890abcdef');
    } finally {
      if (prior !== undefined) process.env.FREEINFERENCE_API_KEY = prior;
    }
  });
});

describe('validateConfig', () => {
  it('returns empty array for valid config', () => {
    const cfg = loadConfig();
    const problems = validateConfig(cfg);
    expect(problems).toHaveLength(0);
  });

  it('detects missing API key', () => {
    const prior = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const cfg = loadConfig({ model: { provider: 'openai', model: 'gpt-4', apiKey: undefined } });
      // Note: apiKey may be set from env, so we check if the config ends up without one
      const problems = validateConfig(cfg);
      expect(problems.some(p => p.includes('API key'))).toBe(!cfg.model.apiKey);
    } finally {
      if (prior !== undefined) process.env.OPENAI_API_KEY = prior;
    }
  });

  it('detects invalid maxIterations', () => {
    const cfg = loadConfig();
    cfg.safety.maxIterations = 0;
    const problems = validateConfig(cfg);
    expect(problems.some(p => p.includes('maxIterations'))).toBe(true);
  });

  it('detects invalid safety mode', () => {
    const cfg = loadConfig();
    cfg.safety.mode = 'invalid' as any;
    const problems = validateConfig(cfg);
    expect(problems.some(p => p.includes('safety.mode'))).toBe(true);
  });

  it('detects invalid contextBudgetTokens', () => {
    const cfg = loadConfig();
    cfg.safety.contextBudgetTokens = 100;
    const problems = validateConfig(cfg);
    expect(problems.some(p => p.includes('contextBudgetTokens'))).toBe(true);
  });
});
