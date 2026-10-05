// Skill curator — Hermes-style background self-improvement orchestrator for
// Mochi (ported from hermes_cli/agent/curator.py + tools/skills_hub.py).
//
// The curator is a background maintenance pass that runs after a task
// finishes (or on idle), enabled by default. It is deliberately conservative:
//   - Only touches agent-created skills (usage registry marks them).
//   - Never hard-deletes; archives stale skills (recoverable).
//   - Pinned skills bypass auto-transitions.
//   - Produces a durable report.
//
// It also holds the "skill opportunity" detector: when the agent has recorded
// lessons / repeated failure patterns that look like a reusable procedure, it
// flags them so the main loop can prompt the model to author a skill via the
// skill_manage tool (auto skill creation, Hermes-faithful).
import { readdirSync, existsSync, readFileSync, statSync, mkdirSync, writeFileSync, renameSync, rmdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {skillsRoot, archiveRoot, loadUsage, safeSlug, parseFrontmatter} from './skill-manager.js';

export interface CuratorConfig {
  enabled: boolean;
  staleAfterDays: number;      // unused -> flag stale
  archiveAfterDays: number;    // unused -> archive (recoverable)
  intervalMs: number;          // minimum time between runs
  consolidate: boolean;        // merge near-duplicate agent-created skills (title/token overlap)
}

export function defaultCuratorConfig(): CuratorConfig {
  return {
    enabled: true, // on by default: the curator is what makes skills improve over time
    staleAfterDays: 30,
    archiveAfterDays: 90,
    intervalMs: 24 * 3600 * 1000,
    consolidate: true, // merge near-duplicate agent-created skills as the tree grows
  };
}

// ─── Skill opportunity detection (auto skill creation trigger) ──────────

export interface SkillOpportunity {
  title: string;
  signal: string;
  confidence: number; // 0..1 heuristic
  kind: 'lesson' | 'error-pattern' | 'repeat';
}

/** A cheap, model-free signal that a reusable procedure may exist. Consumed by
 *  the loop to nudge the model toward authoring a skill with skill_manage.
 *  Mirrors Hermes' "could this be a skill?" background reviewer but without a
 *  model round-trip by default. */
export function detectSkillOpportunities(
  lessons: Array<{ title?: string; pattern?: string }>,
  errorPattern: string | undefined,
  repeatCount: number,
): SkillOpportunity[] {
  const out: SkillOpportunity[] = [];
  if (repeatCount >= 2) {
    out.push({ title: 'Recurring task class', signal: `Same strategy/answer repeated ${repeatCount}x`, confidence: Math.min(0.5 + repeatCount * 0.1, 0.9), kind: 'repeat' });
  }
  for (const l of lessons) {
    const title = l.title || l.pattern || '(lesson)';
    if (title && title.length > 3) {
      out.push({ title, signal: 'Recorded lesson', confidence: 0.7, kind: 'lesson' });
    }
  }
  if (errorPattern) {
    out.push({ title: errorPattern.slice(0, 80), signal: 'Classified failure pattern', confidence: 0.6, kind: 'error-pattern' });
  }
  const seen = new Set<string>();
  const uniq = out.filter((o) => {
    const k = `${o.kind}:${o.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return uniq.slice(0, 5);
}

/** Render opportunities as a system hint the loop can inject. */
export function opportunitiesToPrompt(opps: SkillOpportunity[]): string | null {
  if (!opps.length) return null;
  const lines = opps.map((o, i) =>
    `${i + 1}. ${o.title} (${o.signal}, ~${Math.round(o.confidence * 100)}%)`,
  );
  return 'SKILL OPPORTUNITY DETECTED — consider persisting a reusable procedure:\n' +
    lines.join('\n') +
    '\nIf this task type will recur, use `skill_manage` action="create" to save a concise ' +
    'SKILL.md (frontmatter + body) capturing the approach — and if the reusable part is an EXECUTABLE ' +
    'workflow (a command pipeline, script invocation, multi-command recipe), capture it as a callable tool ' +
    'with `tool_factory` action="create" instead (hot-loaded, callable by name forever after). ' +
    'Only do this for genuinely reusable patterns.';
}

// ─── Lifecycle scan (the curator's core pass) ────────────────────────────

export interface SkillSnapshot {
  name: string;
  path: string;
  category?: string;
  agentCreated: boolean;
  lastUsedAt: number;
  ageMs: number;
  patches: number;
}

export function scanSkills(projectDir: string, cfg: CuratorConfig): { snapshots: SkillSnapshot[]; stale: SkillSnapshot[]; archive: SkillSnapshot[] } {
  const usage = loadUsage(projectDir);
  const root = skillsRoot(projectDir);
  const snapshots: SkillSnapshot[] = [];
  if (!existsSync(root)) return { snapshots: [], stale: [], archive: [] };
  const now = Date.now();
  const visit = (p: string, category?: string) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const sub = join(p, e.name);
      const skillMd = join(sub, 'SKILL.md');
      if (existsSync(skillMd)) {
        // Resolve the canonical name from frontmatter (records are keyed by the
        // skill's `name`, not the slug directory name).
        const raw = readFileSync(skillMd, 'utf8');
        const pf = parseFrontmatter(raw);
        const canonical = pf && typeof pf.meta.name === 'string' ? pf.meta.name : e.name;
        const rec = usage.byName[canonical] ?? usage.byName[e.name] ?? { name: canonical, agentCreated: false, patches: 0, createdAt: now, lastUsedAt: now };
        const st = statSync(skillMd);
        snapshots.push({
          name: canonical,
          path: skillMd,
          category,
          agentCreated: !!rec.agentCreated,
          lastUsedAt: rec.lastUsedAt ?? now,
          ageMs: now - (st.mtimeMs || now),
          patches: rec.patches ?? 0,
        });
      } else {
        visit(sub, e.name);
      }
    }
  };
  visit(root);
  const stale = snapshots.filter((s) => s.agentCreated && now - s.lastUsedAt > cfg.staleAfterDays * 86400_000);
  const archive = snapshots.filter((s) => s.agentCreated && now - s.lastUsedAt > cfg.archiveAfterDays * 86400_000);
  return { snapshots, stale, archive };
}

export interface CuratorOutput {
  scanned: number;
  agentCreated: number;
  stale: string[];
  archived: string[];
  /** Near-duplicate merges performed when cfg.consolidate is on:
   *  {kept, merged} skill name pairs (loser body appended to winner, loser
   *  archived). Previously the `consolidate` config flag existed but was
   *  never consumed — vaporware. */
  consolidated: Array<{ kept: string; merged: string }>;
  reportPath: string;
}

/** Token-overlap similarity between two skill bodies (keywords ≥5 chars,
 *  Jaccard over the keyword sets). Deliberately embeddings-free: cheap,
 *  deterministic, good enough to catch same-procedure-different-title dupes. */
export function skillSimilarity(a: string, b: string): number {
  const kw = (s: string): Set<string> => {
    const words = s.toLowerCase().replace(/[\x00-\x1f]/g, ' ').match(/[a-z][a-z0-9_-]{4,}/g) ?? [];
    return new Set(words);
  };
  const ka = kw(a);
  const kb = kw(b);
  if (!ka.size || !kb.size) return 0;
  let inter = 0;
  for (const w of ka) if (kb.has(w)) inter++;
  return inter / (ka.size + kb.size - inter);
}

/** Merge near-duplicate agent-created skills. The OLDER skill is kept (it has
 *  the usage history); the newer body is appended under an "## Absorbed from"
 *  heading, and the newer SKILL.md is archived. Only fires on ≥70% keyword
 *  overlap, and never on pinned skills (the caller pre-filters those). */
export function consolidateSkills(
  snapshots: SkillSnapshot[],
  cfg: CuratorConfig,
): Array<{ kept: string; merged: string }> {
  if (!cfg.consolidate) return [];
  const out: Array<{ kept: string; merged: string }> = [];
  // Oldest first so the kept skill is always the earlier one.
  const sorted = [...snapshots].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  const dead = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    if (dead.has(sorted[i].name)) continue;
    const bodyA = readFileSync(sorted[i].path, 'utf8');
    for (let j = i + 1; j < sorted.length; j++) {
      if (dead.has(sorted[j].name)) continue;
      const bodyB = readFileSync(sorted[j].path, 'utf8');
      if (skillSimilarity(bodyA, bodyB) < 0.7) continue;
      // Absorb j into i: append its body, then archive j's directory.
      try {
        const absorbed = `\n\n## Absorbed from \`${sorted[j].name}\`\n\n${bodyB.trim()}\n`;
        writeFileSync(sorted[i].path, bodyA.trimEnd() + absorbed, 'utf8');
        const arc = join(archiveRoot(projectDirFor(sorted[i].path)), safeSlug(sorted[j].name), 'SKILL.md');
        mkdirSync(dirname(arc), { recursive: true });
        renameSync(sorted[j].path, arc);
        // Leave no empty husk directory in the live tree.
        try { rmdirSync(dirname(sorted[j].path)); } catch { /* non-empty or gone */ }
        out.push({ kept: sorted[i].name, merged: sorted[j].name });
        dead.add(sorted[j].name);
      } catch { /* a failed merge must not kill the curator pass */ }
    }
  }
  return out;
}

