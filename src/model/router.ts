import type { ModelConfig, ModelProfile } from '../types.js';
import { PROVIDERS } from '../providers.js';
import { createOpenAIProvider, type ProviderConfig } from './openai.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
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
  // Resolve aliates
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
