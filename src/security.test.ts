// Differential parity: the native Rust secret-redaction must produce the
// SAME OUTPUT as the TypeScript regex pass on every test case — including
// adversarial placements (inside JSON, code blocks, base64, URLs, multiple
// keys per line, mixed casing for bearer, all GitHub / Slack variants).
//
// If the native addon is not built, this suite self-skips — the TS
// implementation is still tested by `src/security.test.ts`.

import { describe, it, expect } from 'vitest';
import { redact } from './security.js';
import { isNativeCoreAvailable, nativeRedactSecrets } from './native/core.js';

const KEY_CASES: Array<[string, string]> = [
  // Each entry: (label, input). The label appears in the failure message.
  ['openai style',           'cfg.api_key="sk-abcdefghijklmnop1234"'],
  ['anthropic',              'env.MOCHI_KEY=sk-ant-abcdefghijklmnop1234'],
  ['google aiza',            'GOOGLE_KEY=AIzaSyA-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
  ['github ghp',             'token=ghp_abcdefghijklmnop1234xx'],
  ['github gho',             'token=gho_abcdefghijklmnop1234xx'],
  ['github ghu',             'token=ghu_abcdefghijklmnop1234xx'],
  ['github ghs',             'token=ghs_abcdefghijklmnop1234xx'],
  ['github ghr',             'token=ghr_abcdefghijklmnop1234xx'],
  ['aws access key',         'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
  ['jwt 3-part',             'auth: eyJabcdefghijkl.eyJabcdefghijkl.signature123abc'],
  ['bearer lower',           'Authorization: bearer abcdefghijklmnopqrst1234'],
  ['bearer upper',           'AUTHORIZATION: BEARER abcdefghijklmnopqrst1234'],
  ['bearer title',           'Authorization: Bearer abcdefghijklmnopqrst1234'],
  ['rsa private key',        '-----BEGIN RSA PRIVATE KEY----- data'],
  ['openssh private key',    '-----BEGIN OPENSSH PRIVATE KEY----- data'],
  ['ec private key',         '-----BEGIN EC PRIVATE KEY----- data'],
  ['encrypted private key',  '-----BEGIN ENCRYPTED PRIVATE KEY----- data'],
  ['slack xoxb',             'slack: xoxb-1234567890-abcdef'],
  ['slack xoxa',             'slack: xoxa-1234567890-abcdef'],
  ['slack xoxp',             'slack: xoxp-1234567890-abcdef'],
  ['slack xoxr',             'slack: xoxr-1234567890-abcdef'],
  ['slack xoxs',             'slack: xoxs-1234567890-abcdef'],
  ['gitlab pat',             'token=glpat-Abcdefghijklmnopqrstuv'],
  // No-secret inputs (must be passed through untouched).
  ['empty',                  ''],
  ['no secret english',      'Hello world, this string has no secrets in it at all.'],
  ['short sk does not match', 'tag=sk-abc, other stuff'],
  ['eyJ without 2 dots',     'eyJabcdefghijkl'], // not a JWT — no two clauses
  // Adversarial placements.
  ['inside JSON value',      '{"api_key":"sk-abcdefghijklmnop1234","ok":true}'],
  ['inside code fence',      "```js\nconst k='sk-abcdefghijklmnop1234';\n```"],
  ['inside URL query',       'https://api.example.com/?key=sk-abcdefghijklmnop1234'],
  ['inside base64 blob',     Buffer.from('token: sk-abcdefghijklmnop1234').toString('base64')],
  ['multiple in one line',   'sk-abcdefghijklmnop1234 then AKIAIOSFODNN7EXAMPLE then glpat-Abcdefghijklmnopqrstuv'],
  ['utf-8 around key',       'Hello 🎉 sk-abcdefghijklmnop1234 world ✨'],
  ['idempotent input',       '[secret-redacted] more text and sk-abcdefghijklmnop1234'],
  ['large clean text',       'a'.repeat(2000)],
  ['large with single key',  ('a'.repeat(500) + ' sk-abcdefghijklmnop1234 ' + 'a'.repeat(500))],
  ['trailing whitespace',    '   sk-abcdefghijklmnop1234   '],
  ['two adjacent keys',      'sk-aaaaaaaaaaaaaaaa1111sk-bbbbbbbbbbbbbbbb2222'],
  ['key at end of input',    'prefix: sk-abcdefghijklmnop1234'],
  ['key at start of input',  'sk-abcdefghijklmnop1234 suffix'],
];

describe('redact() parity — TypeScript vs Rust native', () => {
  for (const [label, input] of KEY_CASES) {
    it(`matches TS for: ${label}`, () => {
      const ts = redact(input);
      // Native is consulted by redact() itself; this assertion is only
      // meaningful when the native addon is loaded (otherwise the call
      // is the TS path by definition).
      if (isNativeCoreAvailable() && nativeRedactSecrets) {
        const rust = nativeRedactSecrets(input);
        if (rust !== null) {
          expect(rust, `rust=${JSON.stringify(rust)} ts=${JSON.stringify(ts)}`).toBe(ts);
        }
      }
      // Idempotence: re-redacting yields the same string.
      expect(redact(ts), `not idempotent for ${label}`).toBe(ts);
    });
  }
});

describe('nativeRedactSecrets edge cases', () => {
  it('returns null on null/undefined callers (TS contract — empty passthrough)', () => {
    // The native wrapper returns '' for empty input (security.ts treats that
    // specially as "no redaction needed"); the security.ts `redact()` itself
    // short-circuits on empty input before calling native. Verify the
    // passthrough at the wrapper level is well-defined.
    const out = nativeRedactSecrets('');
    expect(out === null || out === '').toBe(true);
  });

  it('redacts 100KB synthetic tool output without truncating', () => {
    const big = ('lorem ipsum sk-abcdefghijklmnop1234 dolor sit amet '.repeat(1500));
    if (isNativeCoreAvailable() && nativeRedactSecrets) {
      const out = nativeRedactSecrets(big);
      if (out !== null) {
        // No raw key bytes should remain.
        expect(out).not.toContain('sk-abcdefghijklmnop1234');
        // The redaction marker must appear 1500 times.
        expect((out.match(/\[secret-redacted\]/g) || []).length).toBe(1500);
      }
    }
  });
});
