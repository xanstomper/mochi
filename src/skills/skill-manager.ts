// Skill self-management for Mochi — ported from Hermes' `skill_manage` /
// `skill_usage` machinery (how an agent author-creates and auto-improves its
// own procedural memory, "agentskills.io" spec).
//
// Hermes model we reproduce (see hermes_cli/agent/curator.py + skill_manager):
//   - The agent authors SKILL.md files (YAML frontmatter + markdown body).
//   - Agent-created skills live in the writable, per-project
//     `.mochi/skills/<category?>/<name>/SKILL.md` tree (shadowing bundled ones).
//   - A usage registry (`<project>/.mochi/skill-usage.json`) marks which skills
//     are agent-created and tracks patch counts / last used, so a background
//     curator can maintain ONLY those and never touch bundled/user skills.
//   - Never auto-deletes: delete() archives into `.mochi/skills/.archive/`.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lintSkillDoc } from './skill-lint.js';
import { parseFrontmatter as parseSkillFrontmatter } from './skills.js';
import { mochiStateDir } from '../core/mochi-dir.js';
import type { Tool } from '../tools/types.js';

/** Where agent-created + returned skills live, relative to the project dir. */
export function skillsRoot(projectDir: string): string {
  return join(mochiStateDir(projectDir), 'skills');
}
export function archiveRoot(projectDir: string): string {
  return join(mochiStateDir(projectDir), 'skills', '.archive');
}
export function usagePath(projectDir: string): string {
  return join(mochiStateDir(projectDir), 'skill-meta.json');
}

// ─── Usage registry (mirrors Hermes' tools/skill_usage.py) ───────────────

export interface UsageRecord {
  name: string;
  agentCreated: boolean;
  patches: number;
  createdAt: number;
  lastUsedAt: number;
  category?: string;
  /** MCH-201: Quality signal — wins/losses from run outcomes, derived score. */
  wins?: number;
  losses?: number;
  score?: number;
}

export interface UsageDB {
  byName: Record<string, UsageRecord>;
}
export interface MarkOpts {
  agentCreated?: boolean;
  category?: string;
  /** MCH-201: outcome signal — true for a successful run, false for a failed one. */
  win?: boolean;
}

/** MCH-201: quality score formula. Returns 0..100.
 *  Balances win ratio against log2(uses+2) so a skill used once with 1 win
 *  doesn't beat one used 50 times with 40 wins. Capped at 100. */
export function computeSkillScore(wins: number, losses: number, uses: number): number {
  return Math.min(100, Math.round((wins / (wins + losses + 1)) * 100 * Math.log2(uses + 2)));
}

export function loadUsage(projectDir: string): UsageDB {
  try {
    const raw = readFileSync(usagePath(projectDir), 'utf8');
    return { byName: JSON.parse(raw) as Record<string, UsageRecord> } as UsageDB;
  } catch {
    return { byName: {} };
  }
}

export function saveUsage(projectDir: string, db: UsageDB): void {
  mkdirSync(join(projectDir, '.mochi'), { recursive: true });
  writeFileSync(usagePath(projectDir), JSON.stringify(db.byName, null, 2), 'utf8');
}

/** Record a skill as seen/used; optionally mark it as agent-authored.
 *  MCH-201: when opts.win is provided, updates wins/losses + recomputes score. */
export function markUsed(projectDir: string, name: string, opts: MarkOpts = {}): void {
  const db = loadUsage(projectDir);
  const rec = db.byName[name] ?? { name, agentCreated: false, patches: 0, createdAt: Date.now(), lastUsedAt: Date.now() };
  rec.lastUsedAt = Date.now();
  if (opts.agentCreated) rec.agentCreated = true;
  if (opts.category) rec.category = opts.category;
  if (!rec.createdAt) rec.createdAt = Date.now();
  // MCH-201: track win/loss outcome and recompute quality score
  if (opts.win === true) {
    rec.wins = (rec.wins ?? 0) + 1;
  } else if (opts.win === false) {
    rec.losses = (rec.losses ?? 0) + 1;
  }
  if (opts.win !== undefined) {
    const uses = (rec.wins ?? 0) + (rec.losses ?? 0);
    rec.score = computeSkillScore(rec.wins ?? 0, rec.losses ?? 0, uses);
  }
  db.byName[name] = rec;
  saveUsage(projectDir, db);
}

