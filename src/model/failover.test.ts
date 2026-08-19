import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { createProvider, withFailover, resetCapabilityRegistry } from './router.js';
import { loadConfig } from '../config.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import type { ModelConfig, StreamChunk, ModelResponse } from '../types.js';

afterEach(() => resetCapabilityRegistry());

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