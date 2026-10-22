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
import { execFileSync } from 'node:child_process';
import {skillsRoot, archiveRoot, loadUsage, safeSlug, parseFrontmatter, renderSkill} from './skill-manager.js';
import { writeSkill, markUsed } from './skill-manager.js';
import {
  loadSkillUsage, saveSkillUsage, loadSkillKindStats, skillKindBaseline, resolveSkillsSettings,
  PROMOTION_MIN_PASSES, PROBATION_EXPIRY_MS, DEMOTION_WINDOW, DEMOTION_MARGIN, DEMOTION_MIN_BASELINE_RUNS,
  type SkillUsage,
} from './skills.js';
import { mochiStateDir } from '../core/mochi-dir.js';
import { loadLessons } from '../lessons.js';
import { evaluateForgedToolLifecycle, type ForgedLifecycleResult } from '../tools/tool-forge.js';
import { lintSkillDoc, formatSkillLint } from './skill-lint.js';
import { maybeRedact } from '../security/security.js';

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
  /** Lessons promoted to agent-created skills this pass. */
  promoted: string[];
  /** Lifecycle promotions (probation/demoted → active) on verified evidence. */
  lifecyclePromoted: string[];
  /** Evidence-based demotions (active → probation-adjacent 'demoted'). */
  demoted: Array<{ name: string; reason: string }>;
  /** Probation spells past expiry without promotion (flagged, not acted on). */
  probationStale: string[];
  /** Skills the age rule would have archived but a strong recent record
   *  protected (evidence beats calendar). */
  archiveProtected: string[];
  /** Per-skill quality signals computed this pass (evidence for the above). */
  signals: SkillSignals[];
  reportPath: string;
  /** Tool Forge lifecycle outcome of this pass (Wave O): forged tools are
   *  promoted/trimmed by the same evidence discipline as skills. Absent
   *  when the evaluation could not run. */
  forgedTools?: ForgedLifecycleResult;
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

export interface PromotionResult {
  promoted: string[];
  skipped: Array<{ signature: string; reason: string }>;
}

/** Promotion bar: retrieved repeatedly AND fixed something at least once.
 *  Anything lower is noise that would fill the tree with junk. */
export const PROMOTE_MIN_USES = 3;
export const PROMOTE_MIN_SUCCESSES = 1;

/** Turn proven lessons into agent-created skills (the self-training loop's
 *  write path: experience → lesson → reusable procedure). Conservative:
 *  only lessons retrieved 3+ times with ≥1 recorded fix qualify; bodies are
 *  templated from the lesson's own trigger+strategy (match/apply/verify —
 *  the actual retrieval protocol, no invented specifics); writeSkill's
 *  lint+quality gates still apply, so junk can never land; collisions with
 *  existing skill names skip. Promoted skills are flagged agentCreated so
 *  later curator passes lifecycle-manage them (stale/archive/consolidate). */
export function promoteLessons(projectDir: string): PromotionResult {
  const promoted: string[] = [];
  const skipped: Array<{ signature: string; reason: string }> = [];
  let lessons;
  try {
    lessons = loadLessons(projectDir);
  } catch {
    return { promoted, skipped };
  }
  for (const l of lessons) {
    const sig = (l.signature ?? '').trim();
    const strategy = (l.lesson ?? '').trim();
    if (!sig || strategy.length < 20) { skipped.push({ signature: sig || '(empty)', reason: 'no usable trigger/strategy' }); continue; }
    if ((l.useCount ?? 0) < PROMOTE_MIN_USES || (l.successCount ?? 0) < PROMOTE_MIN_SUCCESSES) {
      skipped.push({ signature: sig, reason: `below bar (uses ${l.useCount ?? 0}, fixes ${l.successCount ?? 0})` });
      continue;
    }
    const name = `learned-${safeSlug(sig).slice(0, 40)}`;
    // Collision with any existing skill (root or category dir): keep the human
    // version, skip. A missing tree means no collision (writeSkill creates it).
    try {
      const root = skillsRoot(projectDir);
      let collision = existsSync(join(root, name, 'SKILL.md'));
      if (!collision && existsSync(root)) {
        for (const e of readdirSync(root, { withFileTypes: true })) {
          if (e.isDirectory() && !e.name.startsWith('.') && existsSync(join(root, e.name, name, 'SKILL.md'))) { collision = true; break; }
        }
      }
      if (collision) { skipped.push({ signature: sig, reason: `skill ${name} already exists` }); continue; }
    } catch {
      skipped.push({ signature: sig, reason: 'tree unreadable' });
      continue;
    }
    const body = [
      `# Learned fix for "${sig.slice(0, 80)}"`,
      ``,
      `## Trigger / when to use`,
      `When command output contains \`${sig.slice(0, 120)}\`${l.kind ? ` during ${l.kind} failures` : ''}. Auto-promoted after ${l.useCount} retrievals with ${l.successCount} recorded fix${l.successCount === 1 ? '' : 'es'}.`,
      ``,
      `## Procedure`,
      `1. Confirm the failure output matches the signature above — a similar message with a different root cause needs a different fix.`,
      `2. Apply the learned fix: ${strategy}`,
      `3. Re-run the failing command and confirm the error clears.`,
      ``,
      `## Pitfalls`,
      `- Re-applying blindly when the signature matches a different root cause — step 1 exists for this; signatures are substrings, not diagnoses.`,
      ``,
      `## Verification`,
      `The originating command exits clean. If the fix stops working, patch this skill (do not duplicate it) so the curator keeps one canonical copy.`,
      ``,
    ].join('\n');
    const description = `Auto-learned fix: ${strategy.slice(0, 140)}. Use when output matches the recorded failure signature.`;
    // Lesson promotion is itself outcome-gated (≥3 retrievals, ≥1 fix), so
    // its skills are born ACTIVE — probation is for unproven authorship.
    const r = writeSkill(projectDir, { name, description, body, category: 'learned', lifecycle: 'active' });
    if (!r.ok) { skipped.push({ signature: sig, reason: `gate rejected (${String(r.error).slice(0, 120)})` }); continue; }
    try {
      markUsed(projectDir, name, { agentCreated: true, category: 'learned' });
    } catch { /* usage record is best-effort; the skill file itself landed */ }
    promoted.push(name);
  }
  return { promoted, skipped };
}

