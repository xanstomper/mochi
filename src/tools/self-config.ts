// Native tool: self-config (MCH-213) + api-probe (MCH-214) + doctor (MCH-215)
// Self-setup surface: the agent can inspect its own config, validate a
// provider endpoint/key with a live no-cost probe, and persist a working
// model config mid-task — without a human running `mochi config`. This is the
// "setting itself up with APIs" capability: give it a base URL + key and it
// wires itself, proves the key works, and continues the task on the new model.
//
// Safety: `set` requires `permission: 'write'` and never echoes the API key
// back (masked). `probe` is read-only network. `doctor` is read-only.

import type { Tool } from './types.js';
import { verifyApiKey } from '../model/auth-verify.js';
import { loadConfigFile, saveConfigFile } from '../model/providers.js';

function maskKey(key: string | undefined): string {
  if (!key) return '(none)';
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function providerKind(provider: string): 'openai' | 'anthropic' | 'gemini' {
  const p = provider.toLowerCase();
  if (p.includes('anthropic') || p === 'claude') return 'anthropic';
  if (p.includes('gemini') || p.includes('google')) return 'gemini';
  return 'openai';
}

export const selfConfigTool: Tool = {
  def: {
    name: 'self_config',
    description:
      "Inspect or change THIS agent's own runtime configuration: view current model/provider/reasoning (API key masked), test a provider endpoint+key with a live zero-cost probe, or persist a new model/provider/apiKey and switch to it immediately. Use when the current model is failing, a task needs a different model, or the user supplies new provider credentials mid-task.",
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: "'show' (current config) | 'probe' (live-test a baseUrl+key) | 'set' (persist + switch model/provider/apiKey) | 'doctor' (full workspace health report)",
        required: true,
      },
      { name: 'provider', type: 'string', description: 'Provider name (for probe/set)', required: false },
      { name: 'baseUrl', type: 'string', description: 'OpenAI-compatible base URL (for probe/set)', required: false },
      { name: 'model', type: 'string', description: 'Model id (for probe/set)', required: false },
      { name: 'apiKey', type: 'string', description: 'API key (for probe/set). Never echoed back — masked in all output.', required: false },
      { name: 'reasoning', type: 'string', description: 'Reasoning effort: off|low|medium|high|max (for set)', required: false },
      { name: 'timeoutMs', type: 'number', description: 'Probe timeout in ms (default 10000)', required: false },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const action = String(args.action ?? 'show');

    if (action === 'show') {
      const cfg = ctx.config;
      const model = cfg.model as { provider?: string; baseUrl?: string; model?: string; apiKey?: string } | undefined;
      return [
        `provider: ${model?.provider ?? '(unset)'}`,
        `baseUrl: ${model?.baseUrl ?? '(unset)'}`,
        `model: ${model?.model ?? '(unset)'}`,
        `apiKey: ${maskKey(model?.apiKey)}`,
        `reasoning: ${cfg.reasoning ?? 'auto'}`,
        `fallbackProviders: ${Array.isArray((cfg.model as unknown as { fallbackProviders?: unknown } | undefined)?.fallbackProviders) ? `${((cfg.model as unknown as { fallbackProviders: unknown[] }).fallbackProviders).length} configured` : '(none)'}`,
      ].join('\n');
    }

    if (action === 'probe') {
      const provider = String(args.provider ?? (ctx.config.model as { provider?: string } | undefined)?.provider ?? 'openai');
      const baseUrl = String(args.baseUrl ?? (ctx.config.model as { baseUrl?: string } | undefined)?.baseUrl ?? '');
      const apiKey = String(args.apiKey ?? (ctx.config.model as { apiKey?: string } | undefined)?.apiKey ?? '');
      if (!baseUrl) return 'probe requires baseUrl (or a configured baseUrl in current config).';
      const verdict = await verifyApiKey({
        provider,
        baseUrl,
        apiKey,
        kind: providerKind(provider),
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : 10_000,
      });
      if (verdict.ok) return `PROBE OK: ${provider} @ ${baseUrl} accepted the key (status 200/429). Safe to set.`;
      return `PROBE FAILED (${verdict.reason}): ${verdict.message}${verdict.reason === 'network' ? ' — key may still be valid; retry or set with caution.' : ' — do NOT set this key.'}`;
    }

    if (action === 'set') {
      const provider = args.provider !== undefined ? String(args.provider) : undefined;
      const baseUrl = args.baseUrl !== undefined ? String(args.baseUrl) : undefined;
      const model = args.model !== undefined ? String(args.model) : undefined;
      const apiKey = args.apiKey !== undefined ? String(args.apiKey) : undefined;
      const reasoning = args.reasoning !== undefined ? String(args.reasoning) : undefined;
      if (!provider && !baseUrl && !model && !apiKey && !reasoning) {
        return 'set requires at least one of: provider, baseUrl, model, apiKey, reasoning.';
      }
      // Pre-flight: if credentials/endpoint are being changed, probe first and
      // refuse to persist a known-bad key (same "prove it" rule as login).
      const nextProvider = provider ?? (ctx.config.model as { provider?: string } | undefined)?.provider ?? 'openai';
      const nextBaseUrl = baseUrl ?? (ctx.config.model as { baseUrl?: string } | undefined)?.baseUrl ?? '';
      const nextKey = apiKey ?? (ctx.config.model as { apiKey?: string } | undefined)?.apiKey ?? '';
      if (baseUrl || apiKey) {
        const verdict = await verifyApiKey({
          provider: nextProvider,
          baseUrl: nextBaseUrl,
          apiKey: nextKey,
          kind: providerKind(nextProvider),
          timeoutMs: 10_000,
        });
        if (!verdict.ok && verdict.reason === 'auth') {
          return `REFUSED: probe says the endpoint rejects this credential (${verdict.message}). Config unchanged — a bad key would burn every request on failover.`;
        }
      }
      // Persist to the global config file (same store `mochi login` uses) and
      // apply live to this run.
      try {
        const cfg = loadConfigFile();
        cfg.model = cfg.model ?? ({} as typeof cfg.model);
        if (provider) cfg.model.provider = provider;
        if (baseUrl) cfg.model.baseUrl = baseUrl;
        if (model) cfg.model.model = model;
        if (apiKey) cfg.model.apiKey = apiKey;
        if (reasoning) cfg.reasoning = reasoning as typeof cfg.reasoning;
        saveConfigFile(cfg);
      } catch (e) {
        return `Config file persist failed: ${e instanceof Error ? e.message : String(e)}. Live config NOT changed.`;
      }
      const live = ctx.config as unknown as { model?: Record<string, unknown>; reasoning?: string };
      if (live.model) {
        if (provider) live.model.provider = provider;
        if (baseUrl) live.model.baseUrl = baseUrl;
        if (model) live.model.model = model;
        if (apiKey) live.model.apiKey = apiKey;
      }
      if (reasoning) live.reasoning = reasoning;
      return [
        'CONFIG SET (persisted + live):',
        `  provider: ${provider ?? '(unchanged)'}`,
        `  baseUrl: ${baseUrl ?? '(unchanged)'}`,
        `  model: ${model ?? '(unchanged)'}`,
        `  apiKey: ${apiKey ? maskKey(apiKey) : '(unchanged)'}`,
        `  reasoning: ${reasoning ?? '(unchanged)'}`,
        'The next model call in this task uses the new settings. If the run was started with a fixed provider instance, a fresh run picks this up guaranteed.',
      ].join('\n');
    }

    if (action === 'doctor') {
      // MCH-215: in-task health report — same engine as `mochi doctor`, so the
      // agent can diagnose its own environment (sqlite, browser, skills, daemon)
      // mid-run instead of telling the user to go run the CLI.
      const m = (ctx.config.model ?? {}) as { provider?: string; baseUrl?: string; model?: string; apiKey?: string };
      const { doctorReport, formatDoctor } = await import('../doctor.js');
      const report = await doctorReport({
        provider: m.provider ?? 'openai',
        baseUrl: m.baseUrl ?? '',
        model: m.model ?? '',
        apiKey: m.apiKey,
        workspaceDir: ctx.cwd,
        // Never probe the endpoint from inside a task: a hung endpoint would
        // stall the agent loop. Reachability shows n/a; self_config probe is
        // the explicit live-test path.
        probeProvider: false,
      });
      return formatDoctor(report);
    }

    return `Unknown action '${action}'. Use show | probe | set | doctor.`;
  },
};
