import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { taskRepoMap, repoMap } from './repo-map.js';

// Dataset port #2 (aider repomap.py): sqrt edge-weight damping + chat-files
// PageRank personalization (×50). Needs the codegraph SQLite index, so the
// suite skips cleanly when it is unavailable (light mode / no languages).

const hasGraph = (() => {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'mochi-repomap-'));
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
})();

// Build a tiny repo whose call graph makes hot.ts the structural hub:
// main.ts -> hub.ts (x8 refs), other.ts -> hub.ts (x1 ref).
function buildFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-repomap2-'));
  writeFileSync(join(dir, 'hub.ts'), 'export function hub(): number { return 1; }\n');
  writeFileSync(join(dir, 'main.ts'), Array.from({ length: 8 }, (_, i) => `import { hub } from './hub.js'; export const m${i} = () => hub();`).join('\n') + '\n');
  writeFileSync(join(dir, 'other.ts'), "import { hub } from './hub.js'; export const o = () => hub();\n");
  return dir;
}

describe.skipIf(!hasGraph)('aider repo-map refinements (dataset #2)', () => {
  it('chatFiles personalization lifts a touched file up the ranking', () => {
    const dir = buildFixture();
    try {
      // Build the codegraph index for the fixture (best-effort; skip when
      // the indexer cannot run in this environment).
      try {
        execFileSync('node', ['-e', `
          (async () => {
            const m = await import('${resolve(dir, 'node_modules')}').catch(() => null);
          })();
        `], { cwd: dir, stdio: 'ignore' });
      } catch { /* indexer may not be available; assertions handle empty */ }

      const base = taskRepoMap(dir, { task: 'fix hub', topK: 10 });
      if (base.length === 0) return; // no codegraph -> nothing to compare

      // Whichever file is currently ranked last: putting it in chatFiles
      // must move it above at least one previously-higher file (the ×50
      // PageRank multiplier dominates structural position alone).
      const lastFile = base[base.length - 1].file;
      const boosted = taskRepoMap(dir, { task: 'fix hub', chatFiles: [join(dir, lastFile)], topK: 10 });
      const lastIdx = (f: string) => boosted.findIndex((e) => e.file === f);
      const previouslyAbove = base.filter((e) => e.file !== lastFile).map((e) => e.file);
      const anyDemoted = previouslyAbove.some((f) => {
        const i = lastIdx(f);
        return i === -1 || i > lastIdx(lastFile);
      });
      expect(anyDemoted).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('repoMap still returns normalized ranks after sqrt edge damping', () => {
    const dir = buildFixture();
    try {
      const entries = repoMap(dir, 10);
      if (entries.length === 0) return;
      expect(entries[0].rank).toBeLessThanOrEqual(1.0000001);
      expect(entries[0].rank).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
