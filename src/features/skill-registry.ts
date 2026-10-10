// Skill source registry — the "distributed skill library" surface.
//
// Layer on top of skill-importer.ts. The importer already handles raw imports
// from local paths / `hermes:` / `github:owner/repo` / git URLs. What it lacks
// is the *named, shared, publishable* dimension: a way to register a source
// once under a friendly name, list its discoverable packs, install a specific
// pack BY NAME, and publish a project's skills as a shareable pack catalog.
//
// This is the competitive surface Claude Code/Codex don't ship as a first-class
// feature: Mochi can own a real skill *registry*, not just a skills folder.
//
// Design rules:
//   - State is a single JSON file (~/.mochi/skill-sources.json) — throw it away
//     and nothing breaks.
//   - Pure for cache/discover/publish helpers; only clone/import touch disk.
//   - Reuses the existing importer for the heavy lifting. A "pack" is one
//     SKILL.md root (or a subdir of the source). Installed packs land in the
//     same ~/.mochi/skills tree the harness already discovers.
//   - A source may ship a `packs.json` catalog (cat/owner/name/description per
//     pack) so `install <pack>` can resolve a pack to its subdir by name. When
//     absent, install resolves by matching a directory name or SKILL.md name.

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { safeSlug } from '../skill-manager.js';
import { parseFrontmatter } from '../skill-manager.js';

// ─── Registry state ────────────────────────────────────────────────────────

export interface SkillSource {
  /** Friendly name/id for the source. */
  name: string;
  /** The source spec: local path, "hermes:", or github:owner/repo / git URL. */
  source: string;
  /** Optional catalog override file (relative to source root). Default: packs.json */
  catalogFile?: string;
  /** Human note, e.g. "my team's production packs". */
  description?: string;
  /** Monotonic clock so the CLI can show newest-first. */
  addedAt: number;
}

export interface RegistryState {
  sources: Record<string, SkillSource>;
}

export interface PackInfo {
  /** Pack id (the name you install by). */
  name: string;
  /** Optional category grouping (the "skills in other categories" surface). */
  category?: string;
  description: string;
  /** Subdirectory of the source root that holds the pack (default: source root). */
  path?: string;
}

export function registryPath(): string {
  const base = process.env.MOCHI_SKILL_REGISTRY || join(homedir(), '.mochi', 'skill-sources.json');
  return base;
}

export function loadRegistry(): RegistryState {
  try {
    const p = registryPath();
    if (!existsSync(p)) return { sources: {} };
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as { sources?: Record<string, SkillSource> };
    if (!parsed || typeof parsed.sources !== 'object') return { sources: {} };
    const clean: Record<string, SkillSource> = {};
    for (const [k, v] of Object.entries(parsed.sources)) {
      if (v && typeof v.name === 'string' && typeof v.source === 'string') clean[k] = v;
    }
    return { sources: clean };
  } catch {
    return { sources: {} };
  }
}

export function saveRegistry(state: RegistryState): void {
  const p = registryPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
}

/** Register (add/replace) a named source. Returns the id it maps to. */
export function registerSource(spec: { name: string; source: string; catalogFile?: string; description?: string }): SkillSource {
  const name = safeSlug(spec.name || spec.source);
  const state = loadRegistry();
  const rec: SkillSource = {
    name,
    source: spec.source,
    ...(spec.catalogFile ? { catalogFile: spec.catalogFile } : {}),
    ...(spec.description ? { description: spec.description } : {}),
    addedAt: Date.now(),
  };
  state.sources[name] = rec;
  saveRegistry(state);
  return rec;
}

export function unregisterSource(name: string): boolean {
  const state = loadRegistry();
  const id = safeSlug(name);
  if (!state.sources[id]) return false;
  delete state.sources[id];
  saveRegistry(state);
  return true;
}

export function getSource(name: string): SkillSource | undefined {
  const id = safeSlug(name);
  return loadRegistry().sources[id];
}

// ─── Catalog / pack discovery (pure, no network) ───────────────────────────

const DEFAULT_CATALOG = 'packs.json';

/** Load {path: PackInfo[]} for a source dir. Missing/corrupt catalog -> null. */
export function loadCatalog(sourceDir: string, catalogFile = DEFAULT_CATALOG): PackInfo[] | null {
  const p = join(sourceDir, catalogFile);
  if (!existsSync(p)) return null;
  try {
    const arr = JSON.parse(readFileSync(p, 'utf8')) as PackInfo[];
    if (!Array.isArray(arr)) return null;
    return arr.filter((x) => x && typeof x.name === 'string' && x.name.trim());
  } catch {
    return null;
  }
}

