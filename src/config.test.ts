import { describe, it, expect } from 'vitest';
import { loadConfig, validateConfig } from './config.js';

describe('loadConfig', () => {
  it('loads defaults (isolated from user config)', () => {
    // Hermetic: neutralize host env that promotes safety.mode to 'uncensored'
    const priorUncensored = process.env.MOCHI_UNCENSORED;
    const priorSafety = process.env.MOCHI_SAFETY;
    delete process.env.MOCHI_UNCENSORED;
    delete process.env.MOCHI_SAFETY;
    try {
      const cfg = loadConfig({}, '/nonexistent/nowhere.json');
      expect(cfg.model.provider).toBe('opencode-zen');
      expect(cfg.safety.mode).toBe('ask');
      expect(cfg.projectDir).toBe('.mochi');
    } finally {
      if (priorUncensored !== undefined) process.env.MOCHI_UNCENSORED = priorUncensored;
      if (priorSafety !== undefined) process.env.MOCHI_SAFETY = priorSafety;
    }
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
      const cfg = loadConfig({ model: { provider: 'freeinference', model: 'deepseek-v4-flash', apiKey: 'sk-config-real-key-123456' } });
      expect(cfg.model.apiKey).toBe('sk-config-real-key-123456');
    } finally {
      if (prior !== undefined) process.env.FREEINFERENCE_API_KEY = prior;
    }
  });

  it('auto-builds a cross-provider failover chain from env keys of other providers', () => {
    // 150/159 failed traces were "provider cooling down" — the failover chain
    // existed in the router but nothing ever populated it. Other providers'
    // env keys must become fallback entries so a provider-wide cooldown no
    // longer kills tasks.
    const prior = {
      zen: process.env.OPENCODE_ZEN_API_KEY,
      fi: process.env.FREEINFERENCE_API_KEY,
      go: process.env.OPENCODE_GO_API_KEY,
    };
    process.env.OPENCODE_ZEN_API_KEY = 'sk-primary-key-aaaaaaaa';
    process.env.FREEINFERENCE_API_KEY = 'sk-failover-key-bbbbbbbb';
    delete process.env.OPENCODE_GO_API_KEY;
    try {
      const cfg = loadConfig({ model: { provider: 'opencode-zen' } }, '/nonexistent/nowhere.json');
      expect(cfg.model.failover).toBeDefined();
      expect(cfg.model.failover!.length).toBeGreaterThanOrEqual(1);
      const fi = cfg.model.failover!.find((f) => f.provider === 'freeinference');
      expect(fi).toBeDefined();
      expect(fi!.apiKey).toBe('sk-failover-key-bbbbbbbb');
      expect(fi!.model).toBe('kimi-k2.7-code'); // the provider's defaultModel
      // The primary itself must never appear in the chain.
      expect(cfg.model.failover!.some((f) => f.provider === 'opencode-zen')).toBe(false);
    } finally {
      for (const [k, v] of [['OPENCODE_ZEN_API_KEY', prior.zen], ['FREEINFERENCE_API_KEY', prior.fi], ['OPENCODE_GO_API_KEY', prior.go]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('does not add failover entries for providers without env keys', () => {
    const prior = { zen: process.env.OPENCODE_ZEN_API_KEY, oa: process.env.OPENAI_API_KEY };
    process.env.OPENCODE_ZEN_API_KEY = 'sk-primary-key-cccccccc';
    delete process.env.OPENAI_API_KEY;
    try {
      const cfg = loadConfig({ model: { provider: 'opencode-zen' } }, '/nonexistent/nowhere.json');
      // No OPENAI_API_KEY -> openai must not be in the chain.
      expect(cfg.model.failover?.some((f) => f.provider === 'openai') ?? false).toBe(false);
    } finally {
      for (const [k, v] of [['OPENCODE_ZEN_API_KEY', prior.zen], ['OPENAI_API_KEY', prior.oa]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('respects an explicit user-configured failover chain instead of auto-building', () => {
    const prior = process.env.FREEINFERENCE_API_KEY;
    process.env.FREEINFERENCE_API_KEY = 'sk-env-key-dddddddd';
    try {
      const explicit = [{
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-explicit-key-eeeeeeee',
        model: 'gpt-4o-mini',
      }];
      const cfg = loadConfig({ model: { provider: 'freeinference', failover: explicit as any } }, '/nonexistent/nowhere.json');
      expect(cfg.model.failover).toEqual(explicit);
      // freeinference must not have been appended to the explicit chain.
      expect(cfg.model.failover!.some((f) => f.provider === 'freeinference')).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.FREEINFERENCE_API_KEY;
      else process.env.FREEINFERENCE_API_KEY = prior;
    }
  });

  it('excludes a placeholder env key from the failover chain', () => {
    const prior = { zen: process.env.OPENCODE_ZEN_API_KEY, oa: process.env.OPENAI_API_KEY };
    process.env.OPENCODE_ZEN_API_KEY = 'sk-primary-key-ffffffff';
    process.env.OPENAI_API_KEY = 'hi'; // placeholder
    try {
      const cfg = loadConfig({ model: { provider: 'opencode-zen' } }, '/nonexistent/nowhere.json');
      expect(cfg.model.failover?.some((f) => f.provider === 'openai') ?? false).toBe(false);
    } finally {
      for (const [k, v] of [['OPENCODE_ZEN_API_KEY', prior.zen], ['OPENAI_API_KEY', prior.oa]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('validateConfig', () => {
  it('returns empty array for valid config', () => {
    const cfg = loadConfig();
    const problems = validateConfig(cfg);
    expect(problems).toHaveLength(0);
  });

  it('does not report a missing API key (key is a call-time concern, not structural)', () => {
    const prior = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const cfg = loadConfig({ model: { provider: 'openai', model: 'gpt-4', apiKey: undefined } });
      const problems = validateConfig(cfg);
      // Missing-key must not be a structural config problem; it is surfaced
      // at the model call layer so Runtimes can be built without keys.
      expect(problems.some(p => p.includes('API key'))).toBe(false);
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

  it('supports reasoning configuration and validates reasoning level', () => {
    const cfg = loadConfig({ reasoning: 'high' });
    expect(cfg.reasoning).toBe('high');
    expect(validateConfig(cfg)).toHaveLength(0);

    const invalidCfg = loadConfig({ reasoning: 'super' as any });
    const problems = validateConfig(invalidCfg);
    expect(problems.some(p => p.includes('reasoning'))).toBe(true);
  });

  it('auto-loads mcpServers from .mcp.json if present in cwd', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-mcp-'));
    const mcpPath = resolve(dir, '.mcp.json');
    writeFileSync(mcpPath, JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        postgres: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/db'] },
      },
    }));
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      const cfg = loadConfig();
      expect(cfg.mcpServers).toBeDefined();
      expect(cfg.mcpServers?.github?.command).toBe('npx');
      expect(cfg.mcpServers?.postgres?.command).toBe('npx');
      expect(cfg.mcpServers?.postgres?.args).toContain('postgresql://localhost/db');
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
