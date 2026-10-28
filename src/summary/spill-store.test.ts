// D2: spill-store unit tests — content addressing, round-trip identity,
// marker resolvability, integrity verification, gitignore, key scanning.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  clearSpillStore, describeSpilledRef, retrieveSpilled, scanSpillRefs,
  spillContent, spillDirPath, spillKeyOf, spillMarker, SPILL_KEY_RE,
} from './spill-store.js';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-d2-spill-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('spill store: round trip (spill then retrieve identical content)', () => {
  it('retrieves exactly what was spilled', () => {
    const text = `line1\n${'x'.repeat(50_000)}\nEVIDENCE needle TS2345 at src/a.ts:12\nline3`;
    const ref = spillContent(dir, text, { tool: 'shell' });
    expect(ref).toBeTruthy();
    const hit = retrieveSpilled(dir, ref!.key)!;
    expect(hit).toBeTruthy();
    expect(hit.text).toBe(text); // identical content, byte for byte
    expect(hit.chars).toBe(text.length);
    expect(hit.key).toBe(ref!.key);
  });

  it('retrieves by a unique hash prefix', () => {
    const ref = spillContent(dir, `${'y'.repeat(5000)} unique-prefix-content`, {});
    expect(ref).toBeTruthy();
    const hit = retrieveSpilled(dir, ref!.key.slice(0, 10)); // 'spill-' + 4 hex
    expect(hit).toBeTruthy();
    expect(hit!.key).toBe(ref!.key);
  });

  it('returns null for unknown keys and malformed keys', () => {
    expect(retrieveSpilled(dir, 'spill-0000000000000000')).toBeNull();
    expect(retrieveSpilled(dir, 'not-a-key')).toBeNull();
    expect(retrieveSpilled(dir, '')).toBeNull();
  });

  it('refuses to resolve corrupted content (wrong evidence is worse than none)', () => {
    const text = 'integrity-check payload '.repeat(400);
    const ref = spillContent(dir, text, {})!;
    const file = resolve(spillDirPath(dir), `${ref.key.slice('spill-'.length)}.txt`);
    writeFileSync(file, 'TAMPERED', 'utf8');
    expect(retrieveSpilled(dir, ref.key)).toBeNull();
  });
});

describe('spill store: content addressing', () => {
  it('identical content spills to the identical key (idempotent, deduped)', () => {
    const text = 'same content '.repeat(2000);
    const a = spillContent(dir, text, { tool: 'read' });
    const b = spillContent(dir, text, { tool: 'shell' });
    expect(a!.key).toBe(b!.key);
    // One file on disk for one content.
    const files = readdirSync(spillDirPath(dir)).filter((f) => f.endsWith('.txt'));
    expect(files.length).toBe(1);
  });

  it('different content gets different keys', () => {
    const a = spillContent(dir, 'content A '.repeat(2000), {});
    const b = spillContent(dir, 'content B '.repeat(2000), {});
    expect(a!.key).not.toBe(b!.key);
  });

  it('keys are content hashes: spillKeyOf is deterministic and matches the stored file', () => {
    const text = 'hash me '.repeat(3000);
    const ref = spillContent(dir, text, {})!;
    expect(ref.key).toBe(spillKeyOf(text));
    expect(ref.key).toMatch(/^spill-[0-9a-f]{16}$/);
  });

  it('keeps the store local and gitignored', () => {
    spillContent(dir, 'gitignore me '.repeat(2000), {});
    const gi = resolve(spillDirPath(dir), '.gitignore');
    expect(existsSync(gi)).toBe(true);
    expect(readFileSync(gi, 'utf8')).toContain('*');
    // Local-only: everything lives under <root>/.mochi/spill/.
    expect(spillDirPath(dir)).toBe(resolve(dir, '.mochi', 'spill'));
  });

  it('returns null for empty content and never writes a file for it', () => {
    expect(spillContent(dir, '', {})).toBeNull();
    expect(existsSync(spillDirPath(dir))).toBe(false);
  });
});

describe('spill store: elision markers and key scanning', () => {
  it('marker names the key, the size, and the exact retrieval command', () => {
    const marker = spillMarker('spill-abcdef0123456789', { tool: 'shell', chars: 250_000 });
    expect(marker).toContain('spill-abcdef0123456789');
    expect(marker).toContain('250,000');
    expect(marker).toContain('recall_output key="spill-abcdef0123456789"');
  });

  it('scanSpillRefs finds every marker key exactly once, in order', () => {
    const text = [
      'before spill-aaaaaaaaaaaaaaaa middle',
      'spill-bbbbbbbbbbbbbbbb and spill-aaaaaaaaaaaaaaaa again',
      'spill-cccccccccccccccc end',
    ].join('\n');
    expect(scanSpillRefs(text)).toEqual(['spill-aaaaaaaaaaaaaaaa', 'spill-bbbbbbbbbbbbbbbb', 'spill-cccccccccccccccc']);
  });

  it('SPILL_KEY_RE does not match keys with wrong shapes', () => {
    expect(scanSpillRefs('spill-short spill-ABCDEF0123456789 spill-12345678901234567')).toEqual([]);
  });

  it('describeSpilledRef previews the content; unknown keys describe nothing', () => {
    const body = 'p'.repeat(4000 - 'PREVIEW-START '.length);
    const ref = spillContent(dir, `PREVIEW-START ${body}`, {})!;
    const desc = describeSpilledRef(dir, ref.key);
    expect(desc).toContain(ref.key);
    expect(desc).toContain('4,000 chars');
    expect(desc).toContain('PREVIEW-START');
    expect(describeSpilledRef(dir, 'spill-0000000000000000')).toBeNull();
  });

  it('clearSpillStore empties the store (tests)', () => {
    spillContent(dir, 'clear me '.repeat(2000), {});
    clearSpillStore(dir);
    expect(retrieveSpilled(dir, spillKeyOf('clear me '.repeat(2000)))).toBeNull();
  });
});
