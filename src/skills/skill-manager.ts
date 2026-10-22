// Skill self-management for Mochi — ported from Hermes' `skill_manage` /
// `skill_usage` machinery (how an agent author-creates and auto-improves its
// own procedural memory, "agentskills.io" spec).
//
// Hermes model we reproduce (see hermes_cli/agent/curator.py + skill_manager):
//   - The agent authors SKILL.md files (YAML frontmatter + markdown body).
//   - Agent-created skills live in the writable, per-project
//     `.mochi/skills/<category?>/<name>/SKILL.md` tree (shadowing bundled ones).
//   - THE usage registry (`<project>/.mochi/skill-usage.json`, owned by
//     skills.ts) marks which skills are agent-created and tracks patch
//     counts / last used alongside the loads/wins outcome stats, so a
//     background curator can maintain ONLY agent-created skills and never
//     touch bundled/user skills. (It used to be a separate skill-meta.json
//     that disagreed with the stats file; skills.ts migrates it on load.)
//   - Never auto-deletes: delete() archives into `.mochi/skills/.archive/`.
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { lintSkillDoc } from './skill-lint.js';
import { parseFrontmatter as parseSkillFrontmatter, loadSkillUsage, saveSkillUsage, skillUsagePath, resolveSkillsSettings, type SkillUsage, type SkillLifecycleState, type SkillVerifiedOutcome } from './skills.js';
import { mochiStateDir } from '../core/mochi-dir.js';
import type { Tool } from '../tools/types.js';

/** Where agent-created + returned skills live, relative to the project dir. */
export function skillsRoot(projectDir: string): string {
  return join(mochiStateDir(projectDir), 'skills');
}
export function archiveRoot(projectDir: string): string {
  return join(mochiStateDir(projectDir), 'skills', '.archive');
}
/** The unified skill registry file (canonical store lives in skills.ts;
 *  this stays as the curator-facing path helper). */
export function usagePath(projectDir: string): string {
  return skillUsagePath(projectDir);
}

// ─── Usage registry (mirrors Hermes' tools/skill_usage.py) ───────────────
// Lifecycle view over the unified registry in skills.ts: loadUsage
// materializes every recorded skill with lifecycle defaults filled in, and
// saveUsage writes records back WITHOUT dropping the loads/wins outcome
// stats the selection boost reads (they round-trip on the record).

export interface UsageRecord {
  name: string;
  agentCreated: boolean;
  patches: number;
  createdAt: number;
  lastUsedAt: number;
  category?: string;
  /** Outcome stats from the unified registry (round-tripped by saveUsage). */
  loads?: number;
  wins?: number;
  /** Evidence-lifecycle state + signals (round-tripped like loads/wins;
   *  written by the birth stamp, recordSkillOutcome, and the curator). */
  state?: SkillLifecycleState;
  stateAt?: number;
  probationSince?: number;
  verifiedPasses?: number;
  verifiedFails?: number;
  verifiedPartials?: number;
  recentOutcomes?: SkillVerifiedOutcome[];
  passesInState?: number;
  demotionStrikes?: number;
  helpful?: number;
  harmful?: number;
  kindLoads?: Record<string, number>;
  kindPasses?: Record<string, number>;
  lastVerdict?: SkillVerifiedOutcome;
  lastVerdictAt?: number;
  lastDemotionReason?: string;
  /** Automatic-repair bookkeeping (D8; round-tripped like the lifecycle
   *  fields above; written by skill-repair.ts). */
  repairAttempts?: number;
  lastRepairAt?: number;
  lastRepairReason?: string;
}

export interface UsageDB {
  byName: Record<string, UsageRecord>;
}
export interface MarkOpts {
  agentCreated?: boolean;
  category?: string;
}

