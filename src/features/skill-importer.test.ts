import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFileCb);
import {
  importSkills,
  resolveSkillSource,
  originForSource,
  discoverSourceSkills,
  installedSkillNames,
  isGitSourceSpec,
  resolveSourceDir,
} from './skill-importer.js';

describe('skill-importer', () => {
  let tmp: string;
  let fixture: string;

  beforeAll(() => {
    tmp = mkdtempUnder();
    fixture = join(tmp, 'fixture');
    // Build a small external skills tree in the agentskills.io format.
    const cat = join(fixture, 'research');
    mkdirSync(join(cat, 'arxiv', 'references'), { recursive: true });
    writeFileSync(join(cat, 'arxiv', 'SKILL.md'), [
      '---',
      'name: arxiv',
      'description: Search arXiv papers.',
      '---',
      '',
      '# arXiv',
      'Use the API to search.',
      '',
    ].join('\n'));
    writeFileSync(join(cat, 'arxiv', 'references', 'guide.md'), '# ref');
    mkdirSync(join(fixture, 'dev'));
    writeFileSync(join(fixture, 'dev', 'SKILL.md'), '---\nname: tooling-dev\ndescription: Dev tooling.\n---\n\nbody\n');
    writeFileSync(join(fixture, 'ignore-me.txt'), 'not a skill');
  });

  afterAll(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('resolveSkillSource maps the hermes: alias', () => {
    const root = resolveSkillSource('hermes:');
    expect(root).toBeTruthy();
    if (root) expect(root.endsWith(join('.hermes', 'skills')) || root.includes('.hermes')).toBe(true);
  });

  it('resolveSkillSource resolves a plain dir', () => {
    expect(resolveSkillSource(fixture)).toBe(fixture);
    expect(resolveSkillSource('does-not-exist-xyz')).toBeNull();
  });

  it('originForSource derives a slug from the dir', () => {
    expect(originForSource(fixture, fixture)).toBe('fixture');
    expect(originForSource('/x/y/.hermes/skills', 'hermes:')).toBe('hermes');
  });

  it('discoverSourceSkills finds SKILL.md roots and drops non-skill files', () => {
    const { skills, errors } = discoverSourceSkills(fixture);
    expect(errors).toEqual([]);
    const names = skills.map((s) => s.name).sort();
    expect(names).toContain('arxiv');
    expect(names).toContain('tooling-dev');
    expect(skills.some((s) => s.path.endsWith('ignore-me.txt'))).toBe(false);
  });

  it('importSkills copies into an origin-namespaced tree and carries references', async () => {
    const target = join(tmp, 'out');
    const rep = await importSkills({ source: fixture, targetRoot: target, origin: 'test' });
    expect(rep.origin).toBe('test');
    expect(rep.errors).toEqual([]);
    expect(rep.imported.map((i) => i.name).sort()).toEqual(['arxiv', 'tooling-dev']);
    expect(existsSync(join(target, 'arxiv', 'SKILL.md'))).toBe(true);
    // references/ travelled with the skill
    expect(existsSync(join(target, 'arxiv', 'references', 'guide.md'))).toBe(true);
    // provenance marker written
    expect(readFileSync(join(target, 'arxiv', '.origin'), 'utf8').trim()).toBe('test');
  });

  it('is idempotent and non-destructive without force', async () => {
    const target = join(tmp, 'out2');
    await importSkills({ source: fixture, targetRoot: target, origin: 'o1' });
    const second = await importSkills({ source: fixture, targetRoot: target, origin: 'o1' });
    expect(second.imported).toEqual([]);
    expect(second.skipped.every((s) => s.reason.includes('already installed'))).toBe(true);
  });

  it('overwrites when force=true', async () => {
    const target = join(tmp, 'out3');
    await importSkills({ source: fixture, targetRoot: target, origin: 'o' });
    writeFileSync(join(target, 'arxiv', 'SKILL.md'), '---\nname: arxiv\ndescription: old.\n---\n\nold\n');
    const rep = await importSkills({ source: fixture, targetRoot: target, origin: 'o', force: true });
    expect(rep.imported.some((i) => i.name === 'arxiv')).toBe(true);
    expect(readFileSync(join(target, 'arxiv', 'SKILL.md'), 'utf8')).toContain('# arXiv');
  });

  it('installedSkillNames reflects existing roots', async () => {
    const target = join(tmp, 'out4');
    await importSkills({ source: fixture, targetRoot: target, origin: 'o' });
    const names = installedSkillNames([target]);
    expect(names.has('arxiv')).toBe(true);
    expect(names.has('nope')).toBe(false);
  });

  it('isGitSourceSpec recognizes github:/git URLs and rejects plain paths', () => {
    expect(isGitSourceSpec('github:owner/repo')).toBe(true);
    expect(isGitSourceSpec('git+https://gihub.com/o/r.git')).toBe(true);
    expect(isGitSourceSpec('https://github.com/o/r.git')).toBe(true);
    expect(isGitSourceSpec('git@github.com:o/r.git')).toBe(true);
    expect(isGitSourceSpec('/home/me/skills')).toBe(false);
    expect(isGitSourceSpec('hermes:')).toBe(false);
    expect(isGitSourceSpec('')).toBe(false);
  });

  it('resolveSourceDir returns local/known roots and reports unresolvable plain paths', async () => {
    // Local dir passes through.
    expect((await resolveSourceDir(fixture)).dir).toBe(fixture);
    // A plain non-existent path with no git marker yields an error, not a clone.
    const missing = await resolveSourceDir('/does/not/exist-xyz');
    expect(missing.dir).toBeNull();
    expect(missing.error).toMatch(/no such source path/);
  });

  it('resolveSourceDir clones a git URL into the cache (local file:// repo)', async () => {
    // Create a small local git repo to clone from deterministically (no network).
    const repoDir = join(tmp, 'local-skills-repo');
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, 'SKILL.md'), '---\nname: local-skill\ndescription: d.\n---\n\nbody\n');
    const git = (args: string[], cwd = repoDir) => execFileAsync('git', args, { cwd });
    await git(['init', '-q']);
    await git(['config', 'user.email', 't@t']);
    await git(['config', 'user.name', 't']);
    await git(['add', '.']);
    await git(['commit', '-qm', 'init']);

    // Make a bare repo so `file://<path>.git` exists (git clones bare repos directly).
    const bareDir = `${repoDir}.git`;
    await git(['clone', '--bare', repoDir, bareDir]);
    const url = `file://${bareDir}`;
    const rep = await resolveSourceDir(url);
    expect(rep.dir).toBeTruthy();
    if (rep.dir) {
      expect(existsSync(join(rep.dir, '.git'))).toBe(true);
      // The importer can now read the cloned tree.
      const { discoverSourceSkills } = await import('./skill-importer.js');
      const { skills } = discoverSourceSkills(rep.dir);
      expect(skills.some((s) => s.name === 'local-skill')).toBe(true);
    }
  });
});

function mkdtempUnder(): string {
  const base = join(tmpdir(), `mochi-skill-import-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(base, { recursive: true });
  return base;
}