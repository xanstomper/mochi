import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MochiConfig, ModelProfile } from './types.js';
import { PROVIDERS } from './model/providers.js';
import { normalizeModelName } from './model/router.js';

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
    // Long-run defaults: hours-long tasks are the norm (user mandate).
    // 80 iterations ≈ a full multi-feature session; 240 min ≈ one working
    // session. Runtime guards + compaction make both ceilings safe, and the
    // validation range (1-100 / 0.5-720) already admits them.
    maxIterations: 80,
    maxRuntimeMinutes: 240,
    maxConcurrentAgents: 3,
    maxConcurrentSubagents: 4,
    maxSubagentDepth: 2,
    contextBudgetTokens: 400_000,
  },
  permissions: {
    read: true,
    write: true,
    shell: true,
    network: true,
    gitDestructive: true,
    admin: true,
  },
  telemetry: false,
  // Balanced default: "max" over-specifies heavy compute for the free/low-tier
  // flash models (making them slow/stall/thin on trivial work). medium keeps
  // correctness while responding fast; users can raise via MOCHI_REASONING or
  // the /reasoning menu.
  reasoning: 'medium',
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

export function loadEnvFiles(): void {
  const envPaths = [
    resolve(process.cwd(), '.env'),
    resolve(homedir(), '.mochi', '.env'),
    resolve(homedir(), '.hermes', '.env'),
  ];
  for (const p of envPaths) {
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key] && val) {
          process.env[key] = val;
        }
      }
    } catch {
      /* best-effort */
    }
  }
}

