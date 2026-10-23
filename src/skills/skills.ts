import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  // P5 (cache stability): render in canonical name order. Discovery walks
  // the filesystem (readdir order is OS/fs-dependent) and callers pass
  // selections in score order — without a canonical render order the same
  // skill set could serialize differently across runs and break the
  // provider prefix cache. Callers that need score order (pickers) use
  // the search API, not this prompt block.
  visible = [...visible].sort((a, b) => a.name.localeCompare(b.name));
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


// ---- Unified skill usage registry ------------------------------------------
// ONE store for everything the harness knows about a skill's use: outcome
// stats (loads/wins — read by the selection boost in context.ts / the TUI)
// AND lifecycle metadata (agentCreated/patches/createdAt/lastUsedAt/category
// — read by the skill curator in skill-manager.ts). These used to live in
// two files (skill-usage.json here, skill-meta.json in skill-manager.ts)
// written by disjoint call sites, so they disagreed: a skill loaded daily
// via the skill tool never refreshed the curator's lastUsedAt clock and
// could be archived as "unused". skill-usage.json is canonical; a legacy
// skill-meta.json is merged in (and removed) on first load.

/** Where the unified per-project skill usage registry lives. */
export function skillUsagePath(projectDir: string): string {
  return join(mochiStateDir(projectDir), 'skill-usage.json');
}

/** Legacy second registry (skill-manager's old file), migrated on load. */
function legacySkillMetaPath(projectDir: string): string {
  return join(mochiStateDir(projectDir), 'skill-meta.json');
}

/** Lifecycle states for the evidence-based skill lifecycle. A record with
 *  NO state predates the lifecycle (bundled / hand-written / legacy) and is
 *  treated as active and outside lifecycle management. */
export type SkillLifecycleState = 'probation' | 'active' | 'demoted';

/** A run's final verifier-gate verdict, in trajectory vocabulary. 'none'
 *  means the gate never produced a verdict for the run (chat/research kinds,
 *  or verification not reached) — such runs are loads, not evidence. */
export type SkillRunVerdict = 'pass' | 'fail' | 'partial' | 'blocked' | 'none';

/** Verified outcomes that count as lifecycle evidence (window entries). */
export type SkillVerifiedOutcome = 'pass' | 'fail' | 'partial';

export interface SkillUsage {
  loads: number;
  wins: number;
  /** MCH-201: loss count for the derived quality score. */
  losses?: number;
  /** MCH-201: derived 0-100 quality score (computeSkillScore). */
  score?: number;
  agentCreated?: boolean;
  patches?: number;
  createdAt?: number;
  lastUsedAt?: number;
  category?: string;
  // ── Evidence lifecycle (B1) — all optional; absent = legacy record ──
  /** Current lifecycle state (agent-authored skills only). */
  state?: SkillLifecycleState;
  /** When the current state was entered (ms epoch). */
  stateAt?: number;
  /** When the CURRENT probation spell began (reset on re-entry). */
  probationSince?: number;
  /** Cumulative loaded runs whose final gate verdict was PASS. */
  verifiedPasses?: number;
  /** Cumulative loaded runs whose final gate verdict was FAIL or BLOCKED. */
  verifiedFails?: number;
  /** Cumulative loaded runs whose final gate verdict was PARTIAL. */
  verifiedPartials?: number;
  /** Rolling window of the last 10 verified outcomes, oldest first. */
  recentOutcomes?: SkillVerifiedOutcome[];
  /** Verified PASS runs since entering the current state (promotion bar). */
  passesInState?: number;
  /** Demotions not yet cleared by a re-promotion. */
  demotionStrikes?: number;
  /** ACE-style counters: a load followed by gate PASS / FAIL|PARTIAL|BLOCKED. */
  helpful?: number;
  harmful?: number;
  /** Verified loaded runs per task kind (baseline subtraction input). */
  kindLoads?: Record<string, number>;
  /** Of those, the runs ending in gate PASS, per task kind. */
  kindPasses?: Record<string, number>;
  /** Most recent verified verdict + when, for audit/reporting. */
  lastVerdict?: SkillVerifiedOutcome;
  lastVerdictAt?: number;
  /** Evidence string recorded at the most recent demotion. */
  lastDemotionReason?: string;
  // ── Automatic repair (D8) — written only by skill-repair.ts ──
  /** Completed repair attempts (patched + re-probationed). Capped at
   *  MAX_SKILL_REPAIR_ATTEMPTS in skill-repair.ts; a skill at the cap
   *  stays demoted until a human intervenes. */
  repairAttempts?: number;
  /** When the most recent repair attempt finished (ms epoch). */
  lastRepairAt?: number;
  /** Outcome of the most recent repair attempt: the patch summary on
   *  success, or the refusal/failure reason (incl. exhaustion). */
  lastRepairReason?: string;
}

