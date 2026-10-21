import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { mochiStateDir } from '../core/mochi-dir.js';
import { fileURLToPath } from 'node:url';
import { lintSkillDoc, type SkillLintResult } from './skill-lint.js';
import { BLOCK_SCALAR_RE, readBlockScalar, stripMatchingQuotes } from './frontmatter.js';

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
/** Fold a YAML folded-scalar (`>`) block: adjacent non-empty lines join with a
 *  space, blank lines become paragraph breaks. */
export function parseFrontmatter(raw: string): { frontmatter: Record<string, string | boolean | string[]>; body: string } {
  const m = /^\ufeff?---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  const yaml = m[1];
  const body = (m[2] ?? '').replace(/^\r?\n/, '');
  const out: Record<string, string | boolean | string[]> = {};
  const lines = yaml.split(/\r?\n/);
  let lastArrayKey: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*-\s+/.test(line) && lastArrayKey) {
      const item = stripMatchingQuotes(line.replace(/^\s*-\s*/, '').trim());
      if (item) (out[lastArrayKey] as string[]).push(item);
      continue;
    }
    lastArrayKey = undefined;
    const idx = line.search(/:\s*/);
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!key) continue;
    // YAML block scalars (`key: |`, `key: >-`, `key: |+`, `key: |2-` …): consume
    // the indented continuation lines. Imported Cursor/Antigravity/Hermes skills
    // write long descriptions this way, and dropping the continuation left the
    // description as a bare `>-`, which broke skill retrieval + the prompt.
    const block = BLOCK_SCALAR_RE.exec(value);
    if (block) {
      const { text, next } = readBlockScalar(lines, i, value);
      out[key] = text;
      i = next;
      continue;
    }
    if (value === 'true' || value === 'false') {
      out[key] = value === 'true';
    } else if (value.startsWith('- ')) {
      const arr = [stripMatchingQuotes(value.slice(2).trim())];
      out[key] = arr;
      lastArrayKey = key;
    } else if (value === '') {
      // A key with no inline value is an array/list start (items follow).
      out[key] = [];
      lastArrayKey = key;
    } else {
      out[key] = stripMatchingQuotes(value).trim();
    }
  }
  return { frontmatter: out, body };
}

/** Lint a raw SKILL.md source. Parses frontmatter with the canonical parser so
 *  quoted YAML scalars (`name: "foo"`) are not mistaken for an invalid slug — a
 *  hand-rolled regex that kept the quotes produced false `slug-format` failures
 *  for imported Codex/Claude skills whose frontmatter quotes its values. */
export function lintSkillSource(
  raw: string,
  fallbackName = '',
): { name: string; description: string; body: string; result: SkillLintResult } {
  const { frontmatter, body } = parseFrontmatter(raw);
  const rawName = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : '';
  const name = rawName || fallbackName;
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.replace(/\s+/g, ' ').trim() : '';
  return { name, description, body, result: lintSkillDoc(name, description, body) };
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

export interface SkillSearchHit {
  skill: Skill;
  /** 0..1+ ranked score (exact name = 1.0, usage-boosted can exceed base). */
  score: number;
  /** One-line why-it-matched excerpt for pickers. */
  snippet: string;
}

const SEARCH_STOPWORDS = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'for', 'on', 'with', 'that', 'is', 'be', 'how', 'what', 'my', 'me']);

function searchTokens(s: string): Set<string> {
  const t = new Set<string>();
  for (const w of (s.toLowerCase().match(/[a-z0-9]+/g) ?? [])) {
    if (!SEARCH_STOPWORDS.has(w)) t.add(w);
  }
  return t;
}

/** Interactive skill search: multi-signal fuzzy rank over name + description
 *  (+ usage boost), returning best-effort ranked hits with snippets — never
 *  an empty "no results" dead-end when anything remotely matches. Unlike
 *  `selectRelevantSkills` (auto path, thresholded to zero), this is the
 *  USER-facing discovery path (`/skills search <q>`): recall first, the
 *  picker does the final judgment. Pure + deterministic. */
