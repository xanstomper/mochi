import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { skillsRoot, curateAutoSkills, usagePath } from './skill-manager.js';
import { skillTool } from './tools/skill.js';

const ws = mkdtempSync('/tmp/mochi-curate-');
const autoDir = join(skillsRoot(ws), 'auto');

function writeAuto(name: string, body = 'test skill body'): void {
  mkdirSync(autoDir, { recursive: true });
  writeFileSync(join(autoDir, `${name}.md`), body);
}

afterAll(() => rmSync(ws, { recursive: true, force: true }));

describe('curateAutoSkills', () => {
  it('archives never-used auto skills', async () => {
    writeAuto('never-used');
    const n = await curateAutoSkills(ws, { maxAgeMs: 0 });
    expect(n.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(autoDir, 'never-used.md'))).toBe(false);
    expect(existsSync(join(skillsRoot(ws), '.archive', 'never-used', 'never-used.md'))).toBe(true);
  });

  it('keeps recently-used auto skills', async () => {
    writeAuto('fresh');
    // Simulate a load via the real skill tool path: usagePath file with fresh lastUsedAt.
    mkdirSync(join(ws, '.mochi'), { recursive: true });
    writeFileSync(usagePath(ws), JSON.stringify({ fresh: { lastUsedAt: Date.now() } }));
    const n = await curateAutoSkills(ws, { maxAgeMs: 14 * 24 * 3600_000 });
    expect(existsSync(join(autoDir, 'fresh.md'))).toBe(true);
    expect(n.length).toBe(0);
  });

  it('archives auto skills whose last use expired', async () => {
    writeAuto('stale');
    mkdirSync(join(ws, '.mochi'), { recursive: true });
    writeFileSync(usagePath(ws), JSON.stringify({ stale: { lastUsedAt: Date.now() - 30 * 24 * 3600_000 } }));
    await curateAutoSkills(ws, { maxAgeMs: 14 * 24 * 3600_000 });
    expect(existsSync(join(autoDir, 'stale.md'))).toBe(false);
  });

  it('usagePath points at skill-meta.json (no schema collision with skills.ts)', () => {
    expect(usagePath(ws)).not.toContain('skill-usage.json');
    expect(usagePath(ws).endsWith('skill-meta.json')).toBe(true);
  });
});
