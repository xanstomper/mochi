// Local-first model tier (item 19) — tests.
//
// Covers the five required surfaces:
//   1. resolution       — endpoint/model precedence (env > model.local > baseUrl > default)
//   2. policy           — local-tier predicate, offline mode, remote-fallback opt-in
//   3. router wiring    — local tier selectable like any provider; defaults untouched
//   4. degradation      — dead endpoint -> fast, visible, actionable error;
//                         fallback only when explicitly enabled; offline never falls back
//   5. egress           — a local-tier run makes ZERO remote model calls (fetch-spy asserted)
//
// env is stubbed per-test and restored; the capability registry is reset so
// dead-endpoint markers never leak between tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  DEFAULT_LOCAL_ENDPOINT,
  LocalTierError,
  isLocalTierProvider,
  isLocalTierPrimary,
  offlineMode,
  remoteFallbackAllowed,
  resolveLocalEndpoint,
  resolveLocalModel,
  withLocalConnectGuidance,
  withRemoteEgressBlock,
} from './local.js';
import { createProvider, resolveProvider, withFailover, resetCapabilityRegistry, type RawProvider } from './router.js';
import { loadConfig, validateConfig } from '../config.js';
import type { ModelConfig, MochiConfig } from '../types.js';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Guaranteed-dead loopback endpoint (discard port, refuses instantly). */
const DEAD_LOCAL = 'http://127.0.0.1:9/v1';
const UNRESOLVABLE_REMOTE = 'https://offline-egress-probe.invalid/v1';

const localCfg = (over: Partial<ModelConfig> = {}): ModelConfig => ({
  provider: 'local',
  model: 'qwen-test',
  local: { endpoint: DEAD_LOCAL, model: 'qwen-test' },
  ...over,
});

/** Async variant: awaits fn BEFORE restoring env. */
async function withEnvAsync(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const keys = Object.keys(vars);
  const backup = new Map<string, string | undefined>();
  try {
    for (const k of keys) {
      backup.set(k, process.env[k]);
      if (vars[k] === undefined) delete process.env[k];
      else process.env[k] = vars[k]!;
    }
    await fn();
  } finally {
    for (const k of keys) {
      const prev = backup.get(k);
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
  }
}

const envBackup = new Map<string, string | undefined>();
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const keys = Object.keys(vars);
  try {
    for (const k of keys) {
      envBackup.set(k, process.env[k]);
      if (vars[k] === undefined) delete process.env[k];
      else process.env[k] = vars[k]!;
    }
    fn();
  } finally {
    for (const k of keys) {
      const prev = envBackup.get(k);
      if (prev === undefined) delete process.env[k];
      else process.env[k] = prev;
    }
    envBackup.clear();
  }
}

/** Spy on globalThis.fetch; records every attempted URL while passing calls through. */
function spyFetch(): { urls: string[]; restore: () => void } {
  const urls: string[] = [];
  const orig = globalThis.fetch;
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return orig(input as Parameters<typeof orig>[0], init);
  }) as unknown as typeof fetch;
  globalThis.fetch = spy;
  return { urls, restore: () => { globalThis.fetch = orig; } };
}

/** A fetch URL is remote when it is NOT this machine (loopback = local model server). */
const isRemote = (url: string): boolean => !/\/\/(127\.0\.0\.1|localhost|\[::1\]|::1)[:/]/.test(url);

/** Hand-built remote-entry spy provider (never hits the network unless told to). */
function remoteSpy(over: Partial<RawProvider> = {}): RawProvider & { calls: number } {
  const p: RawProvider & { calls: number } = {
    calls: 0,
    async *streamChat() { this.calls++; throw new Error('remote spy streamChat: not expected'); },
    async chat() { this.calls++; return { content: 'REMOTE-OK', finishReason: 'stop' }; },
    providerId: 'openai',
    isLocal: false,
    ...over,
  };
  return p;
}

/** Hand-built local-entry provider that fails like a dead endpoint (transport shape). */
function deadLocalSpy(): RawProvider & { calls: number } {
  const connectErr = Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }) });
  const p: RawProvider & { calls: number } = {
    calls: 0,
    async *streamChat() { this.calls++; throw connectErr; },
    async chat() { this.calls++; throw connectErr; },
    providerId: 'local',
    isLocal: true,
  };
  return p;
}

