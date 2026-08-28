import { homedir } from 'node:os';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MochiConfig } from './types.js';

export type ProviderKind = 'openai' | 'anthropic' | 'gemini';

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  envKey: string;
  models: string[];
  defaultModel: string;
  chatPath?: string;
}

export const PROVIDERS: Provider[] = [
  { id: 'opencode-zen', name: 'OpenCode Zen', kind: 'openai', baseUrl: 'https://opencode.ai/zen/v1', envKey: 'OPENCODE_ZEN_API_KEY', models: ['opencode/deepseek-v4-flash-free', 'opencode/deepseek-v4-flash', 'opencode/opencode-zen-3.5', 'opencode/gpt-5.4-nano'], defaultModel: 'opencode/deepseek-v4-flash-free' },
  { id: 'opencode-go', name: 'OpenCode Go', kind: 'openai', baseUrl: 'https://opencode.ai/go/v1', envKey: 'OPENCODE_GO_API_KEY', models: ['opencode-go/deepseek-v4-flash-free', 'opencode-go/deepseek-v4-flash'], defaultModel: 'opencode-go/deepseek-v4-flash-free' },
  { id: 'freeinference', name: 'FreeInference.org (Harvard SEAS)', kind: 'openai', baseUrl: 'https://freeinference.org/v1', envKey: 'FREEINFERENCE_API_KEY', models: ['glm-5.2', 'glm-5.3-flash', 'minimax-m3', 'kimi-k2.7-code', 'qwen3.6-35b', 'diffusiongemma', 'deepseek-v4-flash', 'bge-m3'], defaultModel: 'deepseek-v4-flash' },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-5', 'gpt-5-nano', 'o3', 'o4-mini'], defaultModel: 'gpt-4o' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', envKey: 'ANTHROPIC_API_KEY', models: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022', 'claude-opus-4-20250514'], defaultModel: 'claude-3-5-sonnet-20241022' },
  { id: 'gemini', name: 'Google Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', envKey: 'GEMINI_API_KEY', models: ['gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-2.0-flash-lite'], defaultModel: 'gemini-2.0-flash' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', envKey: 'DEEPSEEK_API_KEY', models: ['deepseek-chat', 'deepseek-reasoner'], defaultModel: 'deepseek-chat' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'google/gemini-2.0-flash'], defaultModel: 'anthropic/claude-3.5-sonnet' },
  { id: 'groq', name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], defaultModel: 'llama-3.3-70b-versatile' },
  { id: 'mistral', name: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', envKey: 'MISTRAL_API_KEY', models: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest'], defaultModel: 'mistral-large-latest' },
  { id: 'xai', name: 'xAI (Grok)', kind: 'openai', baseUrl: 'https://api.x.ai/v1', envKey: 'XAI_API_KEY', models: ['grok-4', 'grok-2-latest'], defaultModel: 'grok-4' },
  { id: 'together', name: 'Together AI', kind: 'openai', baseUrl: 'https://api.together.xyz/v1', envKey: 'TOGETHER_API_KEY', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'], defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo' },
  { id: 'fireworks', name: 'Fireworks', kind: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', envKey: 'FIREWORKS_API_KEY', models: ['accounts/fireworks/models/llama-v3p3-70b-instruct'], defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
  { id: 'cerebras', name: 'Cerebras', kind: 'openai', baseUrl: 'https://api.cerebras.ai/v1', envKey: 'CEREBRAS_API_KEY', models: ['llama3.1-8b', 'llama3.3-70b'], defaultModel: 'llama-3.3-70b' },
  { id: 'azure', name: 'Azure OpenAI', kind: 'openai', baseUrl: 'YOUR_AZURE_ENDPOINT/openai/deployments/YOUR_DEPLOYMENT', envKey: 'AZURE_OPENAI_API_KEY', models: ['gpt-4o'], defaultModel: 'gpt-4o' },
  { id: 'huggingface', name: 'Hugging Face', kind: 'openai', baseUrl: 'https://router.huggingface.co/v1', envKey: 'HF_TOKEN', models: ['meta-llama/Llama-3.3-70B-Instruct'], defaultModel: 'meta-llama/Llama-3.3-70B-Instruct' },
  { id: 'ollama', name: 'Ollama (local)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', envKey: '', models: ['llama3.1', 'qwen2.5-coder'], defaultModel: 'llama3.1' },
  { id: 'llamacpp', name: 'llama.cpp (local)', kind: 'openai', baseUrl: 'http://localhost:8080/v1', envKey: '', models: ['local-model'], defaultModel: 'local-model' },
  { id: 'perplexity', name: 'Perplexity', kind: 'openai', baseUrl: 'https://api.perplexity.ai', envKey: 'PERPLEXITY_API_KEY', models: ['sonar-pro'], defaultModel: 'sonar-pro' },
  { id: 'sambanova', name: 'SambaNova', kind: 'openai', baseUrl: 'https://api.sambanova.ai/v1', envKey: 'SAMBANOVA_API_KEY', models: ['Meta-Llama-3.3-70B-Instruct'], defaultModel: 'Meta-Llama-3.3-70B-Instruct' },
  { id: 'voyageai', name: 'SiliconFlow', kind: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', envKey: 'SILICONFLOW_API_KEY', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-Coder-32B-Instruct'], defaultModel: 'deepseek-ai/DeepSeek-V3' },
];

export const providerById = (id: string): Provider | undefined => PROVIDERS.find((p) => p.id === id);
export const providerByName = (name: string): Provider | undefined => PROVIDERS.find((p) => p.name.toLowerCase() === name.toLowerCase() || p.id === name.toLowerCase());

export function configFilePath(): string {
  const override = process.env.MOCHI_CONFIG_PATH;
  if (override) return override;
  return resolve(homedir(), '.config/mochi', 'config.json');
}

export function loadConfigFile(): MochiConfig {
  const path = configFilePath();
  if (!existsSync(path)) return {} as MochiConfig;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as MochiConfig;
  } catch {
    return {} as MochiConfig;
  }
}

export function saveConfigFile(cfg: MochiConfig): void {
  const path = configFilePath();
  const dir = resolve(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2));
}