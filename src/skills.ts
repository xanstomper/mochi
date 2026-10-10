import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Agent Skills support (agentskills.io spec), modeled on pi's loader. Skills are
// markdown files (typically `SKILL.md` or `my-skill.md`) whose YAML frontmatter
// declares a `name` + `description`. They give the model reusable, task-specific
// instructions (workflows) it can load on demand, so a codebase can teach Mochi
// "how we do releases / how to fix a test / our conventions" without the model
// guessing. The agent advertises <available_skills> in the system prompt and a
// `skill` tool loads a chosen skill's full body.
//
// Fully offline + deterministic (no model, no network): parsing, discovery,
// dedup, and prompt formatting are all pure, unit-testable.

export interface Skill {
  name: string;
  description: string;
  path: string;
  /** When true, the skill is not advertised to the model (only explicit loads). */
  disableModelInvocation?: boolean;
  /** Optional tool names the skill expects to be available. */
  tools?: string[];
}

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

const NAME_RE = /^[a-z0-9-]+$/;

export function validateSkillName(name: string): string[] {
  const errs: string[] = [];
  if (name.length > MAX_NAME_LENGTH) errs.push(`name exceeds ${MAX_NAME_LENGTH} chars`);
  if (!NAME_RE.test(name)) errs.push('name must be lowercase a-z, 0-9, hyphens only');
  return errs;
}

/** Parse a small YAML-ish frontmatter block. Handles scalar strings, flags, and
 *  `- item` arrays (projecting both inline and multiline lists). Not a full YAML
 *  parser (enough for the agentskills spec). */
