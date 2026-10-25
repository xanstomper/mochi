import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadSkillFile,
  bundledSkillsDir,
  parseFrontmatter,
} from './skills/skills.js';
import { lintSkillDoc } from './skills/skill-lint.js';

describe('redteam-review skill', () => {
  it('is bundled, loads, and passes the skill quality gate', () => {
    const filePath = join(bundledSkillsDir(), 'redteam-review', 'SKILL.md');
    const { skill, diagnostics } = loadSkillFile(filePath);
    expect(diagnostics).toEqual([]);
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe('redteam-review');

    const raw = readFileSync(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(raw);
    const description = frontmatter['description'];
    expect(typeof description).toBe('string');
    const result = lintSkillDoc(
      'redteam-review',
      description as string,
      body,
    );
    expect(result.ok).toBe(true);
    expect(
      result.issues.filter((i) => i.severity === 'error'),
    ).toEqual([]);
  });
});
