import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { skillsRoot, markUsed, curateAutoSkills, usagePath } from './skill-manager.js';
import { readFileSync } from 'node:fs';

const dir = mkdtempSync(join(tmpdir(), 'mochi-curate-'));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

function makeAutoSkill(ws: string, slug: string): void {
  const autoDir = join(skillsRoot(ws), 'auto');
  mkdirSync(autoDir, { recursive: true });
  writeFileSync(join(autoDir, `${slug}.md`), `---\nname: ${slug}\ndescription: auto\n---\nbody\n`);
}

describe('curateAutoSkills (MCH-56)', () => {
  it('archives never-used auto skills and returns their slugs', () => {
    const ws = join(dir, 'stale');
    makeAutoSkill(ws, 'tool-route-stale');
    const archived = curateAutoSkills(ws, { maxAgeMs: 1000 });
    expect(archived).toContain('tool-route-stale');
    expect(existsSync(join(skillsRoot(ws), 'auto', 'tool-route-stale.md'))).toBe(false);
    // Archived, not deleted: file lives under .archive/
    const arcDir = join(ws, '.mochi', 'skills', '.archive', 'tool-route-stale');
    expect(readdirSync(arcDir).length).toBeGreaterThan(0);
  });

  it('keeps recently used auto skills', () => {
    const ws = join(dir, 'fresh');
    makeAutoSkill(ws, 'tool-route-fresh');
    markUsed(ws, 'tool-route-fresh'); // lastUsedAt = now
    const archived = curateAutoSkills(ws, { maxAgeMs: 1000 });
    expect(archived).not.toContain('tool-route-fresh');
    expect(existsSync(join(skillsRoot(ws), 'auto', 'tool-route-fresh.md'))).toBe(true);
  });

  it('archives skills whose lastUsedAt is older than the window', () => {
    const ws = join(dir, 'old');
    makeAutoSkill(ws, 'tool-route-old');
    markUsed(ws, 'tool-route-old');
    // Force lastUsedAt far into the past.
    const usageFile = usagePath(ws);
    const db = JSON.parse(readFileSync(usageFile, 'utf8'));
    db['tool-route-old'].lastUsedAt = Date.now() - 30 * 24 * 3600_000;
    writeFileSync(usageFile, JSON.stringify(db));
    const archived = curateAutoSkills(ws, { maxAgeMs: 14 * 24 * 3600_000 });
    expect(archived).toContain('tool-route-old');
  });
});