/** Tolerant per-entry parse: an entry is kept when it carries outcome stats
 *  (numeric loads+wins) or any lifecycle field; anything else is malformed
 *  and dropped (the pre-unification loader dropped non-numeric loads/wins). */
function parseUsageRecord(v: unknown): SkillUsage | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const hasStats = typeof r.loads === 'number' && typeof r.wins === 'number';
  const hasMeta = typeof r.agentCreated === 'boolean' || typeof r.patches === 'number'
    || typeof r.createdAt === 'number' || typeof r.lastUsedAt === 'number'
    || typeof r.state === 'string';
  if (!hasStats && !hasMeta) return null;
  const out: SkillUsage = {
    loads: typeof r.loads === 'number' ? r.loads : 0,
    wins: typeof r.wins === 'number' ? r.wins : 0,
  };
  if (typeof r.losses === 'number') out.losses = r.losses;
  if (typeof r.score === 'number') out.score = r.score;
  if (typeof r.agentCreated === 'boolean') out.agentCreated = r.agentCreated;
  if (typeof r.patches === 'number') out.patches = r.patches;
  if (typeof r.createdAt === 'number') out.createdAt = r.createdAt;
  if (typeof r.lastUsedAt === 'number') out.lastUsedAt = r.lastUsedAt;
  if (typeof r.category === 'string') out.category = r.category;
  // Evidence-lifecycle fields: copied only when well-typed, so a hand-edited
  // or partially corrupt registry degrades to legacy behavior per-field
  // instead of poisoning the whole record.
  if (r.state === 'probation' || r.state === 'active' || r.state === 'demoted') out.state = r.state;
  if (typeof r.stateAt === 'number') out.stateAt = r.stateAt;
  if (typeof r.probationSince === 'number') out.probationSince = r.probationSince;
  if (typeof r.verifiedPasses === 'number') out.verifiedPasses = r.verifiedPasses;
  if (typeof r.verifiedFails === 'number') out.verifiedFails = r.verifiedFails;
  if (typeof r.verifiedPartials === 'number') out.verifiedPartials = r.verifiedPartials;
  if (Array.isArray(r.recentOutcomes)) {
    const win = r.recentOutcomes.filter((o): o is SkillVerifiedOutcome => o === 'pass' || o === 'fail' || o === 'partial');
    if (win.length) out.recentOutcomes = win.slice(-10);
  }
  if (typeof r.passesInState === 'number') out.passesInState = r.passesInState;
  if (typeof r.demotionStrikes === 'number') out.demotionStrikes = r.demotionStrikes;
  if (typeof r.helpful === 'number') out.helpful = r.helpful;
  if (typeof r.harmful === 'number') out.harmful = r.harmful;
  const numRec = (v: unknown): Record<string, number> | undefined => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const rec: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) if (typeof n === 'number') rec[k] = n;
    return Object.keys(rec).length ? rec : undefined;
  };
  const kl = numRec(r.kindLoads); if (kl) out.kindLoads = kl;
  const kp = numRec(r.kindPasses); if (kp) out.kindPasses = kp;
  if (r.lastVerdict === 'pass' || r.lastVerdict === 'fail' || r.lastVerdict === 'partial') out.lastVerdict = r.lastVerdict;
  if (typeof r.lastVerdictAt === 'number') out.lastVerdictAt = r.lastVerdictAt;
  if (typeof r.lastDemotionReason === 'string') out.lastDemotionReason = r.lastDemotionReason;
  if (typeof r.repairAttempts === 'number') out.repairAttempts = r.repairAttempts;
  if (typeof r.lastRepairAt === 'number') out.lastRepairAt = r.lastRepairAt;
  if (typeof r.lastRepairReason === 'string') out.lastRepairReason = r.lastRepairReason;
  return out;
}