/** Bump patch count on an edit/patch/write_file (curator self-improvement
 *  telemetry). Returns the new count. */
export function bumpPatch(projectDir: string, name: string): number {
  const db = loadUsage(projectDir);
  const rec = db.byName[name] ?? { name, agentCreated: false, patches: 0, createdAt: Date.now(), lastUsedAt: Date.now() };
  rec.patches = (rec.patches ?? 0) + 1;
  rec.lastUsedAt = Date.now();
  db.byName[name] = rec;
  saveUsage(projectDir, db);
  return rec.patches;
}

export function listAgentCreated(projectDir: string): UsageRecord[] {
  const db = loadUsage(projectDir);
  return Object.values(db.byName).filter((r) => r.agentCreated).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export function forget(projectDir: string, name: string): void {
  const db = loadUsage(projectDir);
  delete db.byName[name];
  saveUsage(projectDir, db);
}

// ─── Frontmatter parse / validate (YAML-ish) ────────────────────────────

/** Parse a SKILL.md's frontmatter. Delegates to the single canonical parser in
 *  skills.ts so BOM handling, quoted scalars, inline + list arrays, and YAML
 *  block scalars behave identically wherever skills are read (the loader, the
 *  importer, Claude interop, and the curator). */
export function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } | null {
  if (!/^\ufeff?---/.test(text)) return null;
  const { frontmatter, body } = parseSkillFrontmatter(text);
  return { meta: frontmatter as Record<string, unknown>, body };
}

export function renderSkill(p: { name: string; description: string; category?: string; tags?: string[]; body: string }): string {
  const lines = ['---', `name: ${p.name}`, `description: ${p.description}`];
  if (p.category) lines.push(`category: ${p.category}`);
  if (p.tags?.length) lines.push(`tags: [${p.tags.join(', ')}]`);
  lines.push('---', '', p.body.replace(/^\n/, ''));
  return lines.join('\n');
}

export function safeSlug(name: string): string {
  // Traversal-safe slug: keep [a-z0-9_-], convert everything else (incl. dots)
  // to '-', collapse runs, drop edges. Dots are replaced so no '..' path
  // segment can ever survive into the skill tree.
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'skill';
}

// ─── Skill tree writes ───────────────────────────────────────────────────

export interface CreateInput {
  name: string;
  description: string;
  body: string;
  category?: string;
}
export interface SkillQuality {
  score: number;
  passed: boolean;
  strengths: string[];
  missing: string[];
}

