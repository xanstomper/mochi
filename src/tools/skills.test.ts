import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFrontmatter, discoverSkills, loadProjectSkills } from '../skills.js';
import { skillTool } from './skill.js';
import { Workspace } from '../workspace.js';
import { EventBus } from '../events.js';
import type { ToolContext } from './types.js';
import type { MochiConfig } from '../types.js';

describe('skills frontmatter', () => {
  it('parses name, description, flags, and arrays', () => {
    const { frontmatter, body } = parseFrontmatter(`---
name: my-skill
description: "Do the thing"
disable-model-invocation: true
tools:
  - read
  - shell
---
# body here
`);
    expect(frontmatter.name).toBe('my-skill');
    expect(frontmatter.description).toBe('Do the thing');
    expect(frontmatter['disable-model-invocation']).toBe(true);
    expect(frontmatter.tools).toEqual(['read', 'shell']);
    expect(body).toContain('# body here');
  });

  it('returns empty frontmatter for files without a block', () => {
    expect(parseFrontmatter('# plain\nno frontmatter').frontmatter).toEqual({});
  });
});

describe('skills discovery', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-skill-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('discovers SKILL.md root, nested skills, and plain md files', () => {
    // skill root (no recursion below)
    const releaseDir = join(dir, 'release');
    mkdirSync(releaseDir, { recursive: true });
    writeFileSync(join(releaseDir, 'SKILL.md'), `---\nname: release\n description: "ship a release"\n---\nbody`);

    // nested plain md under sub dir
    const sub = join(dir, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'fix-tests.md'), `---\nname: fix-tests\ndescription: "repair flaky tests"\n---\nsteps`);

    // a file without description is skipped
    writeFileSync(join(dir, 'no-desc.md'), `---\nname: nodesc\n---\nno desc`);

    const skills = discoverSkills(dir).skills;
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['fix-tests', 'release']);
  });

  it('dedups by name and returns diagnostics for invalid names', () => {
    const proj = join(dir, 'proj');
    const sdir = join(proj, '.mochi', 'skills');
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, 'SKILL.md'), `---\nname: bad_name\ndescription: "an invalid skill"\n---\nx`);
    const { skills, diagnostics } = loadProjectSkills(proj);
    expect(skills.length).toBe(1);
    expect(diagnostics.some((d) => d.includes('lowercase'))).toBe(true);
  });
});

describe('skill tool', () => {
  let dir: string;
  let ctx: ToolContext;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-skill-tool-'));
    const sdir = join(dir, '.mochi', 'skills');
    mkdirSync(sdir, { recursive: true });
    writeFileSync(join(sdir, 'SKILL.md'), `---\nname: deploy\ndescription: "Standard deploy steps"\n---\n1. build\n2. push`);
    const ws = new Workspace(dir);
    ws.ensure();
    ctx = { cwd: dir, workspace: ws, config: {} as MochiConfig, events: new EventBus(), agentId: 't' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists and loads a skill by name', async () => {
    const list = await skillTool.execute({ name: 'list' }, ctx);
    expect(list).toContain('deploy');
    const body = await skillTool.execute({ name: 'deploy' }, ctx);
    expect(body).toContain('1. build');
    expect(body).toContain('2. push');
  });

  it('reports a missing skill', async () => {
    const out = await skillTool.execute({ name: 'nope' }, ctx);
    expect(out).toContain("No skill named 'nope'");
  });
});