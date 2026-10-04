import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createProvider, withFailover, resetCapabilityRegistry } from './router.js';
import { loadConfig } from '../config.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { ModelConfig, StreamChunk, ModelResponse } from '../types.js';

afterEach(() => {
  resetCapabilityRegistry();
  vi.unstubAllEnvs();
});

/** Bind a server, note the port, close it. Later connects get a real
 *  ECONNREFUSED (not the special "bad port" error). */
function deadUrl(): Promise<string> {
  return new Promise((done) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => done(`http://127.0.0.1:${port}/v1`));
    });
  });
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<string> {
  let out = '';
  for await (const c of gen) out += c.content ?? '';
  return out;
}

function baseConfig(over: Partial<ModelConfig> = {}): ModelConfig {
  return {
    provider: 'openai',
    baseUrl: '', // filled per-test with a real dead URL
    apiKey: 'x',
    model: 'primary-model',
    ...over,
  };
}

describe('multi-provider failover', () => {
  it.each(['stream', 'chat'] as const)('does not call any provider with an already cancelled signal (%s)', async (mode) => {
    const controller = new AbortController();
    const cancelled = new Error('cancelled before dispatch');
    controller.abort(cancelled);
    let calls = 0;
    const raw = {
      async *streamChat(): AsyncGenerator<StreamChunk> {
        calls++;
        yield { content: 'must not run' };
      },
      async chat(): Promise<ModelResponse> {
        calls++;
        return { content: 'must not run' } as ModelResponse;
      },
    };
    const provider = withFailover([raw], 'test');
    const options = { signal: controller.signal };
    const result = mode === 'stream'
      ? collect(provider.streamChat([], [], options))
      : provider.chat([], [], options);
    await expect(result).rejects.toBe(cancelled);
    expect(calls).toBe(0);
  });

  it.each(['stream', 'chat'] as const)('does not start a fallback after caller cancellation (%s)', async (mode) => {
    const controller = new AbortController();
    const cancelled = new Error('operator stopped this request');
    let fallbackCalls = 0;
    const primary = {
      async *streamChat(): AsyncGenerator<StreamChunk> {
        controller.abort(cancelled);
        throw cancelled;
      },
      async chat(): Promise<ModelResponse> {
        controller.abort(cancelled);
        throw cancelled;
      },
    };
    const fallback = {
      async *streamChat(): AsyncGenerator<StreamChunk> {
        fallbackCalls++;
        yield { content: 'must not run' };
      },
      async chat(): Promise<ModelResponse> {
        fallbackCalls++;
        return { content: 'must not run' } as ModelResponse;
      },
    };
    const provider = withFailover([primary, fallback], 'test');
    const options = { signal: controller.signal };
    const result = mode === 'stream'
      ? collect(provider.streamChat([], [], options))
      : provider.chat([], [], options);
    await expect(result).rejects.toBe(cancelled);
    expect(fallbackCalls).toBe(0);
  });

  it('falls through when the primary stalls before yielding a chunk', async () => {
    // Exercise a short configured header deadline, not an unrealistically
    // short production timeout for reasoning models.
    vi.stubEnv('MOCHI_MODEL_HEADERS_TIMEOUT_MS', '250');
    const stalled = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Keep the connection open without yielding model data.
    });
    stalled.listen(0, '127.0.0.1');
    await once(stalled, 'listening');
    const port = (stalled.address() as AddressInfo).port;
    const fake = await startFakeOpenAI([{ content: 'recovered from stall', finishReason: 'stop' }]);
    try {
      const provider = createProvider(baseConfig({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        failover: [{ provider: 'openai', baseUrl: fake.url, apiKey: 'local-test-key', model: 'fake-model' }],
      }));
      const started = Date.now();
      const text = await collect(provider.streamChat([{ role: 'user', content: 'hi' }], []));
      expect(text).toContain('recovered from stall');
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      stalled.closeAllConnections();
      stalled.close();
      await fake.close();
    }
  }, 10_000);

  it('falls through to the fallback when the primary refuses connections', async () => {
    const dead = await deadUrl();
    const fake = await startFakeOpenAI([{ content: 'hello from fallback', finishReason: 'stop' }]);
    try {
      const provider = createProvider(baseConfig({
        baseUrl: dead,
        failover: [{ provider: 'openai', baseUrl: fake.url, apiKey: 'x', model: 'fake-model' }],
      }));
      const text = await collect(provider.streamChat([{ role: 'user', content: 'hi' }], []));
      expect(text).toContain('hello from fallback');
      // The primary was marked dead by the capability gate; the fallback request
      // used the fallback's own model id.
      expect(fake.requests.some((r) => r.body?.model === 'fake-model')).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it('throws the last error when every provider in the chain fails', async () => {
    const dead1 = await deadUrl();
    const dead2 = await deadUrl();
    const provider = createProvider(baseConfig({
      baseUrl: dead1,
      failover: [{ provider: 'openai', baseUrl: dead2, apiKey: 'x', model: 'm' }],
    }));
    await expect(collect(provider.streamChat([{ role: 'user', content: 'hi' }], []))).rejects.toThrow();
  });

  it('non-streaming chat falls through too', async () => {
    const dead = await deadUrl();
    const fake = await startFakeOpenAI([{ content: 'chat fallback', finishReason: 'stop' }]);
    try {
      const provider = createProvider(baseConfig({
        baseUrl: dead,
        failover: [{ provider: 'openai', baseUrl: fake.url, apiKey: 'x', model: 'fake-model' }],
      }));
      const res: ModelResponse = await provider.chat([{ role: 'user', content: 'hi' }], []);
      expect(res.content).toContain('chat fallback');
    } finally {
      await fake.close();
    }
  });

  it('never replays a mid-stream failure onto the fallback', async () => {
    // Hand-built raw chain: provider A yields one chunk then dies, B would
    // succeed. The wrapper must rethrow A's error, not start B.
    let bCalled = 0;
    const a = {
      async *streamChat() {
        yield { content: 'partial ' };
        throw new Error('boom mid-stream');
      },
      async chat() {
        throw new Error('boom mid-stream');
      },
    };
    const b = {
      async *streamChat() {
        bCalled++;
        yield { content: 'should never appear' };
      },
      async chat() {
        bCalled++;
        return { content: 'should never appear', toolCalls: undefined, finishReason: 'stop', usage: undefined } as ModelResponse;
      },
    };
    const provider = withFailover([a, b] as never[], 'test');
    await expect(collect(provider.streamChat([{ role: 'user', content: 'hi' }], []))).rejects.toThrow('boom mid-stream');
    expect(bCalled).toBe(0);
  });

  it('selects the profile model on the fallback (inherits primary profiles)', async () => {
    const dead = await deadUrl();
    const fake = await startFakeOpenAI([{ content: 'ok', finishReason: 'stop' }]);
    try {
      const provider = createProvider(baseConfig({
        baseUrl: dead,
        profiles: { coding: 'primary-coding' },
        failover: [{ provider: 'openai', baseUrl: fake.url, apiKey: 'x', model: 'fb-model' }],
      }), 'coding');
      await collect(provider.streamChat([{ role: 'user', content: 'hi' }], []));
      const model = fake.requests.map((r) => r.body?.model).find((m) => m);
      expect(model).toBeTruthy();
    } finally {
      await fake.close();
    }
  });
});

describe('failover config wiring', () => {
  it('loads a failover chain from config', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-failover-cfg-'));
    mkdirSync(resolve(dir, '.config/mochi'), { recursive: true });
    const cfgPath = resolve(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify({
      model: {
        provider: 'openai',
        baseUrl: 'http://primary/x',
        model: 'p',
        failover: [
          { provider: 'freeinference', baseUrl: 'https://freeinference.org/v1', model: 'deepseek-v4-flash' },
        ],
      },
    }));
    const cfg = loadConfig({ configDir: dir } as never, cfgPath);
    expect(cfg.model.failover).toHaveLength(1);
    expect(cfg.model.failover![0].provider).toBe('freeinference');
  });
});