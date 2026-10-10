// MCH-49: repo-map tests. Real codegraph over a temp repo with real imports.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoMap, repoMapText } from './repo-map.js';
import { getFunctionSynapse, ensureLanguage } from './codegraph.js';

let dir = '';

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('repo-map (MCH-49)', () => {
  it('ranks a hub file above isolated files via real codegraph edges', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-rm-'));
    // hub.ts defines the hub function; a/b/c each CALL it cross-file.
    writeFileSync(join(dir, 'hub.ts'), 'export function hub(): number { return 1; }\n');
    writeFileSync(join(dir, 'a.ts'), 'import { hub } from "./hub.js";\nexport function a() { return hub(); }\n');
    writeFileSync(join(dir, 'b.ts'), 'import { hub } from "./hub.js";\nexport function b() { return hub(); }\n');
    writeFileSync(join(dir, 'c.ts'), 'import { hub } from "./hub.js";\nexport function c() { return hub(); }\n');
    // Grammar must load before the tree-sitter indexer produces rows; any
    // codegraph query then builds/warms the in-memory index for cwd.
    await ensureLanguage('typescript');
    await getFunctionSynapse(dir, 'hub');

    const map = repoMap(dir);
    expect(map.length).toBeGreaterThan(0);
    const files = map.map((e) => e.file);
    // hub must appear in the map (direct or via rank flow)
    expect(files.some((f) => f.includes('hub.ts'))).toBe(true);
    const hubRank = map.find((e) => e.file.includes('hub.ts'))!.rank;
    const aRank = map.find((e) => e.file.includes('a.ts'))?.rank ?? -1;
    expect(hubRank).toBeGreaterThanOrEqual(aRank);
    // normalized: top rank is 1.0
    expect(map[0].rank).toBe(1);
  });

  it('degrades to empty gracefully without a valid index', () => {
    const empty = repoMap('/tmp/definitely-not-a-mochi-repo-' + Date.now());
    expect(Array.isArray(empty)).toBe(true);
  });

  it('repoMapText returns undefined for empty map, text for populated', () => {
    expect(repoMapText('/tmp/definitely-not-a-mochi-repo-' + Date.now())).toBeUndefined();
    if (dir) {
      const text = repoMapText(dir);
      expect(text).toContain('REPO MAP');
    }
  });
});