export function loadUsage(projectDir: string): UsageDB {
  const byName: Record<string, UsageRecord> = {};
  for (const [name, u] of loadSkillUsage(projectDir)) {
    byName[name] = {
      name,
      agentCreated: u.agentCreated ?? false,
      patches: u.patches ?? 0,
      createdAt: u.createdAt ?? u.lastUsedAt ?? 0,
      lastUsedAt: u.lastUsedAt ?? 0,
      ...(u.category ? { category: u.category } : {}),
      loads: u.loads,
      wins: u.wins,
      ...(u.state ? { state: u.state } : {}),
      ...(u.stateAt !== undefined ? { stateAt: u.stateAt } : {}),
      ...(u.probationSince !== undefined ? { probationSince: u.probationSince } : {}),
      ...(u.verifiedPasses !== undefined ? { verifiedPasses: u.verifiedPasses } : {}),
      ...(u.verifiedFails !== undefined ? { verifiedFails: u.verifiedFails } : {}),
      ...(u.verifiedPartials !== undefined ? { verifiedPartials: u.verifiedPartials } : {}),
      ...(u.recentOutcomes ? { recentOutcomes: u.recentOutcomes } : {}),
      ...(u.passesInState !== undefined ? { passesInState: u.passesInState } : {}),
      ...(u.demotionStrikes !== undefined ? { demotionStrikes: u.demotionStrikes } : {}),
      ...(u.helpful !== undefined ? { helpful: u.helpful } : {}),
      ...(u.harmful !== undefined ? { harmful: u.harmful } : {}),
      ...(u.kindLoads ? { kindLoads: u.kindLoads } : {}),
      ...(u.kindPasses ? { kindPasses: u.kindPasses } : {}),
      ...(u.lastVerdict ? { lastVerdict: u.lastVerdict } : {}),
      ...(u.lastVerdictAt !== undefined ? { lastVerdictAt: u.lastVerdictAt } : {}),
      ...(u.lastDemotionReason ? { lastDemotionReason: u.lastDemotionReason } : {}),
      ...(u.repairAttempts !== undefined ? { repairAttempts: u.repairAttempts } : {}),
      ...(u.lastRepairAt !== undefined ? { lastRepairAt: u.lastRepairAt } : {}),
      ...(u.lastRepairReason ? { lastRepairReason: u.lastRepairReason } : {}),
    };
  }
  return { byName };
}

export function saveUsage(projectDir: string, db: UsageDB): void {
  const usage = new Map<string, SkillUsage>();
  for (const [name, rec] of Object.entries(db.byName)) {
    usage.set(name, {
      loads: rec.loads ?? 0,
      wins: rec.wins ?? 0,
      agentCreated: rec.agentCreated,
      patches: rec.patches,
      createdAt: rec.createdAt,
      lastUsedAt: rec.lastUsedAt,
      ...(rec.category ? { category: rec.category } : {}),
      ...(rec.state ? { state: rec.state } : {}),
      ...(rec.stateAt !== undefined ? { stateAt: rec.stateAt } : {}),
      ...(rec.probationSince !== undefined ? { probationSince: rec.probationSince } : {}),
      ...(rec.verifiedPasses !== undefined ? { verifiedPasses: rec.verifiedPasses } : {}),
      ...(rec.verifiedFails !== undefined ? { verifiedFails: rec.verifiedFails } : {}),
      ...(rec.verifiedPartials !== undefined ? { verifiedPartials: rec.verifiedPartials } : {}),
      ...(rec.recentOutcomes ? { recentOutcomes: rec.recentOutcomes } : {}),
      ...(rec.passesInState !== undefined ? { passesInState: rec.passesInState } : {}),
      ...(rec.demotionStrikes !== undefined ? { demotionStrikes: rec.demotionStrikes } : {}),
      ...(rec.helpful !== undefined ? { helpful: rec.helpful } : {}),
      ...(rec.harmful !== undefined ? { harmful: rec.harmful } : {}),
      ...(rec.kindLoads ? { kindLoads: rec.kindLoads } : {}),
      ...(rec.kindPasses ? { kindPasses: rec.kindPasses } : {}),
      ...(rec.lastVerdict ? { lastVerdict: rec.lastVerdict } : {}),
      ...(rec.lastVerdictAt !== undefined ? { lastVerdictAt: rec.lastVerdictAt } : {}),
      ...(rec.lastDemotionReason ? { lastDemotionReason: rec.lastDemotionReason } : {}),
      ...(rec.repairAttempts !== undefined ? { repairAttempts: rec.repairAttempts } : {}),
      ...(rec.lastRepairAt !== undefined ? { lastRepairAt: rec.lastRepairAt } : {}),
      ...(rec.lastRepairReason ? { lastRepairReason: rec.lastRepairReason } : {}),
    });
  }
  saveSkillUsage(projectDir, usage);
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
  /** Birth state for the evidence lifecycle (only consulted when probation
   *  enforcement is on). Default 'probation': model-authored skills must
   *  earn activation with verifier-passed runs. 'active' is reserved for
   *  paths that already carry an outcome gate of their own (lesson
   *  promotion: ≥3 retrievals + ≥1 recorded fix before the skill exists). */
  lifecycle?: 'probation' | 'active';
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
  /** Lifecycle state stamped at birth (only when probation enforcement
   *  is on; undefined = legacy behavior, no stamp). */
  state?: SkillLifecycleState;
}

