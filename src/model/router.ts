import type { ModelConfig, ModelProfile, StreamChunk, ModelResponse, ChatMessage, ToolDefinition } from '../types.js';
import { PROVIDERS } from './providers.js';
import { createOpenAIProvider, type ProviderConfig } from './openai.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createVertexProvider } from './vertex.js';
import { createAntigravityProvider } from './antigravity.js';
import { CapabilityRegistry, providerKey } from './capability.js';
// isAbort (local abort classification) lives in rate-limit.ts alongside the
// retry/backoff logic it complements; router reuses that single canonical
// implementation rather than redefining it.
import { isAbort } from './rate-limit.js';
import { ProviderError } from '../utils/http-error.js';
export type { ProviderConfig } from './openai.js';
// normalizeModelName lives in model-name.ts so config.ts (and every light
// command that loads config) does not drag the provider SDK graph in at
// startup; re-exported here for all existing importers.
import { normalizeModelName } from './model-name.js';
export { normalizeModelName };
// Local-first model tier (item 19): resolution, egress policy, connect-
// failure guidance and the offline egress guard live in local.ts.
import {
  isLocalTierProvider,
  isLocalTierPrimary,
  offlineMode,
  remoteFallbackAllowed,
  resolveLocalEndpoint,
  resolveLocalModel,
  withLocalConnectGuidance,
  withRemoteEgressBlock,
} from './local.js';

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


const ALIAS_KIND: Record<string, 'anthropic' | 'gemini' | 'vertex'> = {
  anthropic: 'anthropic',
  claude: 'anthropic',
  gemini: 'gemini',
  google: 'gemini',
  vertex: 'vertex',
  antigravity: 'gemini',
  'google-antigravity': 'gemini',
};

export function resolveProvider(config: ModelConfig): ProviderConfig {
  const name = config.provider.toLowerCase();
  const alias = ALIASES[name];
  // Local tier (item 19): endpoint/model come from model.local / MOCHI_LOCAL_*
  // with their own precedence chain — a generic `baseUrl` never overrides the
  // local-specific knobs (provider switching stamps it with the static
  // default, which would otherwise pin the endpoint).
  const isLocal = isLocalTierProvider(name);
  const baseUrl = isLocal
    ? resolveLocalEndpoint(config)
    : (config.baseUrl || alias?.baseUrl || 'https://api.openai.com/v1');
  const rawModel = isLocal
    ? resolveLocalModel(config)
    : (config.model || alias?.defaultModel || 'gpt-4o-mini');
  const model = normalizeModelName(rawModel, baseUrl);
  return { baseUrl, apiKey: config.apiKey, model, providerName: config.provider };
}

export function selectModel(config: ModelConfig, profile: ModelProfile): string {
  const rawModel = config.profiles?.[profile] ?? config.model;
  return normalizeModelName(rawModel, config.baseUrl || '');
}

export function createProvider(config: ModelConfig, profile?: ModelProfile) {
  // Local tier egress policy (item 19): when the LOCAL tier is the run's
  // primary in OFFLINE mode, every non-local chain entry is wrapped in an
  // egress guard that refuses the call BEFORE any fetch — even if a stale or
  // explicit failover entry is still present. Config-time stripping lives in
  // loadConfig; this is the router-level guarantee for direct SDK configs.
  const offlineLocal = isLocalTierPrimary(config) && offlineMode(config);
  const chain = [config, ...(config.failover ?? [])].map((c) => {
    // A failover entry may omit profiles; only inherit from primary if targeting the same provider.
    const merged: ModelConfig = c.profiles
      ? c
      : (c.provider === config.provider
        ? { ...c, profiles: config.profiles }
        : { ...c, profiles: undefined });
    const raw = createRawProvider(merged, profile);
    const gated = withCapabilityGate(raw, merged, resolveProvider(merged));
    if (offlineLocal && !raw.isLocal) {
      return withRemoteEgressBlock(gated, merged.provider, merged.baseUrl);
    }
    return gated;
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
        // Item 19: a local-tier primary falling through to a remote provider is
        // NEVER silent — task content is about to leave the machine. Emitted
        // only when the local entry ACTUALLY failed (a successful local run
        // must not warn about a fallback that never happened), and never for
        // an offline egress guard (that call is refused, not sent).
        if (chain[i].isLocal && chain[i + 1] && !chain[i + 1].isLocal && !chain[i + 1].egressBlocked) {
          console.warn(`[failover] LOCAL TIER: local endpoint failed before output; falling back to REMOTE provider "${chain[i + 1].providerId ?? 'unknown'}" — task content will be sent off-machine. Disable via model.local.offline / MOCHI_OFFLINE=1.`);
        }
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
        // Item 19: same rule for the non-streaming path — warn only when the
        // local entry actually failed, a remote entry is next, and that entry
        // is not an offline egress guard (refused ≠ sent).
        if (chain[i].isLocal && chain[i + 1] && !chain[i + 1].isLocal && !chain[i + 1].egressBlocked) {
          console.warn(`[failover] LOCAL TIER: local endpoint failed; falling back to REMOTE provider "${chain[i + 1].providerId ?? 'unknown'}" — task content will be sent off-machine. Disable via model.local.offline / MOCHI_OFFLINE=1.`);
        }
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
  let raw: RawProvider;
  if (name === 'antigravity' || name === 'google-antigravity') raw = createAntigravityProvider(resolved);
  else if (kind === 'anthropic' || name === 'anthropic') raw = createAnthropicProvider(resolved);
  else if (kind === 'gemini' || name === 'gemini' || name === 'google') raw = createGeminiProvider(resolved);
  else if (name === 'vertex' || kind === 'vertex') raw = createVertexProvider(resolved);
  else raw = createOpenAIProvider(resolved);
  // Item 19: local-tier routes get the connect-failure relabeling (fast,
  // visible, actionable dead-endpoint errors) and every entry carries routing
  // metadata so withFailover can make a local→remote fallthrough visible and
  // createProvider can apply the offline egress guard.
  const isLocal = isLocalTierProvider(name);
  const tagged: RawProvider = isLocal
    ? withLocalConnectGuidance(raw, resolved.baseUrl, remoteFallbackAllowed(config))
    : raw;
  tagged.providerId = name;
  tagged.isLocal = isLocal;
  return tagged;
}

function kindOf(id: string): 'openai' | 'anthropic' | 'gemini' | 'vertex' | undefined {
  const fromAlias = ALIAS_KIND[id];
  if (fromAlias) return fromAlias;
  return PROVIDERS.find((p) => p.id === id)?.kind;
}

export interface RawProvider {
  streamChat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal; reasoningEffort?: string }): AsyncGenerator<StreamChunk>;
  chat(messages: ChatMessage[], tools: ToolDefinition[], options?: { temperature?: number; maxTokens?: number; signal?: AbortSignal; reasoningEffort?: string }): Promise<ModelResponse>;
  /** Routing metadata (item 19): which provider id this entry routes to, and
   *  whether it is a local-tier route (on-machine model server). Set by
   *  createRawProvider; absent on hand-built providers (tests). */
  providerId?: string;
  isLocal?: boolean;
  /** Set by the offline egress guard: this entry refuses every call BEFORE
   *  any network activity. withFailover must not announce a remote fallback
   *  to it (the call never leaves the machine). */
  egressBlocked?: boolean;
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

  // Forward routing metadata (item 19): withFailover and the offline egress
  // guard key off these flags.
  return { streamChat, chat, providerId: provider.providerId, isLocal: provider.isLocal };
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