export function parseFrontmatter(raw: string): { frontmatter: Record<string, string | boolean | string[]>; body: string } {
  const m = /^\ufeff?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const yaml = m[1];
  const body = (m[2] ?? '').replace(/^\r?\n/, '');
  const out: Record<string, string | boolean | string[]> = {};
  const lines = yaml.split(/\r?\n/);
  let lastArrayKey: string | undefined;
  for (const line of lines) {
    if (/^\s*-\s+/.test(line) && lastArrayKey) {
      const item = line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '');
      if (item) (out[lastArrayKey] as string[]).push(item);
      continue;
    }
    lastArrayKey = undefined;
    const idx = line.search(/:\s*/);
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!key) continue;
    if (value === 'true' || value === 'false') {
      out[key] = value === 'true';
    } else if (value.startsWith('- ')) {
      const arr = [value.slice(2).trim().replace(/^["']|["']$/g, '')];
      out[key] = arr;
      lastArrayKey = key;
    } else if (value === '') {
      // A key with no inline value is an array/list start (items follow).
      out[key] = [];
      lastArrayKey = key;
    } else {
      out[key] = value.replace(/^["']|["']$/g, '').trim();
    }
  }
  return { frontmatter: out, body };
}

/** Load a single skill from a markdown file. Returns null (with diagnostics)
 *  if it lacks both a name and a description. */
export function loadSkillFile(filePath: string): { skill: Skill | null; diagnostics: string[] } {
  const diagnostics: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return { skill: null, diagnostics: [`cannot read ${filePath}: ${err instanceof Error ? err.message : err}`] };
  }
  const { frontmatter } = parseFrontmatter(raw);
  const name = (frontmatter.name as string) || basename(dirname(filePath));
  const description = (frontmatter.description as string) || '';
  if (!description.trim()) {
    return { skill: null, diagnostics: [`skill ${name} has no description; skipping`] };
  }
  const tools = Array.isArray(frontmatter.tools)
    ? (frontmatter.tools as string[])
    : typeof frontmatter.tools === 'string'
      ? (frontmatter.tools as string).split(/[\s,]+/).filter(Boolean)
      : undefined;
  for (const e of validateSkillName(name)) diagnostics.push(`skill ${name}: ${e}`);
  return {
    skill: {
      name,
      description: description.slice(0, MAX_DESCRIPTION_LENGTH),
      path: filePath,
      disableModelInvocation: frontmatter['disable-model-invocation'] === true,
      tools,
    },
    diagnostics,
  };
}

/** Recursively discover skill files under `dir`. A directory containing a
 *  `SKILL.md` is a skill root (no further recursion below it). Plain `*.md`
 *  files with frontmatter in the root are also skills. Returns skills and any
 *  per-file diagnostics (e.g. invalid names).
 *
 *  `maxEntries` bounds the total number of directory entries scanned across the
 *  whole walk. This is a hard safety valve against pathological trees (e.g. a
 *  huge home directory) that would otherwise block the event loop with
 *  synchronous `readdirSync` calls during prompt build. When the budget is
 *  exhausted the walk stops early and returns whatever it found so far. */
export function discoverSkills(dir: string, depth = 0, maxEntries = 4096): { skills: Skill[]; diagnostics: string[] } {
  if (!existsSync(dir)) return { skills: [], diagnostics: [] };
  if (depth > 6) return { skills: [], diagnostics: [] };
  const skills: Skill[] = [];
  const diagnostics: string[] = [];
  let entries: { name: string; isDir: boolean }[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return { skills, diagnostics };
  }
  if (maxEntries <= 0) return { skills, diagnostics };
  const hasSkillMd = entries.some((e) => e.name === 'SKILL.md' && !e.isDir);
  if (hasSkillMd) {
    const p = join(dir, 'SKILL.md');
    const r = loadSkillFile(p);
    if (r.skill) skills.push(r.skill);
    diagnostics.push(...r.diagnostics);
    return { skills, diagnostics }; // skill root: do not recurse further
  }
  // The entry budget bounds the number of directory entries processed across
  // the WHOLE walk (not per directory). Each processed entry decrements a
  // running remainder handed down to subdirectories, so a pathological tree
  // with thousands of files is cut short instead of blocking the event loop
  // with unbounded readdirSync calls; an over-budget flat dir still yields its
  // first maxEntries files rather than nothing.
  let rem = maxEntries;
  for (const e of entries) {
    if (rem <= 0) break; // entry budget exhausted: stop walking
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDir) {
      const sub = discoverSkills(full, depth + 1, rem);
      rem -= 1;
      skills.push(...sub.skills);
      diagnostics.push(...sub.diagnostics);
      continue;
    }
    if (e.name.endsWith('.md')) {
      rem -= 1;
      const r = loadSkillFile(full);
      if (r.skill) skills.push(r.skill);
      diagnostics.push(...r.diagnostics);
    }
  }
  return { skills, diagnostics };
}

/** Load skills from both a project skills dir and a user/global skills dir.
 *  Dedups by name; on collision the project skill wins (most specific), and the
 *  same file reached twice is only counted once. */
export function loadProjectSkills(projectDir: string, userDir?: string, extraDirs: string[] = []): { skills: Skill[]; diagnostics: string[] } {
  const map = new Map<string, Skill>();
  const seen = new Set<string>();
  const diagnostics: string[] = [];
  function add(skills: Skill[], d: string[]) {
    diagnostics.push(...d);
    for (const s of skills) {
      if (seen.has(s.path)) continue;
      seen.add(s.path);
      map.set(s.name, s);
    }
  }
  const effectiveUser = userDir || defaultUserSkillsDir();
  if (effectiveUser) {
    const u = discoverSkills(effectiveUser);
    add(u.skills, u.diagnostics);
  }
  const proj = discoverSkills(join(projectDir, '.mochi', 'skills'));
  add(proj.skills, proj.diagnostics);
  for (const d of extraDirs) {
    const x = discoverSkills(d);
    add(x.skills, x.diagnostics);
  }
  return { skills: [...map.values()], diagnostics };
}

/** Format skills for injection into the system prompt (Agent Skills XML). */
export function formatSkillsForPrompt(skills: Skill[], limit?: number): string {
  let visible = skills.filter((s) => !s.disableModelInvocation);
  if (limit && limit > 0) visible = visible.slice(0, limit);
  if (visible.length === 0) return '';
  const lines = [
    '',
    'The following skills provide specialized instructions for specific tasks.',
    'When the task matches a skill description, use the `skill` tool to load its body before acting.',
    '<available_skills>',
  ];
  for (const s of visible) {
        lines.push(`  <skill name="${esc(s.name)}"><description>${esc(s.description)}</description></skill>`);
  }
  lines.push('</available_skills>');
  return lines.join('\n');
}


// ---- MCH-40 (skills v2): usage stats + staleness + conflict detection ------

/** Where per-project skill usage stats live. JSON: { [skillName]: { loads, wins } } */
export function skillUsagePath(projectDir: string): string {
  return join(projectDir, '.mochi', 'skill-usage.json');
}

export interface SkillUsage { loads: number; wins: number }

/** Read usage stats; missing/corrupt file -> empty map (never break a run). */
export function loadSkillUsage(projectDir: string): Map<string, SkillUsage> {
  const out = new Map<string, SkillUsage>();
  try {
    const p = skillUsagePath(projectDir);
    if (!existsSync(p)) return out;
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Record<string, SkillUsage>;
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v.loads === 'number' && typeof v.wins === 'number') out.set(k, v);
    }
  } catch { /* corrupt stats are non-fatal */ }
  return out;
}