export function searchSkills(
  skills: Skill[],
  query: string,
  opts: { limit?: number; usageBoost?: Map<string, number> } = {},
): SkillSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = opts.limit ?? 8;
  const qToks = searchTokens(q);
  const hits: SkillSearchHit[] = [];
  for (const s of skills) {
    const name = s.name.toLowerCase();
    const desc = (s.description ?? '').toLowerCase();
    let score = 0;
    let snippet = s.description.split('\n')[0].slice(0, 120);
    if (name === q) {
      score = 1.0;
      snippet = `exact name match`;
    } else if (name.startsWith(q)) {
      score = 0.9;
      snippet = `name starts with "${query.trim()}"`;
    } else if (name.includes(q)) {
      score = 0.75;
      snippet = `name contains "${query.trim()}"`;
    } else if (desc.includes(q) && q.length >= 3) {
      score = 0.55;
      const i = desc.indexOf(q);
      snippet = '…' + s.description.slice(Math.max(0, i - 24), i + q.length + 48).replace(/\s+/g, ' ') + '…';
    } else if (qToks.size > 0) {
      // Token overlap, name-weighted: shared vocabulary with the NAME counts
      // double — a query token in the name is a stronger signal than one
      // buried in a long description.
      const nameToks = searchTokens(s.name.replace(/-/g, ' '));
      const descToks = searchTokens(s.description);
      let inter = 0;
      for (const t of qToks) {
        if (nameToks.has(t)) inter += 2;
        else if (descToks.has(t)) inter += 1;
      }
      const denom = Math.min(Math.max(qToks.size, 1), nameToks.size * 2 + descToks.size);
      const overlap = denom > 0 ? inter / (denom + nameToks.size) : 0;
      if (overlap > 0.12) {
        score = Math.min(0.7, 0.25 + overlap);
        snippet = `shares ${inter > 1 ? 'terms' : 'a term'} with "${query.trim()}"`;
      }
    }
    if (score > 0) {
      if (opts.usageBoost) score += Math.min(0.15, ((opts.usageBoost.get(s.name) ?? 0) / 20) * 0.15);
      hits.push({ skill: s, score, snippet });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
  return hits.slice(0, Math.max(1, limit));
}


// ---- MCH-40 (skills v2): usage stats + staleness + conflict detection ------

/** Where per-project skill usage stats live. JSON: { [skillName]: { loads, wins } } */
export function skillUsagePath(projectDir: string): string {
  return join(mochiStateDir(projectDir), 'skill-usage.json');
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
    mkdirSync(mochiStateDir(projectDir), { recursive: true });
    writeFileSync(p, JSON.stringify(all, null, 2));
  } catch { /* stats are best-effort */ }
}

/** Failure telemetry for loaded skills. Kept separate from the wins/loads
 *  counters so existing consumers keep their shape; the curator folds these
 *  notes into agent-created SKILL.md files and then clears the queue. */
export interface SkillFailureRecord {
  count: number;
  lastAt: number;
  lastError: string;
  recent: Array<{ at: number; error: string }>;
}

export function skillFailurePath(projectDir: string): string {
  return join(mochiStateDir(projectDir), 'skill-failures.json');
}

export function loadSkillFailures(projectDir: string): Record<string, SkillFailureRecord> {
  try {
    const p = skillFailurePath(projectDir);
    if (!existsSync(p)) return {};
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Record<string, SkillFailureRecord>;
    const out: Record<string, SkillFailureRecord> = {};
    for (const [name, rec] of Object.entries(raw)) {
      if (!rec || typeof rec.count !== 'number') continue;
      out[name] = {
        count: Math.max(0, Math.floor(rec.count)),
        lastAt: typeof rec.lastAt === 'number' ? rec.lastAt : 0,
        lastError: typeof rec.lastError === 'string' ? rec.lastError.slice(0, 500) : '',
        recent: Array.isArray(rec.recent)
          ? rec.recent.filter((r) => r && typeof r.error === 'string').slice(-5).map((r) => ({ at: Number(r.at) || 0, error: String(r.error).slice(0, 500) }))
          : [],
      };
    }
    return out;
  } catch {
    return {};
  }
}

function saveSkillFailures(projectDir: string, all: Record<string, SkillFailureRecord>): void {
  mkdirSync(mochiStateDir(projectDir), { recursive: true });
  writeFileSync(skillFailurePath(projectDir), JSON.stringify(all, null, 2));
}

/** Record that a loaded skill participated in a failed run. Dedupes identical
 *  consecutive errors so a retry loop cannot flood the queue. */
