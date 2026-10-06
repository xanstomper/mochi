import type { ModelConfig, ModelProfile, StreamChunk, ModelResponse, ChatMessage, ToolDefinition } from '../types.js';
import { PROVIDERS } from '../providers.js';
import { createOpenAIProvider, type ProviderConfig } from './openai.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { CapabilityRegistry, providerKey } from './capability.js';
// isAbort (local abort classification) lives in rate-limit.ts alongside the
// retry/backoff logic it complements; router reuses that single canonical
// implementation rather than redefining it.
import { isAbort } from './rate-limit.js';
export type { ProviderConfig } from './openai.js';

const ALIASES: Record<string, { baseUrl: string; defaultModel: string }> = {
  'opencode-zen': { baseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'deepseek-v4-flash' },
  'opencode': { baseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'deepseek-v4-flash' },
  'zen': { baseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'deepseek-v4-flash' },
  'opencode-go': { baseUrl: 'https://opencode.ai/go/v1', defaultModel: 'deepseek-v4-flash' },
  'go': { baseUrl: 'https://opencode.ai/go/v1', defaultModel: 'deepseek-v4-flash' },
  'freeinference': { baseUrl: 'https://freeinference.org/v1', defaultModel: 'kimi-k2.7-code' },
  'freeinference-org': { baseUrl: 'https://freeinference.org/v1', defaultModel: 'kimi-k2.7-code' },
};

// OpenCode.ai's OpenAI-compatible endpoints list and accept BARE model ids
// (e.g. `deepseek-v4-flash-free`), not the `opencode/…`-prefixed ids their docs
// historically used. The ALIASES above keep the prefix as a human-friendly
// default, but we strip it here at the request boundary for opencode.ai bases
// so the request actually succeeds. Other OpenAI-compatible providers are
// untouched because they often DO expect the prefixed id.
function opencodeBase(baseUrl: string): boolean {
  return /opencode\.ai\/(zen|go)/.test(baseUrl);
}

function resolveModelForBase(baseUrl: string, model: string): string {
  if (!opencodeBase(baseUrl)) return model;
  // Strip any `provider/`-style prefix; the endpoint wants just `deepseek-v4-…`.
  const stripped = model.replace(/^(?:opencode-go|opencode|zen|go)\//, '');
  return stripped || model;
}

const ALIAS_KIND: Record<string, 'anthropic' | 'gemini'> = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  gemini: 'gemini',
  google: 'gemini',
  vertex: 'gemini',
};

export function resolveProvider(config: ModelConfig): ProviderConfig {
  const name = config.provider.toLowerCase();
  const alias = ALIASES[name];
  const baseUrl = config.baseUrl || alias?.baseUrl || 'https://api.openai.com/v1';
  const model = resolveModelForBase(baseUrl, config.model || alias?.defaultModel || 'gpt-4o-mini');
  return { baseUrl, apiKey: config.apiKey, model, providerName: config.provider };
}

export function selectModel(config: ModelConfig, profile: ModelProfile): string {
  return resolveModelForBase(config.baseUrl || '', config.profiles?.[profile] ?? config.model);
}

export function createProvider(config: ModelConfig, profile?: ModelProfile) {
  const chain = [config, ...(config.failover ?? [])].map((c) => {
    // A failover entry may omit profiles; only inherit from primary if targeting the same provider.
    const merged: ModelConfig = c.profiles
      ? c
      : (c.provider === config.provider
        ? { ...c, profiles: config.profiles }
        : { ...c, profiles: undefined });
    const raw = createRawProvider(merged, profile);
    return withCapabilityGate(raw, merged, resolveProvider(merged));
  });
  if (chain.length === 1) return chain[0];
  return withFailover(chain, resolveProvider(config).providerName ?? config.provider);
}

/**
 * Try providers in order. `streamChat` only falls through when the current
 * provider errors BEFORE yielding any chunk (dead endpoint, auth failure,
 * request refused). Once output has started we rethrow: replaying partial
 * output onto another model would corrupt the tool-call stream. `chat` (the
 * non-streaming convenience) falls through on any error. Whichever error came
 * LAST among tried providers is thrown when the chain is exhausted, so the
 * caller sees the most useful failure.
 */
