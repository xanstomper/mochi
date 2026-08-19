import type { ModelConfig, ModelProfile, StreamChunk, ModelResponse, ChatMessage, ToolDefinition } from '../types.js';
import { PROVIDERS } from '../providers.js';
import { createOpenAIProvider, type ProviderConfig } from './openai.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { CapabilityRegistry, providerKey } from './capability.js';
export type { ProviderConfig } from './openai.js';

const ALIASES: Record<string, { baseUrl: string; defaultModel: string }> = {
  'opencode-zen': { baseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'opencode/deepseek-v4-flash-free' },
  'opencode': { baseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'opencode/deepseek-v4-flash-free' },
  'zen': { baseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'opencode/deepseek-v4-flash-free' },
  'opencode-go': { baseUrl: 'https://opencode.ai/go/v1', defaultModel: 'opencode-go/deepseek-v4-flash-free' },
  'go': { baseUrl: 'https://opencode.ai/go/v1', defaultModel: 'opencode-go/deepseek-v4-flash-free' },
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
    // A failover entry may omit profiles; inherit them from the primary.
    const merged: ModelConfig = c.profiles ? c : { ...c, profiles: config.profiles };
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
  async function* streamChat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number }): AsyncGenerator<StreamChunk> {
    let lastErr: unknown;
    for (let i = 0; i < chain.length; i++) {
      let began = false;
      try {
        for await (const chunk of chain[i].streamChat(messages, tools, options)) {
          began = true;
          yield chunk;
        }
        return;
      } catch (err) {
        lastErr = err;
        if (began) throw err; // mid-stream: never replay
      }
    }
    throw lastErr ?? new Error(`All ${chain.length} model providers (${primaryName}${chain.length > 1 ? ' + fallbacks' : ''}) failed.`);
  }

  async function chat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number }): Promise<ModelResponse> {
    let lastErr: unknown;
    for (let i = 0; i < chain.length; i++) {
      try {
        return await chain[i].chat(messages, tools, options);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`All model providers failed: ${String(lastErr)}`);
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
  streamChat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number }): AsyncGenerator<StreamChunk>;
  chat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number }): Promise<ModelResponse>;
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
  const key = providerKey(config.provider, resolved.baseUrl);
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
    if (st.status === 'cooldown') {
      throw new Error(`Provider ${config.provider} is cooling down after failures. Try again shortly. (${st.record?.lastError ?? ''})`);
    }
    return reg;
  };

  async function* streamChat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number }): AsyncGenerator<StreamChunk> {
    const reg = gate();
    try {
      for await (const chunk of provider.streamChat(messages, tools, options)) {
        yield chunk;
      }
      reg.record(key, { ok: true, check: 'chat' });
    } catch (err) {
      reg.record(key, { ok: false, error: err instanceof Error ? err.message : String(err), check: 'chat' });
      if (isPermanent(err)) reg.markDead(key, err instanceof Error ? err.message : String(err));
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
      reg.record(key, { ok: false, error: err instanceof Error ? err.message : String(err), check: 'chat' });
      if (isPermanent(err)) reg.markDead(key, err instanceof Error ? err.message : String(err));
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