export function recordSkillFailure(projectDir: string, name: string, error: string): void {
  try {
    const all = loadSkillFailures(projectDir);
    const msg = String(error || 'run failed').replace(/\s+/g, ' ').trim().slice(0, 500);
    const cur = all[name] ?? { count: 0, lastAt: 0, lastError: '', recent: [] };
    cur.count += 1;
    cur.lastAt = Date.now();
    cur.lastError = msg;
    if (!cur.recent.length || cur.recent[cur.recent.length - 1].error !== msg) {
      cur.recent.push({ at: cur.lastAt, error: msg });
      cur.recent = cur.recent.slice(-5);
    }
    all[name] = cur;
    saveSkillFailures(projectDir, all);
  } catch { /* telemetry is best-effort */ }
}

/** A green run clears the failure queue for that skill. */
export function clearSkillFailures(projectDir: string, name: string): void {
  try {
    const all = loadSkillFailures(projectDir);
    if (!(name in all)) return;
    delete all[name];
    saveSkillFailures(projectDir, all);
  } catch { /* best-effort */ }
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
  const active = skills.filter((s) => !s.disableModelInvocation);
  const out: Array<{ a: string; b: string; score: number }> = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const score = skillConflictScore(active[i], active[j]);
      if (score > 0.8) out.push({ a: active[i].name, b: active[j].name, score: Math.round(score * 100) / 100 });
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
  if (A.size < 4 || B.size < 4) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
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
    // src/skills/skills.ts (or dist/skills/skills.js): up 3 = package root.
    // Also up 2 for legacy flat layouts (dist/skills.js shipped pre-0.23).
    candidates.push(join(dirname(dirname(dirname(here))), 'skills'));
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

// ─── MCH-202: TF-IDF Skill Index ─────────────────────────────────────────
// Replace O(N·M) linear token-overlap scan with an inverted term-frequency index
// cached at <projectDir>/.mochi/skill-index.json. Rebuilt only when the skills
// directories' mtimes advance. Falls back to the linear scan when unavailable.

/** Index file shape written to disk. */
export interface SkillIndex {
  /** Unix ms of the newest mtime seen across all indexed skill dirs. */
  mtime: number;
  /** Map of term → [skillName, tf] pairs where tf is in [0,1]. */
  terms: Record<string, Array<[string, number]>>;
  /** All skill names in the index (for score normalisation checks). */
  names: string[];
}

const INDEX_STOP = new Set([
  'a','an','the','and','or','of','to','in','for','on','with','that','is','be',
  'how','what','my','me','this','by','as','it','at','from','use','used','when',
]);

function indexTokens(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (w) => w.length >= 3 && !INDEX_STOP.has(w),
  );
}

/** Build and persist a TF-IDF term index for the given skill list. */
export function buildSkillIndex(skills: Skill[], indexPath: string, dirsMtime: number): void {
  try {
    const terms: Record<string, Array<[string, number]>> = {};
    for (const s of skills) {
      const tokens = indexTokens(`${s.name} ${s.description}`);
      const freq: Record<string, number> = {};
      for (const t of tokens) freq[t] = (freq[t] ?? 0) + 1;
      const total = tokens.length || 1;
      for (const [t, count] of Object.entries(freq)) {
        const tf = count / total;
        if (!terms[t]) terms[t] = [];
        terms[t].push([s.name, tf]);
      }
    }
    const idx: SkillIndex = { mtime: dirsMtime, terms, names: skills.map((s) => s.name) };
    const dir = indexPath.split('/').slice(0, -1).join('/');
    mkdirSync(dir, { recursive: true });
    writeFileSync(indexPath, JSON.stringify(idx), 'utf8');
  } catch { /* index build is best-effort; fall back to linear scan */ }
}

/** Load the cached index; return null when missing or stale (dirs have newer mtime). */
export function loadSkillIndex(indexPath: string, dirsMtime: number): SkillIndex | null {
  try {
    if (!existsSync(indexPath)) return null;
    const idx = JSON.parse(readFileSync(indexPath, 'utf8')) as SkillIndex;
    if (typeof idx.mtime !== 'number' || idx.mtime < dirsMtime) return null;
    return idx;
  } catch {
    return null;
  }
}

/** Score a single skill against a task query using the prebuilt index.
 *  Returns a value in [0, ~1] compatible with the existing tokenOverlap range. */