/** Recover the project dir from a skill path (…/.mochi/skills/... or …/skills/...). */
function projectDirFor(skillPath: string): string {
  const s = skillPath.split('/');
  const idx = s.lastIndexOf('skills');
  return idx > 0 ? s.slice(0, idx).join('/') : dirname(dirname(skillPath));
}

export function runCurator(projectDir: string, cfg: CuratorConfig): CuratorOutput {
  const { snapshots, stale, archive } = scanSkills(projectDir, cfg);
  const agentCreated = snapshots.filter((s) => s.agentCreated);
  const archived: string[] = [];
  const now = Date.now();
  for (const s of archive) {
    try {
      const arc = join(archiveRoot(projectDir), safeSlug(s.name), 'SKILL.md');
      mkdirSync(dirname(arc), { recursive: true });
      renameSync(s.path, arc);
      archived.push(s.name);
    } catch { /* keep going */ }
  }
  // Dedup pass runs on the survivors (post-archive). Skills the agent has
  // USED (usage record) or CREATED this session are eligible; human/bundled
  // skills are never auto-merged, and pinned skills are never merged away.
  // Fresh-but-never-used agent skills still merge: near-duplicates usually
  // come from re-authoring the same procedure in one session.
  const pinned = new Set(loadCuratorState(projectDir).pinned ?? []);
  const usage = loadUsage(projectDir);
  const consolidateable = scanSkills(projectDir, cfg).snapshots.filter((s) =>
    (s.agentCreated || usage.byName[s.name]?.agentCreated) && !archived.includes(s.name) && !pinned.has(s.name));
  const consolidated = consolidateSkills(consolidateable, cfg);
  for (const c of consolidated) archived.push(c.merged);
  const report = [
    `# Skill curator report (${new Date(now).toISOString()})`,
    `Scanned: ${snapshots.length} skills (${agentCreated.length} agent-created).`,
    `Stale: ${stale.map((s) => s.name).join(', ') || '(none)'}.`,
    `Archived: ${archived.join(', ') || '(none)'}.`,
    consolidated.length ? `Consolidated: ${consolidated.map((c) => `${c.merged} → ${c.kept}`).join(', ')}.` : '',
    ``,
    'Agent-created skills (maintainable):',
    ...agentCreated.map((s) => `- ${s.name}${s.category ? ` [${s.category}]` : ''} — ${s.patches} patches, active`),
  ].join('\n');
  const reportDir = join(projectDir, '.mochi', 'reports');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `skill-curator-${now}.md`);
  writeFileSync(reportPath, report, 'utf8');
  return { scanned: snapshots.length, agentCreated: agentCreated.length, stale: stale.map((s) => s.name), archived, consolidated, reportPath };
}