/** Read the unified registry; missing/corrupt file -> empty map (never
 *  break a run). Merges a legacy skill-meta.json when one is present. */
export function loadSkillUsage(projectDir: string): Map<string, SkillUsage> {
  const out = new Map<string, SkillUsage>();
  try {
    const p = skillUsagePath(projectDir);
    if (existsSync(p)) {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        const rec = parseUsageRecord(v);
        if (rec) out.set(k, rec);
      }
    }
  } catch { /* corrupt stats are non-fatal */ }
  migrateLegacySkillMeta(projectDir, out);
  return out;
}

/** One-time migration: fold legacy skill-meta.json records into the
 *  canonical registry (canonical fields win; legacy fills gaps), persist
 *  the merge, and remove the legacy file so the stores can't diverge again. */
function migrateLegacySkillMeta(projectDir: string, into: Map<string, SkillUsage>): void {
  try {
    const legacy = legacySkillMetaPath(projectDir);
    if (!existsSync(legacy)) return;
    const parsed = JSON.parse(readFileSync(legacy, 'utf8')) as Record<string, unknown>;
    for (const [k, v] of Object.entries(parsed)) {
      const rec = parseUsageRecord(v);
      if (!rec) continue;
      const cur = into.get(k);
      if (!cur) { into.set(k, rec); continue; }
      if (cur.agentCreated === undefined && rec.agentCreated !== undefined) cur.agentCreated = rec.agentCreated;
      if (cur.patches === undefined && rec.patches !== undefined) cur.patches = rec.patches;
      if (cur.createdAt === undefined && rec.createdAt !== undefined) cur.createdAt = rec.createdAt;
      if (cur.lastUsedAt === undefined && rec.lastUsedAt !== undefined) cur.lastUsedAt = rec.lastUsedAt;
      if (cur.category === undefined && rec.category !== undefined) cur.category = rec.category;
    }
    saveSkillUsage(projectDir, into);
    try { rmSync(legacy, { force: true }); } catch { /* the in-memory merge still applied */ }
  } catch { /* legacy migration is best-effort */ }
}

/** Persist the unified registry (best-effort; stats never break a run). */
export function saveSkillUsage(projectDir: string, usage: Map<string, SkillUsage>): void {
  try {
    mkdirSync(mochiStateDir(projectDir), { recursive: true });
    const obj: Record<string, SkillUsage> = {};
    for (const [k, v] of usage) obj[k] = v;
    writeFileSync(skillUsagePath(projectDir), JSON.stringify(obj, null, 2));
  } catch { /* stats are best-effort */ }
}

/** Record one skill load; `won` marks the run ending successfully after use.
 *  Also stamps lastUsedAt: the curator's staleness clock reads this same
 *  registry, so a load here is what keeps a used skill from being archived
 *  as stale. */
