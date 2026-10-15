import type { ModelConfig, ModelProfile, StreamChunk, ModelResponse, ChatMessage, ToolDefinition } from '../types.js';
import { PROVIDERS } from './providers.js';
import { createOpenAIProvider, type ProviderConfig } from './openai.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createAntigravityProvider } from './antigravity.js';
import { CapabilityRegistry, providerKey } from './capability.js';
// isAbort (local abort classification) lives in rate-limit.ts alongside the
// retry/backoff logic it complements; router reuses that single canonical
// implementation rather than redefining it.
import { isAbort } from './rate-limit.js';
import { ProviderError } from '../utils/http-error.js';
export type { ProviderConfig } from './openai.js';

const ALIASES: Record<string, { baseUrl: string; defaultModel: string }> = {
  'opencode-zen': { baseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'deepseek-v4-flash' },
  'opencode': { baseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'deepseek-v4-flash' },
  'zen': { baseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'deepseek-v4-flash' },
  'opencode-go': { baseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'deepseek-v4-flash' },
  'go': { baseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'deepseek-v4-flash' },
  'freeinference': { baseUrl: 'https://freeinference.org/v1', defaultModel: 'glm-5.3-flash' },
  'freeinference-org': { baseUrl: 'https://freeinference.org/v1', defaultModel: 'glm-5.3-flash' },
  'antigravity': { baseUrl: 'https://daily-cloudcode-pa.googleapis.com', defaultModel: 'gemini-3.8-flash' },
  'google-antigravity': { baseUrl: 'https://daily-cloudcode-pa.googleapis.com', defaultModel: 'gemini-3.8-flash' },
};

/**
 * Robust model name normalizer:
 * 1. Strips provider prefixes ('freeinference/', 'opencode/', 'opencode-go/', etc.)
 *    on direct OpenAI-compatible providers (non-OpenRouter).
 * 2. Normalizes spacing/punctuation (e.g. 'deep seek v4 flash' -> 'deepseek-v4-flash').
 * 3. Fixes common typos (e.g. 'flah' -> 'flash').
 * 4. Gracefully aliases non-existent or misnamed models (e.g. 'glm-5.4-flash' -> 'glm-5.3-flash').
 */
export function normalizeModelName(rawModel: string, baseUrl?: string): string {
  if (!rawModel) return rawModel;
  let m = rawModel.trim();

  // If baseUrl is OpenRouter, OpenRouter requires 'vendor/model' format (e.g. anthropic/claude-3.5-sonnet).
  // For all direct providers (FreeInference, OpenCode, DeepSeek, OpenAI, Groq, Mistral, Zhipu, etc.),
  // endpoints accept bare model IDs without vendor prefixes.
  // Aggregators that REQUIRE vendor prefixes (Novita's deepseek/…, Nebius'
  // Qwen/…, Together's meta-llama/…) are exempt from stripping: stripping
  // deepseek/deepseek-v4.1-flash to deepseek-v4.1-flash 404s on Novita.
  const isOpenRouter = Boolean(baseUrl && baseUrl.includes('openrouter.ai'));
  const needsVendorPrefix = Boolean(baseUrl && /openrouter\.ai|novita\.ai|nebius|together\.xyz|fireworks\.ai|deepinfra\.com|models\.github\.ai|kilo\.ai/i.test(baseUrl));
  if (!isOpenRouter && !needsVendorPrefix) {
    m = m.replace(/^(?:freeinference|freeinforge|opencode-go|opencode|zen|go|openai|deepseek|zhipu|zai|anthropic|google|gemini|antigravity)\//i, '');
  }

  // Normalize whitespace, multiple dashes, and casing
  const clean = m.toLowerCase().replace(/[\s_]+/g, '-');

  // Typo correction: 'flah' -> 'flash'
  const deflashed = clean.replace(/flah$/i, 'flash').replace(/flah(?=-)/i, 'flash');

  // GLM models: FreeInference and OpenCode provide glm-5.3-flash and glm-5.3.
  // Users frequently ask for 'glm 5.4 flash' / 'glm-5.4-flash' / 'glm 5.4' / 'glm-5.4'.
  // Map these gracefully to the real available flash tier: glm-5.3-flash.
  if (
    deflashed === 'glm-5.4-flash' ||
    deflashed === 'glm-5.4' ||
    deflashed === 'glm5.4-flash' ||
    deflashed === 'glm5.4' ||
    deflashed === 'glm-flash' ||
    deflashed === 'glm-5-flash'
  ) {
    return 'glm-5.3-flash';
  }
  if (deflashed === 'glm-5.3-flash' || deflashed === 'glm-5.3' || deflashed === 'glm-5') {
    return deflashed;
  }

  // DeepSeek models: deep seek v4 flash -> deepseek-v4-flash
  // Note: On OpenCode, deepseek-v4-flash-free is a distinct model ID; on FreeInference it must be deepseek-v4-flash.
  if (deflashed === 'deepseek-v4-flash-free' || deflashed === 'deep-seek-v4-flash-free') {
    if (baseUrl && baseUrl.includes('freeinference')) {
      return 'deepseek-v4-flash';
    }
    return 'deepseek-v4-flash-free';
  }
  if (
    deflashed === 'deepseek-v4-flash' ||
    deflashed === 'deep-seek-v4-flash' ||
    deflashed === 'deepseek-flash' ||
    deflashed === 'deep-seek-flash' ||
    deflashed === 'deepseek-v4' ||
    deflashed === 'deep-seek-v4'
  ) {
    return 'deepseek-v4-flash';
  }

  // GPT models
  if (deflashed === 'gpt-5.4-nano' || deflashed === 'gpt5.4-nano' || deflashed === 'gpt-5.4nano') {
    return 'gpt-5.4-nano';
  }
  if (deflashed === 'gpt-5.4' || deflashed === 'gpt5.4') {
    return 'gpt-5.4';
  }

  // Qwen models
  if (deflashed === 'qwen3.6-35b' || deflashed === 'qwen-3.6-35b' || deflashed === 'qwen-3.6' || deflashed === 'qwen3.6') {
    return 'qwen3.6-35b';
  }

  // MiniMax
  if (deflashed === 'minimax-m3' || deflashed === 'minimaxm3') {
    return 'MiniMax-M3';
  }

  return m;
}

const ALIAS_KIND: Record<string, 'anthropic' | 'gemini'> = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  gemini: 'gemini',
  google: 'gemini',
  vertex: 'gemini',
  antigravity: 'gemini',
  'google-antigravity': 'gemini',
};

