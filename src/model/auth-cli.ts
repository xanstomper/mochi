// Pure, testable core of `mochi auth` (status/logout). The cli.ts branch
// stays a thin adapter over these so the coverage ratchet keeps meaning
// something — untested CLI glue is how gates silently rot.

import type { Provider } from './providers.js';
import type { verifyApiKey } from './auth-verify.js';

export type KeySource = 'env' | 'file' | 'ambient' | 'local' | 'missing';

/** Where does this provider's credential come from (never the key itself).
 *  `ambient` = a real OAuth/login cached by another CLI on this machine
 *  (Codex, Gemini CLI, Claude Code, gcloud ADC) — resolved by the caller. */
export function keySource(
  p: Pick<Provider, 'id' | 'envKey'>,
  activeId: string,
  envKeyValue: string | undefined,
  storedKey: string | undefined,
  usable: (key: string | undefined) => boolean,
  ambientKey?: string,
): KeySource {
  if (!p.envKey) return 'local';
  if (usable(envKeyValue)) return 'env';
  if (p.id === activeId && usable(storedKey)) return 'file';
  if (ambientKey && usable(ambientKey)) return 'ambient';
  return 'missing';
}

/** One status row per provider (no probing — fast, offline). `ambient` is a
 *  per-provider map of real OAuth tokens cached by other CLIs (see
 *  ambient-auth.ts); pass undefined to skip. */
export function authStatusLines(
  providers: Array<Pick<Provider, 'id' | 'envKey'>>,
  activeId: string,
  lookup: (envKey: string) => string | undefined,
  storedKey: string | undefined,
  usable: (key: string | undefined) => boolean,
  ambient?: (providerId: string) => string | undefined,
): string[] {
  return providers.map((p) => {
    const src = keySource(p, activeId, p.envKey ? lookup(p.envKey) : undefined, storedKey, usable, ambient?.(p.id));
    const mark = p.id === activeId ? '*' : ' ';
    const state = src === 'env' ? 'set (env)' : src === 'file' ? 'set (file)' : src === 'ambient' ? 'set (ambient)' : src === 'local' ? 'keyless local' : 'missing';
    return `${mark}${p.id.padEnd(16)} ${state}`;
  });
}

/** Live-verify one configured credential (stubbed in tests, real in CLI). */
export async function probeKeyState(
  verify: typeof verifyApiKey,
  opts: { provider: string; baseUrl: string; apiKey: string; kind: 'openai' | 'anthropic' | 'gemini' | 'vertex' },
): Promise<'verified' | 'REJECTED' | 'unreachable'> {
  try {
    const v = await verify({ ...opts, timeoutMs: 8000 });
    return v.ok ? 'verified' : v.reason === 'auth' ? 'REJECTED' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}

export interface LogoutOutcome {
  ok: boolean;
  message: string;
  /** True when the caller should persist the cleared config. */
  cleared: boolean;
}

/** Decide a logout without touching disk (caller persists on cleared). Any
 *  provider with stored material (keyring entry or legacy active slot, as
 *  resolved by the caller) can be cleared — not just the active one. */
export function decideLogout(
  targetId: string,
  knownProvider: boolean,
  activeId: string,
  storedKey: string | undefined,
): LogoutOutcome {
  if (!knownProvider) return { ok: false, message: `Unknown provider: ${targetId}`, cleared: false };
  void activeId;
  if (!storedKey) {
    return { ok: false, message: `No stored key for ${targetId}.`, cleared: false };
  }
  return { ok: true, message: `Cleared stored key for ${targetId}.`, cleared: true };
}