const user = { role: 'user' as const, content: 'ping' };

/** Minimal-but-valid MochiConfig for validateConfig. */
const fullCfg = (model: Partial<ModelConfig> = {}): MochiConfig => ({
  model: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', ...model },
  safety: { mode: 'auto', commandTimeoutSeconds: 120, maxIterations: 10, maxRuntimeMinutes: 60, maxConcurrentAgents: 1, contextBudgetTokens: 100_000 },
  permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
  projectDir: '.mochi',
  configDir: '/tmp/mochi-local-test',
} as unknown as MochiConfig);

beforeEach(() => {
  resetCapabilityRegistry();
});
afterEach(() => {
  resetCapabilityRegistry();
  vi.restoreAllMocks();
});

// ── 1. resolution ────────────────────────────────────────────────────────────

describe('resolveLocalEndpoint / resolveLocalModel precedence', () => {
  it('falls back to the default ollama endpoint and local-model id', () => {
    withEnv({ MOCHI_LOCAL_ENDPOINT: undefined, MOCHI_LOCAL_MODEL: undefined }, () => {
      const cfg: ModelConfig = { provider: 'local' };
      expect(resolveLocalEndpoint(cfg)).toBe(DEFAULT_LOCAL_ENDPOINT);
      expect(resolveLocalModel(cfg)).toBe('local-model');
    });
  });

  it('model.local beats a stamped generic baseUrl', () => {
    withEnv({ MOCHI_LOCAL_ENDPOINT: undefined }, () => {
      const cfg: ModelConfig = { provider: 'local', baseUrl: 'https://stamped.example/v1', model: 'stamped-model', local: { endpoint: 'http://127.0.0.1:8931/v1', model: 'qwen' } };
      expect(resolveLocalEndpoint(cfg)).toBe('http://127.0.0.1:8931/v1');
      expect(resolveLocalModel(cfg)).toBe('qwen');
    });
  });

  it('env beats the config block (one-shot override wins)', () => {
    withEnv({ MOCHI_LOCAL_ENDPOINT: 'http://127.0.0.1:8932/v1', MOCHI_LOCAL_MODEL: 'llama-test' }, () => {
      const cfg: ModelConfig = { provider: 'local', local: { endpoint: 'http://127.0.0.1:8931/v1', model: 'qwen' } };
      expect(resolveLocalEndpoint(cfg)).toBe('http://127.0.0.1:8932/v1');
      expect(resolveLocalModel(cfg)).toBe('llama-test');
    });
  });

  it('generic model field is the last config stop before the default', () => {
    withEnv({ MOCHI_LOCAL_ENDPOINT: undefined, MOCHI_LOCAL_MODEL: undefined }, () => {
      const cfg: ModelConfig = { provider: 'local', model: 'generic-model' };
      expect(resolveLocalModel(cfg)).toBe('generic-model');
    });
  });
});

// ── 2. policy ────────────────────────────────────────────────────────────────

