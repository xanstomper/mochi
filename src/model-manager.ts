import type { MochiConfig, ModelProfile } from './types.js';
import { PROVIDERS, providerById, loadConfigFile, saveConfigFile, configFilePath } from './providers.js';

export interface ProviderSelection {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export function currentConfig(): MochiConfig {
  return loadConfigFile();
}

export function setProvider(config: MochiConfig, selection: ProviderSelection): MochiConfig {
  const cfg = { ...config };
  cfg.model = {
    ...cfg.model,
    provider: selection.provider,
    baseUrl: selection.baseUrl,
    model: selection.model,
    apiKey: selection.apiKey || cfg.model.apiKey,
  };
  if (!cfg.reasoning) {
    cfg.reasoning = 'max';
  }
  const p = providerById(selection.provider);
  if (p && (p.kind === 'openai' || p.kind === 'anthropic' || p.kind === 'gemini')) {
    cfg.model.profiles = cfg.model.profiles ?? ({} as Record<ModelProfile, string>);
    cfg.model.profiles.fast = selection.model;
    cfg.model.profiles.coding = selection.model;
    cfg.model.profiles.reasoning = selection.model;
    cfg.model.profiles.review = selection.model;
  }
  saveConfigFile(cfg);
  return cfg;
}

export function login(config: MochiConfig, providerId: string, apiKey: string, model?: string): MochiConfig {
  const p = providerById(providerId);
  if (!p) throw new Error(`Unknown provider: ${providerId}`);
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