/** Birth stamp for the evidence-based lifecycle. Marks the record
 *  agent-created (the curator maintains authored skills) and places the
 *  skill in its birth state. A material rewrite of an ACTIVE or DEMOTED
 *  skill re-enters probation — the new body has no evidence behind it;
 *  an edit during probation keeps the original clock and counters
 *  (refinement mid-probation is expected, not a reset). Returns the
 *  resulting state, or undefined when the stamp could not be written. */
export function stampSkillBirth(projectDir: string, name: string, bornAs: 'probation' | 'active'): SkillLifecycleState | undefined {
  try {
    const all = loadSkillUsage(projectDir);
    const cur = all.get(name) ?? { loads: 0, wins: 0 };
    const now = Date.now();
    cur.agentCreated = true;
    if (!cur.createdAt) cur.createdAt = now;
    if (bornAs === 'probation') {
      if (cur.state !== 'probation') {
        cur.state = 'probation';
        cur.stateAt = now;
        cur.probationSince = now;
        cur.passesInState = 0;
      }
    } else if (!cur.state) {
      cur.state = 'active';
      cur.stateAt = now;
    }
    all.set(name, cur);
    saveSkillUsage(projectDir, all);
    return cur.state;
  } catch { return undefined; }
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
    // Evidence lifecycle: the rubric above is only a lint gate — an authored
    // skill is born on PROBATION and is promoted by verifier-passed runs
    // (curator), never by its structural score. Enforcement off (config /
    // MOCHI_SKILLS_PROBATION=0) skips the stamp entirely: legacy behavior.
    let state: SkillLifecycleState | undefined;
    if (resolveSkillsSettings().probationEnabled) {
      state = stampSkillBirth(projectDir, name, input.lifecycle ?? 'probation');
    }
    return { ok: true, path: target, quality, ...(state ? { state } : {}) };
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
      if (r.state === 'probation') {
        return `Created skill '${name}' at ${r.path} — on PROBATION: it is advertised only when a task matches it strongly, and the curator promotes it to fully active after 3 runs that load it end in a verifier PASS (with its verification snippet, if any, passing). Its quality score (${r.quality?.score ?? 0}/100) is a format gate only and does not activate it. The user can read it with 'mochi skills ${name}'.`;
      }
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
      return r.state === 'probation'
        ? `Updated skill '${name}' (quality ${r.quality?.score ?? 0}/100). The rewrite re-enters PROBATION until verifier-passed runs re-earn activation.`
        : `Updated skill '${name}' (quality ${r.quality?.score ?? 0}/100).`;
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