export function resolveProvider(config: ModelConfig): ProviderConfig {
  const name = config.provider.toLowerCase();
  const alias = ALIASES[name];
  const baseUrl = config.baseUrl || alias?.baseUrl || 'https://api.openai.com/v1';
  const rawModel = config.model || alias?.defaultModel || 'gpt-4o-mini';
  const model = normalizeModelName(rawModel, baseUrl);
  return { baseUrl, apiKey: config.apiKey, model, providerName: config.provider };
}

export function selectModel(config: ModelConfig, profile: ModelProfile): string {
  const rawModel = config.profiles?.[profile] ?? config.model;
  return normalizeModelName(rawModel, config.baseUrl || '');
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
    (combinedErr as Error & { cause?: unknown }).cause = lastErr;
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
    (combinedErr as Error & { cause?: unknown }).cause = lastErr;
    throw combinedErr;
  }

  return { streamChat, chat };
}

function createRawProvider(config: ModelConfig, profile?: ModelProfile) {
  const name = config.provider.toLowerCase();
  const kind = kindOf(config.provider);
  const resolved = resolveProvider(config);
  if (profile && config.profiles?.[profile]) {
    resolved.model = normalizeModelName(config.profiles[profile], resolved.baseUrl);
  }
  if (name === 'antigravity' || name === 'google-antigravity') return createAntigravityProvider(resolved);
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
      const waitMs = st.record?.cooldownUntil ? Math.max(0, st.record.cooldownUntil - Date.now()) : 0;
      if (waitMs > 0) {
        const wait = ` Try again in ~${(Math.round(waitMs / 100) / 10)}s.`;
        throw new Error(`Provider ${config.provider} is cooling down after failures.${wait} (${st.record?.lastError ?? ''})`);
      }
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
        if (isPermanent(err)) {
          reg.markDead(key, err instanceof Error ? err.message : String(err));
        } else {
          reg.record(key, { ok: false, error: err instanceof Error ? err.message : String(err), check: 'chat' });
        }
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
        if (isPermanent(err)) {
          reg.markDead(key, err instanceof Error ? err.message : String(err));
        } else {
          reg.record(key, { ok: false, error: err instanceof Error ? err.message : String(err), check: 'chat' });
        }
      }
      throw err;
    }
  }

  return { streamChat, chat };
}

function isPermanent(err: unknown): boolean {
  if (err instanceof ProviderError) {
    if (err.status === 400 || err.status === 401 || err.status === 402 || err.status === 403 || err.status === 404) {
      return true;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/not found|404|insufficient.*funds|402|unauthorized|401|forbidden|403/i.test(msg)) {
    return true;
  }
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