/** Record one skill load; `won` marks the run ending successfully after use. */
export function recordSkillUsage(projectDir: string, name: string, won?: boolean): void {
  try {
    const p = skillUsagePath(projectDir);
    const all: Record<string, SkillUsage> = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
    const cur = all[name] ?? { loads: 0, wins: 0 };
    cur.loads += 1;
    if (won === true) cur.wins += 1;
    all[name] = cur;
    mkdirSync(join(projectDir, '.mochi'), { recursive: true });
    writeFileSync(p, JSON.stringify(all, null, 2));
  } catch { /* stats are best-effort */ }
}

/** Build the boost map for selectRelevantSkills: wins count as successes. */
export function usageBoostMap(usage: Map<string, SkillUsage>): Map<string, number> {
  const m = new Map<string, number>();
  for (const [name, u] of usage) {
    if (u.loads >= 3 && u.wins > 0) m.set(name, u.wins);
  }
  return m;
}

/** Stale = frontmatter `updated` stamp older than 90 days, or no stamp and
 *  file mtime older than 90 days. Returns skill names needing a refresh. */
export function staleSkills(skills: Skill[], now = Date.now()): string[] {
  const NINETY_DAYS = 90 * 24 * 3600 * 1000;
  const out: string[] = [];
  for (const s of skills) {
    try {
      const raw = readFileSync(s.path, 'utf8');
      const m = raw.match(/^updated:\s*(\d{4}-\d{2}-\d{2})/m);
      if (m) {
        const age = now - new Date(m[1] + 'T00:00:00Z').getTime();
        if (age > NINETY_DAYS) out.push(s.name);
      } else {
        const stat = statSync(s.path) as { mtimeMs: number };
        if (now - stat.mtimeMs > NINETY_DAYS) out.push(s.name);
      }
    } catch { /* unreadable: skip */ }
  }
  return out;
}

/** Conflicts: two skills whose name+description overlap >0.8 tokenOverlap —
 *  the model can't choose between near-twins, so surface them for merge. */
export function skillConflicts(skills: Skill[]): Array<{ a: string; b: string; score: number }> {
  const out: Array<{ a: string; b: string; score: number }> = [];
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const score = skillConflictScore(skills[i], skills[j]);
      if (score > 0.8) out.push({ a: skills[i].name, b: skills[j].name, score: Math.round(score * 100) / 100 });
    }
  }
  return out;
}

