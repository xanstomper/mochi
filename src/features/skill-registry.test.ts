import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadRegistry,
  saveRegistry,
  registerSource,
  unregisterSource,
  getSource,
  discoverPacks,
  loadCatalog,
  resolvePackDir,
  buildCatalogFromSkills,
  registryPath,
  type RegistryState,
} from './skill-registry.js';

// Point state at a throwaway file before any test touches loadRegistry.
function useRegistryFile(tmp: string) {
  const p = join(tmp, 'skill-sources.json');
  vi.stubEnv('MOCHI_SKILL_REGISTRY', p);
  return p;
}

function mkdtempUnder(): string {
  const base = join(tmpdir(), `mochi-skill-registry-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(base, { recursive: true });
  return base;
}

describe('skill-registry', () => {
  let tmp: string;
  let sourceDir: string;

  beforeAll(() => {
    tmp = mkdtempUnder();
    // A source tree with two packs + a catalog.
    sourceDir = join(tmp, 'team-packs');
    mkdirSync(join(sourceDir, 'pack-a'), { recursive: true });
    writeFileSync(join(sourceDir, 'pack-a', 'SKILL.md'), '---\nname: pack-a\ndescription: Pack A.\n---\n\nbody a\n');
    mkdirSync(join(sourceDir, 'pack-b', 'references'), { recursive: true });
    writeFileSync(join(sourceDir, 'pack-b', 'SKILL.md'), '---\nname: pack-b\ndescription: Pack B.\ncategory: infra\n---\n\nbody b\n');
    mkdirSync(join(sourceDir, 'references'), { recursive: true });
    writeFileSync(join(sourceDir, 'references', 'guide.md'), '# ref');
    writeFileSync(
      join(sourceDir, 'packs.json'),
      JSON.stringify([
        { name: 'pack-a', description: 'Pack A.', path: 'pack-a' },
        { name: 'pack-b', description: 'Pack B.', path: 'pack-b', category: 'infra' },
      ]),
    );
  });

  beforeEach(() => {
    useRegistryFile(tmp);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('registry round-trips through the JSON file', () => {
    const p = registryPath();
    saveRegistry({ sources: {} });
    expect(existsSync(p)).toBe(true);
    expect(loadRegistry()).toEqual({ sources: {} });
  });

  it('registerSource slugifies the name and persists', () => {
    const rec = registerSource({ name: 'My Team Packs', source: sourceDir, description: 'prod packs' });
    expect(rec.name).toBe('my-team-packs');
    expect(getSource('my-team-packs')?.source).toBe(sourceDir);
    expect(loadRegistry().sources['my-team-packs'].description).toBe('prod packs');
  });

  it('unregisterSource removes and returns true; missing returns false', () => {
    registerSource({ name: 'temp', source: sourceDir });
    expect(unregisterSource('temp')).toBe(true);
    expect(getSource('temp')).toBeUndefined();
    expect(unregisterSource('never-existed')).toBe(false);
  });

  it('loadCatalog returns null when absent and parses valid catalogs', () => {
    expect(loadCatalog(join(tmp, 'no-such-dir'))).toBeNull();
    const cat = loadCatalog(sourceDir);
    expect(cat).toHaveLength(2);
    expect(cat![0].name).toBe('pack-a');
  });

  it('discoverPacks prefers the catalog when present', () => {
    const packs = discoverPacks(sourceDir);
    expect(packs.map((p) => p.name).sort()).toEqual(['pack-a', 'pack-b']);
    expect(packs.find((p) => p.name === 'pack-b')?.category).toBe('infra');
  });

  it('discoverPacks falls back to scanning SKILL.md roots (no catalog)', () => {
    const bare = join(tmp, 'bare');
    mkdirSync(join(bare, 'x-one'), { recursive: true });
    writeFileSync(join(bare, 'x-one', 'SKILL.md'), '---\nname: x-one\ndescription: d.\n---\n\nbody\n');
    writeFileSync(join(bare, 'x-one', 'junk.txt'), 'nope');
    const packs = discoverPacks(bare);
    expect(packs.map((p) => p.name)).toEqual(['x-one']);
    // No packs.json -> catalog returned null -> fallback used.
    expect(loadCatalog(bare)).toBeNull();
  });

  it('resolvePackDir resolves catalog paths and direct dir names', () => {
    expect(resolvePackDir(sourceDir, 'pack-a')).toBe(join(sourceDir, 'pack-a'));
    expect(resolvePackDir(sourceDir, 'pack-b')).toBe(join(sourceDir, 'pack-b'));
    // Case-insensitive by name.
    expect(resolvePackDir(sourceDir, 'PACK-A')).toBe(join(sourceDir, 'pack-a'));
    expect(resolvePackDir(sourceDir, 'nope')).toBeUndefined();
  });

  it('buildCatalogFromSkills emits one entry per skill root with category', () => {
    const home = join(tmp, 'installed');
    mkdirSync(join(home, 's1'), { recursive: true });
    writeFileSync(join(home, 's1', 'SKILL.md'), '---\nname: s1\ndescription: Skill one.\n---\n\nbody\n');
    mkdirSync(join(home, 's2'), { recursive: true });
    writeFileSync(join(home, 's2', 'SKILL.md'), '---\nname: s2\ndescription: Skill two.\ncategory: web\n---\n\nbody\n');
    writeFileSync(join(home, 'not-a-skill.txt'), 'x');
    const cat = buildCatalogFromSkills(home);
    expect(cat.map((p) => p.name).sort()).toEqual(['s1', 's2']);
    expect(cat.find((p) => p.name === 's2')?.category).toBe('web');
  });
});