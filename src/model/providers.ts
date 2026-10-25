import { homedir } from 'node:os';
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { MochiConfig } from '../types.js';
import { warnPlaintextKeysOnce } from '../config-plaintext-keys.js';

export type ProviderKind = 'openai' | 'anthropic' | 'gemini';

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  envKey: string;
  models: string[];
  defaultModel: string;
  contextWindow?: number;
  chatPath?: string;
  /** Key/OAuth console page (verified reachable — only filled where
   *  checked; the menu offers to open it. Absent = unknown, never guessed. */
  consoleUrl?: string;
  /** How to obtain a key (console URL, or CLI command for token-via-OAuth
   *  flows like `gh auth login`). Optional — only filled where verified;
   *  never a placeholder. Shown by `mochi auth status` and /login hints. */
  keyHelp?: string;
}

export const PROVIDERS: Provider[] = [
  { id: 'opencode-zen', name: 'OpenCode Zen', kind: 'openai', baseUrl: 'https://opencode.ai/zen/v1', envKey: 'OPENCODE_ZEN_API_KEY', models: ['deepseek-v4-flash-free', 'deepseek-v4-flash', 'glm-5.3-flash', 'glm-5.3', 'gpt-5.4-nano', 'gpt-5.4', 'kimi-k2.7-code', 'minimax-m2.7', 'qwen3.8-flash', 'claude-sonnet-4-6'], defaultModel: 'deepseek-v4-flash' },
  { id: 'opencode-go', name: 'OpenCode Go', kind: 'openai', baseUrl: 'https://opencode.ai/zen/v1', envKey: 'OPENCODE_GO_API_KEY', models: ['deepseek-v4-flash', 'glm-5.3-flash'], defaultModel: 'deepseek-v4-flash' },
  { id: 'freeinference', name: 'FreeInference.org (Harvard SEAS)', kind: 'openai', baseUrl: 'https://freeinference.org/v1', envKey: 'FREEINFERENCE_API_KEY', models: ['glm-5.3-flash', 'deepseek-v4-flash', 'glm-5.3', 'MiniMax-M3', 'qwen3.6-35b', 'diffusiongemma', 'bge-m3'], defaultModel: 'glm-5.3-flash' },
  { id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', envKey: 'OPENAI_API_KEY', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-5', 'gpt-5-nano', 'gpt-5.4', 'gpt-5.4-nano', 'o3', 'o4-mini'], defaultModel: 'gpt-5.4', consoleUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', envKey: 'ANTHROPIC_API_KEY', models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5', 'claude-sonnet-4-6'], defaultModel: 'claude-sonnet-4-5', consoleUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'gemini', name: 'Google Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', envKey: 'GEMINI_API_KEY', models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'], defaultModel: 'gemini-2.5-flash', consoleUrl: 'https://aistudio.google.com/apikey' },
  { id: 'antigravity', name: 'Google Antigravity', kind: 'gemini', baseUrl: 'https://daily-cloudcode-pa.googleapis.com', envKey: 'ANTIGRAVITY_API_KEY', models: ['gemini-3.8-flash', 'claude-sonnet-4-6', 'claude-opus-4-6', 'gemini-3.7-flash', 'claude-sonnet-4-5', 'claude-opus-4-5', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gpt-oss-120b', 'gemini-4-argon-disabled', 'tab_flash_lite_preview', 'tab_jump_flash_lite_preview'], defaultModel: 'gemini-3.8-flash', contextWindow: 1_048_576, consoleUrl: 'https://daily-cloudcode-pa.googleapis.com', keyHelp: 'Login via `mochi login antigravity` (OAuth browser flow) or ambient omp credentials.' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', envKey: 'DEEPSEEK_API_KEY', models: ['deepseek-chat', 'deepseek-reasoner'], defaultModel: 'deepseek-chat', consoleUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', envKey: 'OPENROUTER_API_KEY', models: ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'google/gemini-2.0-flash'], defaultModel: 'anthropic/claude-3.5-sonnet', consoleUrl: 'https://openrouter.ai/keys' },
  { id: 'groq', name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', envKey: 'GROQ_API_KEY', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'], defaultModel: 'llama-3.3-70b-versatile', consoleUrl: 'https://console.groq.com/keys' },
  { id: 'mistral', name: 'Mistral', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', envKey: 'MISTRAL_API_KEY', models: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest'], defaultModel: 'mistral-large-latest', consoleUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'xai', name: 'xAI (Grok)', kind: 'openai', baseUrl: 'https://api.x.ai/v1', envKey: 'XAI_API_KEY', models: ['grok-4', 'grok-2-latest'], defaultModel: 'grok-4', consoleUrl: 'https://console.x.ai' },
  { id: 'together', name: 'Together AI', kind: 'openai', baseUrl: 'https://api.together.xyz/v1', envKey: 'TOGETHER_API_KEY', models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-Coder-32B-Instruct-Turbo'], defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', consoleUrl: 'https://api.together.xyz/settings/api-keys' },
  { id: 'fireworks', name: 'Fireworks', kind: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', envKey: 'FIREWORKS_API_KEY', models: ['accounts/fireworks/models/llama-v3p3-70b-instruct'], defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct' },
  { id: 'cerebras', name: 'Cerebras', kind: 'openai', baseUrl: 'https://api.cerebras.ai/v1', envKey: 'CEREBRAS_API_KEY', models: ['llama-3.3-70b', 'llama3.1-8b'], defaultModel: 'llama-3.3-70b' },
  { id: 'azure', name: 'Azure OpenAI', kind: 'openai', baseUrl: 'YOUR_AZURE_ENDPOINT/openai/deployments/YOUR_DEPLOYMENT', envKey: 'AZURE_OPENAI_API_KEY', models: ['gpt-4o'], defaultModel: 'gpt-4o' },
  { id: 'huggingface', name: 'Hugging Face', kind: 'openai', baseUrl: 'https://router.huggingface.co/v1', envKey: 'HF_TOKEN', models: ['meta-llama/Llama-3.3-70B-Instruct'], defaultModel: 'meta-llama/Llama-3.3-70B-Instruct', consoleUrl: 'https://huggingface.co/settings/tokens' },
  { id: 'bedrock', name: 'AWS Bedrock', kind: 'openai', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', envKey: 'AWS_BEARER_TOKEN_BEDROCK', models: ['anthropic.claude-sonnet-4-5', 'amazon.nova-pro-v1', 'meta.llama3-3-70b-instruct'], defaultModel: 'anthropic.claude-sonnet-4-5' },
  { id: 'github-models', name: 'GitHub Models', kind: 'openai', baseUrl: 'https://models.github.ai/inference', envKey: 'GITHUB_TOKEN', models: ['openai/gpt-4.1', 'anthropic/claude-sonnet-4-5', 'mistral-ai/mistral-large'], defaultModel: 'openai/gpt-4.1', keyHelp: 'No manual key needed if you use the gh CLI: run `gh auth login` (device-flow OAuth handled by gh), then export GITHUB_TOKEN=$(gh auth token)', consoleUrl: 'https://github.com/settings/tokens' },
  { id: 'deepinfra', name: 'DeepInfra', kind: 'openai', baseUrl: 'https://api.deepinfra.com/v1/openai', envKey: 'DEEPINFRA_API_KEY', models: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-Coder-32B-Instruct'], defaultModel: 'meta-llama/Llama-3.3-70B-Instruct', consoleUrl: 'https://deepinfra.com/dash/api_keys' },
  { id: 'lmstudio', name: 'LM Studio (local)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', envKey: '', models: ['local-model'], defaultModel: 'local-model' },
  { id: 'cloudflare', name: 'Cloudflare Workers AI', kind: 'openai', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1', envKey: 'CLOUDFLARE_API_TOKEN', models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast'], defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  { id: 'ollama', name: 'Ollama (local)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', envKey: '', models: ['llama3.1', 'qwen2.5-coder'], defaultModel: 'llama3.1' },
  { id: 'llamacpp', name: 'llama.cpp (local)', kind: 'openai', baseUrl: 'http://localhost:8080/v1', envKey: '', models: ['local-model'], defaultModel: 'local-model' },
  { id: 'perplexity', name: 'Perplexity', kind: 'openai', baseUrl: 'https://api.perplexity.ai', envKey: 'PERPLEXITY_API_KEY', models: ['sonar-pro'], defaultModel: 'sonar-pro', consoleUrl: 'https://www.perplexity.ai/settings/api' },
  { id: 'sambanova', name: 'SambaNova', kind: 'openai', baseUrl: 'https://api.sambanova.ai/v1', envKey: 'SAMBANOVA_API_KEY', models: ['Meta-Llama-3.3-70B-Instruct'], defaultModel: 'Meta-Llama-3.3-70B-Instruct' },
  { id: 'siliconflow', name: 'SiliconFlow', kind: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', envKey: 'SILICONFLOW_API_KEY', models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-Coder-32B-Instruct'], defaultModel: 'deepseek-ai/DeepSeek-V3' },
  { id: 'moonshot', name: 'Moonshot AI (Kimi)', kind: 'openai', baseUrl: 'https://api.moonshot.ai/v1', envKey: 'MOONSHOT_API_KEY', models: ['kimi-k3', 'kimi-k2.6', 'kimi-k2.7-code'], defaultModel: 'kimi-k3', consoleUrl: 'https://platform.moonshot.ai/console/api-keys' },
  { id: 'minimax', name: 'MiniMax', kind: 'openai', baseUrl: 'https://api.minimax.io/v1', envKey: 'MINIMAX_API_KEY', models: ['MiniMax-M3', 'MiniMax-M3.1-Flash-Preview', 'MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1'], defaultModel: 'MiniMax-M3' },
  { id: 'zhipu', name: 'Zhipu BigModel (GLM)', kind: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', envKey: 'ZHIPUAI_API_KEY', models: ['glm-5.3', 'glm-4.5', 'glm-4.5-air'], defaultModel: 'glm-5.3', consoleUrl: 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys' },
  { id: 'zai', name: 'Z.AI (GLM, overseas)', kind: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', envKey: 'ZAI_API_KEY', models: ['glm-5.3', 'glm-4.5', 'glm-4.5-air'], defaultModel: 'glm-5.3' },
  { id: 'cohere', name: 'Cohere', kind: 'openai', baseUrl: 'https://api.cohere.ai/compatibility/v1', envKey: 'COHERE_API_KEY', models: ['command-a-plus-05-2026', 'command-a-03-2025', 'command-a-reasoning-08-2025'], defaultModel: 'command-a-plus-05-2026', consoleUrl: 'https://dashboard.cohere.com/api-keys' },
  { id: 'qwen', name: 'Alibaba Qwen (DashScope)', kind: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', envKey: 'DASHSCOPE_API_KEY', models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen2.5-coder-32b-instruct'], defaultModel: 'qwen-max', consoleUrl: 'https://bailian.console.aliyun.com/' },
  { id: 'upstage', name: 'Upstage (Solar)', kind: 'openai', baseUrl: 'https://api.upstage.ai/v1', envKey: 'UPSTAGE_API_KEY', models: ['solar-pro4', 'solar-mini'], defaultModel: 'solar-pro4', keyHelp: 'Get a key at https://console.upstage.ai (API Keys)', consoleUrl: 'https://console.upstage.ai/' },
  { id: 'nebius', name: 'Nebius AI Studio', kind: 'openai', baseUrl: 'https://api.studio.nebius.ai/v1', envKey: 'NEBIUS_API_KEY', models: ['meta-llama/Meta-Llama-3.3-70B-Instruct', 'Qwen/Qwen3-235B-A22B'], defaultModel: 'meta-llama/Meta-Llama-3.3-70B-Instruct', keyHelp: 'Get a key at https://studio.nebius.com (API keys)', consoleUrl: 'https://studio.nebius.com/' },
  { id: 'novita', name: 'Novita AI', kind: 'openai', baseUrl: 'https://api.novita.ai/openai/v1', envKey: 'NOVITA_API_KEY', models: ['deepseek/deepseek-v4.1-flash', 'meta-llama/llama-3.1-8b-instruct'], defaultModel: 'deepseek/deepseek-v4.1-flash', keyHelp: 'Get a key at https://novita.ai (API Keys)', consoleUrl: 'https://novita.ai/' },
  { id: 'ai21', name: 'AI21 Labs (Jamba)', kind: 'openai', baseUrl: 'https://api.ai21.com/studio/v1', envKey: 'AI21_API_KEY', models: ['jamba-large', 'jamba-mini'], defaultModel: 'jamba-large', keyHelp: 'Get a key at https://studio.ai21.com (API keys)', consoleUrl: 'https://studio.ai21.com/' },
  { id: 'tokenjuice', name: 'TokenJuice', kind: 'openai', baseUrl: 'https://api.tokenjuice.ai/v1', envKey: 'TOKENJUICE_API_KEY', models: ['deepseek-ai/DeepSeek-V4.1-Flash'], defaultModel: 'deepseek-ai/DeepSeek-V4.1-Flash', consoleUrl: 'https://api.tokenjuice.ai' },
  { id: 'openai-codex', name: 'OpenAI Codex (ChatGPT Plus/Pro)', kind: 'openai', baseUrl: 'https://chatgpt.com/backend-api', envKey: 'OPENAI_CODEX_OAUTH_TOKEN', models: ['gpt-5.5', 'gpt-5.6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.4', 'gpt-5.4-nano', 'gpt-5', 'o3', 'o4-mini'], defaultModel: 'gpt-5.5', consoleUrl: 'https://chatgpt.com' },
  { id: 'cline', name: 'ClinePass', kind: 'openai', baseUrl: 'https://api.cline.bot/api/v1', envKey: 'CLINE_API_KEY', models: ['kimi-k3', 'z-ai/glm-5.3-flash', 'claude-3-5-sonnet', 'deepseek-chat'], defaultModel: 'kimi-k3', consoleUrl: 'https://app.cline.bot' },
  { id: 'kilo', name: 'Kilo Code (Gateway)', kind: 'openai', baseUrl: 'https://api.kilo.ai/api/gateway', envKey: 'KILO_API_KEY', models: ['claude-sonnet-4-6', 'anthropic/claude-opus-5', 'openai/gpt-5.1-codex', 'deepseek/deepseek-r1'], defaultModel: 'claude-sonnet-4-6', consoleUrl: 'https://kilo.ai' },
  // ── Ecosystem breadth wave (2026-10) ───────────────────────────────────────
  { id: 'vyceai', name: 'Vyce AI (free gateway)', kind: 'openai', baseUrl: 'https://vyceai.com/v1', envKey: 'VYCEAI_API_KEY', models: ['deepseek-v4-flash', 'glm-5.3-flash', 'claude-sonnet-4-6', 'agnes'], defaultModel: 'deepseek-v4-flash', consoleUrl: 'https://vyceai.com' },
  { id: 'pollinations', name: 'Pollinations (keyless)', kind: 'openai', baseUrl: 'https://text.pollinations.ai/openai/v1', envKey: '', models: ['openai', 'openai-fast', 'mistral'], defaultModel: 'openai', keyHelp: 'No API key required — keyless free tier. Optional: referrer param for higher limits.' },
  { id: 'chutes', name: 'Chutes (free tier)', kind: 'openai', baseUrl: 'https://api.chutes.ai/app/v1', envKey: 'CHUTES_API_KEY', models: ['deepseek-ai/DeepSeek-V3', 'zai-org/GLM-4.5-Air', 'Qwen/Qwen3-Coder-30B-A3B-Instruct'], defaultModel: 'zai-org/GLM-4.5-Air', consoleUrl: 'https://chutes.ai' },
  { id: 'wenxin', name: 'Baidu Wenxin (ERNIE)', kind: 'openai', baseUrl: 'https://qianfan.baidubce.com/v2', envKey: 'WENXIN_API_KEY', models: ['ernie-4.5-turbo-128k', 'ernie-speed-128k'], defaultModel: 'ernie-4.5-turbo-128k', consoleUrl: 'https://console.bce.baidu.com/iam/#/iam/apikey/list' },
];