/**
 * Discover packs present in a source dir. Prefers a `packs.json` catalog when
 * present; otherwise falls back to scanning for SKILL.md roots (reusing the
 * importer's rules). Returns a stable list ordered by name.
 */
export function discoverPacks(sourceDir: string, catalogFile = DEFAULT_CATALOG): PackInfo[] {
  const catalog = loadCatalog(sourceDir, catalogFile);
  if (catalog && catalog.length > 0) return catalog;

  // Fallback: scan for skill roots. Two shapes:
  //   (a) <root>/<pack>/SKILL.md          -> pack id = <pack>
  //   (b) <root>/SKILL.md                 -> the whole source is one pack
  const out: PackInfo[] = [];
  const seen = new Set<string>();
  const rootSkill = join(sourceDir, 'SKILL.md');
  if (existsSync(rootSkill)) {
    const fm = parseFrontmatter(readFileSync(rootSkill, 'utf8'));
    const name = fm && typeof fm.meta.name === 'string' && fm.meta.name.trim() ? fm.meta.name.trim() : basename(sourceDir);
    out.push({ name, description: (fm?.meta?.description as string) || '' });
    seen.add(name.toLowerCase());
  }
  let entries: { name: string; isDir: boolean }[] = [];
  try {
    entries = readdirSync(sourceDir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    /* unreadable -> falls through */
  }
  for (const e of entries) {
    if (!e.isDir) continue;
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.archive' || e.name.startsWith('.')) continue;
    const skillPath = join(sourceDir, e.name, 'SKILL.md');
    if (!existsSync(skillPath)) continue;
    const fm = parseFrontmatter(readFileSync(skillPath, 'utf8'));
    const name = fm && typeof fm.meta.name === 'string' && fm.meta.name.trim() ? fm.meta.name.trim() : e.name;
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push({ name, path: e.name, description: (fm?.meta?.description as string) || '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a pack id within a source dir to a concrete subdir (or undefined if
 *  the pack is missing). Catalog paths are used when present. */
export function resolvePackDir(sourceDir: string, packName: string, catalogFile = DEFAULT_CATALOG): string | undefined {
  const catalog = loadCatalog(sourceDir, catalogFile);
  if (catalog) {
    const want = packName.toLowerCase();
    const hit = catalog.find((p) => p.name.toLowerCase() === want);
    if (hit) return hit.path ? join(sourceDir, hit.path) : sourceDir;
  }
  // Direct dir match.
  const dir = join(sourceDir, packName);
  if (existsSync(join(dir, 'SKILL.md')) && statSync(join(dir, 'SKILL.md')).isFile()) return dir;
  // Name-match against a per-dir SKILL.md frontmatter.
  let entries: { name: string; isDir: boolean }[] = [];
  try {
    entries = readdirSync(sourceDir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return undefined;
  }
  for (const e of entries) {
    if (!e.isDir) continue;
    const sp = join(sourceDir, e.name, 'SKILL.md');
    if (!existsSync(sp)) continue;
    try {
      const fm = parseFrontmatter(readFileSync(sp, 'utf8'));
      const nm = fm && typeof fm.meta.name === 'string' ? fm.meta.name.trim() : '';
      if (nm.toLowerCase() === packName.toLowerCase()) return join(sourceDir, e.name);
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

// ─── Publish (generate a shareable catalog) ────────────────────────────────

/**
 * Build a `packs.json` catalog from an installed-skill tree (~/.mochi/skills or
 * a --packs-root arg). Walks one level of skill roots and emits a catalog entry
 * per skill. Pure: reads only, returns JSON text.
 */
export function buildCatalogFromSkills(skillsRootDir: string): PackInfo[] {
  const out: PackInfo[] = [];
  if (!existsSync(skillsRootDir)) return out;
  let entries: { name: string; isDir: boolean }[] = [];
  try {
    entries = readdirSync(skillsRootDir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDir || e.name.startsWith('.') || e.name === '.archive') continue;
    const sp = join(skillsRootDir, e.name, 'SKILL.md');
    if (!existsSync(sp)) continue;
    try {
      const fm = parseFrontmatter(readFileSync(sp, 'utf8'));
      const name = fm && typeof fm.meta.name === 'string' && fm.meta.name.trim() ? fm.meta.name.trim() : e.name;
      out.push({
        name,
        path: e.name,
        description: (fm?.meta?.description as string) || '',
        category: (fm?.meta?.category as string) || undefined,
      });
    } catch {
      /* skip unreadable */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}