// ─── Evidence lifecycle: signals, promotion, demotion (B1) ──────────────
// The curator is the ONLY writer of lifecycle state transitions (the loop
// records evidence; writeSkill stamps births). Every decision below cites
// its evidence — counts and rates computed from the unified registry and
// the per-kind baseline — because a lifecycle that can't show its work is
// just self-grading with extra steps (the failure mode this replaces).

export interface SkillSignals {
  name: string;
  state?: string;
  loads: number;
  wins: number;
  /** wins/loads over all recorded runs (includes unverified kinds). */
  fixRate: number | null;
  /** Loaded runs with a verifier-gate verdict (pass+fail+partial). */
  verifiedOutcomes: number;
  /** Gate-PASS share of verified outcomes. */
  verifiedRate: number | null;
  /** Gate-PASS share of the rolling last-10 verified window. */
  windowRate: number | null;
  /** ACE-style counters: load → PASS (helpful) / FAIL·PARTIAL·BLOCKED. */
  helpful: number;
  harmful: number;
  /** Matched no-skill baseline pass-rate for the kinds this skill serves. */
  baselineRate: number | null;
  baselineRuns: number;
  /** Per-kind verified pass-rates (retrieval→success view: the kinds where
   *  loading this skill correlates with verified success). */
  kindRates: Record<string, { loads: number; rate: number | null }>;
}

function signalsFor(name: string, rec: SkillUsage, kindStats: Record<string, { runs: number; passes: number }>): SkillSignals {
  const verifiedOutcomes = (rec.verifiedPasses ?? 0) + (rec.verifiedFails ?? 0) + (rec.verifiedPartials ?? 0);
  const win = rec.recentOutcomes ?? [];
  const base = skillKindBaseline(rec, kindStats);
  const kindRates: SkillSignals['kindRates'] = {};
  for (const [kind, loads] of Object.entries(rec.kindLoads ?? {})) {
    kindRates[kind] = { loads, rate: loads > 0 ? (rec.kindPasses?.[kind] ?? 0) / loads : null };
  }
  return {
    name,
    ...(rec.state ? { state: rec.state } : {}),
    loads: rec.loads,
    wins: rec.wins,
    fixRate: rec.loads > 0 ? rec.wins / rec.loads : null,
    verifiedOutcomes,
    verifiedRate: verifiedOutcomes > 0 ? (rec.verifiedPasses ?? 0) / verifiedOutcomes : null,
    windowRate: win.length > 0 ? win.filter((o) => o === 'pass').length / win.length : null,
    helpful: rec.helpful ?? 0,
    harmful: rec.harmful ?? 0,
    baselineRate: base.rate,
    baselineRuns: base.runs,
    kindRates,
  };
}

