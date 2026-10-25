import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadSkillFile,
  bundledSkillsDir,
  parseFrontmatter,
} from './skills/skills.js';
import { lintSkillDoc } from './skills/skill-lint.js';

describe('effort-stakes skill', () => {
  it('is bundled, loads, and passes the skill quality gate', () => {
    const filePath = join(bundledSkillsDir(), 'effort-stakes', 'SKILL.md');
    const { skill, diagnostics } = loadSkillFile(filePath);
    expect(diagnostics).toEqual([]);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('effort-stakes');

    const raw = readFileSync(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);
    const description = frontmatter['description'];
    expect(typeof description).toBe('string');
    const result = lintSkillDoc(
      'effort-stakes',
      description as string,
      body,
    );
    expect(result.ok).toBe(true);
    expect(
      result.issues.filter((i) => i.severity === 'error'),
    ).toEqual([]);
  });
});