/** Deterministic production gate for generated procedural memory. */
export function assessSkillQuality(description: string, body: string): SkillQuality {
  // A heading only counts as substantive if it has at least one non-header
  // content line before the next heading (or the end). A required section
  // whose heading is immediately followed by another heading is EMPTY and must
  // not satisfy the gate, even when the header text itself is present.
  const sectionHasContent = (heading: RegExp): boolean => {
    const lines = body.split(/\r?\n/);
    let inSection = false;
    for (const line of lines) {
      if (/^#{1,3}\s/.test(line)) {
        if (inSection) return false; // hit the NEXT heading with no content
        inSection = heading.test(line);
        continue;
      }
      if (inSection && line.trim()) return true; // substantive content line
    }
    return false; // reached end with no content after the heading
  };

  const checks = [
    { label: 'When to use section with trigger conditions', points: 20, ok: sectionHasContent(/#{1,3}\s+(when to use|triggers?|use when)\b/i) },
    { label: 'numbered procedure with at least 3 concrete steps', points: 25, ok: (body.match(/^\s*\d+[.)]\s+\S+/gm) ?? []).length >= 3 },
    { label: 'Pitfalls or failure recovery section', points: 15, ok: sectionHasContent(/#{1,3}\s+(pitfalls?|failure|recovery|troubleshooting)\b/i) },
    { label: 'Verification section with executable evidence', points: 25, ok: sectionHasContent(/#{1,3}\s+(verification|validate|testing)\b/i) && /(run|test|check|verify|exit|pass)/i.test(body) },
    { label: 'specific description and substantial body', points: 15, ok: description.trim().length >= 24 && body.trim().length >= 240 },
  ];
  const strengths = checks.filter((c) => c.ok).map((c) => c.label);
  const missing = checks.filter((c) => !c.ok).map((c) => c.label);
  const score = checks.reduce((sum, c) => sum + (c.ok ? c.points : 0), 0);
  return { score, passed: score >= 80 && missing.length <= 1, strengths, missing };
}


export interface WriteResult {
  ok: boolean;
  path?: string;
  error?: string;
  archived?: boolean;
  quality?: SkillQuality;
}

function atomicWrite(path: string, content: string): void {
  const staging = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(staging, path);
  } catch (error) {
    // An exclusive-create collision belongs to another writer: leave it alone.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      try { rmSync(staging, { force: true }); } catch { /* preserve original error */ }
    }
    throw error;
  }
}

/** Write (or overwrite across create/edit). Validated; returns errors rather
 *  than throwing, matching the tool's JSON contract. */
export function writeSkill(projectDir: string, input: CreateInput): WriteResult {
  try {
    const name = String(input.name ?? '').trim();
    if (!name) return { ok: false, error: 'name is required' };
    if (!input.description) return { ok: false, error: 'description is required' };
    if (!input.body || !input.body.trim()) return { ok: false, error: 'body is required' };
    // Safety gate (placeholders, injection language): the same rules the whole
    // bundled library passes. Size/procedure quality stays with
    // assessSkillQuality below (richer messages, existing contract) — this
    // gate only blocks content that must never persist.
    const lint = lintSkillDoc(name, input.description, input.body);
    const unsafe = lint.issues.filter((i) => i.severity === 'error' && (i.rule === 'no-injection' || i.rule === 'no-placeholders'));
    if (unsafe.length > 0) {
      return { ok: false, error: `Skill lint failed:\n${unsafe.map((i) => `[${i.severity}] ${i.rule}: ${i.message}`).join('\n')}` };
    }
    const quality = assessSkillQuality(input.description, input.body);
    if (!quality.passed) {
      return { ok: false, quality, error: `Skill quality gate failed (${quality.score}/100): ${quality.missing.join('; ')}` };
    }
    const slug = safeSlug(name);
    const root = input.category
      ? join(skillsRoot(projectDir), safeSlug(input.category), slug)
      : join(skillsRoot(projectDir), slug);
    mkdirSync(root, { recursive: true });
    const target = join(root, 'SKILL.md');
    atomicWrite(target, renderSkill({ name, description: input.description, category: input.category, body: input.body }));
    markUsed(projectDir, name, { category: input.category });
    return { ok: true, path: target, quality };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface ResolvedSkill {
  name: string;
  path: string;
  category?: string;
}

function findSkillFile(projectDir: string, name: string): ResolvedSkill | null {
  const root = skillsRoot(projectDir);
  if (!existsSync(root)) return null;
  const slug = safeSlug(name);
  const exact = join(root, slug, 'SKILL.md');
  if (existsSync(exact)) return { name, path: exact };
  for (const cat of readdirSync(root, { withFileTypes: true })) {
    if (!cat.isDirectory() || cat.name.startsWith('.')) continue;
    const p = join(root, cat.name, slug, 'SKILL.md');
    if (existsSync(p)) return { name, path: p, category: cat.name };
  }
  return null;
}

/** Patch a SKILL.md by replacing a substring — the curator's "improve the
 *  skill" path. Mirrors Hermes `patch` action. */
export function patchSkill(projectDir: string, name: string, target: ResolvedSkill, oldString: string, newString: string, replaceAll = false): WriteResult {
  if (oldString.length === 0) return { ok: false, error: 'old_string must be non-empty' };
  try {
    const text = readFileSync(target.path, 'utf8');
    let next: string;
    if (replaceAll) {
      const split = text.split(oldString);
      if (split.length === 1) return { ok: false, error: 'old_string not found' };
      next = split.join(newString);
    } else {
      const idx = text.indexOf(oldString);
      if (idx === -1) return { ok: false, error: 'old_string not found' };
      if (text.indexOf(oldString, idx + 1) !== -1) {
        return { ok: false, error: 'Ambiguous patch: old_string must be unique; include more context or use replace_all.' };
      }
      next = text.slice(0, idx) + newString + text.slice(idx + oldString.length);
    }
    const parsed = parseFrontmatter(next);
    if (!parsed) return { ok: false, error: 'Patched skill has invalid frontmatter' };
    const quality = assessSkillQuality(String(parsed.meta.description ?? ''), parsed.body);
    if (!quality.passed) {
      return { ok: false, quality, error: `Skill quality gate failed (${quality.score}/100): ${quality.missing.join('; ')}` };
    }
    atomicWrite(target.path, next);
    bumpPatch(projectDir, name);
    return { ok: true, path: target.path, quality };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Auto-skill lifecycle curator (MCH-56) ────────────────────────────────
// Auto-drafted skills (MCH-44/55) that were never marked used within
// `maxAgeMs` get archived (never deleted) so the skill list stays dense with
// skills that actually earn their prompt tokens.

/** Archive auto-drafted skills with zero usage older than maxAgeMs. Returns archived slugs. */
export function curateAutoSkills(projectDir: string, opts: { maxAgeMs?: number } = {}): string[] {
  const maxAgeMs = opts.maxAgeMs ?? 14 * 24 * 3600_000; // 14 days
  const archived: string[] = [];
  try {
    const autoDir = join(skillsRoot(projectDir), 'auto');
    if (!existsSync(autoDir)) return archived;
    const db = loadUsage(projectDir);
    const now = Date.now();
    for (const file of readdirSync(autoDir)) {
      if (!file.endsWith('.md')) continue;
      const slug = file.replace(/\.md$/, '');
      const rec = db.byName[slug];
      // Never touched, or last touched beyond the window -> archive.
      const last = rec?.lastUsedAt ?? 0;
      if (last !== 0 && now - last < maxAgeMs) continue;
      // Auto skills are flat files <auto>/<slug>.md — archive directly.
      const src = join(autoDir, file);
      const arc = join(archiveRoot(projectDir), slug, file);
      mkdirSync(dirname(arc), { recursive: true });
      renameSync(src, arc);
      archived.push(slug);
    }
    if (archived.length) {
      for (const slug of archived) delete db.byName[slug];
      saveUsage(projectDir, db);
    }
  } catch { /* curation must never throw */ }
  return archived;
}

export function deleteSkill(projectDir: string, name: string): WriteResult {
  const found = findSkillFile(projectDir, name);
  if (!found) return { ok: false, error: `No skill named '${name}'` };
  try {
    const arc = join(archiveRoot(projectDir), safeSlug(name), basename(found.path));
    mkdirSync(dirname(arc), { recursive: true });
    renameSync(found.path, arc);
    forget(projectDir, name);
    return { ok: true, path: arc, archived: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── The tool itself (Hermes `skill_manage`, namespaced to mochi) ─────────

export const skillManageTool: Tool = {
  def: {
    name: 'skill_manage',
    description:
      'Author your own reusable SKILL.md skills (procedural memory): capture recurring fixes, workflows, and conventions as trigger conditions → numbered steps → pitfalls → verification, so future sessions start with answers. ' +
      'Load the `skill-authoring` skill once for the quality bar before your first create. Default scope is per-project (.mochi/skills/); category "global" persists across projects (~/.mochi/skills/). ' +
      'Actions: create (name+description+body, optional category); edit (name + new description/body); patch (name + old_string/new_string); delete (name — archived, never hard-deleted).',
    parameters: [
      { name: 'action', type: 'string', description: 'create | edit | patch | delete', required: true },
      { name: 'name', type: 'string', description: 'Skill name (slugified for the directory)', required: true },
      { name: 'description', type: 'string', description: 'One-line description (create/edit)', required: false },
      { name: 'body', type: 'string', description: 'Full SKILL.md markdown body (create/edit)', required: false },
      { name: 'category', type: 'string', description: 'Optional category folder (create)', required: false },
      { name: 'old_string', type: 'string', description: 'Text to find (patch)', required: false },
      { name: 'new_string', type: 'string', description: 'Replacement text, empty to delete (patch)', required: false },
      { name: 'replace_all', type: 'boolean', description: 'Replace all occurrences (patch)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const action = String(args.action ?? '').toLowerCase();
    const name = String(args.name ?? '').trim();
    const projectDir = ctx.workspace.dir || ctx.cwd;
    if (!name) return `${JSON.stringify({ ok: false, error: 'name is required' })}`;
    if (action === 'create') {
      const category = args.category ? String(args.category) : undefined;
      // category "global" (or "user") => ~/.mochi/skills — cross-project memory.
      // writeSkill() appends .mochi/skills itself — pass HOME, NOT the skills
      // path, or the dir doubles to .mochi/skills/.mochi/skills (undiscoverable).
      const targetDir = category === 'global' || category === 'user'
        ? (process.env.HOME || projectDir)
        : projectDir;
      const r = writeSkill(targetDir, {
        name,
        description: String(args.description ?? ''),
        body: String(args.body ?? ''),
        category: category === 'global' || category === 'user' ? undefined : category,
      });
      if (!r.ok) return JSON.stringify(r);
      // Model-authored skills must enter the curator lifecycle (stale,
      // archive, consolidation, regression doctor) — writeSkill only records
      // usage, which left agentCreated=false and made them invisible to it.
      try { markUsed(targetDir, name, { agentCreated: true, category: category === 'global' || category === 'user' ? undefined : category }); } catch { /* best-effort */ }
      return `Created skill '${name}' at ${r.path}. It is advertised to every future session in this scope; the user can read it with 'mochi skills ${name}'.`;
    }
    if (action === 'edit') {
      const found = findSkillFile(projectDir, name);
      if (!found) return JSON.stringify({ ok: false, error: `No skill named '${name}'` });
      const text = readFileSync(found.path, 'utf8');
      const pf = parseFrontmatter(text);
      if (!pf) return JSON.stringify({ ok: false, error: 'Existing skill has no frontmatter to edit' });
      const newDesc = args.description !== undefined ? String(args.description) : String(pf.meta.description ?? '');
      const newBody = args.body !== undefined ? String(args.body) : (pf.body || '');
      const r = writeSkill(projectDir, {
        name,
        description: newDesc,
        body: newBody,
        category: typeof pf.meta.category === 'string' ? pf.meta.category : undefined,
      });
      if (!r.ok) return JSON.stringify(r);
      bumpPatch(projectDir, name);
      return `Updated skill '${name}' (quality ${r.quality?.score ?? 0}/100).`;
    }
    if (action === 'patch') {
      if (args.old_string === undefined) return JSON.stringify({ ok: false, error: 'old_string is required for patch' });
      const found = findSkillFile(projectDir, name);
      if (!found) return JSON.stringify({ ok: false, error: `No skill named '${name}'` });
      const r = patchSkill(projectDir, name, found, String(args.old_string), String(args.new_string ?? ''), !!args.replace_all);
      return r.ok ? `Patched skill '${name}'.` : JSON.stringify(r);
    }
    if (action === 'delete') {
      const r = deleteSkill(projectDir, name);
      return r.ok ? `Archived skill '${name}' (recoverable in .mochi/skills/.archive).` : JSON.stringify(r);
    }
    return `${JSON.stringify({ ok: false, error: `Unknown action '${action}'. Use create, edit, patch, or delete.` })}`;
  },
};