describe('local-tier policy predicates', () => {
  it('counts the configurable tier and the legacy localhost providers as local', () => {
    for (const id of ['local', 'ollama', 'llamacpp', 'lmstudio', 'LOCAL']) {
      expect(isLocalTierProvider(id)).toBe(true);
    }
    for (const id of ['openai', 'anthropic', 'gemini', 'freeinference', 'openrouter', undefined]) {
      expect(isLocalTierProvider(id)).toBe(false);
    }
    expect(isLocalTierPrimary({ provider: 'local' })).toBe(true);
    expect(isLocalTierPrimary({ provider: 'openai' })).toBe(false);
  });

  it('offline mode: env on/off spellings; env off overrides config on', () => {
    withEnv({ MOCHI_OFFLINE: undefined }, () => {
      expect(offlineMode({ provider: 'local' })).toBe(false);
      expect(offlineMode({ provider: 'local', local: { offline: true } })).toBe(true);
    });
    withEnv({ MOCHI_OFFLINE: '1' }, () => {
      expect(offlineMode({ provider: 'local' })).toBe(true);
    });
    withEnv({ MOCHI_OFFLINE: '0' }, () => {
      expect(offlineMode({ provider: 'local', local: { offline: true } })).toBe(false);
    });
    withEnv({ MOCHI_OFFLINE: 'true' }, () => {
      expect(offlineMode({ provider: 'local', local: { offline: false } })).toBe(true);
    });
  });

  it('remote fallback is opt-in, and offline mode forces it off', () => {
    withEnv({ MOCHI_OFFLINE: undefined, MOCHI_LOCAL_ALLOW_REMOTE: undefined }, () => {
      expect(remoteFallbackAllowed({ provider: 'local' })).toBe(false);
      expect(remoteFallbackAllowed({ provider: 'local', local: { allowRemoteFallback: true } })).toBe(true);
    });
    withEnv({ MOCHI_LOCAL_ALLOW_REMOTE: '1' }, () => {
      expect(remoteFallbackAllowed({ provider: 'local' })).toBe(true);
    });
    // Offline wins over ANY opt-in — that is its purpose.
    withEnv({ MOCHI_OFFLINE: '1', MOCHI_LOCAL_ALLOW_REMOTE: '1' }, () => {
      expect(remoteFallbackAllowed({ provider: 'local', local: { allowRemoteFallback: true } })).toBe(false);
    });
  });
});

// ── 3. router wiring ─────────────────────────────────────────────────────────