export const providerById = (id: string): Provider | undefined => {
  const norm = id.toLowerCase();
  if (norm === 'google-antigravity') return PROVIDERS.find((p) => p.id === 'antigravity');
  if (norm === 'cline-pass') return PROVIDERS.find((p) => p.id === 'cline');
  if (norm === 'codex') return PROVIDERS.find((p) => p.id === 'openai-codex');
  return PROVIDERS.find((p) => p.id === norm);
};
export const providerByName = (name: string): Provider | undefined => {
  const norm = name.toLowerCase();
  if (norm === 'google-antigravity') return PROVIDERS.find((p) => p.id === 'antigravity');
  if (norm === 'cline-pass') return PROVIDERS.find((p) => p.id === 'cline');
  if (norm === 'codex') return PROVIDERS.find((p) => p.id === 'openai-codex');
  return PROVIDERS.find((p) => p.name.toLowerCase() === norm || p.id === norm);
};

export function configFilePath(): string {
  const override = process.env.MOCHI_CONFIG_PATH;
  if (override) return override;
  return resolve(homedir(), '.config/mochi', 'config.json');
}

export function loadConfigFile(): MochiConfig {
  const path = configFilePath();
  if (!existsSync(path)) return {} as MochiConfig;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as MochiConfig;
    // P3 gun 3 (config-side only): warn once per process when this file
    // carries raw key material — field paths only, never values. The keyring
    // path is the sibling auth.json (mirrors keyringPath() without importing
    // it: keyring.ts already imports configFilePath from this module).
    warnPlaintextKeysOnce(parsed, path, resolve(dirname(path), 'auth.json'));
    return parsed;
  } catch {
    return {} as MochiConfig;
  }
}

export function saveConfigFile(cfg: MochiConfig): void {
  const path = configFilePath();
  const dir = resolve(path, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, path);
}