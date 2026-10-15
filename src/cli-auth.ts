// `mochi auth` command core, extracted for testability (cli.ts stays a thin
// adapter). All disk/network effects arrive injected; tests use fakes.
import { PROVIDERS, providerById, loadConfigFile, saveConfigFile } from './model/providers.js';
import { isKeyUsable } from './model/startup-check.js';
import { probeKeyState, decideLogout, keySource } from './model/auth-cli.js';
import { verifyApiKey } from './model/auth-verify.js';
import type { MochiConfig } from './types.js';

export interface AuthCommandDeps {
  positional: string[];
  flags: Record<string, string | boolean>;
  runtime: { config: MochiConfig };
  log: (s: string) => void;
  error: (s: string) => void;
  /** Never returns (process.exit in prod, thrown Exit in tests). */
  exit: (code: number) => never;
  verify?: typeof verifyApiKey;
}

export async function runAuthCommand(deps: AuthCommandDeps): Promise<void> {
  const { positional, flags, runtime, log, error, exit } = deps;
  const verify = deps.verify ?? verifyApiKey;
  const sub = positional[1] ?? 'status';
  const activeId = runtime.config.model.provider;
  const lookup = (k: string): string | undefined => process.env[k];
  if (sub === 'status') {
    const probing = !!flags.probe;
    // Per-provider stored keys (keyring first, legacy active slot second) so
    // every provider reports its real source — not just the active one.
    const { loadKeyring, storedKeyForProvider, accountsFor, activeAccountName } = await import('./model/keyring.js');
    const { codexAmbientToken, geminiAmbientToken, claudeAmbientToken, gcloudAmbientToken, antigravityAmbientToken, listAntigravityAccounts, tokenjuiceAmbientToken, kiloAmbientToken } = await import('./model/ambient-auth.js');
    const ring = loadKeyring();
    const legacyKey = runtime.config.model.apiKey;
    const storedFor = (pid: string) => storedKeyForProvider(ring, pid, activeId, legacyKey);
    // Ambient OAuth: real tokens cached by other CLIs the user already logged
    // into (Codex, Gemini CLI, Claude Code, gcloud ADC). Resolved once, lazily.
    const ambientMap = new Map<string, string>();
    const ambientInfo: Record<string, { account?: string; count?: number }> = {};
    await Promise.all(PROVIDERS.map(async (p) => {
      try {
        let tok: string | undefined;
        if (p.id === 'openai' || p.id === 'openai-codex') tok = (await codexAmbientToken())?.token;
        else if (p.id === 'gemini' || p.id === 'google') tok = geminiAmbientToken()?.token ?? (await gcloudAmbientToken())?.token;
        else if (p.id === 'anthropic') tok = claudeAmbientToken()?.token;
        else if (p.id === 'kilo') tok = (await kiloAmbientToken())?.token;
        else if (p.id === 'cline' || p.id === 'cline-pass') tok = process.env.CLINE_API_KEY;
        else if (p.id === 'antigravity' || p.id === 'google-antigravity') {
          const amb = await antigravityAmbientToken();
          tok = amb?.token;
          const accs = await listAntigravityAccounts();
          if (amb?.account) {
            ambientInfo[p.id] = { account: amb.account, count: accs.length };
          }
        } else if (p.id === 'tokenjuice') {
          tok = tokenjuiceAmbientToken()?.token;
        }
        if (tok) ambientMap.set(p.id, tok);
      } catch { /* ambient is best-effort */ }
    }));
    const ambientFor = (pid: string) => ambientMap.get(pid);
    const rows = PROVIDERS.map((p) => {
      const src = keySource(p, activeId, p.envKey ? lookup(p.envKey) : undefined, storedFor(p.id), isKeyUsable, ambientFor(p.id));
      const mark = p.id === activeId ? '*' : ' ';
      const info = ambientInfo[p.id];
      const state = src === 'env' ? 'set (env)' : src === 'file' ? 'set (file)' : src === 'ambient' ? (info?.account ? `set (ambient: ${info.account})` : 'set (ambient)') : src === 'local' ? 'keyless local' : 'missing';
      const n = (info?.count && info.count > 1) ? info.count : accountsFor(p.id).length;
      const activeName = info?.account ?? activeAccountName(p.id);
      const extra = n > 1 ? `  (${n} accounts, active: ${activeName})` : '';
      return `${mark}${p.id.padEnd(16)} ${state}${extra}`;
    });
    if (probing) {
      const probed = await Promise.all(PROVIDERS.map(async (p, i) => {
        const src = rows[i].includes('set (env)') ? 'env' : rows[i].includes('set (file)') ? 'file' : null;
        if (!src) return rows[i];
        const key = src === 'env' ? String(process.env[p.envKey]) : String(storedFor(p.id) ?? '');
        return `${rows[i]} · ${await probeKeyState(verify, { provider: p.id, baseUrl: p.baseUrl, apiKey: key, kind: p.kind })}`;
      }));
      log(probed.join('\n'));
    } else {
      log(rows.join('\n'));
    }
    log(`\n* = active. Authenticate with: mochi login <provider> (keys are live-probed before storing).${probing ? '' : ' Add --probe to live-verify configured keys.'}`);
    return;
  }
  if (sub === 'logout' || sub === 'reset') {
    // `reset` is an explicit alias for `logout`: changing a key is just
    // `mochi login <provider>` again (it overwrites the stored key after a
    // live probe); resetting clears it here — for ANY provider with a stored
    // key, not just the active one (the keyring owns per-provider keys).
    const target = positional[2] ?? activeId;
    const { loadKeyring, storedKeyForProvider, deleteKeyringKey } = await import('./model/keyring.js');
    const ring = loadKeyring();
    const resolved = storedKeyForProvider(ring, target, activeId, runtime.config.model.apiKey);
    const out = decideLogout(target, !!providerById(target), activeId, resolved);
    if (!out.cleared) {
      log(out.message);
      if (target && !providerById(target)) exit(1);
      return;
    }
    deleteKeyringKey(target);
    if (target === activeId) {
      const cfg = loadConfigFile() as { model?: { apiKey?: string } };
      if (cfg.model) delete cfg.model.apiKey;
      saveConfigFile(cfg as never);
      runtime.config.model.apiKey = undefined;
    }
    const p = providerById(target)!;
    log(`${out.message} Re-login with: mochi login ${target}. Env-provided keys are unaffected (unset $${p.envKey} to remove those).`);
    return;
  }
  if (sub === 'export') {
    // Print the owned keyring as JSON (opencode `auth export` parity) for
    // backup/migration. Secrets go to STDOUT deliberately — redirect to a
    // file, never paste into chats/logs. Nothing is printed for empty rings.
    const { loadKeyring } = await import('./model/keyring.js');
    const ring = loadKeyring();
    const ids = Object.keys(ring);
    if (!ids.length) {
      log('Keyring empty — nothing stored (env-only and keyless setups export nothing).');
      return;
    }
    error('WARNING: writing secrets to stdout — redirect to a file, never paste this output.');
    log(JSON.stringify(Object.fromEntries(ids.map((id) => [id, { type: ring[id].type, key: ring[id].key }])), null, 2));
    return;
  }
  if (sub === 'import') {
    // Restore a keyring from `auth export` JSON (file path or '-' for stdin).
    // Shape-validated only (unknown ids skipped with a message); keys are
    // NOT live-probed here — run `auth status --probe` after to verify.
    const src = positional[2] ?? '-';
    let raw: string;
    try {
      if (src === '-') {
        const { readStdin } = await import('./pipeline.js');
        raw = await readStdin();
      } else {
        const { readFileSync } = await import('node:fs');
        const { resolve } = await import('node:path');
        raw = readFileSync(resolve(src), 'utf8');
      }
    } catch {
      error(`Cannot read import source "${src}".`);
      exit(1);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw!);
    } catch {
      error(`Import source "${src}" is not valid JSON.`);
      exit(1);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      error(`Import source "${src}" must be an object shaped {provider: {type, key}}.`);
      exit(1);
    }
    const { setKeyringKey } = await import('./model/keyring.js');
    const stored: string[] = [];
    const skipped: string[] = [];
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const p = providerById(id);
      const e = entry as Record<string, unknown> | null;
      const key = typeof e?.key === 'string' ? e.key : '';
      const type = e?.type === 'oauth' ? 'oauth' as const : 'api-key' as const;
      if (!p || !key) { skipped.push(id); continue; }
      try {
        setKeyringKey(p.id, key, type);
        stored.push(p.id);
      } catch {
        skipped.push(id);
      }
    }
    log(`Imported ${stored.length} key(s)${stored.length ? `: ${stored.join(', ')}` : ''}${skipped.length ? ` (skipped unknown/empty: ${skipped.join(', ')})` : ''}. Keys are stored unverified — run \`mochi auth status --probe\` to verify.`);
    return;
  }
  if (sub === 'switch') {
    const provider = positional[2];
    const account = positional[3];
    if (!provider || !account) {
      error('Usage: mochi auth switch <provider> <account>');
      exit(1);
    }
    if (!providerById(provider)) { error(`Unknown provider: ${provider}`); exit(1); }
    const { switchAccount, loadKeyring, setAccount } = await import('./model/keyring.js');
    if (provider === 'antigravity' || provider === 'google-antigravity') {
      const { antigravityAmbientToken, listAntigravityAccounts } = await import('./model/ambient-auth.js');
      const accs = await listAntigravityAccounts();
      const match = accs.find((a) => a.email.toLowerCase() === account.toLowerCase());
      if (match) {
        const tok = await antigravityAmbientToken(undefined, match.email);
        if (tok) {
          setAccount('antigravity', match.email, tok.token, 'oauth');
          log(`Switched active account for antigravity to "${match.email}".`);
          return;
        }
      }
    }
    if (!switchAccount(provider, account)) {
      error(`No account named "${account}" for ${provider}. List with: mochi auth accounts ${provider}`);
      exit(1);
    }
    // Sync the active config slot when switching a key of the active provider.
    if (provider === activeId) {
      const ring = loadKeyring();
      const newKey = ring[provider]?.key;
      const cfg = loadConfigFile() as { model?: { apiKey?: string } };
      if (cfg.model && newKey) cfg.model.apiKey = newKey;
      if (cfg.model && !newKey) delete cfg.model.apiKey;
      saveConfigFile(cfg as never);
      runtime.config.model.apiKey = newKey;
    }
    log(`Switched active account for ${provider} to "${account}".`);
    return;
  }
  if (sub === 'accounts') {
    const target = positional[2] ?? activeId;
    if (!providerById(target)) { error(`Unknown provider: ${target}`); exit(1); }
    if (target === 'antigravity' || target === 'google-antigravity') {
      const { listAntigravityAccounts, antigravityAmbientToken } = await import('./model/ambient-auth.js');
      const accs = await listAntigravityAccounts();
      const { activeAccountName } = await import('./model/keyring.js');
      const curAmbient = await antigravityAmbientToken();
      const active = activeAccountName('antigravity') || curAmbient?.account || accs[0]?.email;
      if (accs.length > 0) {
        log(`Accounts for antigravity (${accs.length}):`);
        for (const a of accs) {
          const isAct = a.email.toLowerCase() === (active ?? '').toLowerCase();
          log(`${isAct ? '*' : ' '} ${a.email} (id: ${a.id}, project: ${a.projectId || 'aicode-consumers'})`);
        }
        log(`\n* = active. Switch with: mochi auth switch antigravity <email>`);
        return;
      }
    }
    const { accountsFor, activeAccountName } = await import('./model/keyring.js');
    const names = accountsFor(target);
    if (!names.length) { log(`No stored accounts for ${target}. Login with: mochi login ${target} --account <name>`); return; }
    const active = activeAccountName(target);
    for (const n of names) log(`${n === active ? '*' : ' '} ${n}`);
    log(`\n* = active. Login a new account with: mochi login ${target} --account <name>`);
    return;
  }
  if (sub === 'account' && positional[2] === 'delete') {
    const provider = positional[3];
    const account = positional[4] ?? 'default';
    if (!provider) { error('Usage: mochi auth account delete <provider> [account]'); exit(1); }
    if (!providerById(provider)) { error(`Unknown provider: ${provider}`); exit(1); }
    const { deleteAccount, loadKeyring } = await import('./model/keyring.js');
    if (!deleteAccount(provider, account)) {
      error(`No account "${account}" for ${provider}.`);
      exit(1);
    }
    log(`Removed account "${account}" from ${provider}.`);
    // Sync config slot when removing an account from the active provider.
    if (provider === activeId) {
      const ring = loadKeyring();
      const newKey = ring[provider]?.key;
      const cfg = loadConfigFile() as { model?: { apiKey?: string } };
      if (cfg.model && newKey) cfg.model.apiKey = newKey;
      if (cfg.model && !newKey) delete cfg.model.apiKey;
      saveConfigFile(cfg as never);
      runtime.config.model.apiKey = newKey;
    }
    return;
  }
  error(`Unknown auth command "${sub}". Use: mochi auth [status [--probe] | accounts [provider] | switch <provider> <account> | logout [provider] | reset [provider] | export | import [file|-]] (authenticate with: mochi login <provider> [--account name]; change a key by logging in again)`);
  exit(1);
}