describe('router wiring', () => {
  it('resolveProvider routes the local tier to the resolved endpoint/model', () => {
    withEnv({ MOCHI_LOCAL_ENDPOINT: undefined, MOCHI_LOCAL_MODEL: undefined }, () => {
      const r = resolveProvider(localCfg({ local: { endpoint: 'http://127.0.0.1:8933/v1', model: 'qwen-test' } }));
      expect(r.baseUrl).toBe('http://127.0.0.1:8933/v1');
      expect(r.model).toBe('qwen-test');
      expect(r.providerName).toBe('local');
    });
  });

  it('the local tier is selectable exactly like a remote provider', () => {
    withEnv({ MOCHI_LOCAL_ENDPOINT: undefined, MOCHI_LOCAL_MODEL: undefined }, () => {
      const p = createProvider(localCfg());
      expect(p.providerId).toBe('local');
      expect(p.isLocal).toBe(true);
      expect(typeof p.chat).toBe('function');
      expect(typeof p.streamChat).toBe('function');
    });
  });

  it('a remote primary is untouched by the local-tier tagging', () => {
    const p = createProvider({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
    expect(p.providerId).toBe('openai');
    expect(p.isLocal).toBe(false);
  });
});

// ── 4. degradation ───────────────────────────────────────────────────────────

describe('degradation: dead local endpoint', () => {
  it('fails FAST and VISIBLY with an actionable error; states nothing was sent off-machine', async () => {
    await withEnvAsync({ MOCHI_LOCAL_ENDPOINT: undefined, MOCHI_LOCAL_ALLOW_REMOTE: undefined, MOCHI_OFFLINE: undefined }, async () => {
      const p = createProvider(localCfg());
      const t0 = Date.now();
      let err: unknown;
      try {
        await p.chat([user], []);
      } catch (e) { err = e; }
      const ms = Date.now() - t0;
      expect(err).toBeInstanceOf(LocalTierError);
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain('unreachable');
      expect(msg).toContain(DEAD_LOCAL);
      expect(msg).toContain('nothing was sent off-machine');
      expect(msg).toContain('allowRemoteFallback'); // actionable opt-in hint
      console.log(`[local.test] dead-endpoint failure took ${ms}ms (retries included)`);
      expect(ms).toBeLessThan(15_000); // bounded: never a hang
    });
  }, 30_000);

  it('relabels only transport failures — HTTP status errors pass through untouched', async () => {
    const underlying: RawProvider = {
      async *streamChat() { throw new Error('HTTP 401 unauthorized'); },
      async chat() { throw new Error('HTTP 401 unauthorized'); },
    };
    const wrapped = withLocalConnectGuidance(underlying, 'http://127.0.0.1:8934/v1', false);
    await expect(wrapped.chat([user], [])).rejects.toThrow('HTTP 401 unauthorized');
    await expect(wrapped.chat([user], [])).rejects.not.toBeInstanceOf(LocalTierError);
  });
});

describe('degradation: fallback policy', () => {
  it('an explicit user failover chain IS the opt-in — fallback fires and is LOUD', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const local = deadLocalSpy();
    const remote = remoteSpy();
    const p = withFailover([local, remote], 'local');
    const out = await p.chat([user], []);
    expect(out.content).toBe('REMOTE-OK');
    expect(local.calls).toBe(1);
    expect(remote.calls).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('[failover] LOCAL TIER');
    expect(warn.mock.calls[0]?.[0]).toContain('openai');
  });

  it('the same visibility rule holds on the streaming path (fail BEFORE output)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const local = deadLocalSpy();
    const remote = remoteSpy({
      async *streamChat() { this.calls++; yield { content: 'chunk-1' }; yield { content: 'chunk-2' }; },
    });
    const p = withFailover([local, remote], 'local');
    const chunks: string[] = [];
    for await (const c of p.streamChat([user], [])) chunks.push(c.content ?? '');
    expect(chunks.join('')).toBe('chunk-1chunk-2');
    expect(local.calls).toBe(1);
    expect(remote.calls).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('falling back to REMOTE');
  });

  it('offline mode NEVER falls back — the guard refuses the remote call before any fetch', async () => {
    await withEnvAsync({ MOCHI_OFFLINE: '1', MOCHI_LOCAL_ENDPOINT: undefined, MOCHI_LOCAL_MODEL: undefined }, async () => {
      const { urls, restore } = spyFetch();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const cfg = localCfg({
          local: { endpoint: DEAD_LOCAL, model: 'qwen-test' },
          failover: [{ provider: 'openai', baseUrl: UNRESOLVABLE_REMOTE, model: 'gpt-4o-mini' }],
        });
        const p = createProvider(cfg);
        let err: unknown;
        try {
          await p.chat([user], []);
        } catch (e) { err = e; }
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toContain('refusing model call to remote provider');
        expect(msg).toContain('must not leave the machine');
        // The refused call is NEVER announced as a remote fallback.
        expect(warn.mock.calls.some((c) => String(c[0]).includes('[failover] LOCAL TIER'))).toBe(false);
        // EGRESS: the remote entry never fetched anything, anywhere.
        const remote = urls.filter((u) => isRemote(u));
        expect(remote).toEqual([]);
      } finally {
        restore();
      }
    });
  }, 30_000);

  it('withRemoteEgressBlock refuses before delegating (unit)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const remote = remoteSpy();
    const guarded = withRemoteEgressBlock(remote, 'openai', UNRESOLVABLE_REMOTE);
    await expect(guarded.chat([user], [])).rejects.toThrow(/refusing model call to remote provider "openai"/);
    // The guard carries routing metadata: the failover loop names the blocked
    // provider correctly and never announces a fallback to a refused call.
    expect(guarded.providerId).toBe('openai');
    expect(guarded.isLocal).toBe(false);
    expect(guarded.egressBlocked).toBe(true);
    const drain = async (): Promise<number> => {
      let n = 0;
      for await (const _ of guarded.streamChat([user], [])) n++;
      return n;
    };
    await expect(drain()).rejects.toThrow(/refusing model call to remote provider "openai"/);
    expect(remote.calls).toBe(0);
    expect(warn).not.toHaveBeenCalled(); // refusal is the loud part, not a fallback warn
  });
});

// ── 5. egress ────────────────────────────────────────────────────────────────

