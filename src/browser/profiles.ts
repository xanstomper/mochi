// Named browser profiles — the credential registry for browser automation.
//
// Before this module, the browser tool took `profile` as a RAW DIRECTORY
// PATH and handed it to the driver. That meant any caller (including a
// prompt-injected one) could point the browser at ANY directory on disk —
// including the user's real Chrome profile — and a "profile" was invisible:
// nothing listed what existed, when it was used, or let the user revoke it.
//
// A persisted browser profile IS a credential store: it holds session
// cookies and localStorage for every site the user logged into through it.
// This module treats it like one:
//   - Profiles are NAMED (a strict slug), never raw paths. The tool layer
//     resolves name -> directory inside a single managed root; path-like
//     values are refused outright.
//   - The registry (~/.mochi/browser-profiles/registry.json) lists every
//     profile with created/last-used timestamps and the origin hosts it
//     has been seen navigating to.
//   - Revocation is real: it deletes the profile's data directory (the
//     cookies ARE the credential) and tombstones the name so a revoked
//     profile cannot silently resurrect with old state.
//   - Creation is explicit: resolveProfileDir creates the entry on first
//     use and reports `created: true` so callers can announce it — a new
//     credential store is never minted silently.
//
// The root is HOME-level (~/.mochi/browser-profiles), not workspace-level:
// a login belongs to the user, not to a project. It is deliberately NOT
// shared across tasks by default — each task run names the profile it
// wants, and the default profile is a mochi-managed directory, never the
// user's personal browser profile. Override the root with
// MOCHI_BROWSER_PROFILES_DIR (tests, sandboxes).
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { atomicWriteFileSync } from '../core/atomic-fs.js';

export interface BrowserProfileEntry {
  name: string;
  /** Absolute userDataDir for this profile. */
  dir: string;
  createdAt: number;
  lastUsedAt: number | null;
  /** Origin hosts (e.g. "github.com") this profile has navigated to. */
  origins: string[];
  /** Tombstone: revoked profiles keep an entry so the name cannot be
   *  silently re-created with the expectation of fresh state while the
   *  user believes it destroyed. Re-creating requires the entry to be
   *  explicitly cleared by deleting the tombstone (forgetProfile). */
  revoked?: boolean;
  revokedAt?: number;
  /** Adopted legacy default dir (~/.cache/mochi/browser-profile) so
   *  pre-registry logins are not orphaned by the move to named profiles. */
  legacy?: boolean;
}

interface RegistryFile { profiles: BrowserProfileEntry[] }

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

/** The managed root that holds every profile directory + the registry. */
export function profilesRoot(): string {
  const env = process.env.MOCHI_BROWSER_PROFILES_DIR;
  if (env && env.trim()) return resolve(env.trim());
  return resolve(homedir(), '.mochi', 'browser-profiles');
}

export function registryPath(): string {
  return resolve(profilesRoot(), 'registry.json');
}

/** The pre-registry default profile location (Phase A driver default). */
export function legacyDefaultProfileDir(): string {
  return resolve(homedir(), '.cache', 'mochi', 'browser-profile');
}

/** True when `value` is a valid profile NAME (vs a path or junk). */
export function isProfileName(value: string): boolean {
  return NAME_RE.test(value);
}

/** True when a value looks like a filesystem path rather than a name —
 *  path-like profile arguments are refused by the tool (credential safety:
 *  a raw path could point the browser at the user's personal profile). */
export function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value === '.' || value === '..' || /^[a-zA-Z]:/.test(value) || value.startsWith('~');
}

function loadRegistry(): RegistryFile {
  try {
    const raw = JSON.parse(readFileSync(registryPath(), 'utf8')) as RegistryFile;
    if (raw && Array.isArray(raw.profiles)) {
      // Schema-validate: a hand-edited or corrupt registry must not smuggle
      // entries whose `dir` escapes the managed root.
      const root = profilesRoot();
      const clean: BrowserProfileEntry[] = [];
      for (const p of raw.profiles) {
        if (!p || typeof p !== 'object') continue;
        const e = p as BrowserProfileEntry;
        if (typeof e.name !== 'string' || !isProfileName(e.name)) continue;
        if (typeof e.dir !== 'string') continue;
        const isLegacyDefault = e.legacy === true && resolve(e.dir) === legacyDefaultProfileDir();
        const insideRoot = resolve(e.dir) === resolve(root, e.name);
        if (!isLegacyDefault && !insideRoot) continue; // dir must be the managed slot (or the adopted legacy default)
        clean.push({
          name: e.name,
          dir: resolve(e.dir),
          createdAt: typeof e.createdAt === 'number' ? e.createdAt : 0,
          lastUsedAt: typeof e.lastUsedAt === 'number' ? e.lastUsedAt : null,
          origins: Array.isArray(e.origins) ? e.origins.filter((o): o is string => typeof o === 'string').slice(0, 200) : [],
          ...(e.revoked ? { revoked: true, revokedAt: typeof e.revokedAt === 'number' ? e.revokedAt : 0 } : {}),
          ...(e.legacy ? { legacy: true } : {}),
        });
      }
      return { profiles: clean };
    }
  } catch { /* missing/corrupt registry => empty; entries are recreated explicitly */ }
  return { profiles: [] };
}

