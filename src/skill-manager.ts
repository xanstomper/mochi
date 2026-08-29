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
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import type { Tool } from './tools/types.js';

/** Where agent-created + returned skills live, relative to the project dir. */
export function skillsRoot(projectDir: string): string {
  return join(projectDir, '.mochi', 'skills');
}
export function archiveRoot(projectDir: string): string {
  return join(projectDir, '.mochi', 'skills', '.archive');
}
export function usagePath(projectDir: string): string {
  return join(projectDir, '.mochi', 'skill-usage.json');
}

// ─── Usage registry (mirrors Hermes' tools/skill_usage.py) ───────────────

export interface UsageRecord {
  name: string;
  agentCreated: boolean;
  patches: number;
  createdAt: number;
  lastUsedAt: number;
  category?: string;
}

export interface UsageDB {
  byName: Record<string, UsageRecord>;
}
export interface MarkOpts {
  agentCreated?: boolean;
  category?: string;
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

/** Record a skill as seen/used; optionally mark it as agent-authored. */
export function markUsed(projectDir: string, name: string, opts: MarkOpts = {}): void {
  const db = loadUsage(projectDir);
  const rec = db.byName[name] ?? { name, agentCreated: false, patches: 0, createdAt: Date.now(), lastUsedAt: Date.now() };
  rec.lastUsedAt = Date.now();
  if (opts.agentCreated) rec.agentCreated = true;
  if (opts.category) rec.category = opts.category;
  if (!rec.createdAt) rec.createdAt = Date.now();
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

// ─── Frontmatter parse / validate (YAML-ish, matches mochi skills.ts load) ─

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } | null {
  const m = FM_RE.exec(text);
  if (!m) return null;
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    } else {
      meta[key] = val;
    }
  }
  return { meta, body: m[2]?.replace(/^\n/, '') ?? '' };
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
export interface WriteResult {
  ok: boolean;
  path?: string;
  error?: string;
  archived?: boolean;
}

/** Write (or overwrite across create/edit). Validated; returns errors rather
 *  than throwing, matching the tool's JSON contract. */
export function writeSkill(projectDir: string, input: CreateInput): WriteResult {
  try {
    const name = String(input.name ?? '').trim();
    if (!name) return { ok: false, error: 'name is required' };
    if (!input.description) return { ok: false, error: 'description is required' };
    if (!input.body || !input.body.trim()) return { ok: false, error: 'body is required' };
    const slug = safeSlug(name);
    const root = input.category
      ? join(skillsRoot(projectDir), safeSlug(input.category), slug)
      : join(skillsRoot(projectDir), slug);
    mkdirSync(root, { recursive: true });
    const target = join(root, 'SKILL.md');
    writeFileSync(target, renderSkill({ name, description: input.description, category: input.category, body: input.body }), 'utf8');
    markUsed(projectDir, name, { category: input.category });
    return { ok: true, path: target };
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
  try {
    const text = readFileSync(target.path, 'utf8');
    if (replaceAll) {
      const split = text.split(oldString);
      if (split.length === 1) return { ok: false, error: 'old_string not found' };
      writeFileSync(target.path, split.join(newString), 'utf8');
    } else {
      const idx = text.indexOf(oldString);
      if (idx === -1) return { ok: false, error: 'old_string not found' };
      writeFileSync(target.path, text.slice(0, idx) + newString + text.slice(idx + oldString.length), 'utf8');
    }
    bumpPatch(projectDir, name);
    return { ok: true, path: target.path };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
      'Create, edit, patch, or delete your own reusable procedural-memory skills (SKILL.md files). ' +
      'Skills are how you get smarter over time: capture every non-obvious fix, repeated workflow, or hard-won ' +
      'convention as a structured guide (trigger conditions → numbered steps with reasons → pitfalls → verification) ' +
      'so future sessions start with the answer instead of re-deriving it. Load the `skill-authoring` skill once for ' +
      'the quality bar before your first create. Skills are advertised to every future session and the user can list ' +
      'and read them with `mochi skills`. Author-created skills persist across projects when saved via category ' +
      '"global" (stored under ~/.mochi/skills/); default is per-project .mochi/skills/. The background curator keeps ' +
      'the tree healthy. Actions: create (name+description+body, optional category); ' +
      'edit (name + new description/body); patch (name + old_string/new_string, replace_all optional); ' +
      'delete (name) — archives, never hard-deletes.',
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
      const targetDir = category === 'global' || category === 'user'
        ? (process.env.HOME ? join(process.env.HOME, '.mochi', 'skills') : projectDir)
        : projectDir;
      const r = writeSkill(targetDir, {
        name,
        description: String(args.description ?? ''),
        body: String(args.body ?? ''),
        category: category === 'global' || category === 'user' ? undefined : category,
      });
      if (!r.ok) return JSON.stringify(r);
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
      writeSkill(projectDir, {
        name,
        description: newDesc,
        body: newBody,
        category: typeof pf.meta.category === 'string' ? pf.meta.category : undefined,
      });
      bumpPatch(projectDir, name);
      return `Updated skill '${name}'.`;
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