describe('egress: a local-tier run makes zero remote model calls', () => {
  it('local tier, no failover: the only fetches are loopback', async () => {
    await withEnvAsync({ MOCHI_OFFLINE: undefined, MOCHI_LOCAL_ENDPOINT: undefined, MOCHI_LOCAL_ALLOW_REMOTE: undefined }, async () => {
      const { urls, restore } = spyFetch();
      try {
        const p = createProvider(localCfg());
        await expect(p.chat([user], [])).rejects.toBeInstanceOf(LocalTierError);
        const remote = urls.filter((u) => isRemote(u));
        expect(remote).toEqual([]);
        expect(urls.length).toBeGreaterThan(0); // the loopback attempt itself happened
      } finally {
        restore();
      }
    });
  }, 30_000);

  it('local tier + remote failover entry present, endpoint UP: completes locally, remote NEVER called', async () => {
    // The strongest egress shape: a remote entry sits in the chain, the local
    // endpoint WORKS — the run must complete on loopback with zero remote
    // fetches. Uses a real stub OpenAI-compatible SSE server (bench pattern).
    const { createServer } = await import('node:http');
    const sse = (content: string) =>
      `data: ${JSON.stringify({ id: 'stub', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`;
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push((req.url ?? ''));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse('LOCAL-') + sse('OK') + 'data: [DONE]\n\n');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const port = (server.address() as { port: number }).port;
    await withEnvAsync({ MOCHI_OFFLINE: undefined, MOCHI_LOCAL_ENDPOINT: undefined, MOCHI_LOCAL_ALLOW_REMOTE: undefined }, async () => {
      const { urls, restore } = spyFetch();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const p = createProvider(localCfg({
          local: { endpoint: `http://127.0.0.1:${port}/v1`, model: 'qwen-test' },
          failover: [{ provider: 'openai', baseUrl: UNRESOLVABLE_REMOTE, model: 'gpt-4o-mini' }],
        }));
        const out = await p.chat([user], []);
        expect(out.content).toBe('LOCAL-OK');
        const remote = urls.filter((u) => isRemote(u));
        expect(remote).toEqual([]); // the failover entry existed and was never touched
        expect(hits.some((u) => u.includes('/chat/completions'))).toBe(true); // the local server WAS used
        // A successful local run must NOT warn about a fallback that never happened.
        expect(warn.mock.calls.some((c) => String(c[0]).includes('[failover] LOCAL TIER'))).toBe(false);
      } finally {
        restore();
        server.close();
      }
    });
  });
});

// ── 6. config-level chain rules ──────────────────────────────────────────────

describe('loadConfig: failover chain rules for the local tier', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'mochi-local-cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const KEY_ENV = {
    MOCHI_PROVIDER: undefined, MOCHI_BASE_URL: undefined, MOCHI_MODEL: undefined,
    MOCHI_LOCAL_ENDPOINT: undefined, MOCHI_LOCAL_MODEL: undefined,
    MOCHI_OFFLINE: undefined, MOCHI_LOCAL_ALLOW_REMOTE: undefined,
    OPENAI_API_KEY: 'sk-test-aaaaaaaaaaaa', ANTHROPIC_API_KEY: 'sk-ant-test-bbbbbbbb', GEMINI_API_KEY: 'AIza-test-cccccccc',
  } as const;

  const writeCfg = (obj: unknown): string => {
    const p = resolve(dir, 'config.json');
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };

  it('auto-built chain: remote providers never enter for a local-tier primary', () => {
    const p = writeCfg({ model: { provider: 'local', local: { endpoint: DEAD_LOCAL, model: 'qwen-test' } } });
    withEnv(KEY_ENV, () => {
      const cfg = loadConfig({}, p);
      const remote = (cfg.model.failover ?? []).filter((f) => !isLocalTierProvider(f.provider));
      expect(remote).toEqual([]); // no openai/anthropic/gemini despite live keys
    });
  });

  it('opt-in (model.local.allowRemoteFallback): remote entries stay in the auto-built chain', () => {
    const p = writeCfg({ model: { provider: 'local', local: { endpoint: DEAD_LOCAL, model: 'qwen-test', allowRemoteFallback: true } } });
    withEnv(KEY_ENV, () => {
      const cfg = loadConfig({}, p);
      const remote = (cfg.model.failover ?? []).filter((f) => !isLocalTierProvider(f.provider));
      expect(remote.length).toBeGreaterThan(0);
    });
  });

  it('env opt-in (MOCHI_LOCAL_ALLOW_REMOTE=1) behaves like the config opt-in', () => {
    const p = writeCfg({ model: { provider: 'local', local: { endpoint: DEAD_LOCAL, model: 'qwen-test' } } });
    withEnv({ ...KEY_ENV, MOCHI_LOCAL_ALLOW_REMOTE: '1' }, () => {
      const cfg = loadConfig({}, p);
      const remote = (cfg.model.failover ?? []).filter((f) => !isLocalTierProvider(f.provider));
      expect(remote.length).toBeGreaterThan(0);
    });
  });

  it('an explicit user failover chain is the opt-in and stays untouched', () => {
    const p = writeCfg({
      model: {
        provider: 'local',
        local: { endpoint: DEAD_LOCAL, model: 'qwen-test' },
        failover: [{ provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }],
      },
    });
    withEnv(KEY_ENV, () => {
      const cfg = loadConfig({}, p);
      expect(cfg.model.failover?.map((f) => f.provider)).toEqual(['openai']);
    });
  });

  it('offline mode strips remote entries from an explicit chain and says so loudly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = writeCfg({
      model: {
        provider: 'local',
        local: { endpoint: DEAD_LOCAL, model: 'qwen-test' },
        failover: [
          { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
          { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' },
        ],
      },
    });
    withEnv({ ...KEY_ENV, MOCHI_OFFLINE: '1' }, () => {
      const cfg = loadConfig({}, p);
      expect(cfg.model.failover?.map((f) => f.provider)).toEqual(['ollama']);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('[config] offline mode (local tier)'))).toBe(true);
    });
  });

  it('MOCHI_PROVIDER=local after the env merge re-applies the no-remote auto-chain rule', () => {
    const p = writeCfg({ model: { provider: 'openai' } });
    withEnv({ ...KEY_ENV, MOCHI_PROVIDER: 'local' }, () => {
      const cfg = loadConfig({}, p);
      expect(cfg.model.provider).toBe('local');
      const remote = (cfg.model.failover ?? []).filter((f) => !isLocalTierProvider(f.provider));
      expect(remote).toEqual([]);
    });
  });

  it('offline flag on a remote-primary run warns but does not touch routing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = writeCfg({ model: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' } });
    withEnv({ ...KEY_ENV, MOCHI_OFFLINE: '1' }, () => {
      const cfg = loadConfig({}, p);
      expect(cfg.model.provider).toBe('openai');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('not the local tier'))).toBe(true);
    });
  });
});

