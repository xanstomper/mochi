import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { runSkillDoctor, extractVerificationSnippet } from './skill-curator.js';
import { markUsed, archiveRoot } from './skill-manager.js';

describe('Skill Regression Doctor (MCH-20)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(resolve(tmpdir(), 'mochi-skill-doc-test-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('extracts verification snippets from frontmatter, comments, or fences', () => {
    const text1 = `---
name: test-skill
verification: echo "hello world"
---
# Test Body`;
    expect(extractVerificationSnippet(text1)).toBe('echo "hello world"');

    const text2 = `---
name: test-skill
---
<!-- mochi:verify
node -e "process.exit(0)"
-->`;
    expect(extractVerificationSnippet(text2)).toBe('node -e "process.exit(0)"');

    const text3 = `---
name: test-skill
---
\`\`\`bash verify
npm test
\`\`\``;
    expect(extractVerificationSnippet(text3)).toBe('npm test');

    const text4 = `---
name: test-skill
---
# verify: python3 -c "print(1)"`;
    expect(extractVerificationSnippet(text4)).toBe('python3 -c "print(1)"');
  });

  it('identifies healthy skills and empty/missing-frontmatter degraded skills', () => {
    const skillsDir = join(projectDir, '.mochi', 'skills');
    mkdirSync(join(skillsDir, 'good-skill'), { recursive: true });
    writeFileSync(
      join(skillsDir, 'good-skill', 'SKILL.md'),
      `---\nname: good-skill\ndescription: A healthy skill\n---\n# Content\nFollow these steps.`,
      'utf8',
    );

    mkdirSync(join(skillsDir, 'empty-skill'), { recursive: true });
    writeFileSync(join(skillsDir, 'empty-skill', 'SKILL.md'), '', 'utf8');

    mkdirSync(join(skillsDir, 'no-fm-skill'), { recursive: true });
    writeFileSync(join(skillsDir, 'no-fm-skill', 'SKILL.md'), '# Just markdown without frontmatter', 'utf8');

    const report = runSkillDoctor(projectDir, { executeSnippets: false });
    expect(report.scanned).toBe(3);
    expect(report.healthy).toBe(1);
    expect(report.failures.length).toBe(2);

    const emptyFail = report.failures.find((f) => f.name === 'empty-skill');
    expect(emptyFail).toBeDefined();
    expect(emptyFail?.kind).toBe('empty');

    const fmFail = report.failures.find((f) => f.name === 'no-fm-skill');
    expect(fmFail).toBeDefined();
    expect(fmFail?.kind).toBe('missing-frontmatter');

    expect(existsSync(report.reportPath)).toBe(true);
  });

  it('runs verification snippet successfully and resets consecutive failures', () => {
    const skillsDir = join(projectDir, '.mochi', 'skills', 'verified-skill');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, 'SKILL.md'),
      `---\nname: verified-skill\nverification: exit 0\n---\n# Verified Skill\nAlways works.`,
      'utf8',
    );

    const report = runSkillDoctor(projectDir, { executeSnippets: true });
    expect(report.scanned).toBe(1);
    expect(report.healthy).toBe(1);
    expect(report.failures.length).toBe(0);
  });

  it('tracks failure and auto-archives agent skill after 2 consecutive failures', () => {
    const skillsDir = join(projectDir, '.mochi', 'skills', 'broken-agent-skill');
    mkdirSync(skillsDir, { recursive: true });
    const skillPath = join(skillsDir, 'SKILL.md');
    writeFileSync(
      skillPath,
      `---\nname: broken-agent-skill\nverification: exit 1\n---\n# Broken Skill\nFails on purpose.`,
      'utf8',
    );

    // Register as agent-created in usage registry
    markUsed(projectDir, 'broken-agent-skill', { agentCreated: true });

    // Run 1: first failure recorded
    const report1 = runSkillDoctor(projectDir, { executeSnippets: true, maxConsecutiveFailures: 2 });
    expect(report1.failures.length).toBe(1);
    expect(report1.failures[0].consecutiveFailures).toBe(1);
    expect(report1.failures[0].archived).toBe(false);
    expect(existsSync(skillPath)).toBe(true);

    // Run 2: second consecutive failure triggers auto-archive
    const report2 = runSkillDoctor(projectDir, { executeSnippets: true, maxConsecutiveFailures: 2, autoArchive: true });
    expect(report2.failures.length).toBe(1);
    expect(report2.failures[0].consecutiveFailures).toBe(2);
    expect(report2.failures[0].archived).toBe(true);
    expect(report2.archived).toContain('broken-agent-skill');

    // Live skill file should now be archived
    expect(existsSync(skillPath)).toBe(false);
    const archivedPath = join(archiveRoot(projectDir), 'broken-agent-skill', 'SKILL.md');
    expect(existsSync(archivedPath)).toBe(true);
  });
});
