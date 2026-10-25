// Embeddings for the semantic code index (Wave J).
//
// Two implementations behind one interface:
//
// 1. ProviderEmbedder — real semantic embeddings over the repo's EXISTING
//    provider layer: the provider row comes from model/providers.ts
//    (baseUrl + envKey), the key resolves the same way the chat providers
//    resolve theirs (explicit config key → keyring → provider env var), and
//    the wire call is the OpenAI-compatible POST {baseUrl}/embeddings that
//    every 'openai'-kind provider in the table speaks. Used ONLY when an
//    embedding model is configured (retrieval.embeddingModel /
//    MOCHI_EMBEDDING_MODEL) or the configured provider is a known
//    embedding-capable one (KNOWN_EMBEDDING_MODELS). No silent network
//    calls: an 'openai'-kind chat provider whose embedding support is
//    unknown is NOT assumed to serve embeddings.
//
// 2. LocalFallbackEmbedder — deterministic, offline, dependency-free.
//    *** This is a LEXICAL fallback, not semantic embeddings. *** It builds
//    a hashed bag-of-features vector (identifier-split tokens + character
//    trigrams, the same signals memory/relevance.ts and unified-search.ts
//    rank with) projected into a fixed 512-dim space. Cosine over these
//    vectors captures sub-word/morphological overlap — strictly more than
//    exact token match, strictly less than a trained embedding model. It is
//    labelled 'lexical-fallback' in its id, in index metadata, in tool
//    output and in context blocks, so nothing downstream can mistake it
//    for real semantics.
import { createHash } from 'node:crypto';
import { PROVIDERS, type Provider } from '../model/providers.js';
import { loadKeyring, storedKeyForProvider } from '../model/keyring.js';
import { tokenize } from '../memory/relevance.js';
import { normalizeForNgrams } from '../memory/unified-search.js';
import type { MochiConfig } from '../types.js';

export type EmbedderKind = 'provider' | 'lexical-fallback';

export interface Embedder {
  /** Stable identity, persisted in the index meta. Changing the embedder
   *  invalidates stored vectors (they are keyed by this id). */
  readonly id: string;
  readonly kind: EmbedderKind;
  readonly dims: number;
  embed(texts: string[]): Promise<Float32Array[]>;
}

/** Providers whose /embeddings endpoint + a sane default embedding model
 *  are known. Deliberately short: adding a provider here is a claim that
 *  its embeddings endpoint actually works with this wire shape. */
export const KNOWN_EMBEDDING_MODELS: Record<string, string> = {
  openai: 'text-embedding-3-small',
  openrouter: 'openai/text-embedding-3-small',
  mistral: 'mistral-embed',
  freeinference: 'bge-m3',
};

// ---------------------------------------------------------------------------
// Local lexical-fallback embedder
// ---------------------------------------------------------------------------

export const FALLBACK_DIMS = 512;
const TOKEN_WEIGHT = 1.0;
const TRIGRAM_WEIGHT = 0.6;

/** FNV-1a over the feature string → bucket + sign (signed hashing keeps
 *  collisions zero-mean instead of systematically additive). */
function hashFeature(feature: string): { bucket: number; sign: number } {
  let h = 0x811c9dc5;
  for (let i = 0; i < feature.length; i++) {
    h ^= feature.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const bucket = (h >>> 0) % FALLBACK_DIMS;
  const sign = (h >>> 16) & 1 ? 1 : -1;
  return { bucket, sign };
}

export class LocalFallbackEmbedder implements Embedder {
  readonly id = 'local-lexical-hash-v1';
  readonly kind: EmbedderKind = 'lexical-fallback';
  readonly dims = FALLBACK_DIMS;

  /** Synchronous single-text embedding (query path + tests). */
  embedSync(text: string): Float32Array {
    const v = new Float32Array(FALLBACK_DIMS);
    const add = (feature: string, w: number) => {
      const { bucket, sign } = hashFeature(feature);
      v[bucket] += sign * w;
    };
    // Token features: identifier-split words (camel/snake aware), so
    // `leaseKeeper` contributes 'lease' + 'keeper' + the whole token.
    const tokens = tokenize(text);
    for (const t of tokens) add(`w:${t}`, TOKEN_WEIGHT);
    // Trigram features over the normalized text: sub-word overlap
    // ('locking' ~ 'locks', 'idempotent' ~ 'idempotency').
    const norm = ` ${normalizeForNgrams(text)} `;
    const seen = new Map<string, number>();
    for (let i = 0; i + 3 <= norm.length; i++) {
      const g = norm.slice(i, i + 3);
      seen.set(g, (seen.get(g) ?? 0) + 1);
    }
    for (const [g, c] of seen) add(`g:${g}`, TRIGRAM_WEIGHT * Math.min(c, 4));
    let norm2 = 0;
    for (let i = 0; i < v.length; i++) norm2 += v[i] * v[i];
    const inv = norm2 > 0 ? 1 / Math.sqrt(norm2) : 0;
    for (let i = 0; i < v.length; i++) v[i] *= inv;
    return v;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedSync(t));
  }
}

// ---------------------------------------------------------------------------
// Provider embedder (OpenAI-compatible /embeddings)
// ---------------------------------------------------------------------------

export interface ProviderEmbedderOptions {
  provider: Provider;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
  batchSize?: number;
}

const DEFAULT_PROVIDER_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'openai/text-embedding-3-small': 1536,
  'mistral-embed': 1024,
  'bge-m3': 1024,
};