export function loadConfig(overrides: Partial<MochiConfig> = {}, configPath?: string, projectCwd?: string): MochiConfig {
  if (!process.env.VITEST && !process.env.MOCHI_SKIP_DOTENV) {
    loadEnvFiles();
  }
  const cfg = defaultConfig();
  // B21: MOCHI_CONFIG_DIR must be in effect BEFORE the user config read
  // below — the old assignment sat after the merge, so the env var relocated
  // the reported configDir while the actual read still used the default
  // ~/.config/mochi and configs written into MOCHI_CONFIG_DIR were silently
  // ignored. The later assignment stays: it keeps the env var winning when
  // the user config file itself carries a configDir key.
  if (process.env.MOCHI_CONFIG_DIR) cfg.configDir = process.env.MOCHI_CONFIG_DIR;
  const user = readJsonFile(configPath ?? process.env.MOCHI_CONFIG_PATH ?? resolve(cfg.configDir, 'config.json'));
  if (user) merge(cfg as unknown as Record<string, unknown>, user);

  // Project-level configurations (mochi.json, .mochi/config.json, .mcp.json).
  // B26: resolve against the RUNTIME'S directory, not blindly process.cwd() —
  // SDK consumers (Mochi.create({cwd})), the daemon and embedded embeddings
  // target a project whose mochi.json/.mcp.json was silently ignored when the
  // process cwd differed. Priority: explicit projectCwd param (Runtime passes
  // its resolved cwd), else MOCHI_PROJECT_DIR when absolute, else the process
  // cwd (plain CLI/TUI behavior unchanged).
  const cwd = projectCwd
    ?? (process.env.MOCHI_PROJECT_DIR && resolve(process.env.MOCHI_PROJECT_DIR) === process.env.MOCHI_PROJECT_DIR
        ? process.env.MOCHI_PROJECT_DIR
        : process.cwd());
  // B26: MOCHI_PROJECT_DIR is ALSO the workspace-dir override (line ~258), so
  // it relocates the project-config reads too — not just cfg.projectDir.
  const projectFragments = loadProjectConfigFragments(cwd);
  if (Object.keys(projectFragments).length) {
    // mcpServers keep the pre-restructure WHOLESALE per-server semantics: a
    // project file (.mcp.json / .cursor / .vscode) that declares a server
    // name owns that server's ENTIRE definition. The generic per-leaf deep
    // merge would otherwise leak the user-level server's leftover fields
    // (args/env) into the project's replacement entry.
    const { mcpServers: projectMcp, ...projectRest } = projectFragments as Partial<MochiConfig> & {
      mcpServers?: NonNullable<MochiConfig['mcpServers']>;
    };
    merge(cfg as unknown as Record<string, unknown>, projectRest as Record<string, unknown>);
    if (projectMcp && Object.keys(projectMcp).length > 0) {
      cfg.mcpServers = { ...(cfg.mcpServers ?? {}), ...projectMcp };
    }
  }

  // Provider switch consistency: when the user config selects a provider but
  // carries no baseUrl of its own, the defaultConfig()'s opencode-zen baseUrl
  // (and its opencode/* model IDs) would silently survive the merge — sending
  // requests to opencode.ai with the OTHER provider's API key. Every request
  // 401s and the agent burns its retry/failover budget before failing with 0
  // tokens (measured: ~50-100s stall per task = "mochi got slower than jcode").
  // Derive baseUrl/model/profiles from the PROVIDERS table for the chosen
  // provider whenever the merged config doesn't explicitly set them.
  if (cfg.model.provider) {
    const prov = PROVIDERS.find((pr) => pr.id === cfg.model.provider.toLowerCase());
    const userModel = (user as { model?: { baseUrl?: string; model?: string; profiles?: Record<string, string> } } | undefined)?.model;
    const envMc = envModelConfig();
    // B26: the project mochi.json's model counts as "explicitly set" here —
    // without this, the derivation below overwrote a project-selected model
    // (project file merges BEFORE this block, but userModel only inspects the
    // USER config file).
    const projectModel = projectFragments.model;
    if (prov && cfg.model.baseUrl && !userModel?.baseUrl && !envMc.baseUrl && !projectModel?.baseUrl) {
      cfg.model.baseUrl = prov.baseUrl;
      if (!userModel?.model && !projectModel?.model) cfg.model.model = prov.defaultModel;
      const ownedProfiles = userModel?.profiles ?? cfg.model.profiles;
      if (!ownedProfiles || Object.values(ownedProfiles).every((m) => typeof m === 'string' && m.includes('/'))) {
        cfg.model.profiles = {
          fast: prov.defaultModel,
          coding: prov.defaultModel,
          reasoning: prov.defaultModel,
          review: prov.defaultModel,
        };
      }
    }
  }

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
  'freeinforge': 'FREEINFORGE_API_KEY',
  'vyceai': 'VYCEAI_API_KEY',
  'xai': 'XAI_API_KEY',
};
const envKey = Object.entries(envKeyMap).find(([needle]) => p.includes(needle))?.[1];
if (envKey) {
  cfg.model.apiKey = process.env[envKey] || configuredKey;
}