function saveRegistry(reg: RegistryFile): void {
  const root = profilesRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Registry + profile dirs hold credential material: owner-only perms.
  atomicWriteFileSync(registryPath(), JSON.stringify(reg, null, 2), { mode: 0o600 });
}

/** All registered profiles (including revoked tombstones), name-sorted. */
export function listProfiles(): BrowserProfileEntry[] {
  return loadRegistry().profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export function getProfile(name: string): BrowserProfileEntry | undefined {
  return loadRegistry().profiles.find((p) => p.name === name);
}

export interface ResolveProfileResult {
  entry: BrowserProfileEntry;
  /** True when this call minted the profile (registry entry + directory). */
  created: boolean;
}

/**
 * Resolve a profile NAME to its directory, creating the profile on first
 * use. Throws on an invalid name or a revoked profile — revocation must be
 * a hard stop, not a fallback to fresh state.
 */
export function resolveProfileDir(name: string): ResolveProfileResult {
  if (!isProfileName(name)) {
    throw new Error(`invalid browser profile name "${name}" (use lowercase letters, digits, - and _, max 41 chars)`);
  }
  const reg = loadRegistry();
  let entry = reg.profiles.find((p) => p.name === name);
  if (entry?.revoked) {
    throw new Error(`browser profile "${name}" has been revoked — its stored logins were destroyed. Forget the profile (browser command: forgetprofile) before reusing the name.`);
  }
  let created = false;
  if (!entry) {
    // Adopt the legacy default dir for the `default` profile so existing
    // logins survive the move to the registry (only when it actually
    // exists on disk and has browser state in it).
    const legacyDir = legacyDefaultProfileDir();
    const adoptLegacy = name === 'default' && existsSync(legacyDir) && statSync(legacyDir).isDirectory();
    entry = {
      name,
      dir: adoptLegacy ? legacyDir : resolve(profilesRoot(), name),
      createdAt: Date.now(),
      lastUsedAt: null,
      origins: [],
      ...(adoptLegacy ? { legacy: true } : {}),
    };
    reg.profiles.push(entry);
    created = true;
    saveRegistry(reg);
  }
  mkdirSync(entry.dir, { recursive: true, mode: 0o700 });
  return { entry, created };
}

/** Record a use of the profile (and optionally an origin host it visited). */
export function touchProfile(name: string, originHost?: string): void {
  const reg = loadRegistry();
  const entry = reg.profiles.find((p) => p.name === name);
  if (!entry || entry.revoked) return;
  entry.lastUsedAt = Date.now();
  if (originHost && /^[a-z0-9.-]+$/i.test(originHost) && !entry.origins.includes(originHost)) {
    entry.origins.push(originHost);
    entry.origins.sort();
  }
  saveRegistry(reg);
}

/**
 * Revoke a profile: wipe its data directory (the cookies ARE the
 * credential) and tombstone the name. Returns false when no such
 * profile exists. The tombstone keeps the name blocked until it is
 * explicitly forgotten — re-creating a same-named profile minutes after
 * a revoke would resurrect exactly the confusion revocation prevents.
 */
export function revokeProfile(name: string): boolean {
  const reg = loadRegistry();
  const entry = reg.profiles.find((p) => p.name === name);
  if (!entry) return false;
  try { rmSync(entry.dir, { recursive: true, force: true }); } catch { /* tombstone still applies */ }
  entry.revoked = true;
  entry.revokedAt = Date.now();
  entry.origins = [];
  saveRegistry(reg);
  return true;
}

/** Remove a revoked profile's tombstone so the name can be used again
 *  (fresh, empty state). Returns false when the profile is not revoked. */
export function forgetProfile(name: string): boolean {
  const reg = loadRegistry();
  const idx = reg.profiles.findIndex((p) => p.name === name);
  if (idx < 0 || !reg.profiles[idx].revoked) return false;
  reg.profiles.splice(idx, 1);
  saveRegistry(reg);
  return true;
}

/** True when `dir` is inside the managed profiles root (defense-in-depth
 *  for call sites that resolved a directory some other way). */
export function isManagedProfileDir(dir: string): boolean {
  const root = profilesRoot();
  const abs = resolve(dir);
  return abs === root || abs.startsWith(root.endsWith(sep) ? root : root + sep) || abs === legacyDefaultProfileDir();
}
