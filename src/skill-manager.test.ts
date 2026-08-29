import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import {
  writeSkill, patchSkill, deleteSkill, loadUsage, saveUsage, markUsed, bumpPatch,
  listAgentCreated, parseFrontmatter, renderSkill, safeSlug, skillsRoot, archiveRoot, forget,
} from './skill-manager.js';
import { detectSkillOpportunities, opportunitiesToPrompt, scanSkills, runCurator, shouldRunCurator, recordCuratorRun, loadCuratorState, saveCuratorState, defaultCuratorConfig } from './skill-curator.js';

let proj: string;
beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'mchi-skill-test-'));
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
});

describe('skill-manager', () => {
  it('creates a SKILL.md with frontmatter under category', () => {
    const r = writeSkill(proj, { name: 'Fix TS2345', description: 'Triaging argument mismatch', body: '1. read\n2. check', category: 'frontend' });
    expect(r.ok).toBe(true);
    const md = readFileSync(r.path!, 'utf8');
    expect(md.startsWith('---')).toBe(true);
    expect(md).toContain('name: Fix TS2345');
    expect(md).toContain('category: frontend');
    expect(r.path).toContain(join('.mochi', 'skills', 'frontend', 'fix-ts2345', 'SKILL.md'));
  });

  it('rejects a create missing description or body', () => {
    expect(writeSkill(proj, { name: 'x', description: '', body: 'b' }).ok).toBe(false);
    expect(writeSkill(proj, { name: 'x', description: 'd', body: '' }).ok).toBe(false);
  });

  it('parses frontmatter round-trip', () => {
    const text = renderSkill({ name: 'N', description: 'D', category: 'c', body: 'hello' });
    const pf = parseFrontmatter(text);
    expect(pf?.meta.name).toBe('N');
    expect(pf?.meta.description).toBe('D');
    expect(pf?.meta.category).toBe('c');
    expect(pf?.body).toContain('hello');
  });

  it('patches an existing substring and bumps patch count', () => {
    const r = writeSkill(proj, { name: 'Dep', description: 'steps', body: '1. build\n2. ship' });
    const pr = patchSkill(proj, 'Dep', { name: 'Dep', path: r.path! }, '2. ship', '2. ship + changelog');
    expect(pr.ok).toBe(true);
    expect(readFileSync(r.path!, 'utf8')).toContain('2. ship + changelog');
    expect(loadUsage(proj).byName['Dep']?.patches).toBe(1);
  });

  it('returns not-found when patch old_string missing', () => {
    const r = writeSkill(proj, { name: 'Dep', description: 'steps', body: 'abc' });
    const pr = patchSkill(proj, 'Dep', { name: 'Dep', path: r.path! }, 'nope', 'x');
    expect(pr.ok).toBe(false);
    expect(pr.error).toContain('not found');
  });

  it('marks agent-created and lists them', () => {
    writeSkill(proj, { name: 'A', description: 'd', body: 'b' });
    markUsed(proj, 'A', { agentCreated: true });
    markUsed(proj, 'B', { agentCreated: false });
    const created = listAgentCreated(proj);
    expect(created.map((c) => c.name)).toContain('A');
    expect(created.map((c) => c.name)).not.toContain('B');
  });

  it('delete archives instead of hard-deleting', () => {
    const r = writeSkill(proj, { name: 'Z', description: 'd', body: 'b' });
    const del = deleteSkill(proj, 'Z');
    expect(del.archived).toBe(true);
    expect(existsSync(r.path!)).toBe(false);
    expect(existsSync(join(archiveRoot(proj), safeSlug('Z'), 'SKILL.md'))).toBe(true);
  });

  it('safeSlug sanitizes', () => {
    expect(safeSlug('Fix TS Error!')).toBe('fix-ts-error');
    expect(safeSlug('..//..')).toBe('skill');
  });

  it('bumpPatch and forget', () => {
    writeSkill(proj, { name: 'Q', description: 'd', body: 'b' });
    expect(bumpPatch(proj, 'Q')).toBe(1);
    forget(proj, 'Q');
    expect(loadUsage(proj).byName['Q']).toBeUndefined();
  });
});

describe('skill-curator', () => {
  it('detects skill opportunities from lessons + repeats', () => {
    const opps = detectSkillOpportunities([{ title: 'Fix auth expiry' }], 'TS2345', 2);
    expect(opps.length).toBeGreaterThanOrEqual(2);
    expect(opportunitiesToPrompt(opps)).toContain('skill_manage');
  });

  it('scanSkills finds network category skills', () => {
    writeSkill(proj, { name: 'Net Skill', description: 'd', body: 'b', category: 'net' });
    const { snapshots } = scanSkills(proj, defaultCuratorConfig());
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.category).toBe('net');
  });

  it('runCurator archives agent-created idle skills and writes a report', () => {
    writeSkill(proj, { name: 'Old', description: 'd', body: 'b' });
    markUsed(proj, 'Old', { agentCreated: true });
    // Force the usage record's lastUsedAt into the remote past so the
    // inactivity-based archive triggers immediately.
    const db = loadUsage(proj);
    db.byName['Old']!.lastUsedAt = Date.now() - 9999 * 86400_000;
    saveUsage(proj, db);
    const cfg = { ...defaultCuratorConfig(), staleAfterDays: 0, archiveAfterDays: 0 };
    const out = runCurator(proj, cfg);
    expect(out.archived).toContain('Old');
    expect(existsSync(out.reportPath)).toBe(true);
  });

  it('shouldRunCurator respects enabled + interval + pause', () => {
    const cfg = defaultCuratorConfig();
    expect(cfg.enabled).toBe(true); // on by default: skills improve over time
    const off = { ...cfg, enabled: false };
    expect(shouldRunCurator(proj, off)).toBe(false); // explicit off respected
    const on = { ...cfg, intervalMs: 60_000 };
    expect(shouldRunCurator(proj, on)).toBe(true); // never ran -> run
    recordCuratorRun(proj, 'ran');
    expect(loadCuratorState(proj).runCount).toBe(1);
    expect(shouldRunCurator(proj, on)).toBe(false); // ran just now, interval not elapsed
    // paused blocks even if interval elapsed
    const state = loadCuratorState(proj);
    state.paused = true;
    state.lastRunAt = Date.now() - 3600_000;
    saveCuratorState(proj, state);
    expect(shouldRunCurator(proj, on)).toBe(false);
  });
});