/** Quality signals for every skill in the unified registry. */
export function computeSkillSignals(projectDir: string): SkillSignals[] {
  const kindStats = loadSkillKindStats(projectDir);
  const out: SkillSignals[] = [];
  for (const [name, rec] of loadSkillUsage(projectDir)) out.push(signalsFor(name, rec, kindStats));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Retrieval→success correlation across the registry: Pearson r between
 *  per-skill loads and fix-rate, over skills with ≥2 loads and a recorded
 *  fix-rate. Positive = the skills retrieval reaches for most tend to be
 *  the winners; negative = retrieval is aimed at losers. A harness-level
 *  health signal for the curator report — never a per-skill verdict.
 *  Null with <3 points or zero variance (nothing meaningful to correlate). */
export function retrievalSuccessCorrelation(signals: SkillSignals[]): number | null {
  const pts = signals.filter((s) => s.loads >= 2 && s.fixRate !== null);
  if (pts.length < 3) return null;
  const xs = pts.map((s) => s.loads);
  const ys = pts.map((s) => s.fixRate as number);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/** Run ONE skill's embedded verification snippet (the Skill Doctor's replay)
 *  and report the outcome. No snippet = nothing to replay = ok (structure
 *  was already gated at write time); a snippet that fails blocks promotion.
 *  Same execution recipe as runSkillDoctor (platform shell, timeout). */
export function checkSkillReplay(projectDir: string, skillPath: string, timeoutMs = 3000): { ok: boolean; hasSnippet: boolean; error?: string } {
  let raw: string;
  try {
    raw = readFileSync(skillPath, 'utf8');
  } catch (e) {
    return { ok: false, hasSnippet: false, error: `unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const snippet = extractVerificationSnippet(raw);
  if (!snippet) return { ok: true, hasSnippet: false };
  try {
    if (process.platform === 'win32') {
      execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', snippet], {
        cwd: projectDir, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
      });
    } else {
      execFileSync('/bin/bash', ['-c', snippet], {
        cwd: projectDir, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${process.env.PATH || ''}` },
      });
    }
    return { ok: true, hasSnippet: true };
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    return { ok: false, hasSnippet: true, error: maybeRedact(String(e.stderr ?? e.message ?? err)).slice(0, 300) };
  }
}

export interface LifecycleEvaluation {
  promoted: string[];
  demoted: Array<{ name: string; reason: string }>;
  /** Probation spells past the 14-day expiry without promotion. Flagged
   *  only — a stale probationer is NEVER silently activated or archived
   *  by this pass; the curator report surfaces it for a decision. */
  probationStale: string[];
  signals: SkillSignals[];
}

const pct = (r: number): string => `${Math.round(r * 100)}%`;

/** One lifecycle pass over the registry:
 *  - PROMOTE a probation/demoted skill when ALL hold: ≥3 verified gate-PASS
 *    runs in its current state, its Skill Doctor replay passes, and (for a
 *    demoted skill) those passes are fresh — passesInState was reset at
 *    demotion, so re-promotion IS the strike resolution; strikes clear.
 *  - DEMOTE an active skill on evidence: its last two verified loads both
 *    failed the gate, or its full 10-outcome window trails the matched
 *    no-skill baseline by >15pp with enough baseline data to trust.
 *  - FLAG probation spells older than 14 days that haven't promoted.
 *  Skills with no lifecycle state are outside this system (never touched). */
export function evaluateSkillLifecycle(projectDir: string, opts: { now?: number } = {}): LifecycleEvaluation {
  const now = opts.now ?? Date.now();
  const out: LifecycleEvaluation = { promoted: [], demoted: [], probationStale: [], signals: [] };
  out.signals = computeSkillSignals(projectDir);
  if (!resolveSkillsSettings().probationEnabled) return out;
  const usage = loadSkillUsage(projectDir);
  const kindStats = loadSkillKindStats(projectDir);
  const pathByName = new Map(scanSkills(projectDir, defaultCuratorConfig()).snapshots.map((s) => [s.name, s.path]));
  let dirty = false;
  for (const [name, rec] of usage) {
    if (!rec.state) continue;
    if (rec.state === 'probation' || rec.state === 'demoted') {
      if ((rec.passesInState ?? 0) >= PROMOTION_MIN_PASSES) {
        const path = pathByName.get(name);
        const replay = path ? checkSkillReplay(projectDir, path) : { ok: false, hasSnippet: false, error: 'skill file not found in tree' };
        if (replay.ok) {
          rec.state = 'active';
          rec.stateAt = now;
          rec.demotionStrikes = 0;
          dirty = true;
          out.promoted.push(name);
          continue;
        }
      }
      if (rec.state === 'probation' && now - (rec.probationSince ?? rec.stateAt ?? now) > PROBATION_EXPIRY_MS) {
        out.probationStale.push(name);
      }
    } else if (rec.state === 'active') {
      const win = rec.recentOutcomes ?? [];
      let reason: string | null = null;
      if (win.length >= 2 && win[win.length - 1] === 'fail' && win[win.length - 2] === 'fail') {
        reason = `last two verified runs that loaded it failed the gate (${rec.verifiedFails ?? 0} verified fails recorded; helpful ${rec.helpful ?? 0} / harmful ${rec.harmful ?? 0})`;
      } else if (win.length >= DEMOTION_WINDOW) {
        const windowRate = win.filter((o) => o === 'pass').length / win.length;
        const base = skillKindBaseline(rec, kindStats);
        if (base.rate !== null && base.runs >= DEMOTION_MIN_BASELINE_RUNS && windowRate <= base.rate - DEMOTION_MARGIN) {
          reason = `window pass-rate ${pct(windowRate)} over the last ${win.length} verified loads vs ${pct(base.rate)} matched no-skill baseline (${base.runs} runs, kinds: ${Object.keys(rec.kindLoads ?? {}).join(', ') || 'n/a'})`;
        }
      }
      if (reason) {
        rec.state = 'demoted';
        rec.stateAt = now;
        rec.passesInState = 0;
        rec.demotionStrikes = (rec.demotionStrikes ?? 0) + 1;
        rec.lastDemotionReason = reason;
        dirty = true;
        out.demoted.push({ name, reason });
      }
    }
  }
  if (dirty) saveSkillUsage(projectDir, usage);
  // Signals were computed pre-transition for the report's "before" picture;
  // refresh states so the report never cites a state the pass just changed.
  out.signals = computeSkillSignals(projectDir);
  return out;
}

