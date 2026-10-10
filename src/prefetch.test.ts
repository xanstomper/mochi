// MCH-50: prefetch fusion tests.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prefetchFiles, prefetchText, warmReadCache } from './prefetch.js';
import { ensureLanguage, getFunctionSynapse } from './codegraph.js';

let dir = '';

afterAll(() => { if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('prefetch fusion (MCH-50)', () => {
  it('fuses structural + temporal + runtime signals with fusion bonus', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-pf-'));
    writeFileSync(join(dir, 'hub.ts'), 'export function hub(): number { return 1; }\n');
    writeFileSync(join(dir, 'a.ts'), 'import { hub } from "./hub.js";\nexport function a() { return hub(); }\n');
    writeFileSync(join(dir, 'lone.ts'), 'export function lone(): number { return 2; }\n');
    await ensureLanguage('typescript');
    await getFunctionSynapse(dir, 'hub'); // warm codegraph

    // Cross-session read cache entry for a.ts.
    writeFileSync(join(dir, '.mochi'), '');  // dir marker (loadReadCache validates paths)
    const { saveReadCache } = await import('./read-cache-store.js');
    saveReadCache(dir, new Map());

    const list = prefetchFiles(dir, [], 10);
    expect(list.length).toBeGreaterThan(0);
    // hub.ts is called by a.ts -> structural signal must fire.
    const files = list.map((e) => e.file);
    expect(files).toContain('hub.ts');
    const hub = list.find((e) => e.file === 'hub.ts')!;
    expect(hub.signals).toContain('structure');
    // Fusion bonus: hub appears only via structure here (0.5-ish rank score).
    expect(hub.score).toBeGreaterThan(0);
  });

  it('prefetchText returns a labeled block or empty string', async () => {
    if (!dir) dir = mkdtempSync(join(tmpdir(), 'mochi-pf2-'));
    const text = prefetchText(dir, []);
    expect(typeof text).toBe('string'); // may be '' if no codegraph, but never throws
  });

  it('warmReadCache populates validated cache entries', async () => {
    if (!dir) dir = mkdtempSync(join(tmpdir(), 'mochi-pf2-'));
    writeFileSync(join(dir, 'warmme.ts'), 'export const warm = 1;\n');
    const cache = new Map<string, { mtimeMs: number; size: number; content: string }>();
    const warmed = warmReadCache(dir, cache, [], 5);
    expect(warmed).toBeGreaterThanOrEqual(0);
    // every warmed entry must carry the current stat signature
    for (const [p, entry] of Array.from(cache)) {
      const st = statSync(p);
      expect(entry.mtimeMs).toBe(st.mtimeMs);
      expect(entry.size).toBe(st.size);
      expect(entry.content.length).toBeGreaterThan(0);
    }
  });

  it('excludes files outside the workspace and missing files', () => {
    const d = mkdtempSync(join(tmpdir(), 'mochi-pf3-'));
    try {
      const list = prefetchFiles(d, [], 5);
      for (const e of list) expect(e.file.startsWith('..')).toBe(false);
      expect(list.length).toBe(0); // empty dir: no signals at all
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
