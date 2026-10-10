// MCH-48: cross-session read-cache persistence.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, utimesSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveReadCache, loadReadCache } from './read-cache-store.js';

const dir = mkdtempSync(join(tmpdir(), 'mochi-rc-'));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('read-cache-store (MCH-48)', () => {
  it('saves and rehydrates valid entries (mtime+size match)', () => {
    const f = join(dir, 'a.ts');
    writeFileSync(f, 'export const a = 1;');
    const st = statSync(f);
    const cache = new Map([[f, { mtimeMs: st.mtimeMs, size: st.size, content: 'export const a = 1;' }]]);
    saveReadCache(dir, cache);
    const loaded = loadReadCache(dir);
    expect(loaded.get(f)?.content).toBe('export const a = 1;');
  });

  it('drops stale entries whose file changed', () => {
    const f = join(dir, 'b.ts');
    writeFileSync(f, 'v1');
    const st = statSync(f);
    saveReadCache(dir, new Map([[f, { mtimeMs: st.mtimeMs, size: st.size, content: 'v1' }]]));
    // Touch the file → mtime changes → entry invalid
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(loadReadCache(dir).get(f)).toBeUndefined();
  });

  it('cold start on missing/corrupt store', () => {
    expect(loadReadCache(join(dir, 'nope')).size).toBe(0);
    writeFileSync(join(dir, 'read-cache.json'), '{not json');
    expect(loadReadCache(dir).size).toBe(0);
  });

  it('bounds store to 200 entries, largest content first', () => {
    const big = new Map<string, { mtimeMs: number; size: number; content: string }>();
    const boundDir = join(dir, 'bound');
    mkdirSync(boundDir, { recursive: true });
    for (let i = 0; i < 250; i++) {
      const f = join(boundDir, `gen-${i}.txt`);
      writeFileSync(f, `content ${i}`);
      const st = statSync(f);
      big.set(f, { mtimeMs: st.mtimeMs, size: st.size, content: `content ${i}` });
    }
    saveReadCache(boundDir, big);
    expect(loadReadCache(boundDir).size).toBe(200);
    rmSync(boundDir, { recursive: true, force: true });
  });
});