// ── 7. config validation ─────────────────────────────────────────────────────

describe('validateConfig: local tier', () => {
  afterEach(() => {
    // validateConfig reads env at call time (offlineMode); ensure isolation.
  });

  it('local tier without a generic baseUrl is NOT a problem (endpoint resolves elsewhere)', () => {
    withEnv({ MOCHI_LOCAL_ENDPOINT: undefined }, () => {
      const problems = validateConfig(fullCfg({ provider: 'local', baseUrl: undefined, model: 'qwen-test', local: { endpoint: DEAD_LOCAL, model: 'qwen-test' } }));
      expect(problems.some((p) => p.includes('model.baseUrl should be set'))).toBe(false);
    });
  });

  it('a remote provider without baseUrl is still flagged (unchanged default behavior)', () => {
    withEnv({ MOCHI_LOCAL_ENDPOINT: undefined }, () => {
      const problems = validateConfig(fullCfg({ provider: 'openai', baseUrl: undefined, model: 'gpt-4o-mini' }));
      expect(problems.some((p) => p.includes('model.baseUrl should be set'))).toBe(true);
    });
  });

  it('an unparseable endpoint is a visible problem naming the knob', () => {
    withEnv({ MOCHI_LOCAL_ENDPOINT: 'not a url' }, () => {
      const problems = validateConfig(fullCfg({ provider: 'local', local: { model: 'qwen-test' } }));
      expect(problems.some((p) => p.includes('not a valid http(s) URL') && p.includes('MOCHI_LOCAL_ENDPOINT'))).toBe(true);
    });
  });

  it('offline + allowRemoteFallback is contradictory and flagged', () => {
    withEnv({ MOCHI_OFFLINE: undefined, MOCHI_LOCAL_ALLOW_REMOTE: undefined }, () => {
      const problems = validateConfig(fullCfg({
        provider: 'local',
        local: { endpoint: DEAD_LOCAL, model: 'qwen-test', offline: true, allowRemoteFallback: true },
      }));
      expect(problems.some((p) => p.includes('contradictory'))).toBe(true);
    });
  });
});
