import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MochiConfig, ModelProfile } from './types.js';

const defaultConfig = (): MochiConfig => ({
  model: {
    provider: 'opencode-zen',
    baseUrl: 'https://opencode.ai/zen/v1',
    model: 'opencode/deepseek-v4-flash-free',
    profiles: {
      fast: 'opencode/deepseek-v4-flash-free',
      coding: 'opencode/deepseek-v4-flash-free',
      reasoning: 'opencode/deepseek-v4-flash-free',
      review: 'opencode/deepseek-v4-flash-free',
    },
  },
  safety: {
    mode: 'ask',
    commandTimeoutSeconds: 120,
    maxIterations: 8,
    maxRuntimeMinutes: 30,
    maxConcurrentAgents: 3,
    contextBudgetTokens: 32_000,
  },
  permissions: {
    read: true,
    write: true,
    shell: true,
    network: true,
    gitDestructive: false,
  },
  telemetry: false,
  projectDir: '.mochi',
  configDir: resolve(homedir(), '.config/mochi'),
  quiet: false,
  verbose: false,
  debug: false,
});

function readJsonFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function envModelConfig(): Partial<MochiConfig['model']> {
  const provider = process.env.MOCHI_PROVIDER;
  const baseUrl = process.env.MOCHI_BASE_URL;
  const apiKey = process.env.MOCHI_API_KEY;
  const model = process.env.MOCHI_MODEL;
  const profiles: Partial<Record<ModelProfile, string>> = {};
  for (const p of ['fast', 'coding', 'reasoning', 'review'] as ModelProfile[]) {
    const v = process.env[`MOCHI_MODEL_${p.toUpperCase()}`];
    if (v) profiles[p] = v;
  }
  return {
    ...(provider ? { provider } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    ...(Object.keys(profiles).length ? { profiles: profiles as Record<ModelProfile, string> } : {}),
  };
}

export function loadConfig(overrides: Partial<MochiConfig> = {}, configPath?: string): MochiConfig {
  const cfg = defaultConfig();
  const user = readJsonFile(configPath ?? resolve(cfg.configDir, 'config.json'));
  if (user) merge(cfg as unknown as Record<string, unknown>, user);

  function isPlaceholderKey(key: string | undefined): boolean {
    if (!key) return true;
    const k = key.trim().toLowerCase();
    return k.length < 6 ||
      k === 'hi' || k.startsWith('your') || k.startsWith('sk-your') ||
      k.includes('your-key') || k.includes('set me') || k.startsWith('<');
  }

 // provider-specific API keys: prefer the real env key, and only fall back to a
 // config-file key when it is not a placeholder (so `apiKey: "hi"` in
 // config.json does not silently override a real FREEINFERENCE_API_KEY).
const configuredKey = cfg.model.apiKey && !isPlaceholderKey(cfg.model.apiKey) ? cfg.model.apiKey : undefined;
const p = cfg.model.provider.toLowerCase();
const envKeyMap: Record<string, string> = {
  'opencode-zen': 'OPENCODE_ZEN_API_KEY',
  'opencode-go': 'OPENCODE_GO_API_KEY',
  'openai': 'OPENAI_API_KEY',
  'anthropic': 'ANTHROPIC_API_KEY',
  'gemini': 'GEMINI_API_KEY',
  'google': 'GEMINI_API_KEY',
  'deepseek': 'DEEPSEEK_API_KEY',
  'openrouter': 'OPENROUTER_API_KEY',
  'groq': 'GROQ_API_KEY',
  'mistral': 'MISTRAL_API_KEY',
  'freeinference': 'FREEINFERENCE_API_KEY',
  'xai': 'XAI_API_KEY',
};
const envKey = Object.entries(envKeyMap).find(([needle]) => p.includes(needle))?.[1];
if (envKey) {
  cfg.model.apiKey = process.env[envKey] || configuredKey;
}

  merge(cfg as unknown as Record<string, unknown>, { model: envModelConfig() });
  if (process.env.MOCHI_PROJECT_DIR) cfg.projectDir = process.env.MOCHI_PROJECT_DIR;
  if (process.env.MOCHI_CONFIG_DIR) cfg.configDir = process.env.MOCHI_CONFIG_DIR;
  if (process.env.MOCHI_TELEMETRY) cfg.telemetry = /^1|true|yes$/i.test(process.env.MOCHI_TELEMETRY);
  if (process.env.MOCHI_SAFETY) cfg.safety.mode = process.env.MOCHI_SAFETY as MochiConfig['safety']['mode'];
  if (process.env.MOCHI_PERMISSION_READ) cfg.permissions.read = /^1|true|yes$/i.test(process.env.MOCHI_PERMISSION_READ);
  if (process.env.MOCHI_PERMISSION_WRITE) cfg.permissions.write = /^1|true|yes$/i.test(process.env.MOCHI_PERMISSION_WRITE);
  if (process.env.MOCHI_PERMISSION_SHELL) cfg.permissions.shell = /^1|true|yes$/i.test(process.env.MOCHI_PERMISSION_SHELL);
  if (process.env.MOCHI_PERMISSION_NETWORK) cfg.permissions.network = /^1|true|yes$/i.test(process.env.MOCHI_PERMISSION_NETWORK);
  if (process.env.MOCHI_PERMISSION_GIT_DESTRUCTIVE) cfg.permissions.gitDestructive = /^1|true|yes$/i.test(process.env.MOCHI_PERMISSION_GIT_DESTRUCTIVE);
  if (process.env.MOCHI_QUIET) cfg.quiet = true;
  if (process.env.MOCHI_VERBOSE) cfg.verbose = true;
  if (process.env.MOCHI_DEBUG) cfg.debug = true;

  merge(cfg as unknown as Record<string, unknown>, overrides as Record<string, unknown>);
  return cfg;
}

function merge(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target[key];
    if (sv === undefined) continue;
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      merge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      target[key] = sv;
    }
  }
}

export function loadProjectConfig(projectDir: string): Partial<MochiConfig> {
  return readJsonFile(resolve(projectDir, 'config.json')) ?? {};
}
