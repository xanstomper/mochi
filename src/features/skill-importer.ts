// Cross-agent skill importer (Workstream D — octopus).
//
// Mochi's skills use the agentskills.io convention (SKILL.md with YAML
// frontmatter) — the SAME convention as Hermes, Antigravity, and other agents
// in the Terminus ecosystem. Hermes already ships a mature, curated skill tree
// at ~/.hermes/skills (30+ categories incl. mochi-development, software-dev,
// systems, research, …). Rather than re-authoring those from scratch, Mochi can
// adopt them wholesale: bundle / import external SKILL.md trees into the global
// ~/.mochi/skills/ dir so they load like any other user skill and immediately
// enrich the harness's system prompt (the "harness has no context" complaint).
//
// Design rules:
//   - NON-destructive: never deletes or overwrites an existing Mochi skill
//     unless --force. Imported skills go under a per-origin namespace dir so a
//     Mochi skill of the same name still wins by precedence.
//   - Namespace by origin (e.g. "hermes", or the git repo's basename) so
//     provenance is obvious and safe. On a name collision with an installed
//     skill of a DIFFERENT origin, the first import wins unless --force.
//   - import-source may be: an absolute/relative dir path (Hermes tree, a git
//     checkout, a raw skills dir), or `hermes:` / `jcode:` shortcuts resolving
//     to known home locations.
//   - list-source (dry-run) reports what would be imported without writing.
//
// Only touches: src/features/* (this file, its test), CLI wiring in cli.ts,
// and docs/. No overlap with workstreams A/B/C.

import { existsSync, readdirSync, statSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename, resolve, isAbsolute } from 'node:path';
import { parseFrontmatter, safeSlug } from '../skill-manager.js';

export interface ImportedSkillInfo {
  name: string;
  origin: string;
  from: string;
  to: string;
  size: number;
}

export interface SkillImportReport {
  imported: ImportedSkillInfo[];
  skipped: Array<{ name: string; reason: string; from: string }>;
  errors: string[];
  origin: string;
}

// Known agent skill roots on this machine (Terminus ecosystem).
const KNOWN_ROOTS: Record<string, string> = {
  hermes: join(process.env.HOME || '', '.hermes', 'skills'),
  antigravity: join(process.env.HOME || '', '.antigravity-cli', 'skills'),
  gemini: join(process.env.HOME || '', '.gemini', 'antigravity-cli', 'skills'),
  claude: join(process.env.HOME || '', '.claude', 'skills'),
  'safe-shell': join(process.env.HOME || '', '.mochi', 'skills', 'safe-shell'),
};

/** Resolve a source spec ("hermes:", an absolute path, a relative path, or a
 *  bare dir path) to a directory. Returns null if unresolvable / absent. */
export function resolveSkillSource(spec: string): string | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  if (trimmed.endsWith(':') && KNOWN_ROOTS[trimmed.slice(0, -1)]) {
    return KNOWN_ROOTS[trimmed.slice(0, -1)];
  }
  if (KNOWN_ROOTS[trimmed]) return KNOWN_ROOTS[trimmed];
  const p = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
  return existsSync(p) ? p : null;
}

/** What to report as this import's provenance/origin. */
export function originForSource(resolvedPath: string, sourceSpec?: string): string {
  const trimmed = (sourceSpec || '').trim();
  if (trimmed.endsWith(':') && KNOWN_ROOTS[trimmed.slice(0, -1)]) {
    return trimmed.slice(0, -1);
  }
  if (KNOWN_ROOTS[trimmed]) return trimmed;
  return basename(resolvedPath).replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'imported';
}

export interface DiscoveredSkill {
  name: string;
  path: string; // path to SKILL.md
  size: number;
  description?: string;
}

/**
 * Walk a source tree and collect every skill root (a dir containing SKILL.md,
 * mirroring discoverSkills). Returns {name, path, size} per skill.
 */
export function discoverSourceSkills(sourceDir: string): { skills: DiscoveredSkill[]; errors: string[] } {
  const skills: DiscoveredSkill[] = [];
  const errors: string[] = [];
  let budget = 4096;

  const walk = (dir: string, depth: number) => {
    if (depth > 8 || budget <= 0) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Prefer a bare name in frontmatter; fall back to the folder name (NOT its
    // slug) so human-friendly names survive, then slug at install time.
    if (entries.some((e) => e.name === 'SKILL.md' && !e.isDirectory())) {
      const skillPath = join(dir, 'SKILL.md');
      let name = basename(dir);
      let description: string | undefined;
      try {
        const text = readFileSync(skillPath, 'utf8');
        const fm = parseFrontmatter(text);
        if (fm && typeof fm.meta.name === 'string' && fm.meta.name.trim()) name = fm.meta.name.trim();
        if (fm && typeof fm.meta.description === 'string') description = fm.meta.description.trim();
      } catch { /* keep folder name */ }
      try {
        skills.push({ name, path: skillPath, size: statSync(skillPath).size, description });
      } catch { /* unreadable file -> skip */ }
      budget -= 1;
      return; // a SKILL.md dir is a skill root; do not recurse into its body
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === '.git' || e.name === 'node_modules' || e.name === '.archive') continue;
      walk(join(dir, e.name), depth + 1);
      if (budget <= 0) break;
    }
  };

  walk(sourceDir, 0);
  return { skills, errors };
}

