// Per-provider keyring (~/.config/mochi/auth.json, mode 600): mochi owns one
// stored key PER PROVIDER (opencode auth.json parity), so switching providers
// never loses keys and any provider's key can be cleared — the old single
// active-slot model made logout/reset meaningless for non-active providers.
//
// Shape: { [providerId]: { type: 'api-key' | 'oauth', key, updatedAtMs } }.
// The path derives from the config dir, so the MOCHI_CONFIG_PATH override the
// test suite uses keeps this hermetic too. Reads never throw (corrupt file =
// empty ring); writes set 600 explicitly (config.json inherits umask, but a
// key file must not).

import { readFileSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { configFilePath } from './providers.js';
import { atomicWriteFileSync } from '../core/atomic-fs.js';

export type KeyringType = 'api-key' | 'oauth';

export interface AccountKeyringEntry {
  type: KeyringType;
  key: string;
  updatedAtMs: number;
}
export interface KeyringEntry {
  type: KeyringType;
  key: string;
  updatedAtMs: number;
  /** Multi-account: named accounts. Optional for legacy flat entries. */
  accounts?: Record<string, AccountKeyringEntry>;
  /** Name of the active account. Defaults to the first entry. */
  activeAccount?: string;
}

export type Keyring = Record<string, KeyringEntry>;

/** Path of the keyring file (sibling of the config file). */
export function keyringPath(): string {
  return resolve(dirname(configFilePath()), 'auth.json');
}

function isEntry(v: unknown): v is KeyringEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (e.type === 'api-key' || e.type === 'oauth')
    && typeof e.key === 'string'
    && e.key.length > 0;
}

/** Load the ring; corrupt/missing/unreadable files yield {} (never throws). */
export function loadKeyring(): Keyring {
  try {
    const raw = readFileSync(keyringPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const ring: Keyring = {};
    for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!isEntry(entry)) continue;
      const raw = entry as unknown as Record<string, unknown>;
      const rawAccounts = raw.accounts;
      const accounts: Record<string, AccountKeyringEntry> = {};
      if (rawAccounts && typeof rawAccounts === 'object' && !Array.isArray(rawAccounts)) {
        for (const [aname, arentry] of Object.entries(rawAccounts as Record<string, unknown>)) {
          const e = (arentry as unknown) as Record<string, unknown> | null;
          if (e && (e.type === 'api-key' || e.type === 'oauth') && typeof e.key === 'string' && e.key.length > 0) {
            accounts[aname] = { type: e.type, key: e.key, updatedAtMs: typeof e.updatedAtMs === 'number' ? e.updatedAtMs : 0 };
          }
        }
      }
      const hasAccounts = Object.keys(accounts).length > 0;
      ring[id] = {
        type: entry.type,
        key: entry.key,
        updatedAtMs: typeof entry.updatedAtMs === 'number' ? entry.updatedAtMs : 0,
        accounts: hasAccounts ? accounts : undefined,
        activeAccount: typeof raw.activeAccount === 'string'
          ? (raw.activeAccount as string)
          : (hasAccounts ? Object.keys(accounts)[0] : undefined),
      };
    }
    return ring;
  } catch {
    return {};
  }
}

/** Persist the ring with owner-only permissions (never throws callers off). */
export function saveKeyring(ring: Keyring): void {
  const path = keyringPath();
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(ring, null, 2));
  try {
    chmodSync(path, 0o600);
  } catch { /* best-effort (win32 ACLs differ) */ }
}

/** Stored key for one provider (undefined when absent). Pure read. */
export function getKeyringKey(ring: Keyring, providerId: string): string | undefined {
  return ring[providerId]?.key;
}

/** Store (or overwrite) one provider's key — operates on the active account
 *  (or 'default' when none exists yet). Plain `mochi login` re-auths the
 *  active account without touching other named accounts. */
export function setKeyringKey(providerId: string, key: string, type: KeyringType = 'api-key'): Keyring {
  return setAccount(providerId, activeAccountName(providerId) || 'default', key, type);
}

/** Delete one provider's key. True when an entry existed. */
export function deleteKeyringKey(providerId: string): boolean {
  const ring = loadKeyring();
  if (!(providerId in ring)) return false;
  delete ring[providerId];
  saveKeyring(ring);
  return true;
}