// ─── State (last-run time, pause, pin) — Hermes curator_state ────────────

export interface CuratorState {
  paused: boolean;
  lastRunAt?: number;
  runCount: number;
  lastSummary?: string;
  pinned: string[];
}

function statePath(projectDir: string): string {
  return join(projectDir, '.mochi', 'curator-state.json');
}
export function loadCuratorState(projectDir: string): CuratorState {
  try { return { paused: false, runCount: 0, pinned: [], ...JSON.parse(readFileSync(statePath(projectDir), 'utf8')) }; }
  catch { return { paused: false, runCount: 0, pinned: [] }; }
}
export function saveCuratorState(projectDir: string, s: CuratorState): void {
  mkdirSync(join(projectDir, '.mochi'), { recursive: true });
  writeFileSync(statePath(projectDir), JSON.stringify(s, null, 2), 'utf8');
}

/** Should the curator run now? (inactivity-triggered, mirrors Hermes
 *  maybe_run_curator). Idle + passed interval + not paused + enabled. */
export function shouldRunCurator(projectDir: string, cfg: CuratorConfig): boolean {
  if (!cfg.enabled) return false;
  const s = loadCuratorState(projectDir);
  if (s.paused) return false;
  if (!s.lastRunAt) return true;
  return Date.now() - s.lastRunAt >= cfg.intervalMs;
}

export function recordCuratorRun(projectDir: string, summary: string): void {
  const s = loadCuratorState(projectDir);
  s.lastRunAt = Date.now();
  s.runCount += 1;
  s.lastSummary = summary;
  saveCuratorState(projectDir, s);
}