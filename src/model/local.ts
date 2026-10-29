// Local-first model tier (campaign item 19).
//
// A first-class provider route for a self-hosted model server, configured via
// config (`model.local`) or env, selectable like any other provider. When the
// LOCAL TIER is the run's primary provider, task content must not leave the
// machine: this module owns
//
//   - endpoint/model resolution (env > config block > per-provider baseUrl),
//   - the local-tier predicate (which provider ids count as "local"),
//   - the offline + remote-fallback policy queries used by config.ts (which
//     remote entries may enter the failover chain) and router.ts (the runtime
//     egress guard that refuses a remote call before any fetch happens),
//   - the connect-failure decorator that turns a dead local endpoint into a
//     fast, VISIBLE failure with an actionable message (never a silent
//     fallback, never a hang).
//
// Everything here reads env lazily at call time so tests can stub it with
// vi.stubEnv, and imports only types.js so config.ts keeps its light import
// graph (see model-name.ts for that constraint).

import type { ModelConfig } from '../types.js';
import type { RawProvider } from './router.js';

export const LOCAL_PROVIDER_ID = 'local';

/** Default local endpoint: ollama's OpenAI-compatible server. Overridable via
 *  model.local.endpoint / MOCHI_LOCAL_ENDPOINT; any OpenAI-compatible local
 *  server (llama.cpp, LM Studio, vLLM, …) works. */
export const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:11434/v1';

/** Providers whose model server is on this machine. `local` is the
 *  configurable tier; the other three are the legacy static localhost
 *  providers, which are equally "local" for egress purposes. */
const LOCAL_PROVIDER_IDS = new Set(['local', 'ollama', 'llamacpp', 'lmstudio']);

/** Truthy env spellings shared by the local-tier env switches. */
const ENV_ON = new Set(['1', 'true', 'yes', 'on']);
const ENV_OFF = new Set(['0', 'false', 'no', 'off']);

/** A local-tier route is the run's primary: task content must not leave the
 *  machine on the model path. */
export function isLocalTierProvider(id: string | undefined): boolean {
  if (!id) return false;
  return LOCAL_PROVIDER_IDS.has(id.toLowerCase());
}

export function isLocalTierPrimary(config: ModelConfig): boolean {
  return isLocalTierProvider(config.provider);
}

/** Env override with explicit on AND off spellings; falls back to the config
 *  value when the env var is unset or unparseable. */
function envBool(name: string, fallback: boolean | undefined): boolean | undefined {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (ENV_ON.has(raw)) return true;
  if (ENV_OFF.has(raw)) return false;
  return fallback;
}

/** Offline mode: `model.local.offline` or MOCHI_OFFLINE (env wins). When set,
 *  the local tier refuses every remote route on its model path. */
export function offlineMode(config: ModelConfig): boolean {
  return envBool('MOCHI_OFFLINE', config.local?.offline) === true;
}

/** Remote fallback opt-in. The local tier NEVER silently fails over to a
 *  remote provider: fallback needs model.local.allowRemoteFallback / an
 *  explicit user `failover` chain, and is logged when it happens. Offline
 *  mode forces this false — no opt-in can override it. */
export function remoteFallbackAllowed(config: ModelConfig): boolean {
  if (offlineMode(config)) return false;
  return envBool('MOCHI_LOCAL_ALLOW_REMOTE', config.local?.allowRemoteFallback) === true;
}

/** Resolve the local endpoint. Precedence (env > config block > generic
 *  baseUrl > default): MOCHI_LOCAL_ENDPOINT beats the config file so a
 *  one-shot override always wins; the local-specific block beats a generic
 *  `baseUrl`, which provider switching stamps with the static default. */
export function resolveLocalEndpoint(config: ModelConfig): string {
  const env = (process.env.MOCHI_LOCAL_ENDPOINT ?? '').trim();
  if (env) return env;
  const fromBlock = (config.local?.endpoint ?? '').trim();
  if (fromBlock) return fromBlock;
  if (config.baseUrl && config.baseUrl.trim()) return config.baseUrl.trim();
  return DEFAULT_LOCAL_ENDPOINT;
}

/** Resolve the local model id: MOCHI_LOCAL_MODEL > model.local.model >
 *  the generic model field > 'local-model'. */
export function resolveLocalModel(config: ModelConfig): string {
  const env = (process.env.MOCHI_LOCAL_MODEL ?? '').trim();
  if (env) return env;
  const fromBlock = (config.local?.model ?? '').trim();
  if (fromBlock) return fromBlock;
  if (config.model && config.model.trim()) return config.model.trim();
  return 'local-model';
}