function skillConflictScore(a: Skill, b: Skill): number {
  // Local overlap copy to avoid a circular import with context.ts.
  const STOP = new Set(['a','an','the','and','or','of','to','in','for','on','with','that','is','be']);
  const tok = (s: string) => {
    const t = new Set<string>();
    for (const w of (s.toLowerCase().match(/[a-z0-9]+/g) ?? [])) if (!STOP.has(w)) t.add(w);
    return t;
  };
  const A = tok(a.name + ' ' + a.description);
  const B = tok(b.name + ' ' + b.description);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Read the full markdown body of a skill file (trimmed, for the skill tool). */
export function readSkillBody(skill: Skill, projectDir: string): string {
  try {
    return readFileSync(skill.path, 'utf8');
  } catch {
    // resolve relative to project skills dir as a fallback
    try {
      return readFileSync(join(projectDir, '.mochi', 'skills', skill.name, 'SKILL.md'), 'utf8');
    } catch {
      return '';
    }
  }
}

// type helper preserved for tool context handoff
export type SkillContext = { skill: Skill; body: string };

/** Path to the repo-bundled skills catalog (shipped with the package). Skills
 *  here are always discoverable unless a project/user skill shadows the name.
 *  Works in both source (tsx) and compiled (dist) layouts. */
export function bundledSkillsDir(): string | null {
  const candidates: string[] = [];
  // 1) Module-relative (source or compiled layout): .../src or .../dist -> root/skills
  try {
    const here = fileURLToPath(import.meta.url);
    candidates.push(join(dirname(dirname(here)), 'skills'));
  } catch { /* no import.meta (bundled) */ }
  // 2) CWD-relative: look upward for the repo root that contains skills/
  const start = process.cwd();
  let d = start;
  for (let i = 0; i < 6; i++) {
    candidates.push(join(d, 'skills'));
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** Default user/global skills dir: ~/.mochi/skills. Skills here persist across
 *  projects AND sessions — agent-authored procedural memory that is always
 *  discoverable. The walk is bounded (discoverSkills budget + depth), and this
 *  is a curated .mochi subdirectory, never the raw home tree. */
export function defaultUserSkillsDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home ? join(home, '.mochi', 'skills') : '';
}

/** Additional user/global skill directories across platforms (Hermes, Antigravity, etc.).
 *  Discovered automatically in full runtime when no explicit userDir is passed. */
export function additionalUserSkillDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return [];
  const dirs = [
    join(home, '.hermes', 'skills'),
    join(home, '.gemini', 'antigravity-cli', 'skills'),
    join(home, '.gemini', 'antigravity-cli', 'builtin', 'skills'),
  ];
  return dirs.filter((d) => existsSync(d));
}

/** loadProjectSkills plus the bundled catalog appended last (so project and
 *  user skills shadow bundled ones by name). */
export function loadAllSkills(projectDir: string, userDir?: string): { skills: Skill[]; diagnostics: string[] } {
  // Correct precedence: bundled (lowest) < external cross-agent skills < project < user (highest). loadAll
  const map = new Map<string, Skill>();
  const seen = new Set<string>();
  const diagnostics: string[] = [];
  const add = (d: string) => {
    const r = discoverSkills(d);
    diagnostics.push(...r.diagnostics);
    for (const s of r.skills) {
      if (seen.has(s.path)) continue;
      seen.add(s.path);
      map.set(s.name, s); // later add() calls overwrite by name
    }
  };
  const bundled = bundledSkillsDir();
  if (bundled) add(bundled);      // lowest precedence
  // If userDir is not explicitly passed (e.g. not in an isolated test), bridge external skills
  if (!userDir && !process.env.VITEST) {
    for (const d of additionalUserSkillDirs()) {
      add(d);
    }
  }
  add(join(projectDir, '.mochi', 'skills'));
  const effectiveUser = userDir || defaultUserSkillsDir();
  if (effectiveUser) add(effectiveUser); // highest precedence — global memory
  return { skills: [...map.values()], diagnostics };
}
