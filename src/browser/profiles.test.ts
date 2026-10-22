// Named browser profiles: the registry is a credential store's index —
// names resolve to managed dirs, raw paths are detectable (and refused by
// the tool), revocation destroys state and tombstones the name.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  forgetProfile,
  getProfile,
  isProfileName,
  listProfiles,
  looksLikePath,
  resolveProfileDir,
  revokeProfile,
  touchProfile,
} from './profiles.js';

let root: string;
let prevEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'mochi-profiles-'));
  prevEnv = process.env.MOCHI_BROWSER_PROFILES_DIR;
  process.env.MOCHI_BROWSER_PROFILES_DIR = root;
});
afterEach(() => {
  if (prevEnv === undefined) delete process.env.MOCHI_BROWSER_PROFILES_DIR;
  else process.env.MOCHI_BROWSER_PROFILES_DIR = prevEnv;
  rmSync(root, { recursive: true, force: true });
});

describe('profile names', () => {
  it('accepts slugs, rejects paths and junk', () => {
    expect(isProfileName('default')).toBe(true);
    expect(isProfileName('work-github_2')).toBe(true);
    expect(isProfileName('')).toBe(false);
    expect(isProfileName('Has Caps')).toBe(false);
    expect(isProfileName('../etc')).toBe(false);
    expect(isProfileName('-leading-dash')).toBe(false);
  });
  it('detects path-like values (the tool refuses these as profile args)', () => {
    expect(looksLikePath('/home/user/.config/google-chrome')).toBe(true);
    expect(looksLikePath('C:\\Users\\x\\Chrome')).toBe(true);
    expect(looksLikePath('~/.cache/mochi')).toBe(true);
    expect(looksLikePath('..')).toBe(true);
    expect(looksLikePath('default')).toBe(false);
    expect(looksLikePath('work-github')).toBe(false);
  });
});

describe('registry lifecycle', () => {
  it('creates on first resolve, inside the managed root, and reports creation', () => {
    const r1 = resolveProfileDir('alpha');
    expect(r1.created).toBe(true);
    expect(r1.entry.dir).toBe(resolve(root, 'alpha'));
    expect(existsSync(r1.entry.dir)).toBe(true);
    const r2 = resolveProfileDir('alpha');
    expect(r2.created).toBe(false);
    expect(listProfiles().map((p) => p.name)).toEqual(['alpha']);
  });

  it('touch records last use and origin hosts (deduped)', () => {
    resolveProfileDir('alpha');
    touchProfile('alpha', 'example.com');
    touchProfile('alpha', 'example.com');
    touchProfile('alpha', 'other.test');
    const p = getProfile('alpha')!;
    expect(p.lastUsedAt).toBeGreaterThan(0);
    expect(p.origins).toEqual(['example.com', 'other.test']);
  });

  it('revoke wipes the data dir and hard-blocks further resolution', () => {
    const { entry } = resolveProfileDir('alpha');
    writeFileSync(resolve(entry.dir, 'Cookies'), 'session-secret');
    expect(revokeProfile('alpha')).toBe(true);
    expect(existsSync(entry.dir)).toBe(false);
    expect(getProfile('alpha')?.revoked).toBe(true);
    expect(() => resolveProfileDir('alpha')).toThrow(/revoked/);
    // Revoking twice is a no-op success-wise: still tombstoned.
    expect(revokeProfile('missing')).toBe(false);
  });

  it('forget clears the tombstone so the name can be re-registered fresh', () => {
    resolveProfileDir('alpha');
    revokeProfile('alpha');
    expect(forgetProfile('alpha')).toBe(true);
    const r = resolveProfileDir('alpha');
    expect(r.created).toBe(true);
    expect(r.entry.revoked).toBeUndefined();
    expect(forgetProfile('alpha')).toBe(false); // not revoked anymore
  });

  it('a hand-edited registry entry pointing outside the root is dropped, not honored', () => {
    // Simulate a tampered registry: entry claims dir=/etc. loadRegistry
    // must refuse it (the dir must be the managed slot), so resolution
    // mints a fresh managed profile instead of using the escape path.
    mkdirSync(root, { recursive: true });
    writeFileSync(resolve(root, 'registry.json'), JSON.stringify({
      profiles: [{ name: 'evil', dir: '/etc', createdAt: 1, lastUsedAt: null, origins: [] }],
    }));
    expect(listProfiles().find((p) => p.name === 'evil')).toBeUndefined();
    const r = resolveProfileDir('evil');
    expect(r.entry.dir).toBe(resolve(root, 'evil'));
  });
});