/** Error thrown for local-tier policy violations and dead local endpoints.
 *  Always carries an actionable message; never includes task content. */
export class LocalTierError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'LocalTierError';
    if (options?.cause !== undefined) (this as Error & { cause?: unknown }).cause = options.cause;
  }
}

const CONNECT_FAILURE = /fetch failed|ECONNREFUSED|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|ETIMEDOUT|connect/i;

/** Walk undici's cause chain for the real reason ('fetch failed' hides it —
 *  same walk as openai.ts logBackoff). */
function rootCauseDetail(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== undefined && cur !== null; depth++) {
    const line = cur instanceof Error ? (cur.message.split('\n')[0] ?? '') : String(cur);
    if (line && !parts.includes(line)) parts.push(line);
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return parts.join(' <- ') || String(err);
}

function isConnectFailure(err: unknown): boolean {
  if (err instanceof LocalTierError) return false;
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur !== undefined && cur !== null; depth++) {
    const msg = cur instanceof Error ? cur.message : String(cur);
    if (CONNECT_FAILURE.test(msg)) return true;
    const code = (cur as { code?: unknown })?.code;
    if (typeof code === 'string' && CONNECT_FAILURE.test(code)) return true;
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return false;
}

/**
 * Wrap a local-tier raw provider so a dead/unreachable endpoint fails FAST and
 * VISIBLY with an actionable message, instead of a bare "fetch failed" that
 * the caller might read as a transient remote-provider blip. Only transport
 * failures are re-labeled; HTTP status errors and aborts pass through
 * untouched. `remoteFallbackAllowed` shapes the message: without it the error
 * states that nothing was sent off-machine and how to opt in; with it, that
 * the (visible) remote fallback is next.
 */
export function withLocalConnectGuidance(provider: RawProvider, endpoint: string, remoteFallbackAllowed_: boolean): RawProvider {
  const noFallbackHint = remoteFallbackAllowed_
    ? 'A configured remote fallback (if any) will be tried next — that call sends task content off-machine.'
    : 'Local tier is active: nothing was sent off-machine (no remote provider was called). Fix model.local.endpoint / MOCHI_LOCAL_ENDPOINT, or explicitly opt in to remote fallback with model.local.allowRemoteFallback=true (MOCHI_LOCAL_ALLOW_REMOTE=1).';
  const label = (err: unknown): LocalTierError =>
    new LocalTierError(
      `Local model endpoint ${endpoint} unreachable (${rootCauseDetail(err)}). ${noFallbackHint}`,
      { cause: err },
    );
  return {
    async *streamChat(messages, tools, options) {
      try {
        for await (const chunk of provider.streamChat(messages, tools, options)) yield chunk;
      } catch (err) {
        if (isConnectFailure(err) && !options?.signal?.aborted) throw label(err);
        throw err;
      }
    },
    async chat(messages, tools, options) {
      try {
        return await provider.chat(messages, tools, options);
      } catch (err) {
        if (isConnectFailure(err) && !options?.signal?.aborted) throw label(err);
        throw err;
      }
    },
  };
}

/** Runtime egress guard (defense in depth): when the local tier runs in
 *  offline mode, any NON-local chain entry throws BEFORE making a network
 *  call, even if a stale/explicit failover entry is still in the config. */
export function withRemoteEgressBlock(provider: RawProvider, providerName: string, baseUrl: string | undefined): RawProvider {
  void provider; // the guard never delegates — that is the point
  const refuse = (): LocalTierError =>
    new LocalTierError(
      `Offline mode (local tier): refusing model call to remote provider "${providerName}"${baseUrl ? ` (${baseUrl})` : ''} — task content must not leave the machine. Remove remote failover entries, or unset model.local.offline / MOCHI_OFFLINE to re-enable remote routes.`,
    );
  return {
    async *streamChat(_messages, _tools, options) {
      options?.signal?.throwIfAborted();
      throw refuse();
    },
    async chat(_messages, _tools, options) {
      options?.signal?.throwIfAborted();
      throw refuse();
    },
    // Routing metadata: carry the blocked entry's identity so logs and the
    // failover loop name it correctly, and flag the entry as egress-blocked so
    // withFailover does not announce a fallback that is about to be refused.
    providerId: providerName,
    isLocal: false,
    egressBlocked: true,
  };
}