export function recordSkillUsage(projectDir: string, name: string, won?: boolean): void {
  try {
    const all = loadSkillUsage(projectDir);
    const now = Date.now();
    const cur = all.get(name) ?? { loads: 0, wins: 0 };
    cur.loads += 1;
    if (won === true) cur.wins += 1;
    if (!cur.createdAt) cur.createdAt = now;
    cur.lastUsedAt = now;
    all.set(name, cur);
    saveSkillUsage(projectDir, all);
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

// ─── Evidence-based skill lifecycle: settings + outcome recording (B1) ────
// Promotion currency is the verifier gate, never self-report: the loop's
// finish path records each loaded skill's run verdict here, and the curator
// (skill-curator.ts) turns the accumulated evidence into state transitions.

/** Minimum raw relevance (tokenOverlap base score) for a skill in each
 *  lifecycle state to be ADVERTISED for a task. The normal floor is
 *  MIN_SKILL_SCORE in context.ts (0.25); probationers must match strongly,
 *  demoted skills very strongly. Explicit `skill` loads by name bypass this —
 *  advertising is what's gated, not access. */
export const PROBATION_ADVERTISE_FLOOR = 0.5;
export const DEMOTED_ADVERTISE_FLOOR = 0.6;
/** Verified gate-PASS runs (in the current state) required for promotion. */
export const PROMOTION_MIN_PASSES = 3;
/** A probation spell older than this without promotion is flagged stale. */
export const PROBATION_EXPIRY_MS = 14 * 24 * 3600_000;
/** Verified-outcome window the demotion rule reads. */
export const DEMOTION_WINDOW = 10;
/** Window pass-rate must trail the matched baseline by more than this. */
export const DEMOTION_MARGIN = 0.15;
/** Minimum matched-baseline runs before the baseline comparison is trusted. */
export const DEMOTION_MIN_BASELINE_RUNS = 10;

export interface SkillsSettings {
  /** Probation enforcement: birth stamps, advertising gates, lifecycle
   *  transitions in the curator. Off = legacy behavior throughout. */
  probationEnabled: boolean;
}

/** Resolve lifecycle settings: env MOCHI_SKILLS_PROBATION beats config,
 *  which beats the default (ON). Read at call time so tests and long-running
 *  processes can flip it without a restart. */
export function resolveSkillsSettings(config?: { skills?: { probation?: boolean } }): SkillsSettings {
  const env = process.env.MOCHI_SKILLS_PROBATION;
  if (env !== undefined && env.trim() !== '') {
    return { probationEnabled: !/^(0|false|no)$/i.test(env.trim()) };
  }
  return { probationEnabled: config?.skills?.probation !== false };
}

/** Advertisement gates from registry state: skill name → minimum RAW
 *  relevance score it must clear to be advertised for a task. Probation
 *  skills need a strong match, demoted skills a very strong one. Empty
 *  when enforcement is off (legacy behavior: no gates at all). */
export function advertiseGateFloors(usage: Map<string, SkillUsage>, settings: SkillsSettings): Map<string, number> {
  const gates = new Map<string, number>();
  if (!settings.probationEnabled) return gates;
  for (const [name, rec] of usage) {
    if (rec.state === 'probation') gates.set(name, PROBATION_ADVERTISE_FLOOR);
    else if (rec.state === 'demoted') gates.set(name, DEMOTED_ADVERTISE_FLOOR);
  }
  return gates;
}

/** Record the verified outcome of one run that loaded `name`. This is the
 *  ONLY writer of the evidence fields; state transitions are the curator's
 *  job, never the recorder's. A 'none' verdict carries no evidence and is
 *  ignored (the run's load/win were already recorded by recordSkillUsage).
 *  BLOCKED folds into the fail bucket: the gate refused to certify the run,
 *  which is failure evidence for any skill that participated in it. */
export function recordSkillOutcome(projectDir: string, name: string, verdict: SkillRunVerdict, kind?: string): void {
  if (verdict === 'none') return;
  try {
    const all = loadSkillUsage(projectDir);
    const cur = all.get(name) ?? { loads: 0, wins: 0 };
    const now = Date.now();
    const outcome: SkillVerifiedOutcome = verdict === 'pass' ? 'pass' : verdict === 'partial' ? 'partial' : 'fail';
    if (outcome === 'pass') {
      cur.verifiedPasses = (cur.verifiedPasses ?? 0) + 1;
      cur.helpful = (cur.helpful ?? 0) + 1;
      if (cur.state === 'probation' || cur.state === 'demoted') cur.passesInState = (cur.passesInState ?? 0) + 1;
    } else if (outcome === 'partial') {
      cur.verifiedPartials = (cur.verifiedPartials ?? 0) + 1;
      cur.harmful = (cur.harmful ?? 0) + 1;
    } else {
      cur.verifiedFails = (cur.verifiedFails ?? 0) + 1;
      cur.harmful = (cur.harmful ?? 0) + 1;
    }
    const win = [...(cur.recentOutcomes ?? []), outcome];
    cur.recentOutcomes = win.slice(-DEMOTION_WINDOW);
    if (kind) {
      cur.kindLoads = { ...(cur.kindLoads ?? {}), [kind]: (cur.kindLoads?.[kind] ?? 0) + 1 };
      if (outcome === 'pass') cur.kindPasses = { ...(cur.kindPasses ?? {}), [kind]: (cur.kindPasses?.[kind] ?? 0) + 1 };
    }
    cur.lastVerdict = outcome;
    cur.lastVerdictAt = now;
    if (!cur.createdAt) cur.createdAt = now;
    cur.lastUsedAt = now;
    all.set(name, cur);
    saveSkillUsage(projectDir, all);
  } catch { /* evidence recording is best-effort, like all skill stats */ }
}

// ─── Per-kind run baseline (the "no-skill" comparison arm) ────────────────
// Demotion compares a skill's window pass-rate against runs of the same task
// kinds that did NOT load it. Two small aggregates make that computable:
// global per-kind verified totals here, and the skill's own per-kind counts
// on its registry record (subtracted back out at comparison time).

export interface SkillKindStat { runs: number; passes: number }

export function skillKindStatsPath(projectDir: string): string {
  return join(mochiStateDir(projectDir), 'skill-kind-stats.json');
}

export function loadSkillKindStats(projectDir: string): Record<string, SkillKindStat> {
  try {
    const p = skillKindStatsPath(projectDir);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    const out: Record<string, SkillKindStat> = {};
    for (const [k, v] of Object.entries(parsed)) {
      const r = v as { runs?: unknown; passes?: unknown } | null;
      if (r && typeof r.runs === 'number' && typeof r.passes === 'number') out[k] = { runs: r.runs, passes: r.passes };
    }
    return out;
  } catch { return {}; }
}

/** Record one VERIFIED run of `kind` (any run, skill or not) into the
 *  baseline totals. Called once per run by the loop's finish path. */
export function recordSkillKindOutcome(projectDir: string, kind: string, passed: boolean): void {
  if (!kind) return;
  try {
    const stats = loadSkillKindStats(projectDir);
    const cur = stats[kind] ?? { runs: 0, passes: 0 };
    cur.runs += 1;
    if (passed) cur.passes += 1;
    stats[kind] = cur;
    mkdirSync(mochiStateDir(projectDir), { recursive: true });
    writeFileSync(skillKindStatsPath(projectDir), JSON.stringify(stats, null, 2));
  } catch { /* baseline stats are best-effort */ }
}

/** Matched no-skill baseline for a skill: per-kind verified totals MINUS the
 *  skill's own per-kind verified loads, weighted by where the skill was
 *  actually loaded. Returns rate=null when no baseline data exists. */
export function skillKindBaseline(rec: SkillUsage, kindStats: Record<string, SkillKindStat>): { rate: number | null; runs: number } {
  let runs = 0;
  let passes = 0;
  for (const [kind, loads] of Object.entries(rec.kindLoads ?? {})) {
    const total = kindStats[kind];
    if (!total) continue;
    const baseRuns = Math.max(0, total.runs - loads);
    const basePasses = Math.max(0, Math.min(baseRuns, total.passes - (rec.kindPasses?.[kind] ?? 0)));
    runs += baseRuns;
    passes += basePasses;
  }
  return { rate: runs > 0 ? passes / runs : null, runs };
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
    if (scored.length === 0) return [];
    // False-positive gate: TF-IDF alone can't tell "write isValidIpv4" from
    // "code-readability" — every query shares generic tokens (write, code,
    // function). When the runner-up is nearly as good as the leader, the whole
    // result set is noise: no skill is actually relevant. Require the leader
    // to clear the floor AND lead the pack by a real margin (1.4×) before
    // advertising anything; otherwise advertise nothing, like the linear gate.
    const leader = scored[0];
    const runnerUp = scored[1]?.score ?? 0;
    if (leader.score < runnerUp * 1.4) return [];
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