// Cross-provider failover (auto): the single biggest observed failure class
// (150 of 159 failed traces, Oct 2026) was "Provider X is cooling down after
// failures" — the in-loop failover only swapped model IDs on the SAME
// provider, so a provider-wide cooldown killed every task. The router
// (createProvider -> withFailover) already falls through a `config.failover`
// chain when the primary errors before producing output; the missing piece
// was that nothing ever POPULATED the chain. Build it automatically from
// OTHER registered providers whose API key is present in the environment.
// Locals (ollama/llamacpp, no envKey) and providers without keys never enter
// the chain. Explicit user config always wins: if config.model.failover is
// already set, leave it untouched.
if (!cfg.model.failover || cfg.model.failover.length === 0) {
  const primary = cfg.model.provider.toLowerCase();
  const keyFor = (providerId: string): string | undefined => {
    const probe = envKeyMap[providerId];
    if (!probe) return undefined;
    const v = process.env[probe];
    if (!v || isPlaceholderKey(v)) return undefined;
    return v;
  };
  const failover: NonNullable<MochiConfig['model']['failover']> = [];
  for (const prov of PROVIDERS) {
    if (prov.id === primary) continue;
    if (primary.includes(prov.id) || prov.id.includes(primary)) continue; // same-provider aliases
    const key = keyFor(prov.id);
    if (!key) continue;
    failover.push({
      provider: prov.id,
      baseUrl: prov.baseUrl,
      apiKey: key,
      model: prov.defaultModel,
    });
  }
  if (failover.length) {
    cfg.model.failover = failover;
  }
}

  merge(cfg as unknown as Record<string, unknown>, { model: envModelConfig() });
  // Measured routing may only override a DEFAULT model choice. If any layer
  // set the model explicitly — SDK overrides, user config, project config, or
  // MOCHI_MODEL — the user has pinned it and routing must defer.
  const userModel = (user as { model?: { model?: unknown } } | undefined)?.model;
  const projectModel = (projectFragments as { model?: { model?: unknown } } | undefined)?.model;
  cfg.model.modelPinned = [
    overrides.model?.model,
    userModel?.model,
    projectModel?.model,
    process.env.MOCHI_MODEL,
  ].some((m) => typeof m === 'string' && m.trim() !== '');
  if (process.env.MOCHI_PROJECT_DIR) cfg.projectDir = process.env.MOCHI_PROJECT_DIR;
  if (process.env.MOCHI_CONFIG_DIR) cfg.configDir = process.env.MOCHI_CONFIG_DIR;
  if (process.env.MOCHI_UNCENSORED === '1') {
    cfg.safety.mode = 'uncensored';
    cfg.permissions = {
      read: true,
      write: true,
      shell: true,
      network: true,
      gitDestructive: true,
      admin: true,
    };
  }
  if (process.env.MOCHI_SAFETY) {
    const raw = process.env.MOCHI_SAFETY.trim().toLowerCase();
    if (raw === 'safe' || raw === 'ask' || raw === 'auto' || raw === 'uncensored') {
      cfg.safety.mode = raw as MochiConfig['safety']['mode'];
    } else if (!process.env.VITEST) {
      console.error(`Unknown MOCHI_SAFETY "${process.env.MOCHI_SAFETY}" — must be safe|ask|auto|uncensored. Keeping "${cfg.safety.mode}".`);
    }
  }
  if (process.env.MOCHI_SANDBOX === 'off' || process.env.MOCHI_SANDBOX === 'auto' || process.env.MOCHI_SANDBOX === 'bubblewrap') {
    cfg.safety.sandbox = process.env.MOCHI_SANDBOX;
  } else if (process.env.MOCHI_SANDBOX !== undefined && !process.env.VITEST) {
    console.error(`Unknown MOCHI_SANDBOX "${process.env.MOCHI_SANDBOX}" — must be off|auto|bubblewrap. Ignoring.`);
  }
  if (process.env.MOCHI_PERMISSION_READ) cfg.permissions.read = /^(1|true|yes)$/i.test(process.env.MOCHI_PERMISSION_READ.trim());
  if (process.env.MOCHI_PERMISSION_WRITE) cfg.permissions.write = /^(1|true|yes)$/i.test(process.env.MOCHI_PERMISSION_WRITE.trim());
  if (process.env.MOCHI_PERMISSION_SHELL) cfg.permissions.shell = /^(1|true|yes)$/i.test(process.env.MOCHI_PERMISSION_SHELL.trim());
  if (process.env.MOCHI_PERMISSION_NETWORK) cfg.permissions.network = /^(1|true|yes)$/i.test(process.env.MOCHI_PERMISSION_NETWORK.trim());
  if (process.env.MOCHI_PERMISSION_GIT_DESTRUCTIVE) cfg.permissions.gitDestructive = /^(1|true|yes)$/i.test(process.env.MOCHI_PERMISSION_GIT_DESTRUCTIVE.trim());
  if (process.env.MOCHI_PERMISSION_ADMIN) cfg.permissions.admin = /^(1|true|yes)$/i.test(process.env.MOCHI_PERMISSION_ADMIN.trim());
  if (process.env.MOCHI_PERMISSION_COMPUTER) cfg.permissions.computer = /^(1|true|yes)$/i.test(process.env.MOCHI_PERMISSION_COMPUTER.trim());
  // Per-session opt-in for desktop control (computer tool): MOCHI_COMPUTER=1
  // is the explicit session grant for the "computer" permission tier. It is
  // deliberately NOT set by MOCHI_UNCENSORED or the uncensored defaults
  // above — desktop control always needs its own opt-in.
  if (process.env.MOCHI_COMPUTER === '1') cfg.permissions.computer = true;
  if (process.env.MOCHI_SKILLS_PROBATION !== undefined) {
    // Kill-switch for the evidence-based skill lifecycle: =0/false/no births
    // authored skills active (legacy behavior); anything else keeps it on.
    cfg.skills = { ...(cfg.skills ?? {}), probation: !/^(0|false|no)$/i.test(process.env.MOCHI_SKILLS_PROBATION.trim()) };
  }
  if (process.env.MOCHI_MEMORY_INJECTION_CHARS) {
    const n = Number.parseInt(process.env.MOCHI_MEMORY_INJECTION_CHARS.trim(), 10);
    if (Number.isFinite(n) && n > 0) (cfg.memory ??= {}).injectionChars = n;
  }
  if (cfg.safety.mode === 'uncensored') {
    cfg.permissions.read = true;
    cfg.permissions.write = true;
    cfg.permissions.shell = true;
    cfg.permissions.network = true;
    cfg.permissions.gitDestructive = true;
    cfg.permissions.admin = true;
  }
  if (process.env.MOCHI_QUIET) cfg.quiet = true;
  if (process.env.MOCHI_VERBOSE) cfg.verbose = true;
  if (process.env.MOCHI_DEBUG) cfg.debug = true;
  if (process.env.MOCHI_REASONING) {
    const raw = process.env.MOCHI_REASONING.trim().toLowerCase();
    const known = ['max', 'extreme', 'deep', 'high', 'hard', 'low', 'easy', 'medium', 'off', 'auto'];
    const mapped = raw === 'max' || raw === 'extreme' || raw === 'deep' ? 'max'
      : raw === 'high' || raw === 'hard' ? 'high'
      : raw === 'low' || raw === 'easy' ? 'low'
      : raw === 'off' ? 'off'
      : raw === 'auto' ? 'auto'
      : 'medium';
    if (!known.includes(raw) && !process.env.VITEST) {
      console.error(`Unknown MOCHI_REASONING "${process.env.MOCHI_REASONING}" — using medium.`);
    }
    cfg.reasoning = mapped as MochiConfig['reasoning'];
  }

  merge(cfg as unknown as Record<string, unknown>, overrides as Record<string, unknown>);

  // Normalize model names across primary model, profiles, and failover targets
  if (cfg.model) {
    if (cfg.model.model) {
      cfg.model.model = normalizeModelName(cfg.model.model, cfg.model.baseUrl);
    }
    if (cfg.model.profiles) {
      for (const k of Object.keys(cfg.model.profiles) as ModelProfile[]) {
        if (cfg.model.profiles[k]) {
          cfg.model.profiles[k] = normalizeModelName(cfg.model.profiles[k], cfg.model.baseUrl);
        }
      }
    }
    if (Array.isArray(cfg.model.failover)) {
      for (const fo of cfg.model.failover) {
        if (fo.model) {
          fo.model = normalizeModelName(fo.model, fo.baseUrl);
        }
      }
    }
  }

  return cfg;
}