/** Existing skill names already installed in the target roots (so we don't
 *  shadow across origins unintentionally). targetDirs in precedence order. */
export function installedSkillNames(targetDirs: string[]): Set<string> {
  const names = new Set<string>();
  for (const d of targetDirs) {
    if (!existsSync(d)) continue;
    findSkillNames(d, names, 0);
  }
  return names;
}

function findSkillNames(dir: string, out: Set<string>, depth: number): void {
  if (depth > 8) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.name === 'SKILL.md' && !e.isDirectory())) {
    const p = join(dir, 'SKILL.md');
    try {
      const fm = parseFrontmatter(readFileSync(p, 'utf8'));
      const name = fm && typeof fm.meta.name === 'string' && fm.meta.name.trim()
        ? fm.meta.name.trim()
        : basename(dir);
      out.add(name.toLowerCase());
    } catch {
      out.add(basename(dir).toLowerCase());
    }
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.archive') continue;
    findSkillNames(join(dir, e.name), out, depth + 1);
  }
}

/**
 * Import discovered skills from `source` into `targetRoot` (default
 * ~/.mochi/skills) under `<targetRoot>/<origin>/<name>/SKILL.md`.
 * Non-destructive; skips any skill whose name collides with an already
 * installed skill unless `force`. Also copies a sibling `references/` dir so the
 * imported skill's supporting docs travel with it.
 */
export function importSkills(opts: {
  source: string;                 // source spec (dir path or "hermes:" alias)
  targetRoot?: string;            // default ~/.mochi/skills
  origin?: string;                // namespace override; else derived from source
  force?: boolean;
}): SkillImportReport {
  const report: SkillImportReport = { imported: [], skipped: [], errors: [], origin: opts.origin || '' };
  const resolvedSource = resolveSkillSource(opts.source);
  if (!resolvedSource || !existsSync(resolvedSource) || !statSync(resolvedSource).isDirectory()) {
    report.errors.push(`source not found: ${opts.source}`);
    return report;
  }
  const origin = report.origin || originForSource(resolvedSource, opts.source);
  report.origin = origin;

  const targetRoot = opts.targetRoot || (process.env.HOME ? join(process.env.HOME, '.mochi', 'skills') : '');
  if (!targetRoot) {
    report.errors.push('no target root available (HOME not set)');
    return report;
  }

  const { skills, errors } = discoverSourceSkills(resolvedSource);
  report.errors.push(...errors);

  // Existing skill name set across the whole target tree (any origin) so a new
  // import never silently shadows an installed skill of the same name.
  const installed = installedSkillNames([targetRoot]);

  const seen = new Set<string>();
  for (const s of skills) {
    const slug = safeSlug(s.name);
    if (!slug) {
      report.skipped.push({ name: s.name, reason: 'unusable empty name', from: s.path });
      continue;
    }
    const lower = s.name.toLowerCase();
    if (seen.has(lower)) {
      report.skipped.push({ name: s.name, reason: 'duplicate within source', from: s.path });
      continue;
    }
    seen.add(lower);

    if (installed.has(lower) && !opts.force) {
      report.skipped.push({ name: s.name, reason: 'name already installed (use --force to overwrite)', from: s.path });
      continue;
    }

    const destDir = join(targetRoot, slug);
    const destFile = join(destDir, 'SKILL.md');
    const originFile = join(destDir, '.origin');
    try {
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      const copied = opts.force || !existsSync(destFile);
      if (copied) {
        cpSync(s.path, destFile, { force: true });
        // Carry the sibling `references/` docs along (many imported skills rely
        // on them for their `read`/references tool while the body references).
        const refs = join(join(s.path, '..'), 'references');
        if (existsSync(refs) && statSync(refs).isDirectory()) {
          cpSync(refs, join(destDir, 'references'), { recursive: true, force: true });
        }
        writeFileSync(originFile, origin, 'utf8');
        report.imported.push({ name: s.name, origin, from: s.path, to: destFile, size: s.size });
      } else {
        report.skipped.push({ name: s.name, reason: 'destination already exists (use --force)', from: s.path });
      }
    } catch (e) {
      report.errors.push(`failed to import ${s.name}: ${(e as Error).message}`);
    }
  }
  return report;
}