/** A skill with a strong recent record is protected from AGE-based
 *  archiving: the calendar is a backstop for dead skills, not a reason to
 *  bury a proven one. Strong = ≥5 loads with ≥60% run wins, or ≥5 verified
 *  outcomes with ≥60% gate passes, or ≥3 helpful and helpful > harmful. */
export function evidenceProtectsFromArchive(s: SkillSignals): boolean {
  if (s.loads >= 5 && s.fixRate !== null && s.fixRate >= 0.6) return true;
  if (s.verifiedOutcomes >= 5 && s.verifiedRate !== null && s.verifiedRate >= 0.6) return true;
  if (s.helpful >= 3 && s.helpful > s.harmful) return true;
  return false;
}

export function runCurator(projectDir: string, cfg: CuratorConfig): CuratorOutput {
  const { snapshots, stale, archive } = scanSkills(projectDir, cfg);
  const agentCreated = snapshots.filter((s) => s.agentCreated);
  const archived: string[] = [];
  const now = Date.now();
  // Evidence lifecycle runs FIRST: its signals decide both the state
  // transitions and which age-expired skills the calendar may not bury.
  let lifecycle: LifecycleEvaluation = { promoted: [], demoted: [], probationStale: [], signals: [] };
  try {
    lifecycle = evaluateSkillLifecycle(projectDir);
  } catch { /* lifecycle is best-effort; age-based curation still proceeds */ }
  const signalsByName = new Map(lifecycle.signals.map((s) => [s.name, s]));
  // Tool Forge lifecycle (Wave O): forged tools earn promotion or get
  // trimmed on the same evidence standard as skills. Best-effort — a
  // forge failure never blocks skill curation.
  let forgedTools: ForgedLifecycleResult | undefined;
  try {
    forgedTools = evaluateForgedToolLifecycle(projectDir);
  } catch { /* best-effort */ }
  // Pinned skills are a user directive: never age-archived. (The dedup
  // pass below already honored pins; the archive pass now does too.)
  const pinned = new Set(loadCuratorState(projectDir).pinned ?? []);
  const archiveProtected: string[] = [];
  for (const s of archive) {
    if (pinned.has(s.name)) continue;
    const sig = signalsByName.get(s.name);
    if (sig && evidenceProtectsFromArchive(sig)) { archiveProtected.push(s.name); continue; }
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
  const usage = loadUsage(projectDir);
  const consolidateable = scanSkills(projectDir, cfg).snapshots.filter((s) =>
    (s.agentCreated || usage.byName[s.name]?.agentCreated) && !archived.includes(s.name) && !pinned.has(s.name));
  const consolidated = consolidateSkills(consolidateable, cfg);
  for (const c of consolidated) archived.push(c.merged);
  // Promotion runs on the survivors so fresh lessons become gated,
  // agent-created skills in the same pass (self-training write path).
  let promoted: string[] = [];
  try {
    promoted = promoteLessons(projectDir).promoted;
  } catch { /* promotion is best-effort; curation results still land */ }
  const fmtRate = (r: number | null): string => (r === null ? 'n/a' : `${Math.round(r * 100)}%`);
  const signalLines = lifecycle.signals
    .filter((s) => s.state || s.loads > 0)
    .map((s) => {
      const kinds = Object.entries(s.kindRates)
        .map(([k, v]) => `${k} ${fmtRate(v.rate)} (${v.loads})`)
        .join(', ');
      return `- ${s.name}${s.state ? ` [${s.state}]` : ''}: fix-rate ${fmtRate(s.fixRate)} (${s.wins}/${s.loads} runs), verified ${fmtRate(s.verifiedRate)} (${s.verifiedOutcomes} gate verdicts), helpful ${s.helpful} / harmful ${s.harmful}, baseline ${fmtRate(s.baselineRate)} (${s.baselineRuns} matched runs)${kinds ? `; kinds: ${kinds}` : ''}`;
    });
  const corr = retrievalSuccessCorrelation(lifecycle.signals);
  const report = [
    `# Skill curator report (${new Date(now).toISOString()})`,
    `Scanned: ${snapshots.length} skills (${agentCreated.length} agent-created).`,
    `Stale: ${stale.map((s) => s.name).join(', ') || '(none)'}.`,
    `Archived: ${archived.join(', ') || '(none)'}.`,
    archiveProtected.length ? `Archive-protected by evidence (strong recent record beats calendar age): ${archiveProtected.join(', ')}.` : '',
    lifecycle.promoted.length ? `Lifecycle promotions (verified evidence): ${lifecycle.promoted.map((n) => { const rec = loadSkillUsage(projectDir).get(n); return `${n} (${rec?.verifiedPasses ?? 0} verified gate passes)`; }).join(', ')}.` : '',
    ...lifecycle.demoted.map((d) => `Demoted: ${d.name} — ${d.reason}.`),
    lifecycle.probationStale.length ? `Probation expired without promotion (flagged, NOT auto-activated): ${lifecycle.probationStale.join(', ')}.` : '',
    consolidated.length ? `Consolidated: ${consolidated.map((c) => `${c.merged} → ${c.kept}`).join(', ')}.` : '',
    promoted.length ? `Promoted: ${promoted.join(', ')}.` : '',
    ...(forgedTools?.promoted.length ? [`Forged tools promoted (evidence gate): ${forgedTools.promoted.join(', ')}.`] : []),
    ...(forgedTools?.trimmed.map((t) => `Forged tool trimmed: ${t.name} — ${t.reason}.`) ?? []),
    ...(forgedTools?.probationStale.length ? [`Forged tools stale on probation (flagged, NOT auto-activated): ${forgedTools.probationStale.join(', ')}.`] : []),
    ``,
    'Quality signals (evidence base for lifecycle decisions):',
    ...(corr !== null ? [`Retrieval→success correlation: r = ${corr.toFixed(2)} (per-skill loads vs fix-rate across the registry; positive means retrieval favours winners).`] : []),
    ...(signalLines.length ? signalLines : ['(no recorded skill outcomes yet)']),
    ``,
    'Agent-created skills (maintainable):',
    ...agentCreated.map((s) => `- ${s.name}${s.category ? ` [${s.category}]` : ''} — ${s.patches} patches, ${signalsByName.get(s.name)?.state ?? 'active'}`),
  ].join('\n');
  const reportDir = join(mochiStateDir(projectDir), 'reports');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `skill-curator-${now}.md`);
  writeFileSync(reportPath, report, 'utf8');
  return {
    scanned: snapshots.length,
    agentCreated: agentCreated.length,
    stale: stale.map((s) => s.name),
    archived,
    consolidated,
    promoted,
    lifecyclePromoted: lifecycle.promoted,
    demoted: lifecycle.demoted,
    probationStale: lifecycle.probationStale,
    archiveProtected,
    signals: lifecycle.signals,
    reportPath,
    ...(forgedTools ? { forgedTools } : {}),
  };
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
  return join(mochiStateDir(projectDir), 'curator-state.json');
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

// ─── Auto-skill from successful runs (MCH-44) ──────────────────────────────
/** When the learning store shows a (pattern, strategy) pair that has succeeded
 *  ≥ `minSuccesses` times and NO existing skill covers it, write a draft
 *  SKILL.md derived from the run's lessons. Returns the skill name or null.
 *  Model-free: the draft body is compiled from real recorded evidence, and the
 *  model is later free to refine it via skill_manage. Never throws. */
export function autoDraftSkill(
  projectDir: string,
  opts: {
    pattern: string;
    strategy: string;
    successes: number;
    lessons?: string[];
    taskTitle?: string;
    minSuccesses?: number;
  },
): string | null {
  try {
    const min = opts.minSuccesses ?? 2;
    if (opts.successes < min) return null;
    const slug = safeSlug(`${opts.pattern}-${opts.strategy}`);
    if (!slug || slug.length < 3) return null;
    const root = skillsRoot(projectDir);
    const skillDir = join(root, 'auto');
    const path = join(skillDir, `${slug}.md`);
    if (existsSync(path)) return null; // already drafted — never overwrite
    // Skip if any existing skill's name/description already covers this pattern.
    const usage = loadUsage(projectDir);
    for (const name of Object.keys(usage.byName)) {
      if (skillSimilarity(name.toLowerCase(), `${opts.pattern} ${opts.strategy}`.toLowerCase()) > 0.5) return null;
    }
    const lessons = (opts.lessons ?? []).filter((l) => l && l.length > 3).slice(0, 5);
    const description = `Auto-drafted procedure for recurring pattern: ${opts.pattern.slice(0, 80)}`;
    const body = [
      `# Auto-drafted: ${opts.pattern}`,
      '',
      `Distilled from ${opts.successes} successful run(s) using strategy \`${opts.strategy}\`.`,
      opts.taskTitle ? `Originating task: "${opts.taskTitle.slice(0, 120)}".` : '',
      '',
      '## Procedure that worked',
      ...(lessons.length
        ? lessons.map((l, i) => `${i + 1}. ${l.slice(0, 200)}`)
        : ['1. Apply the strategy that repeatedly succeeded for this pattern; verify before claiming completion.']),
      '',
      '## Notes',
      '- This skill was auto-drafted from run telemetry (MCH-44). Refine or delete via skill_manage.',
    ].filter(Boolean).join('\n');
    mkdirSync(skillDir, { recursive: true });
    // MCH-67: quality gate — reject drafts that fail the lint before they
    // pollute the skill library / retrieval index.
    try {
      const gate = lintSkillDoc(slug, description, body);
      if (!gate.ok) {
        recordCuratorRun(projectDir, `skill draft "${slug}" rejected by quality gate:\n${formatSkillLint(gate)}`);
        return null;
      }
    } catch { /* gate is best-effort — never block drafting on gate failure */ }
    writeFileSync(path, renderSkill({ name: slug, description, category: 'auto', body }));
    return slug;
  } catch {
    return null;
  }
}


// ─── Tool-route → skill bridge (MCH-55) ─────────────────────────────────
// Mines the persisted tool sequences (MCH-52) for a repeated OPENING route
// (first 4 tool calls). When the same opening appears >= minCount times
// across successful runs, auto-draft a skill whose body IS the route —
// the harness's habitual successful workflow becomes a named, reusable
// procedure without any model authoring effort.

/** Returns the drafted skill slug, or null when no route is habitual yet. */
export async function draftSkillFromToolRoutes(
  workspaceDir: string,
  opts: { minCount?: number; prefixLen?: number } = {},
): Promise<string | null> {
  try {
    const { loadToolSeqs } = await import('../core/tool-sequence.js');
    const seqs = loadToolSeqs(workspaceDir).seqs.filter((t) => t.length >= 4);
    if (seqs.length < (opts.minCount ?? 3)) return null;
    const prefixLen = opts.prefixLen ?? 4;
    const counts = new Map<string, number>();
    for (const tools of seqs) {
      const key = tools.slice(0, prefixLen).join(' -> ');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = opts.minCount ?? 3;
    for (const [route, n] of Array.from(counts)) {
      if (n >= bestCount) { best = route; bestCount = n; }
    }
    if (!best) return null;
    // Dedupe consecutive identical tools in the route body for readability.
    const steps = best.split(' -> ').filter((t, i, a) => i === 0 || t !== a[i - 1]);
    return autoDraftSkill(workspaceDir, {
      pattern: `tool-route ${best}`,
      strategy: steps.map((t, i) => `${i + 1}. ${t}`).join(' '),
      successes: bestCount,
      lessons: steps.map((t, i) => `Call \`${t}\` as step ${i + 1} of the habitual opening route.`),
      taskTitle: `Habitual opening route (${bestCount} successful runs)`,
      minSuccesses: opts.minCount ?? 3,
    });
  } catch {
    return null;
  }
}


// ─── Skill Regression Doctor (MCH-20) ──────────────────────────────────

export interface SkillDoctorFailure {
  name: string;
  path: string;
  kind: 'empty' | 'missing-frontmatter' | 'syntax-error' | 'verification-failed';
  error: string;
  consecutiveFailures: number;
  archived: boolean;
}

export interface SkillDoctorReport {
  scanned: number;
  healthy: number;
  failures: SkillDoctorFailure[];
  archived: string[];
  reportPath: string;
}

export interface SkillDoctorHistory {
  byName: Record<string, {
    consecutiveFailures: number;
    lastError?: string;
    lastCheckedAt: number;
  }>;
}

function doctorHistoryPath(projectDir: string): string {
  return join(projectDir, '.mochi', 'skill-doctor-history.json');
}

export function loadDoctorHistory(projectDir: string): SkillDoctorHistory {
  try {
    return JSON.parse(readFileSync(doctorHistoryPath(projectDir), 'utf8'));
  } catch {
    return { byName: {} };
  }
}

export function saveDoctorHistory(projectDir: string, hist: SkillDoctorHistory): void {
  mkdirSync(join(projectDir, '.mochi'), { recursive: true });
  writeFileSync(doctorHistoryPath(projectDir), JSON.stringify(hist, null, 2), 'utf8');
}

export interface SkillDoctorOptions {
  autoArchive?: boolean;           // default: true (archives agent skills with >= maxConsecutiveFailures)
  maxConsecutiveFailures?: number; // default: 2
  executeSnippets?: boolean;       // default: true
  timeoutMs?: number;              // default: 3000ms
}

export function extractVerificationSnippet(rawText: string): string | null {
  const pf = parseFrontmatter(rawText);
  if (pf?.meta && typeof pf.meta.verification === 'string' && pf.meta.verification.trim()) {
    return pf.meta.verification.trim();
  }
  if (pf?.meta && typeof pf.meta.test === 'string' && pf.meta.test.trim()) {
    return pf.meta.test.trim();
  }
  const body = pf ? pf.body : rawText;
  const commentMatch = /<!--\s*mochi:verify\s*\n([\s\S]*?)\n\s*-->/i.exec(body);
  if (commentMatch) {
    return commentMatch[1].trim();
  }
  const blockMatch = /```(?:bash|sh)\s+verify\s*\n([\s\S]*?)\n```/i.exec(body);
  if (blockMatch) {
    return blockMatch[1].trim();
  }
  const inlineMatch = /^[ \t]*#\s*(?:verify|doctest):\s*(.+)$/m.exec(body);
  if (inlineMatch) {
    return inlineMatch[1].trim();
  }
  return null;
}

/** Run the skill regression doctor over a workspace.
 *  Validates structure, frontmatter, and executes any embedded verification
 *  snippets or tests. Tracks failure history across runs and archives broken
 *  agent-created skills after 2 consecutive failures. */
export function runSkillDoctor(
  projectDir: string,
  opts: SkillDoctorOptions = {},
): SkillDoctorReport {
  const cfg = defaultCuratorConfig();
  const { snapshots } = scanSkills(projectDir, cfg);
  const history = loadDoctorHistory(projectDir);
  const now = Date.now();
  const maxFailures = opts.maxConsecutiveFailures ?? 2;
  const autoArchive = opts.autoArchive ?? true;
  const executeSnippets = opts.executeSnippets ?? true;
  const timeoutMs = opts.timeoutMs ?? 3000;

  const failures: SkillDoctorFailure[] = [];
  const archived: string[] = [];
  let healthy = 0;

  for (const s of snapshots) {
    let raw = '';
    try {
      raw = readFileSync(s.path, 'utf8');
    } catch (e: any) {
      const err = e?.message || String(e);
      const rec = history.byName[s.name] || { consecutiveFailures: 0, lastCheckedAt: now };
      rec.consecutiveFailures += 1;
      rec.lastError = err;
      rec.lastCheckedAt = now;
      history.byName[s.name] = rec;
      failures.push({
        name: s.name,
        path: s.path,
        kind: 'syntax-error',
        error: err,
        consecutiveFailures: rec.consecutiveFailures,
        archived: false,
      });
      continue;
    }

    if (!raw.trim()) {
      const rec = history.byName[s.name] || { consecutiveFailures: 0, lastCheckedAt: now };
      rec.consecutiveFailures += 1;
      rec.lastError = 'Skill file is empty';
      rec.lastCheckedAt = now;
      history.byName[s.name] = rec;
      let isArchived = false;
      if (autoArchive && s.agentCreated && rec.consecutiveFailures >= maxFailures) {
        try {
          const arc = join(archiveRoot(projectDir), safeSlug(s.name), 'SKILL.md');
          mkdirSync(dirname(arc), { recursive: true });
          renameSync(s.path, arc);
          try { rmdirSync(dirname(s.path)); } catch { /* ignore */ }
          isArchived = true;
          archived.push(s.name);
        } catch { /* best effort */ }
      }
      failures.push({
        name: s.name,
        path: s.path,
        kind: 'empty',
        error: 'Skill file is empty (0 bytes)',
        consecutiveFailures: rec.consecutiveFailures,
        archived: isArchived,
      });
      continue;
    }

    const pf = parseFrontmatter(raw);
    if (!pf || !pf.meta || !pf.meta.name) {
      const rec = history.byName[s.name] || { consecutiveFailures: 0, lastCheckedAt: now };
      rec.consecutiveFailures += 1;
      rec.lastError = 'Missing frontmatter with required name';
      rec.lastCheckedAt = now;
      history.byName[s.name] = rec;
      let isArchived = false;
      if (autoArchive && s.agentCreated && rec.consecutiveFailures >= maxFailures) {
        try {
          const arc = join(archiveRoot(projectDir), safeSlug(s.name), 'SKILL.md');
          mkdirSync(dirname(arc), { recursive: true });
          renameSync(s.path, arc);
          try { rmdirSync(dirname(s.path)); } catch { /* ignore */ }
          isArchived = true;
          archived.push(s.name);
        } catch { /* best effort */ }
      }
      failures.push({
        name: s.name,
        path: s.path,
        kind: 'missing-frontmatter',
        error: 'Missing YAML frontmatter with required "name" field',
        consecutiveFailures: rec.consecutiveFailures,
        archived: isArchived,
      });
      continue;
    }

    // Check runnable snippet if present
    const snippet = extractVerificationSnippet(raw);
    if (snippet && executeSnippets) {
      try {
        // Platform shell: the `exit 0` / `exit 1` / `echo` probes are already
        // cmd-compatible, so only the runner needs the branch — win32 mirrors
        // exec.ts's runShellString recipe (cmd.exe /d /s /c), POSIX keeps bash.
        if (process.platform === 'win32') {
          execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', snippet], {
            cwd: projectDir,
            timeout: timeoutMs,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env },
          });
        } else {
          execFileSync('/bin/bash', ['-c', snippet], {
            cwd: projectDir,
            timeout: timeoutMs,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PATH: `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${process.env.PATH || ''}` },
          });
        }
        // Success: reset failure count
        history.byName[s.name] = { consecutiveFailures: 0, lastCheckedAt: now };
        healthy++;
      } catch (err: any) {
        // Redact: snippet stderr is persisted to history.json and could echo
        // secret material from the environment the snippet ran in.
        const errorMsg = maybeRedact((err.stderr?.toString() || err.message || String(err)).trim()).slice(0, 300);
        const rec = history.byName[s.name] || { consecutiveFailures: 0, lastCheckedAt: now };
        rec.consecutiveFailures += 1;
        rec.lastError = errorMsg;
        rec.lastCheckedAt = now;
        history.byName[s.name] = rec;

        let isArchived = false;
        if (autoArchive && s.agentCreated && rec.consecutiveFailures >= maxFailures) {
          try {
            const arc = join(archiveRoot(projectDir), safeSlug(s.name), 'SKILL.md');
            mkdirSync(dirname(arc), { recursive: true });
            renameSync(s.path, arc);
            try { rmdirSync(dirname(s.path)); } catch { /* ignore */ }
            isArchived = true;
            archived.push(s.name);
          } catch { /* best effort */ }
        }
        failures.push({
          name: s.name,
          path: s.path,
          kind: 'verification-failed',
          error: errorMsg,
          consecutiveFailures: rec.consecutiveFailures,
          archived: isArchived,
        });
      }
    } else {
      // Structurally valid and no snippet or execution disabled
      history.byName[s.name] = { consecutiveFailures: 0, lastCheckedAt: now };
      healthy++;
    }
  }

  saveDoctorHistory(projectDir, history);

  // Generate markdown report
  const reportLines = [
    `# Skill Doctor Health Report (${new Date(now).toISOString()})`,
    `Total Scanned: ${snapshots.length}`,
    `Healthy: ${healthy}`,
    `Failures: ${failures.length}`,
    `Archived: ${archived.length ? archived.join(', ') : 'none'}`,
    '',
  ];

  if (failures.length > 0) {
    reportLines.push('## Diagnostic Failures');
    for (const f of failures) {
      reportLines.push(`- **${f.name}** (${f.kind}) [consecutive: ${f.consecutiveFailures}]${f.archived ? ' -> ARCHIVED' : ''}`);
      reportLines.push(`  Path: \`${f.path}\``);
      reportLines.push(`  Error: ${f.error}`);
    }
  } else {
    reportLines.push('All evaluated skills are healthy.');
  }

  const reportDir = join(mochiStateDir(projectDir), 'reports');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, `skill-doctor-${now}.md`);
  writeFileSync(reportPath, reportLines.join('\n'), 'utf8');

  return {
    scanned: snapshots.length,
    healthy,
    failures,
    archived,
    reportPath,
  };
}