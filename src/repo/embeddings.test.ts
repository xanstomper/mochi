// Wave J: embedder tests — fallback determinism/properties, provider wire
// shape with a stub fetch, and resolution policy (no silent network use).
import { describe, it, expect } from 'vitest';
import {
  LocalFallbackEmbedder,
  ProviderEmbedder,
  resolveEmbedder,
  FALLBACK_DIMS,
} from './embeddings.js';
import { PROVIDERS } from '../model/providers.js';
import type { MochiConfig } from '../types.js';

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // fallback vectors are unit-norm
}

describe('LocalFallbackEmbedder', () => {
  const emb = new LocalFallbackEmbedder();

  it('is labelled lexical-fallback, never semantic', () => {
    expect(emb.kind).toBe('lexical-fallback');
    expect(emb.id).toContain('lexical');
    expect(emb.dims).toBe(FALLBACK_DIMS);
  });

  it('is deterministic and unit-norm', async () => {
    const [a, b] = await emb.embed(['function acquireLease(ttl) { return renew(); }', 'function acquireLease(ttl) { return renew(); }']);
    expect(Array.from(a)).toEqual(Array.from(b));
    let n = 0;
    for (const x of Array.from(a)) n += x * x;
    expect(Math.sqrt(n)).toBeCloseTo(1, 5);
  });

  it('scores morphological relatives above unrelated text', () => {
    const q = emb.embedSync('idempotency key for payment submissions');
    const near = emb.embedSync('withIdempotencyKey guards the idempotent charge path');
    const far = emb.embedSync('render the banana bread recipe card with a photo');
    expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
  });

  it('splits identifiers: camelCase query matches camelCase code', () => {
    const q = emb.embedSync('fencing token renewal');
    const code = emb.embedSync('export function renewFencingToken(state) { return state.epoch + 1; }');
    expect(cosine(q, code)).toBeGreaterThan(0.05);
  });
});

describe('ProviderEmbedder', () => {
  const provider = PROVIDERS.find((p) => p.id === 'openai')!;

  it('batches, restores index order, and adopts response dims', async () => {
    const calls: Array<{ url: string; body: { model: string; input: string[] } }> = [];
    const fetchFn = (async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as { model: string; input: string[] };
      calls.push({ url, body });
      return {
        ok: true,
        json: async () => ({
          // Each item's vector encodes its OWN index (x10); the array is
          // reversed to prove the client places by `index`, not position.
          data: body.input.map((_, i) => ({ index: i, embedding: [(i + 1) * 10, 0, 0] })).reverse(),
        }),
        text: async () => '',
      } as Response;
    }) as unknown as typeof fetch;
    const emb = new ProviderEmbedder({ provider, model: 'text-embedding-3-small', apiKey: 'k', fetchFn, batchSize: 2 });
    const out = await emb.embed(['a', 'b', 'c']);
    expect(calls.length).toBe(2);
    expect(calls[0].url).toBe('https://api.openai.com/v1/embeddings');
    expect(out.length).toBe(3);
    expect(out[0][0]).toBe(10);
    expect(out[1][0]).toBe(20);
    expect(out[2][0]).toBe(10); // second batch restarts indexing
    expect(emb.dims).toBe(3);
    expect(emb.kind).toBe('provider');
  });

  it('throws on a non-ok response', async () => {
    const fetchFn = (async () => ({ ok: false, status: 401, text: async () => 'bad key', json: async () => ({}) }) as Response) as unknown as typeof fetch;
    const emb = new ProviderEmbedder({ provider, model: 'text-embedding-3-small', apiKey: 'k', fetchFn });
    await expect(emb.embed(['x'])).rejects.toThrow(/401/);
  });
});

describe('resolveEmbedder', () => {
  it('falls back when no config is given (no silent network use)', () => {
    const r = resolveEmbedder(undefined);
    expect(r.embedder.kind).toBe('lexical-fallback');
  });

  it('gate: a configured embedding-capable CHAT provider does NOT auto-wire provider embeddings', () => {
    const cfg = { model: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', apiKey: 'sk-test' } } as MochiConfig;
    const r = resolveEmbedder(cfg);
    expect(r.embedder.kind).toBe('lexical-fallback');
    expect(r.reason).toMatch(/OFF by default/);
  });

  it('gate: falls back for a non-OpenAI-kind provider when explicitly requested (anthropic)', () => {
    const cfg = { retrieval: { embeddingProvider: 'anthropic' } } as MochiConfig;
    const r = resolveEmbedder(cfg);
    expect(r.embedder.kind).toBe('lexical-fallback');
    expect(r.reason).toMatch(/anthropic/);
  });

  it('honours an explicit embeddingProvider with its known embedding model', () => {
    const cfg = {
      model: { provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4', apiKey: 'sk-test' },
      retrieval: { embeddingProvider: 'openai' },
    } as MochiConfig;
    const r = resolveEmbedder(cfg);
    expect(r.embedder.kind).toBe('provider');
    expect(r.embedder.id).toBe('openai:text-embedding-3-small');
  });

  it('honours an explicit provider+model pair regardless of the chat provider (keyless provider)', () => {
    const cfg = {
      model: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-test' },
      retrieval: { embeddingProvider: 'ollama', embeddingModel: 'nomic-embed-text' },
    } as MochiConfig;
    const r = resolveEmbedder(cfg);
    expect(r.embedder.kind).toBe('provider');
    expect(r.embedder.id).toBe('ollama:nomic-embed-text');
  });

  it('falls back when the requested provider has no known embedding model and none is configured', () => {
    const cfg = { retrieval: { embeddingProvider: 'deepseek' } } as MochiConfig;
    const r = resolveEmbedder(cfg);
    expect(r.embedder.kind).toBe('lexical-fallback');
    expect(r.reason).toMatch(/no known embedding model/);
  });

  it('falls back when a model is configured without any provider', () => {
    const cfg = { retrieval: { embeddingModel: 'some-embed-model' } } as MochiConfig;
    const r = resolveEmbedder(cfg);
    expect(r.embedder.kind).toBe('lexical-fallback');
    expect(r.reason).toMatch(/without a provider/);
  });

  it('honours the MOCHI_EMBEDDING_PROVIDER/MODEL env overrides (keyless provider)', () => {
    const prevP = process.env.MOCHI_EMBEDDING_PROVIDER;
    const prevM = process.env.MOCHI_EMBEDDING_MODEL;
    process.env.MOCHI_EMBEDDING_PROVIDER = 'ollama';
    process.env.MOCHI_EMBEDDING_MODEL = 'nomic-embed-text';
    try {
      const r = resolveEmbedder(undefined);
      expect(r.embedder.kind).toBe('provider');
      expect(r.embedder.id).toBe('ollama:nomic-embed-text');
    } finally {
      if (prevP === undefined) delete process.env.MOCHI_EMBEDDING_PROVIDER;
      else process.env.MOCHI_EMBEDDING_PROVIDER = prevP;
      if (prevM === undefined) delete process.env.MOCHI_EMBEDDING_MODEL;
      else process.env.MOCHI_EMBEDDING_MODEL = prevM;
    }
  });
});