/** Resolve the stored key for a provider: keyring first, then the legacy
 *  single active-slot (config.model.apiKey) for the ACTIVE provider only.
 *  Legacy users lose nothing: their key keeps working until they re-login,
 *  which writes the keyring. Pure (caller supplies both sides). */
export function storedKeyForProvider(
  ring: Keyring,
  providerId: string,
  activeId: string,
  legacyActiveKey: string | undefined,
): string | undefined {
  return getKeyringKey(ring, providerId)
    ?? (providerId === activeId ? legacyActiveKey : undefined);
}

/** Current on-disk mode (for the 600 assertion in tests). Null when absent. */
export function keyringMode(): number | null {
  try {
    return statSync(keyringPath()).mode & 0o777;
  } catch {
    return null;
  }
}

// ---------- Multi-account support ----------
export function accountsFor(providerId: string): string[] {
  const ring = loadKeyring();
  const e = ring[providerId];
  if (!e) return [];
  if (!e.accounts || Object.keys(e.accounts).length === 0) {
    // Legacy flat entry counts as a single (default) account.
    return e.key ? ['default'] : [];
  }
  return Object.keys(e.accounts);
}

export function activeAccountName(providerId: string): string {
  const ring = loadKeyring();
  const e = ring[providerId];
  if (!e) return 'default';
  if (e.activeAccount) return e.activeAccount;
  if (e.accounts && Object.keys(e.accounts).length > 0) return Object.keys(e.accounts)[0];
  return 'default';
}

function ensureAccountsEntry(ring: Keyring, providerId: string): KeyringEntry {
  const e = ring[providerId];
  if (!e) {
    const created: KeyringEntry = { type: 'api-key', key: '', updatedAtMs: 0, accounts: {}, activeAccount: undefined };
    ring[providerId] = created;
    return created;
  }
  if (!e.accounts) {
    // Migrate a flat/legacy entry into the accounts model lazily.
    e.accounts = e.key ? { default: { type: e.type, key: e.key, updatedAtMs: e.updatedAtMs } } : {};
    if (!e.activeAccount) e.activeAccount = e.key ? 'default' : undefined;
  }
  return e;
}

export function setAccount(providerId: string, name: string, key: string, type: KeyringType = 'api-key'): Keyring {
  const ring = loadKeyring();
  const e = ensureAccountsEntry(ring, providerId);
  const safeName = name.trim() || 'default';
  e.accounts![safeName] = { type, key, updatedAtMs: Date.now() };
  e.activeAccount = safeName;
  e.type = type;
  e.key = key;
  e.updatedAtMs = Date.now();
  saveKeyring(ring);
  return ring;
}

export function switchAccount(providerId: string, name: string): boolean {
  const ring = loadKeyring();
  const e = ring[providerId];
  if (!e) return false;
  if (!e.accounts) ensureAccountsEntry(ring, providerId);
  const accounts = e.accounts ?? {};
  if (!Object.prototype.hasOwnProperty.call(accounts, name)) return false;
  e.activeAccount = name;
  const a = accounts[name];
  e.type = a.type;
  e.key = a.key;
  e.updatedAtMs = a.updatedAtMs;
  saveKeyring(ring);
  return true;
}

export function deleteAccount(providerId: string, name: string): boolean {
  const ring = loadKeyring();
  const e = ring[providerId];
  if (!e) return false;
  if (!e.accounts) ensureAccountsEntry(ring, providerId);
  const accounts = e.accounts ?? {};
  if (!Object.prototype.hasOwnProperty.call(accounts, name)) {
    // legacy single flat account named 'default': treat delete as deleteKeyringKey
    if (name === 'default' && 'key' in e && e.key) {
      delete ring[providerId];
      saveKeyring(ring);
      return true;
    }
    return false;
  }
  delete accounts[name];
  const remaining = Object.keys(accounts);
  if (remaining.length === 0) {
    delete ring[providerId];
    saveKeyring(ring);
    return true;
  }
  if (e.activeAccount === name) {
    const next = remaining[0];
    e.activeAccount = next;
    const a = accounts[next];
    e.type = a.type;
    e.key = a.key;
    e.updatedAtMs = a.updatedAtMs;
  }
  e.accounts = accounts;
  saveKeyring(ring);
  return true;
}

/** Original setKeyringKey now delegates to the active account (default when
 *  none), preserving both the flat on-disk shape and the multi-account model. */
