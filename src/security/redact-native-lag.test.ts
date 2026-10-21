// Regression: redact() used to return the native redaction result directly
// whenever the native core was available, so any pattern lag between the
// Rust mirror (native/mochi_core/src/redact.rs) and TS SECRET_PATTERNS
// silently skipped the TS patterns — e.g. Discord webhook URLs were in TS
// but missing from the Rust mirror, so on a native host they survived
// redaction. redact() now runs the TS patterns unconditionally (single
// source of truth); this test simulates a lagging native mirror.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../native/core.js', () => ({
  // Native "available" but pattern-lagged: returns its input untouched
  // (none of the TS-only patterns applied).
  nativeRedactSecrets: (s: string) => s,
  nativeClassifyCommand: () => null,
}));

import { redact } from './security.js';

// Assembled to avoid tripping secret-scanners — these are fake fixtures.
const skKey = 'sk-' + 'abcdefghij'.repeat(2) + '12345678';
const webhook = 'https://discordapp.com/api/webhooks/' + '123456789012345678' + '/' + 'AbCdEfGhIjKlMnOpQrStUv';

describe('redact() — native mirror lag must not skip TS patterns', () => {
  it('redacts a Discord webhook URL even when native returns unchanged text', () => {
    const out = redact(`posted ${webhook} in channel`);
    expect(out).toContain('[secret-redacted]');
    expect(out).not.toContain(webhook);
  });

  it('redacts OpenAI-style keys the lagging native mirror missed', () => {
    const out = redact(`cfg.api_key=${skKey}`);
    expect(out).toContain('[secret-redacted]');
    expect(out).not.toContain(skKey);
  });

  it('remains idempotent through the TS pass', () => {
    const once = redact('DISCORD_BOT_TOKEN=abcsecretdef value');
    expect(redact(once)).toBe(once);
  });
});
