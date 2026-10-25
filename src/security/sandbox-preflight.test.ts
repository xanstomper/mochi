import { describe, it, expect, beforeEach } from 'vitest';
import { buildSandboxPreflightNotice, maybeSandboxPreflightNotice, _resetSandboxPreflightForTests } from './sandbox-preflight.js';
import type { SandboxCapabilities } from './sandbox.js';

function caps(over: Partial<SandboxCapabilities> = {}): SandboxCapabilities {
  return {
    platform: 'linux',
    bubblewrap: null,
    unshare: null,
    unshareKillChild: false,
    unsharePropagation: false,
    landlock: { available: false, reason: 'n/a' },
    autoBackend: 'soft',
    autoLevel: 'soft',
    summary: 'SOFT jail only',
    ...over,
  } as SandboxCapabilities;
}

describe('buildSandboxPreflightNotice', () => {
  it('auto + OS-level backend: silent', () => {
    expect(buildSandboxPreflightNotice('auto', caps({ bubblewrap: '/usr/bin/bwrap', autoBackend: 'bubblewrap', autoLevel: 'os' }))).toBeNull();
    // unset mode = auto
    expect(buildSandboxPreflightNotice(undefined, caps({ unshare: '/usr/bin/unshare', autoBackend: 'unshare', autoLevel: 'os' }))).toBeNull();
  });

  it('off: silent (operator opted out)', () => {
    expect(buildSandboxPreflightNotice('off', caps())).toBeNull();
  });

  it('auto degrading to soft: names the backend that WILL run and what is missing', () => {
    const n = buildSandboxPreflightNotice('auto', caps())!;
    expect(n).toContain('SOFT jail');
    expect(n).toContain('NOT OS confinement');
    expect(n).toContain('bubblewrap (bwrap) not found on PATH');
    expect(n).toContain('unshare not found or unprivileged user namespaces disabled');
  });

  it('auto degrading with unshare present-but-unused names it precisely', () => {
    const n = buildSandboxPreflightNotice('auto', caps({ unshare: null }))!;
    expect(n).toContain('unshare');
  });

  it('forced backend missing: warns before the mid-task failure', () => {
    expect(buildSandboxPreflightNotice('bubblewrap', caps())!).toContain('"bubblewrap"');
    expect(buildSandboxPreflightNotice('bubblewrap', caps())!).toContain('not found on PATH');
    expect(buildSandboxPreflightNotice('unshare', caps())!).toContain('"unshare"');
    expect(buildSandboxPreflightNotice('unshare', caps())!).toContain('user namespaces');
  });

  it('forced backend available: silent', () => {
    expect(buildSandboxPreflightNotice('bubblewrap', caps({ bubblewrap: '/usr/bin/bwrap' }))).toBeNull();
    expect(buildSandboxPreflightNotice('unshare', caps({ unshare: '/usr/bin/unshare' }))).toBeNull();
  });
});

describe('maybeSandboxPreflightNotice (startup hook)', () => {
  beforeEach(() => {
    _resetSandboxPreflightForTests();
  });

  it('prints once, then never again — even across entry points', () => {
    const lines: string[] = [];
    const print = (l: string) => lines.push(l);
    const degraded = { safety: { sandbox: 'auto' as const } };
    const softCaps = caps(); // bwrap/unshare absent on purpose
    expect(maybeSandboxPreflightNotice(degraded, print, softCaps)).toBe(true);
    expect(lines).toHaveLength(1);
    // A second call (another command in the same process) is a no-op.
    expect(maybeSandboxPreflightNotice(degraded, print, softCaps)).toBe(false);
    expect(lines).toHaveLength(1);
  });

  it('healthy host: prints nothing, but the once-guard still applies', () => {
    const lines: string[] = [];
    const healthy = caps({ bubblewrap: '/usr/bin/bwrap', autoBackend: 'bubblewrap', autoLevel: 'os' });
    expect(maybeSandboxPreflightNotice({ safety: { sandbox: 'auto' } }, (l) => lines.push(l), healthy)).toBe(false);
    expect(lines).toHaveLength(0);
    expect(maybeSandboxPreflightNotice({ safety: { sandbox: 'auto' } }, (l) => lines.push(l), healthy)).toBe(false);
    expect(lines).toHaveLength(0);
  });

  it('off: prints nothing even on a degraded host', () => {
    const lines: string[] = [];
    expect(maybeSandboxPreflightNotice({ safety: { sandbox: 'off' } }, (l) => lines.push(l), caps())).toBe(false);
    expect(lines).toHaveLength(0);
  });

  it('tolerates config-less callers', () => {
    const lines: string[] = [];
    expect(maybeSandboxPreflightNotice(undefined, (l) => lines.push(l), caps())).toBe(true);
    expect(lines).toHaveLength(1);
  });
});
