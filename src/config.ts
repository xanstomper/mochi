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

  // provider-specific API keys
  if (!cfg.model.apiKey) {
    const p = cfg.model.provider.toLowerCase();
    if (p.includes('opencode-zen')) cfg.model.apiKey = process.env.OPENCODE_ZEN_API_KEY;
    else if (p.includes('opencode-go')) cfg.model.apiKey = process.env.OPENCODE_GO_API_KEY;
    else if (p.includes('openai')) cfg.model.apiKey = process.env.OPENAI_API_KEY;
    else if (p.includes('anthropic')) cfg.model.apiKey = process.env.ANTHROPIC_API_KEY;
    else if (p.includes('gemini') || p.includes('google')) cfg.model.apiKey = process.env.GEMINI_API_KEY;
    else if (p.includes('deepseek')) cfg.model.apiKey = process.env.DEEPSEEK_API_KEY;
    else if (p.includes('openrouter')) cfg.model.apiKey = process.env.OPENROUTER_API_KEY;
    else if (p.includes('groq')) cfg.model.apiKey = process.env.GROQ_API_KEY;
    else if (p.includes('mistral')) cfg.model.apiKey = process.env.MISTRAL_API_KEY;
    else if (p.includes('xai') || p.includes('grok')) cfg.model.apiKey = process.env.XAI_API_KEY;
    else if (p.includes('freeinference')) cfg.model.apiKey = process.env.FREEINFERENCE_API_KEY || cfg.model.apiKey;
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