export function withFailover(chain: RawProvider[], primaryName: string): RawProvider {
  async function* streamChat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal }): AsyncGenerator<StreamChunk> {
    let lastErr: unknown;
    const errors: string[] = [];
    for (let i = 0; i < chain.length; i++) {
      options?.signal?.throwIfAborted();
      let began = false;
      try {
        for await (const chunk of chain[i].streamChat(messages, tools, options)) {
          began = true;
          yield chunk;
        }
        return;
      } catch (err) {
        options?.signal?.throwIfAborted();
        lastErr = err;
        errors.push(`[chain ${i}]: ${err instanceof Error ? err.message : String(err)}`);
        if (began) throw err; // mid-stream: never replay
      }
    }
    const combinedMsg = errors.length > 1
      ? `All ${chain.length} model providers (${primaryName} + fallbacks) failed:\n${errors.join('\n')}`
      : (lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'Unknown error'));
    const combinedErr = new Error(combinedMsg);
    (combinedErr as any).cause = lastErr;
    throw combinedErr;
  }

  async function chat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal }): Promise<ModelResponse> {
    let lastErr: unknown;
    const errors: string[] = [];
    for (let i = 0; i < chain.length; i++) {
      options?.signal?.throwIfAborted();
      try {
        return await chain[i].chat(messages, tools, options);
      } catch (err) {
        options?.signal?.throwIfAborted();
        lastErr = err;
        errors.push(`[chain ${i}]: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const combinedMsg = errors.length > 1
      ? `All ${chain.length} model providers (${primaryName} + fallbacks) failed:\n${errors.join('\n')}`
      : (lastErr instanceof Error ? lastErr.message : String(lastErr ?? 'Unknown error'));
    const combinedErr = new Error(combinedMsg);
    (combinedErr as any).cause = lastErr;
    throw combinedErr;
  }

  return { streamChat, chat };
}

function createRawProvider(config: ModelConfig, profile?: ModelProfile) {
  const name = config.provider.toLowerCase();
  const kind = kindOf(config.provider);
  const resolved = resolveProvider(config);
  if (profile && config.profiles?.[profile]) {
    resolved.model = resolveModelForBase(resolved.baseUrl, config.profiles[profile]);
  }
  if (kind === 'anthropic' || name === 'anthropic') return createAnthropicProvider(resolved);
  if (kind === 'gemini' || name === 'gemini' || name === 'google') return createGeminiProvider(resolved);
  return createOpenAIProvider(resolved);
}

function kindOf(id: string): 'openai' | 'anthropic' | 'gemini' | undefined {
  const fromAlias = ALIAS_KIND[id];
  if (fromAlias) return fromAlias;
  return PROVIDERS.find((p) => p.id === id)?.kind;
}

interface RawProvider {
  streamChat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal; reasoningEffort?: string }): AsyncGenerator<StreamChunk>;
  chat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal; reasoningEffort?: string }): Promise<ModelResponse>;
}

/**
 * Wrap a raw provider with a capability gate (see capability.ts). Before each
 * call we consult the registry for `provider@base`. A provider that is
 * mid-cooldown or marked dead is reported and SKIPPED fast instead of being
 * hammered (the exact failure Mochi hit with dead opencode endpoints). On a
 * permanent transport failure (ECONNREFUSED/ENOTFOUND) the provider is marked
 * dead; on success we record ok so a healthy provider is trusted immediately.
 *
 * Health is kept in-memory for the process by default (no disk pollution, tests
 * isolated). Set MOCHI_CAPABILITY_DIR to persist provider health across runs.
 */
function withCapabilityGate(provider: RawProvider, config: ModelConfig, resolved: ProviderConfig) {
  // Key health PER-MODEL (provider@base::model), not per-endpoint. One bad
  // model on a multi-model aggregator (glm-5.2 500ing while glm-5.3-flash is
  // fine) used to cool down the WHOLE endpoint and kill every task — the
  // dominant failure class in the Oct-2026 trace audit. With per-model keys a
  // failing model backs off alone and the router's next pick on the same
  // endpoint stays callable.
  const key = `${providerKey(config.provider, resolved.baseUrl)}::${resolved.model}`;
  const gate = function () {
    // Persistently remember provider health across runs ONLY when the dir is
    // explicit (MOCHI_CAPABILITY_DIR). Otherwise keep it in-memory for the
    // process so default runs and tests are never polluted by stale state.
    const dir = process.env.MOCHI_CAPABILITY_DIR;
    const reg = dir
      ? new CapabilityRegistry(dir, true)
      : (IN_MEMORY_REGISTRY ??= new CapabilityRegistry('', false));
    const st = reg.status(key);
    if (st.status === 'dead') {
      throw new Error(`Provider ${config.provider} is marked dead (${st.record?.lastError ?? 'previous terminal failure'}). Skipping; re-probe after cooldown.`);
    }
    if (st.status === 'cooldown' && (st.record?.consecutiveFailures ?? 0) >= 2) {
      const waitMs = st.record?.cooldownUntil ? Math.max(0, st.record.cooldownUntil - Date.now()) : undefined;
      const wait = waitMs !== undefined ? ` Try again in ~${(Math.round(waitMs / 100) / 10)}s.` : ' Try again shortly.';
      throw new Error(`Provider ${config.provider} is cooling down after failures.${wait} (${st.record?.lastError ?? ''})`);
    }
    return reg;
  };

  async function* streamChat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal }): AsyncGenerator<StreamChunk> {
    const reg = gate();
    try {
      for await (const chunk of provider.streamChat(messages, tools, options)) {
        yield chunk;
      }
      reg.record(key, { ok: true, check: 'chat' });
    } catch (err) {
      // A local abort (our own stall-guard watchdog tearing down a slow
      // free-tier stream, or the operator cancelling) is NOT a provider health
      // signal. Recording it as a failure (reg.record ok=false) escalates the
      // capability cooldown and can poison a provider that is merely SLOW right
      // now — the root cause of Mochi's recurring "Operation was aborted" +
      // growing-cooldown freezes. Skip the registry penalty for aborts; still
      // rethrow so the caller/withRetries can treat it as transient.
      if (!isAbort(err)) {
        reg.record(key, { ok: false, error: err instanceof Error ? err.message : String(err), check: 'chat' });
        if (isPermanent(err)) reg.markDead(key, err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
  }

  async function chat(messages: ChatMessage[], tools: ToolDefinition[], opts?: { temperature?: number; maxTokens?: number }) {
    const reg = gate();
    try {
      const result = await provider.chat(messages, tools, opts);
      reg.record(key, { ok: true, check: 'chat' });
      return result;
    } catch (err) {
      if (!isAbort(err)) {
        reg.record(key, { ok: false, error: err instanceof Error ? err.message : String(err), check: 'chat' });
        if (isPermanent(err)) reg.markDead(key, err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
  }

  return { streamChat, chat };
}

function isPermanent(err: unknown): boolean {
  if (err && typeof err === 'object' && 'cause' in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object' && 'code' in (cause as object)) {
      const code = (cause as { code?: string }).code;
      if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ENETUNREACH') return true;
    }
  }
  return false;
}

let IN_MEMORY_REGISTRY: CapabilityRegistry | undefined;
export function resetCapabilityRegistry() {
  IN_MEMORY_REGISTRY = undefined;
}
