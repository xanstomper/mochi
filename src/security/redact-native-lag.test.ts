// Parity contract for redact(): the native Rust mirror
// (native/mochi_core/src/redact.rs) runs FIRST as an accelerator, and the
// TS SECRET_PATTERNS pass always runs over its output — the same
// composition classifyCommand uses. The mirror's hand-maintained pattern
// list has lagged TS before (Discord webhook URLs were missing there), and
// the old short-circuit on a non-null native result silently skipped every
// TS-only pattern on native hosts. These tests pin the composed behavior
// with controllable native doubles: subset-lagging, identity, unavailable
// (null), and native-only coverage.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const nativeMock = vi.hoisted(() => ({
  impl: (_s: string): string | null => null,
}));

vi.mock('../native/core.js', () => ({
  nativeRedactSecrets: (s: string) => nativeMock.impl(s),
  nativeClassifyCommand: () => null,
}));

import { redact } from './security.js';

// Assembled to avoid tripping secret-scanners — these are fake fixtures.
const skKey = 'sk-' + 'abcdefghij'.repeat(2) + '12345678';
const webhook = 'https://discordapp.com/api/webhooks/' + '123456789012345678' + '/' + 'AbCdEfGhIjKlMnOpQrStUv';
const ghKey = 'ghp_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

beforeEach(() => {
  nativeMock.impl = () => null;
});

describe('redact() — native/TS parity composition', () => {
  it('native unavailable (null): TS pass alone redacts everything', () => {
    nativeMock.impl = () => null;
    const out = redact(`key=${skKey} hook=${webhook} gh=${ghKey}`);
    expect(out).not.toContain(skKey);
    expect(out).not.toContain(webhook);
    expect(out).not.toContain(ghKey);
  });

  it('lagging mirror (identity result): TS patterns still apply in full', () => {
    nativeMock.impl = (s) => s;
    const out = redact(`posted ${webhook} in channel`);
    expect(out).toContain('[secret-redacted]');
    expect(out).not.toContain(webhook);
    expect(redact(`cfg.api_key=${skKey}`)).not.toContain(skKey);
  });

  it('subset mirror (redacts only sk- keys): TS-only patterns still caught', () => {
    nativeMock.impl = (s) => s.replace(/sk-[A-Za-z0-9_-]{16,}/g, '[secret-redacted]');
    const out = redact(`key=${skKey} hook=${webhook}`);
    expect(out).not.toContain(skKey); // native caught this one
    expect(out).not.toContain(webhook); // native missed it; TS pass caught it
    expect(out).toContain('[secret-redacted]');
  });

  it('native-only coverage is preserved (native result is composed, not discarded)', () => {
    nativeMock.impl = (s) => s.replaceAll('native-only-secret', '[secret-redacted]');
    const out = redact('leaked native-only-secret and ' + skKey);
    expect(out).not.toContain('native-only-secret');
    expect(out).not.toContain(skKey);
  });

  it('remains idempotent through the composed pass', () => {
    nativeMock.impl = (s) => s;
    const once = redact('DISCORD_BOT_TOKEN=abcsecretdef value');
    expect(redact(once)).toBe(once);
  });
});
