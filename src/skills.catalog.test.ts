// skills.ts: bundled catalog discovery + loadAllSkills shadowing.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { loadAllSkills, bundledSkillsDir, discoverSkills } from './skills.js';

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
    expect(files.some((s) => s.name === 'fullstack-dev')).toBe(true);
    expect(files.some((s) => s.name === 'security-audit')).toBe(true);
    expect(files.some((s) => s.name === 'database-optimizer')).toBe(true);
    expect(files.some((s) => s.name === 'devops-ci')).toBe(true);
    expect(files.some((s) => s.name === 'reverse-engineering')).toBe(true);
  });

  it('loadAllSkills includes both bundle and project skills', () => {
    const { skills } = loadAllSkills(dir);
    expect(skills.some((s) => s.name === 'project-skill')).toBe(true);
    expect(skills.some((s) => s.name === 'fullstack-dev')).toBe(true);
  });

  it('project skill shadows a bundled skill with the same name', () => {
    // Create a project skill named fullstack-dev to verify shadowing order.
    mkdirSync(join(dir, '.mochi', 'skills', 'fullstack-dev'), { recursive: true });
    writeFileSync(join(dir, '.mochi', 'skills', 'fullstack-dev', 'SKILL.md'), [
      '---',
      'name: fullstack-dev',
      'description: MY fullstack override',
      '---',
      '# Override',
    ].join('\n'));
    const { skills } = loadAllSkills(dir);
    const override = skills.find((s) => s.name === 'fullstack-dev');
    expect(override?.description).toBe('MY fullstack override');
  });
});