function merge(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const key of Object.keys(source)) {
    // Skip prototype-pollution hazards from untrusted config files.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
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

/** B26 restructure (review fix): merge `later` config fragments INTO `base`
 *  with the SAME precedence loadConfig itself applies — deep per-leaf merge
 *  EXCEPT mcpServers, where a server-name collision REPLACES the whole entry
 *  (the pre-restructure semantics: whoever declares a server name owns its
 *  entire definition). Used by the CLI worktree path so flag overrides keep
 *  beating launch-project fragments per LEAF, never wholesale. */
export function mergeConfigFragments(
  base: Record<string, unknown>,
  later: Partial<MochiConfig>,
): Record<string, unknown> {
  const mergedMcp = { ...((base.mcpServers ?? {}) as NonNullable<MochiConfig['mcpServers']>), ...(later.mcpServers ?? {}) };
  const laterNoMcp = { ...later };
  delete (laterNoMcp as Record<string, unknown>).mcpServers;
  merge(base, laterNoMcp as Record<string, unknown>);
  if (Object.keys(mergedMcp).length) {
    base.mcpServers = mergedMcp as NonNullable<MochiConfig['mcpServers']>;
  }
  return base;
}

export function loadProjectConfig(projectDir: string): Partial<MochiConfig> {
  return readJsonFile(resolve(projectDir, 'config.json')) ?? {};
}

/** Read a directory's project config fragments WITHOUT the user/env/override
 *  layers: mochi.json (preferred) or .mochi/config.json, plus the MCP shapes
 *  other agents author (.mcp.json Claude Code, .cursor/mcp.json Cursor,
 *  .vscode/mcp.json VS Code). Later MCP files win on a name collision.
 *
 *  loadConfig uses this for its project layer. The CLI --worktree path ALSO
 *  uses it (B26 restructure): a worktree session runs in the worktree copy,
 *  so the LAUNCH project's fragments are carried across explicitly through
 *  the overrides channel — restoring "worktree execution, launch-project
 *  config" as visible intent instead of a process.cwd() accident, while the
 *  resolution invariant (project files load from the directory actually being
 *  targeted) stays intact. The carry goes through mergeConfigFragments (per-
 *  leaf deep merge, flags still winning per leaf; mcpServers wholesale). */
export function loadProjectConfigFragments(dir: string): Partial<MochiConfig> {
  const out: Partial<MochiConfig> = {};
  const projectMochi = readJsonFile(resolve(dir, 'mochi.json')) ?? readJsonFile(resolve(dir, '.mochi', 'config.json'));
  if (projectMochi) merge(out as unknown as Record<string, unknown>, projectMochi);
  for (const rel of ['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json']) {
    const mcpJson = readJsonFile(resolve(dir, rel));
    if (mcpJson && typeof mcpJson === 'object') {
      const servers = (mcpJson as { mcpServers?: unknown }).mcpServers
        ?? (mcpJson as { servers?: unknown }).servers
        ?? (mcpJson as { mcp?: unknown }).mcp;
      if (servers && typeof servers === 'object') {
        // Wholesale per-server replacement (NOT a deep merge): whoever
        // declares a server name owns that server's ENTIRE definition — the
        // pre-restructure collision semantics (a project file fully
        // redefines a user-level server, e.g. swap command for url).
        out.mcpServers = { ...(out.mcpServers ?? {}), ...(servers as NonNullable<MochiConfig['mcpServers']>) };
      }
    }
  }
  return out;
}

/** Validate a merged config and return a list of human-readable problems.
 *  Catches common mistakes early (invalid safety mode, bad numbers, MCP server
 *  shape, etc.) so they surface at startup instead of mid-run. Purposely does
 *  NOT check for an API key: a missing key is a per-provider/credential concern
 *  surfaced at the model call layer, and a Runtime must still be constructible
 *  without keys for inspection and tests. */
export function validateConfig(config: MochiConfig): string[] {
  const problems: string[] = [];

  // Provider / model sanity
  if (!config.model.provider) {
    problems.push('model.provider is empty — set provider in config or MOCHI_PROVIDER env var');
  }
  if (!config.model.baseUrl && config.model.provider && !config.model.provider.startsWith('openrouter')) {
    problems.push('model.baseUrl should be set for the selected provider');
  }
  if (!config.model.model) {
    problems.push('model.model is empty — set a default model');
  }

  if (config.reasoning && !['low', 'medium', 'high', 'max', 'off', 'auto'].includes(config.reasoning)) {
    problems.push(`reasoning "${config.reasoning}" is invalid — must be "off", "auto", "low", "medium", "high", or "max"`);
  }
  if (config.selfRepair !== undefined && typeof config.selfRepair !== 'boolean') {
    problems.push(`selfRepair must be a boolean (got ${typeof config.selfRepair})`);
  }

  // Safety config ranges
  const s = config.safety;
  if (s.maxIterations < 1 || s.maxIterations > 100) {
    problems.push(`safety.maxIterations (${s.maxIterations}) is out of range 1–100`);
  }
  if (s.maxRuntimeMinutes < 0.5 || s.maxRuntimeMinutes > 720) {
    problems.push(`safety.maxRuntimeMinutes (${s.maxRuntimeMinutes}) is out of range 0.5–720`);
  }
  if (s.contextBudgetTokens < 1000 || s.contextBudgetTokens > 2_097_152) {
    problems.push(`safety.contextBudgetTokens (${s.contextBudgetTokens}) is out of range 1000–2M`);
  }
  if (s.commandTimeoutSeconds < 5 || s.commandTimeoutSeconds > 600) {
    problems.push(`safety.commandTimeoutSeconds (${s.commandTimeoutSeconds}) is out of range 5–600`);
  }
  if (s.sandbox !== undefined && s.sandbox !== 'off' && s.sandbox !== 'auto' && s.sandbox !== 'bubblewrap' && s.sandbox !== 'unshare') {
    problems.push(`safety.sandbox ("${s.sandbox}") is invalid — must be "off", "auto", "bubblewrap", or "unshare"`);
  }
  if (s.maxConcurrentAgents < 1 || s.maxConcurrentAgents > 32) {
    problems.push(`safety.maxConcurrentAgents (${s.maxConcurrentAgents}) is out of range 1–32`);
  }
  if (s.maxConcurrentSubagents !== undefined && (s.maxConcurrentSubagents < 1 || s.maxConcurrentSubagents > 32)) {
    problems.push(`safety.maxConcurrentSubagents (${s.maxConcurrentSubagents}) is out of range 1–32`);
  }
  if (s.maxSubagentDepth !== undefined && (s.maxSubagentDepth < 0 || s.maxSubagentDepth > 8)) {
    problems.push(`safety.maxSubagentDepth (${s.maxSubagentDepth}) is out of range 0–8`);
  }
  if (s.mode !== 'safe' && s.mode !== 'ask' && s.mode !== 'auto' && s.mode !== 'uncensored') {
    problems.push(`safety.mode "${s.mode}" is invalid — must be "safe", "ask", "auto", or "uncensored"`);
  }

  // Optional budgets
  if (s.maxTokens !== undefined && s.maxTokens < 1000) {
    problems.push(`safety.maxTokens (${s.maxTokens}) must be >= 1000`);
  }
  if (s.maxCostUsd !== undefined && s.maxCostUsd < 0) {
    problems.push(`safety.maxCostUsd (${s.maxCostUsd}) must be >= 0`);
  }
  if (s.pricing?.overrides) {
    for (const [model, rates] of Object.entries(s.pricing.overrides)) {
      for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
        const v = rates?.[field];
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
          problems.push(`safety.pricing.overrides["${model}"].${field} (${String(v)}) must be a finite number >= 0 (USD per 1M tokens)`);
        }
      }
    }
  }

  // MCP server config: a server is launchable with either a stdio command or
  // an HTTP url (McpClient routes on `url` first, then falls back to stdio).
  if (config.mcpServers) {
    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (!server.command && !server.url) {
        problems.push(`MCP server "${name}" needs a "command" or "url" field`);
      }
    }
  }

  return problems;
}