export function indexedRelevanceScore(task: string, skillName: string, index: SkillIndex): number {
  const qTokens = indexTokens(task);
  if (qTokens.length === 0) return 0;
  let score = 0;
  for (const t of qTokens) {
    const postings = index.terms[t];
    if (!postings) continue;
    // IDF: log2(N / df) where N = total skills, df = postings length
    const idf = Math.log2((index.names.length + 1) / (postings.length + 1));
    const entry = postings.find(([name]) => name === skillName);
    if (entry) score += entry[1] * idf;
  }
  // Normalise to roughly [0,1] by dividing by query length-weighted ceiling
  return score / (qTokens.length + 1);
}

/** Compute the maximum mtime of a list of directories (best-effort, 0 on error). */
function dirsMtimeMax(dirs: string[]): number {
  let max = 0;
  for (const d of dirs) {
    try {
      const m = statSync(d).mtimeMs;
      if (m > max) max = m;
    } catch { /* dir may not exist */ }
  }
  return max;
}

/** Filter skills relevant to the task using the TF-IDF index when available,
 *  falling back to the provided linear fallback function if the index is absent.
 *
 *  MCH-202: this is the indexed fast path replacing the O(N·M) scan in
 *  selectRelevantSkills(). Called from context.ts after discovery. */
export function filterRelevantSkillsIndexed(
  skills: Skill[],
  taskText: string,
  max: number,
  projectDir: string,
  minScore = 0.05,
  fallback?: (skills: Skill[], taskText: string, max: number) => Skill[],
): Skill[] {
  if (!taskText.trim()) return [];
  try {
    const indexPath = join(projectDir, '.mochi', 'skill-index.json');
    const skillDirs = [
      join(projectDir, '.mochi', 'skills'),
      defaultUserSkillsDir(),
    ].filter(Boolean);
    const mtime = dirsMtimeMax(skillDirs);
    let idx = loadSkillIndex(indexPath, mtime);
    if (!idx) {
      buildSkillIndex(skills, indexPath, mtime);
      idx = loadSkillIndex(indexPath, mtime);
    }
    if (!idx) {
      return fallback ? fallback(skills, taskText, max) : [];
    }
    const scored = skills
      .map((s) => ({ s, score: indexedRelevanceScore(taskText, s.name, idx!) }))
      .filter((e) => e.score >= minScore)
      .sort((a, b) => b.score - a.score || skills.indexOf(a.s) - skills.indexOf(b.s));
    return scored.slice(0, max).map((e) => e.s);
  } catch {
    return fallback ? fallback(skills, taskText, max) : [];
  }
}

/** Match a skill to an error string using the TF-IDF index. Returns the best
 *  matching skill name + its raw SKILL.md body (truncated to 2000 chars), or
 *  null when no skill scores above the quality threshold. MCH-203 support. */
export function matchSkillToError(
  errorText: string,
  workspaceDir: string,
  globalSkillsDir?: string,
): { name: string; body: string } | null {
  try {
    const { skills } = loadAllSkills(workspaceDir, globalSkillsDir);
    if (skills.length === 0) return null;
    const indexPath = join(workspaceDir, '.mochi', 'skill-index.json');
    const skillDirs = [join(workspaceDir, '.mochi', 'skills'), globalSkillsDir ?? defaultUserSkillsDir()].filter(Boolean);
    const mtime = dirsMtimeMax(skillDirs as string[]);
    let idx = loadSkillIndex(indexPath, mtime);
    if (!idx) {
      buildSkillIndex(skills, indexPath, mtime);
      idx = loadSkillIndex(indexPath, mtime);
    }
    if (!idx) return null;
    // Load usage DB synchronously to check quality score
    let usageDb: Record<string, { score?: number }> = {};
    try {
      const usagePath = join(workspaceDir, '.mochi', 'skill-meta.json');
      if (existsSync(usagePath)) {
        usageDb = JSON.parse(readFileSync(usagePath, 'utf8')) as Record<string, { score?: number }>;
      }
    } catch { /* usage load is best-effort */ }
    // Score each skill against the error text
    const scored = skills
      .map((s) => ({ s, score: indexedRelevanceScore(errorText, s.name, idx!) }))
      .filter((e) => e.score > 0.1)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return null;
    // Prefer skills with quality score >= 40
    const highQuality = scored.filter((e) => (usageDb[e.s.name]?.score ?? 0) >= 40);
    const best = highQuality[0] ?? scored[0];
    if (!best) return null;
    // Load the body
    const body = readSkillBody(best.s, workspaceDir);
    if (!body) return null;
    return { name: best.s.name, body: body.slice(0, 2000) };
  } catch {
    return null;
  }
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
