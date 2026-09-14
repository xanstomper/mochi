import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  importSkills,
  resolveSkillSource,
  originForSource,
  discoverSourceSkills,
  installedSkillNames,
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

  it('importSkills copies into an origin-namespaced tree and carries references', () => {
    const target = join(tmp, 'out');
    const rep = importSkills({ source: fixture, targetRoot: target, origin: 'test' });
    expect(rep.origin).toBe('test');
    expect(rep.errors).toEqual([]);
    expect(rep.imported.map((i) => i.name).sort()).toEqual(['arxiv', 'tooling-dev']);
    expect(existsSync(join(target, 'arxiv', 'SKILL.md'))).toBe(true);
    // references/ travelled with the skill
    expect(existsSync(join(target, 'arxiv', 'references', 'guide.md'))).toBe(true);
    // provenance marker written
    expect(readFileSync(join(target, 'arxiv', '.origin'), 'utf8').trim()).toBe('test');
  });

  it('is idempotent and non-destructive without force', () => {
    const target = join(tmp, 'out2');
    importSkills({ source: fixture, targetRoot: target, origin: 'o1' });
    const second = importSkills({ source: fixture, targetRoot: target, origin: 'o1' });
    expect(second.imported).toEqual([]);
    expect(second.skipped.every((s) => s.reason.includes('already installed'))).toBe(true);
  });

  it('overwrites when force=true', () => {
    const target = join(tmp, 'out3');
    importSkills({ source: fixture, targetRoot: target, origin: 'o' });
    writeFileSync(join(target, 'arxiv', 'SKILL.md'), '---\nname: arxiv\ndescription: old.\n---\n\nold\n');
    const rep = importSkills({ source: fixture, targetRoot: target, origin: 'o', force: true });
    expect(rep.imported.some((i) => i.name === 'arxiv')).toBe(true);
    expect(readFileSync(join(target, 'arxiv', 'SKILL.md'), 'utf8')).toContain('# arXiv');
  });

  it('installedSkillNames reflects existing roots', () => {
    const target = join(tmp, 'out4');
    importSkills({ source: fixture, targetRoot: target, origin: 'o' });
    const names = installedSkillNames([target]);
    expect(names.has('arxiv')).toBe(true);
    expect(names.has('nope')).toBe(false);
  });
});

function mkdtempUnder(): string {
  const base = join(tmpdir(), `mochi-skill-import-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(base, { recursive: true });
  return base;
}