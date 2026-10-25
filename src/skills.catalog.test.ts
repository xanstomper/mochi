// skills.ts: bundled catalog discovery + loadAllSkills shadowing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { loadAllSkills, bundledSkillsDir, discoverSkills } from './skills/skills.js';

let dir: string;
beforeAll(() => {
  // A fake project with its own skills dir (to test shadowing).
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-skillscat-'));
  mkdirSync(join(dir, '.mochi', 'skills', 'project-skill'), { recursive: true });
  writeFileSync(join(dir, '.mochi', 'skills', 'project-skill', 'SKILL.md'), [
    '---',
    'name: project-skill',
    'description: project-specific workflow',
    '---',
    '# Project Skill',
    'Do things the project way.',
  ].join('\n'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('bundled skills catalog', () => {
  it('exposes a shipped skills dir', () => {
    const dir2 = bundledSkillsDir();
    expect(dir2).toBeTruthy();
    const files = discoverSkills(dir2 as string).skills;
    // Culled stubs (fullstack-dev, security-audit, devops-ci, reverse-engineering)
    // replaced by procedure skills — assert on the new floor.
    expect(files.some((s) => s.name === 'native-core-port')).toBe(true);
    expect(files.some((s) => s.name === 'exec-policy')).toBe(true);
    expect(files.some((s) => s.name === 'database-optimizer')).toBe(true);
    expect(files.some((s) => s.name === 'tdd-workflow')).toBe(true);
  });

  it('loadAllSkills includes both bundle and project skills', () => {
    const { skills } = loadAllSkills(dir);
    expect(skills.some((s) => s.name === 'project-skill')).toBe(true);
    expect(skills.some((s) => s.name === 'native-core-port')).toBe(true);
  });

  it('project skill shadows a bundled skill with the same name', () => {
    // Create a project skill named exec-policy to verify shadowing order.
    mkdirSync(join(dir, '.mochi', 'skills', 'exec-policy'), { recursive: true });
    writeFileSync(join(dir, '.mochi', 'skills', 'exec-policy', 'SKILL.md'), [
      '---',
      'name: exec-policy',
      'description: MY exec override',
      '---',
      '# Override',
    ].join('\n'));
    const { skills } = loadAllSkills(dir);
    const override = skills.find((s) => s.name === 'exec-policy');
    expect(override?.description).toBe('MY exec override');
  });
});