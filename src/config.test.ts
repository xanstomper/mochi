import { describe, it, expect } from 'vitest';
import { loadConfig, validateConfig, loadEnvFiles, loadProjectConfig } from './config.js';
import { PROVIDERS } from './model/providers.js';

/** Set/delete env keys for the duration of fn, restoring exactly. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

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
      expect(fi!.model).toBe('glm-5.3-flash'); // the provider's defaultModel
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

  it('auto-loads MCP servers from Cursor and VS Code project configs too', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-mcp-foreign-'));
    mkdirSync(resolve(dir, '.cursor'), { recursive: true });
    mkdirSync(resolve(dir, '.vscode'), { recursive: true });
    writeFileSync(resolve(dir, '.cursor', 'mcp.json'), JSON.stringify({
      mcpServers: { filesystem: { command: 'npx', args: ['-y', 'srv-fs'] } },
    }));
    // VS Code uses `servers`, and shares a name to prove later files win.
    writeFileSync(resolve(dir, '.vscode', 'mcp.json'), JSON.stringify({
      servers: { filesystem: { command: 'uvx', args: ['srv-vscode'] }, memory: { command: 'npx', args: ['srv-mem'] } },
    }));
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      const cfg = loadConfig();
      expect(cfg.mcpServers?.filesystem?.command).toBe('uvx'); // .vscode overrides .cursor
      expect(cfg.mcpServers?.memory?.command).toBe('npx');
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadEnvFiles (.env parsing)', () => {
  it('parses quotes, comments, and malformed lines without clobbering existing keys', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-dotenv-'));
    writeFileSync(resolve(dir, '.env'), [
      '# a comment',
      '',
      'MOCHI_TEST_ENV_A="quoted value"',
      "MOCHI_TEST_ENV_B='single'",
      'MOCHI_TEST_ENV_C=bare',
      'NO_EQUALS_LINE',
      '=no-key',
      'MOCHI_TEST_ENV_A=second-should-not-win',
      'MOCHI_TEST_ENV_PRESET=third-should-not-win',
    ].join('\n'));
    const origCwd = process.cwd();
    const before: Record<string, string | undefined> = { ...process.env };
    process.env.MOCHI_TEST_ENV_PRESET = 'original';
    process.chdir(dir);
    try {
      loadEnvFiles();
      expect(process.env.MOCHI_TEST_ENV_A).toBe('quoted value'); // first wins, quotes stripped
      expect(process.env.MOCHI_TEST_ENV_B).toBe('single');
      expect(process.env.MOCHI_TEST_ENV_C).toBe('bare');
      expect(process.env.MOCHI_TEST_ENV_PRESET).toBe('original'); // never clobber
    } finally {
      process.chdir(origCwd);
      for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
      for (const k of Object.keys(before)) if (before[k] !== process.env[k]) process.env[k] = before[k]!;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('project file merges + config path resolution', () => {
  it('merges cwd mochi.json and accepts the servers alias in .mcp.json', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-projcfg-'));
    writeFileSync(resolve(dir, 'mochi.json'), JSON.stringify({ quiet: true }));
    writeFileSync(resolve(dir, '.mcp.json'), JSON.stringify({ servers: { s1: { command: 'node' } } }));
    const origCwd = process.cwd();
    process.chdir(dir);
    try {
      const cfg = loadConfig({}, '/nonexistent/nowhere.json');
      expect(cfg.quiet).toBe(true); // mochi.json arm
      expect(cfg.mcpServers?.s1?.command).toBe('node'); // "servers" alias arm
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
    // Separately: .mochi/config.json is the fallback when mochi.json is absent.
    const dir2 = mkdtempSync(resolve(tmpdir(), 'mochi-projcfg2-'));
    mkdirSync(resolve(dir2, '.mochi'));
    writeFileSync(resolve(dir2, '.mochi', 'config.json'), JSON.stringify({ verbose: true }));
    process.chdir(dir2);
    try {
      const cfg = loadConfig({}, '/nonexistent/nowhere.json');
      expect(cfg.verbose).toBe(true);
    } finally {
      process.chdir(origCwd);
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('ignores corrupt config files and honors MOCHI_CONFIG_PATH', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-corrupt-'));
    const corrupt = resolve(dir, 'config.json');
    writeFileSync(corrupt, '{not json at all');
    // Explicit corrupt path -> defaults survive (readJsonFile catch arm).
    expect(loadConfig({}, corrupt).model.provider).toBe('opencode-zen');
    // MOCHI_CONFIG_PATH env path (same catch path, resolved via env).
    const origCwd = process.cwd();
    process.chdir(dir); // isolated cwd: no project files interfere
    try {
      withEnv({ MOCHI_CONFIG_PATH: corrupt }, () => {
        expect(loadConfig().model.provider).toBe('opencode-zen');
      });
      // A valid marker through the env path proves the resolution arm.
      writeFileSync(corrupt, JSON.stringify({ model: { model: 'marker-model-xyz' } }));
      withEnv({ MOCHI_CONFIG_PATH: corrupt }, () => {
        expect(loadConfig().model.model).toBe('marker-model-xyz');
      });
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadProjectConfig reads config.json or returns {}', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-lpc-'));
    expect(loadProjectConfig(resolve(dir, 'nope'))).toEqual({});
    writeFileSync(resolve(dir, 'config.json'), JSON.stringify({ telemetry: true }));
    expect(loadProjectConfig(dir)).toEqual({ telemetry: true });
    writeFileSync(resolve(dir, 'config.json'), '{broken');
    expect(loadProjectConfig(dir)).toEqual({}); // corrupt -> {}
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('provider-table consistency + env knobs', () => {
  it('keeps explicit user baseUrl/model/profiles (no provider-table overwrite)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-keep-'));
    const cfgPath = resolve(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ model: { provider: 'openrouter', baseUrl: 'https://custom.example/v1', model: 'custom-model', profiles: { fast: 'custom-fast' } } }));
    try {
      const cfg = loadConfig({}, cfgPath);
      expect(cfg.model.baseUrl).toBe('https://custom.example/v1');
      expect(cfg.model.model).toBe('custom-model');
      expect(cfg.model.profiles?.fast).toBe('custom-fast'); // non-slash profile kept
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives baseUrl/model/profiles from the provider table when omitted', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-derive-'));
    const cfgPath = resolve(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ model: { provider: 'openrouter' } }));
    const prov = PROVIDERS.find((p) => p.id === 'openrouter');
    expect(prov).toBeDefined();
    try {
      const cfg = loadConfig({}, cfgPath);
      expect(cfg.model.baseUrl).toBe(prov!.baseUrl);
      expect(cfg.model.model).toBe(prov!.defaultModel);
      expect(cfg.model.profiles?.fast).toBe(prov!.defaultModel);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors MOCHI_BASE_URL over provider-table derivation', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-envbase-'));
    const cfgPath = resolve(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({ model: { provider: 'openrouter' } }));
    try {
      withEnv({ MOCHI_BASE_URL: 'https://env-base.example/v1' }, () => {
        const cfg = loadConfig({}, cfgPath);
        expect(cfg.model.baseUrl).toBe('https://env-base.example/v1');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies env knobs: dirs, safety, sandbox, permissions, flags', () => {
    withEnv({
      MOCHI_UNCENSORED: undefined,
      MOCHI_PROJECT_DIR: '.proj-env',
      MOCHI_CONFIG_DIR: '/tmp/cfg-env',
      MOCHI_SAFETY: 'auto',
      MOCHI_SANDBOX: 'bubblewrap',
      MOCHI_PERMISSION_READ: '0',
      MOCHI_PERMISSION_ADMIN: 'true',
      MOCHI_QUIET: '1',
      MOCHI_VERBOSE: '1',
      MOCHI_DEBUG: '1',
    }, () => {
      const cfg = loadConfig({}, '/nonexistent/nowhere.json');
      expect(cfg.projectDir).toBe('.proj-env');
      expect(cfg.configDir).toBe('/tmp/cfg-env');
      expect(cfg.safety.mode).toBe('auto');
      expect(cfg.safety.sandbox).toBe('bubblewrap');
      expect(cfg.permissions.read).toBe(false);
      expect(cfg.permissions.admin).toBe(true);
      expect(cfg.quiet).toBe(true);
      expect(cfg.verbose).toBe(true);
      expect(cfg.debug).toBe(true);
    });

    // Invalid safety/sandbox values are ignored (no throw, no clobber).
    withEnv({ MOCHI_UNCENSORED: undefined, MOCHI_SAFETY: 'bogus', MOCHI_SANDBOX: 'chroot' }, () => {
      const cfg = loadConfig({}, '/nonexistent/nowhere.json');
      expect(cfg.safety.mode).toBe('ask'); // kept default
      expect(cfg.safety.sandbox).toBeUndefined();
    });
  });

  // ISSUES L-06: the dead `telemetry` knob is removed from the schema — it
  // was parsed, env-settable, and read by nothing (MOCHI_TELEMETRY=1 was a
  // silent no-op). These assertions PIN the removal: the field must not come
  // back as a knob that does nothing, and config files still carrying it
  // load unchanged (unknown keys are tolerated by the merge).
  it('telemetry is no longer a config knob (removed schema field)', () => {
    withEnv({ MOCHI_TELEMETRY: 'yes' }, () => {
      const cfg = loadConfig({}, '/nonexistent/nowhere.json');
      expect('telemetry' in (cfg as unknown as Record<string, unknown>)).toBe(false);
    });
    const cfg = loadConfig({ telemetry: false } as never, '/nonexistent/nowhere.json');
    // A legacy config file's telemetry key survives the merge as an unknown
    // key (no schema rejection) — but nothing reads it.
    expect((cfg as unknown as Record<string, unknown>).telemetry).toBe(false);
  });

  it('maps MOCHI_REASONING synonyms and falls back to medium', () => {
    const cases: Array<[string, string]> = [
      ['extreme', 'max'], ['deep', 'max'], ['high', 'high'], ['hard', 'high'],
      ['low', 'low'], ['easy', 'low'], ['off', 'off'], ['auto', 'auto'],
      ['medium', 'medium'], ['bogus-level', 'medium'],
    ];
    for (const [raw, expected] of cases) {
      withEnv({ MOCHI_REASONING: raw }, () => {
        expect(loadConfig({}, '/nonexistent/nowhere.json').reasoning).toBe(expected);
      });
    }
  });

  it('applies per-provider env API keys through the envKeyMap', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-envkey-'));
    const cfgPath = resolve(dir, 'config.json');
    try {
      // The provider must come from the CONFIG FILE: overrides merge after
      // the envKeyMap resolution, so they cannot select the key lookup.
      writeFileSync(cfgPath, JSON.stringify({ model: { provider: 'openrouter', model: 'x' } }));
      withEnv({ OPENROUTER_API_KEY: 'sk-or-key-zzzzzzzz' }, () => {
        const cfg = loadConfig({}, cfgPath);
        expect(cfg.model.apiKey).toBe('sk-or-key-zzzzzzzz');
      });
      // A provider with no envKeyMap entry keeps whatever the config carried.
      writeFileSync(cfgPath, JSON.stringify({ model: { provider: 'ollama', model: 'llama', apiKey: 'local-key' } }));
      withEnv({ OPENROUTER_API_KEY: undefined }, () => {
        const cfg = loadConfig({}, cfgPath);
        expect(cfg.model.apiKey).toBe('local-key');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores __proto__ pollution and undefined override values', () => {
    const parsed = JSON.parse('{"__proto__": {"polluted": true}, "telemetry": true}') as Record<string, unknown>;
    const cfg = loadConfig({ quiet: undefined, ...parsed } as never, '/nonexistent/nowhere.json');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined(); // prototype untouched
    expect((cfg as unknown as Record<string, unknown>).telemetry).toBe(true); // unknown key still merged through
    expect(cfg.quiet).toBe(false); // undefined source value skipped, default kept
  });
});

describe('validateConfig full surface', () => {
  it('reports every structural problem it knows about', () => {
    const cfg = loadConfig({ model: { provider: 'openai', baseUrl: '', model: '' } }, '/nonexistent/nowhere.json');
    cfg.reasoning = 'turbo' as never;
    cfg.safety.maxRuntimeMinutes = 0.1;
    cfg.safety.commandTimeoutSeconds = 1;
    cfg.safety.sandbox = 'chroot' as never;
    cfg.safety.maxConcurrentAgents = 99;
    cfg.safety.maxTokens = 10;
    cfg.safety.maxCostUsd = -1;
    cfg.mcpServers = { bad: {} as never };
    const problems = validateConfig(cfg);
    expect(problems.some((p) => p.includes('model.baseUrl'))).toBe(true);
    expect(problems.some((p) => p.includes('model.model is empty'))).toBe(true);
    expect(problems.some((p) => p.includes('maxRuntimeMinutes'))).toBe(true);
    expect(problems.some((p) => p.includes('commandTimeoutSeconds'))).toBe(true);
    expect(problems.some((p) => p.includes('safety.sandbox'))).toBe(true);
    expect(problems.some((p) => p.includes('maxConcurrentAgents'))).toBe(true);
    expect(problems.some((p) => p.includes('maxTokens'))).toBe(true);
    expect(problems.some((p) => p.includes('maxCostUsd'))).toBe(true);
    expect(problems.some((p) => p.includes('MCP server "bad"'))).toBe(true);
    expect(problems.some((p) => p.includes('reasoning "turbo"'))).toBe(true);

    // url-only MCP servers are valid: McpClient routes on `url` for HTTP
    // transports (built-ins like mcp-exa ship this shape).
    cfg.mcpServers = { 'mcp-exa': { url: 'https://mcp.exa.ai/mcp' } as never };
    expect(validateConfig(cfg).some((p) => p.includes('MCP server'))).toBe(false);

    // Empty provider + openrouter waiver are their own arms.
    const empty = loadConfig({}, '/nonexistent/nowhere.json');
    empty.model.provider = '';
    empty.model.baseUrl = '';
    const ep = validateConfig(empty);
    expect(ep.some((p) => p.includes('model.provider is empty'))).toBe(true);
    expect(ep.some((p) => p.includes('model.baseUrl'))).toBe(false); // provider falsy -> no baseUrl complaint

    // openrouter providers never need an explicit baseUrl.
    const or = loadConfig({ model: { provider: 'openrouter', baseUrl: '', model: 'or-model' } }, '/nonexistent/nowhere.json');
    expect(validateConfig(or).some((p) => p.includes('model.baseUrl'))).toBe(false);
  });
});