export class ProviderEmbedder implements Embedder {
  readonly kind: EmbedderKind = 'provider';
  readonly id: string;
  dims: number;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;
  private readonly batchSize: number;

  constructor(opts: ProviderEmbedderOptions) {
    this.model = opts.model;
    this.id = `${opts.provider.id}:${opts.model}`;
    this.baseUrl = (opts.baseUrl ?? opts.provider.baseUrl).replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.batchSize = opts.batchSize ?? 64;
    // Declared dims are a pre-flight estimate; the first response corrects
    // it (see embed()). 0 = unknown until first call.
    this.dims = DEFAULT_PROVIDER_DIMS[opts.model] ?? 0;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = new Array(texts.length);
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      const res = await this.fetchFn(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: batch }),
      });
      if (!res.ok) {
        throw new Error(`embeddings request failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
      }
      const json = (await res.json()) as { data?: Array<{ index: number; embedding: number[] }> };
      const data = json.data ?? [];
      if (data.length !== batch.length) {
        throw new Error(`embeddings response length mismatch: got ${data.length}, sent ${batch.length}`);
      }
      for (const item of data) {
        const vec = Float32Array.from(item.embedding);
        // The response is ground truth for dims (the table is only a
        // pre-flight estimate; a provider returning a different width
        // must not leave callers planning around the wrong size).
        if (item.index === 0) this.dims = vec.length;
        out[start + item.index] = vec;
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Resolution — config → provider layer → embedder
// ---------------------------------------------------------------------------

export interface EmbedderResolution {
  embedder: Embedder;
  /** Why this embedder was chosen (surfaced in stats/tool output). */
  reason: string;
}

function resolveKey(provider: Provider, config?: MochiConfig): string | undefined {
  if (config?.model?.provider === provider.id && config.model.apiKey) return config.model.apiKey;
  try {
    const ring = loadKeyring();
    const key = storedKeyForProvider(ring, provider.id, config?.model?.provider ?? '', config?.model?.apiKey);
    if (key) return key;
  } catch { /* keyring unreadable — env may still carry the key */ }
  if (provider.envKey) {
    const env = process.env[provider.envKey];
    if (env) return env;
  }
  return undefined;
}

/**
 * Pick the embedder for this config. Provider embeddings are OPT-IN (W3-1
 * gate, default OFF until measured): they require an EXPLICIT retrieval
 * embedding config — retrieval.embeddingProvider / retrieval.embeddingModel,
 * or their env overrides MOCHI_EMBEDDING_PROVIDER / MOCHI_EMBEDDING_MODEL.
 * The configured CHAT provider is deliberately NOT reused implicitly: a user
 * whose chat provider happens to be embedding-capable never asked for
 * network embedding calls on every index build and query. Without explicit
 * config the local lexical fallback serves, with the reason recorded.
 * A provider embedder further requires ALL of: an 'openai'-kind provider
 * row, a resolvable API key (local providers with an empty envKey —
 * ollama/lmstudio — count as keyless-OK), and a known or explicitly
 * configured embedding model.
 */
export function resolveEmbedder(config?: MochiConfig): EmbedderResolution {
  const fallback = (reason: string): EmbedderResolution => ({
    embedder: new LocalFallbackEmbedder(),
    reason,
  });

  const retrieval = (config as MochiConfig | undefined)?.retrieval;
  const explicitModel = process.env.MOCHI_EMBEDDING_MODEL || retrieval?.embeddingModel;
  const providerId =
    process.env.MOCHI_EMBEDDING_PROVIDER || retrieval?.embeddingProvider || '';
  if (!providerId && !explicitModel) {
    return fallback(
      'provider embeddings OFF by default (opt in via retrieval.embeddingProvider/embeddingModel or MOCHI_EMBEDDING_PROVIDER/MOCHI_EMBEDDING_MODEL)',
    );
  }
  const provider = PROVIDERS.find((p) => p.id === providerId.toLowerCase());
  if (!provider) {
    return fallback(providerId
      ? `no provider '${providerId}' in the provider table`
      : 'embedding model configured without a provider (set retrieval.embeddingProvider)');
  }
  if (provider.kind !== 'openai') {
    return fallback(`provider '${provider.id}' is ${provider.kind}-kind; only OpenAI-compatible /embeddings is wired`);
  }
  const model = explicitModel || KNOWN_EMBEDDING_MODELS[provider.id];
  if (!model) {
    return fallback(`provider '${provider.id}' has no known embedding model and none is configured (set retrieval.embeddingModel)`);
  }
  const key = resolveKey(provider, config);
  const keylessLocal = provider.envKey === '' || /localhost|127\.0\.0\.1/.test(provider.baseUrl);
  if (!key && !keylessLocal) {
    return fallback(`no API key resolvable for provider '${provider.id}' (keyring/env ${provider.envKey})`);
  }
  const baseUrl =
    config?.model?.provider === provider.id && config.model.baseUrl ? config.model.baseUrl : provider.baseUrl;
  return {
    embedder: new ProviderEmbedder({ provider, model, apiKey: key, baseUrl }),
    reason: explicitModel
      ? `configured embedding model ${model} on provider ${provider.id}`
      : `known embedding model ${model} on configured provider ${provider.id}`,
  };
}

/** Content hash used for files and chunks (sha256 hex, truncated — collision
 *  risk at repo scale is negligible at 128 bits and ids stay readable). */
export function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}
