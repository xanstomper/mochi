import type { MochiConfig, ModelProfile, ModelConfig } from '../types.js';
import {PROVIDERS, providerById, loadConfigFile, saveConfigFile} from './providers.js';
import { setKeyringKey, setAccount } from './keyring.js';
// Light import (P2 speed): see model-name.ts — keeps the provider SDK graph
// out of config/model-manager loads.
import { normalizeModelName } from './model-name.js';

export interface ProviderSelection {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export function currentConfig(): MochiConfig {
  return loadConfigFile();
}

/** Conservative context budget (in tokens) for a model: the WORKING budget the
 *  harness may fill before it starts compacting. This is intentionally below the
 *  model's advertised hard window — the loop's compaction floor is a fraction of
 *  this, so the smaller the prior, the earlier (and safer) compaction fires.
 *  Under-estimating costs a little extra compaction; over-estimating means the
 *  provider hard-rejects mid-task and the run dies on a context cliff, so every
 *  value here rounds DOWN. Override per-host with `MOCHI_CONTEXT_WINDOW`. */
export function modelContextBudget(model: string, provider?: string): number {
  const override = Number(process.env.MOCHI_CONTEXT_WINDOW);
  if (Number.isFinite(override) && override >= 1000) return override;
  const m = (model || '').toLowerCase();
  const p = (provider || '').toLowerCase();
  // Provider-specific long-context classes first (Antigravity gateway:
  // claude-on-AGY 250k, gpt-oss 131k, AGY-native models 1M).
  if (p === 'antigravity' || p === 'google-antigravity') {
    if (m.includes('claude')) return 250_000;
    if (m.includes('gpt-oss')) return 131_072;
    return 1_048_576;
  }
  if (p === 'openai-codex' || m.includes('codex')) {
    if (m.includes('5.6') || m.includes('sol') || m.includes('astra')) return 1_000_000;
    return 272_000;
  }
  if (p === 'tokenjuice') return 262_144;
  // 1M-class long-context models.
  if (m.includes('gemini') || p.includes('gemini') || p.includes('google')) return 1_048_576;
  if (p.includes('freeinference') || m.includes('glm-5') || m.includes('deepseek-v4')) return 500_000;
  // 256k-class.
  if (m.includes('kimi') || m.includes('moonshot')) return 256_000;
  // 200k-class.
  if (m.includes('claude') || p.includes('anthropic')) return 200_000;
  // 128k-class (DeepSeek v3, GLM<5, Qwen, Mistral, Llama-3 long, Grok).
  if (
    m.includes('deepseek') || m.includes('glm') || m.includes('qwen') ||
    m.includes('minimax') || m.includes('mistral') || m.includes('codestral') ||
    m.includes('grok') || m.includes('llama-3') || m.includes('llama-4')
  ) {
    return 128_000;
  }
  // 400k-class.
  if (m.includes('gpt-4') || m.includes('gpt-5') || m.includes('o3') || m.includes('o4')) return 400_000;
  // Small local models.
  if (p === 'ollama' || p === 'llamacpp' || p === 'lmstudio' || m.includes('local') || m.includes('8b')) {
    return 32_000;
  }
  return 128_000;
}

/** Whether the model can accept image content parts (Wave H3). Name-based like
 *  modelContextBudget above, but CONSERVATIVE in the opposite direction: an
 *  unrecognized model is assumed text-only, because handing an image part to a
 *  text-only endpoint can hard-fail the whole request, while withholding one
 *  just degrades to the pre-H3 behavior (the model reads the image file
 *  itself). Used by the agent loop to decide whether a computer-tool
 *  screenshot is inlined into the tool result next to its file path. */
export function modelSupportsVision(model: string, provider?: string): boolean {
  const m = (model || '').toLowerCase();
  const p = (provider || '').toLowerCase();
  // Providers whose registered catalogs are vision-only model families.
  if (p.includes('anthropic') || p.includes('gemini') || p === 'google') return true;
  if (m.includes('claude') || m.includes('gemini')) return true;
  // OpenAI vision lines (gpt-4o / 4.1 / 5, o4; o3 yes, o3-mini is text-only).
  if (
    m.includes('gpt-4o') || m.includes('gpt-4.1') || m.includes('gpt-5') ||
    m.includes('gpt-4-vision') || m.includes('gpt-4-turbo') ||
    m.includes('o4') || (m.includes('o3') && !m.includes('o3-mini'))
  ) return true;
  // Explicit vision families from other vendors.
  if (
    (m.includes('qwen') && m.includes('vl')) ||
    m.includes('llava') || m.includes('pixtral') ||
    m.includes('llama-3.2-vision') || m.includes('llama-4') ||
    m.includes('glm-4v') || m.includes('cogvlm') ||
    m.includes('nova-pro') || m.includes('nova-lite') || m.includes('nova-2') ||
    m.includes('grok-4') || m.includes('grok-2-vision') || m.includes('grok-vision') ||
    m.includes('kimi-vl') || (m.includes('moonshot') && m.includes('vision'))
  ) return true;
  return false;
}

export function setProvider(config: MochiConfig, selection: ProviderSelection): MochiConfig {
  const cfg = { ...config };
  // Tolerate a missing/empty config file (fresh install): loadConfigFile()
  // returns {} as MochiConfig, so cfg.model is undefined — the old code read
  // `cfg.model.apiKey` while BUILDING the object literal and threw
  // "Cannot read properties of undefined", making `mochi login/use/model`
  // fatal before anything was saved.
  const base = cfg.model ?? ({} as MochiConfig['model']);
  const p = providerById(selection.provider);
  const envKey = p?.envKey ? process.env[p.envKey] : undefined;
  // Only inherit base.apiKey if switching models on the SAME provider;
  // never send Provider A's key to Provider B!
  const sameProvider = base.provider === selection.provider;
  const apiKey = selection.apiKey || (sameProvider ? base.apiKey : (envKey || undefined));
  const normModel = normalizeModelName(selection.model, selection.baseUrl);

  cfg.model = {
    ...base,
    provider: selection.provider,
    baseUrl: selection.baseUrl,
    model: normModel,
    apiKey,
  };
  if (!cfg.reasoning) {
    cfg.reasoning = 'medium';
  }
  cfg.safety = {
    ...(cfg.safety ?? {}),
    contextBudgetTokens: modelContextBudget(normModel, selection.provider),
  };
  if (p && (p.kind === 'openai' || p.kind === 'anthropic' || p.kind === 'gemini')) {
    cfg.model.profiles = cfg.model.profiles ?? ({} as Record<ModelProfile, string>);
    cfg.model.profiles.fast = normModel;
    cfg.model.profiles.coding = normModel;
    cfg.model.profiles.reasoning = normModel;
    cfg.model.profiles.review = normModel;
  }
  saveConfigFile(cfg);
  return cfg;
}

export function login(config: MochiConfig, providerId: string, apiKey: string, model?: string, source: 'api-key' | 'oauth' = 'api-key', account?: string): MochiConfig {
  const p = providerById(providerId);
  if (!p) throw new Error(`Unknown provider: ${providerId}`);
  // Own the key per provider (keyring): switching providers later must not
  // lose it, and logout/reset can clear any provider — not just the active
  // one. Account names allow multiple identities per provider (--account).
  // The single config slot below keeps working as before.
  try {
    if (account) setAccount(p.id, account, apiKey, source);
    else setKeyringKey(p.id, apiKey, source);
  } catch { /* keyring is best-effort; the config slot still lands */ }
  return setProvider(config, {
    provider: p.id,
    baseUrl: p.baseUrl,
    model: model || p.defaultModel,
    apiKey,
  });
}

export function selectProviderById(config: MochiConfig, providerId: string, model?: string): MochiConfig {
  const p = providerById(providerId);
  if (!p) throw new Error(`Unknown provider: ${providerId}`);
  return setProvider(config, {
    provider: p.id,
    baseUrl: p.baseUrl,
    model: model || p.defaultModel,
  });
}

export function listProviderIds(): string[] {
  return PROVIDERS.map((p) => p.id);
}

export function listModelsForProvider(providerId: string): string[] {
  const p = providerById(providerId);
  return p ? p.models : [];
}

export function describeConfig(config: MochiConfig): string {
  return [
    `provider: ${config.model.provider}`,
    `baseUrl: ${config.model.baseUrl}`,
    `model:   ${config.model.model}`,
    `apiKey:  ${config.model.apiKey ? 'set' : 'NOT SET'}`,
  ].join('\n');
}

export function maskApiKey(key: string): string {
  if (key.length <= 4) return '****';
  return key.slice(0, 4) + '…' + key.slice(-4);
}

export function addFallbackModel(config: MochiConfig, providerId: string, modelId?: string, apiKey?: string): MochiConfig {
  const p = providerById(providerId);
  if (!p) throw new Error(`Unknown provider: ${providerId}`);
  const m = modelId || p.defaultModel;
  const k = apiKey || (p.envKey ? process.env[p.envKey] : undefined);
  const cfg = { ...config };
  if (!cfg.model) cfg.model = {} as ModelConfig;
  const current = cfg.model.failover ? [...cfg.model.failover] : [];
  const existingIdx = current.findIndex((f) => f.provider.toLowerCase() === p.id.toLowerCase());
  const entry = {
    provider: p.id,
    baseUrl: p.baseUrl,
    model: m,
    apiKey: k,
  };
  if (existingIdx >= 0) {
    current[existingIdx] = entry;
  } else {
    current.push(entry);
  }
  cfg.model.failover = current;
  saveConfigFile(cfg);
  return cfg;
}

export function removeFallbackModel(config: MochiConfig, providerId: string): MochiConfig {
  const cfg = { ...config };
  if (!cfg.model?.failover) return cfg;
  cfg.model.failover = cfg.model.failover.filter((f) => f.provider.toLowerCase() !== providerId.toLowerCase());
  saveConfigFile(cfg);
  return cfg;
}

export function clearFallbackModels(config: MochiConfig): MochiConfig {
  const cfg = { ...config };
  if (cfg.model) {
    cfg.model.failover = [];
  }
  saveConfigFile(cfg);
  return cfg;
}