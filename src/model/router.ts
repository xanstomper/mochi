import type { ModelConfig, ModelProfile } from '../types.js';
import { PROVIDERS } from '../providers.js';
import { createOpenAIProvider, type ProviderConfig } from './openai.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createMockProvider } from './mock.js';
export type { ProviderConfig } from './openai.js';

const ALIASES: Record<string, { baseUrl: string; defaultModel: string }> = {
  'opencode-zen': { baseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'opencode/deepseek-v4-flash-free' },
  'opencode': { baseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'opencode/deepseek-v4-flash-free' },
  'zen': { baseUrl: 'https://opencode.ai/zen/v1', defaultModel: 'opencode/deepseek-v4-flash-free' },
  'opencode-go': { baseUrl: 'https://opencode.ai/go/v1', defaultModel: 'opencode-go/deepseek-v4-flash-free' },
  'go': { baseUrl: 'https://opencode.ai/go/v1', defaultModel: 'opencode-go/deepseek-v4-flash-free' },
};

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
  const model = config.model || alias?.defaultModel || 'gpt-4o-mini';
  return { baseUrl, apiKey: config.apiKey, model, providerName: config.provider };
}

export function selectModel(config: ModelConfig, profile: ModelProfile): string {
  return config.profiles?.[profile] ?? config.model;
}

export function createProvider(config: ModelConfig, profile?: ModelProfile) {
  // The mock provider exists ONLY for the test harness. A production/CLI config
  // can never reach it: it requires both `provider: 'mock'` AND an explicit
  // `mockResponses` fixture array (only ever present in unit tests). If someone
  // sets provider=mock through an env var or config file, they get a clear error
  // instead of a silent mock.
  const mockResponses = (config as unknown as Record<string, unknown>).mockResponses as any;
  if (config.provider === 'mock') {
    if (!Array.isArray(mockResponses)) {
      throw new Error('provider "mock" is test-only and requires an explicit mockResponses array; refusing to use it in production config paths.');
    }
    return createMockProvider(mockResponses ?? []);
  }
  // Resolve aliates
  const name = config.provider.toLowerCase();
  const kind = kindOf(config.provider);
  const resolved = resolveProvider(config);
  if (profile && config.profiles?.[profile]) {
    resolved.model = config.profiles[profile];
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
