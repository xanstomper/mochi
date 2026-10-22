import { describe, it, expect } from 'vitest';
import { redact, maybeRedact, redactObject } from './security.js';

describe('security: redact', () => {
  it('redacts known secret shapes', () => {
    for (const s of ['sk-ant-12345678901234567890', 'AKIA0123456789ABCDEF', 'ghp_' + 'a'.repeat(36)] as any) {
      const input = `token=${s} ok`;
      expect(redact(input)).toContain('[secret-redacted]');
      expect(redact(input)).not.toContain(s);
    }
  });

  it('is idempotent', () => {
    const input = 'sk-ant-12345678901234567890';
    const once = redact(input);
    expect(redact(once)).toBe(once);
  });

  it('redacts env-style assignments', () => {
    expect(redact('DISCORD_BOT_TOKEN=abcsecretdef value')).toContain('[secret-redacted]');
    expect(redact('BLUEBUBBLES_PASSWORD=supersecret')).toContain('[secret-redacted]');
  });

  it('redacts bearer and basic JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redact(jwt)).toContain('[secret-redacted]');
    expect(redact('Authorization: Bearer ' + 'a'.repeat(32))).toContain('[secret-redacted]');
  });

  it('maybeRedact honours the 0 env switch (identity)', () => {
    const prev = process.env.MOCHI_REDACT_SECRETS;
    process.env.MOCHI_REDACT_SECRETS = '0';
    expect(maybeRedact('sk-ant-12345678901234567890')).toBe('sk-ant-12345678901234567890');
    if (prev === undefined) delete process.env.MOCHI_REDACT_SECRETS; else process.env.MOCHI_REDACT_SECRETS = prev;
  });

  it('redactObject masks sensitive keys', () => {
    const out = redactObject({ apiKey: 'very-secret-value', name: 'public', nested: { token: 'more-secret' } });
    expect(out.apiKey).toBe('[secret-redacted]');
    expect(out.nested.token).toBe('[secret-redacted]');
  });

  it('redacts a Discord-shaped three-part token (bounded pattern keeps real shapes)', () => {
    // Segments sized like a real Discord bot token (<= ~40 chars each).
    const tok = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTA' + '.' + 'AbCdEf' + '.' + 'xYz9BcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab';
    expect(redact(`token is ${tok} ok`)).toBe('token is [secret-redacted] ok');
  });

  it('does not hang on a long unbroken word-char run (ReDoS bound)', () => {
    // The unbounded three-part pattern scanned this quadratically
    // (200K chars ~ 218s). Bounded segments keep it linear-ish; the
    // assertion is correctness — the suite timeout is the perf bound.
    const run = 'x'.repeat(200_000);
    expect(redact(run)).toBe(run);
  });
});