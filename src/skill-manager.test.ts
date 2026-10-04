import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import {
  writeSkill, patchSkill, deleteSkill, loadUsage, saveUsage, markUsed, bumpPatch,
  listAgentCreated, parseFrontmatter, renderSkill, safeSlug, skillsRoot, archiveRoot, forget,
} from './skill-manager.js';
import { detectSkillOpportunities, opportunitiesToPrompt, scanSkills, runCurator, shouldRunCurator, recordCuratorRun, loadCuratorState, saveCuratorState, defaultCuratorConfig } from './skill-curator.js';

function procedureFixture(detail: string): string {
  return [
    '## When to use',
    'Use when maintaining a project workflow after a reproducible failure.',
    '## Procedure',
    '1. Reproduce the failure and record the exact diagnostic.',
    '2. Inspect the affected implementation and its callers.',
    '3. Apply a minimal repair while preserving existing behavior.',
    detail,
    '## Pitfalls',
    'Do not suppress diagnostics or remove assertions to conceal failures.',
    '## Verification',
    'Run `npm run typecheck` and the focused regression tests; require successful exits.',
  ].join('\n');
}

let proj: string;
beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'mchi-skill-test-'));
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
});

describe('skill-manager', () => {
  it('creates a SKILL.md with frontmatter under category', () => {
    const r = writeSkill(proj, { name: 'Fix TS2345', description: 'Triaging argument mismatch', body: procedureFixture('1. read\n2. check'), category: 'frontend' });
    expect(r.ok).toBe(true);
    const md = readFileSync(r.path!, 'utf8');
    expect(md.startsWith('---')).toBe(true);
    expect(md).toContain('name: Fix TS2345');
    expect(md).toContain('category: frontend');
    expect(r.path).toContain(join('.mochi', 'skills', 'frontend', 'fix-ts2345', 'SKILL.md'));
  });

  it('removes staging files after successful skill writes and patches', () => {
    const r = writeSkill(proj, {
      name: 'Atomic',
      description: 'Persist generated procedures without exposing partial writes',
      body: procedureFixture('Write through a same-directory staging file.'),
    });
    expect(r.ok).toBe(true);
    expect(existsSync(`${r.path}.tmp`)).toBe(false);
    const pr = patchSkill(proj, 'Atomic', { name: 'Atomic', path: r.path! }, 'staging file', 'temporary staging file');
    expect(pr.ok).toBe(true);
    expect(existsSync(`${r.path}.tmp`)).toBe(false);
  });

  it('preserves staging files owned by another writer', async () => {
    const { writeFileSync } = await import('node:fs');
    const input = {
      name: 'Concurrent',
      description: 'Preserve independent writers during skill publication',
      body: procedureFixture('Original procedure.'),
    };
    const created = writeSkill(proj, input);
    expect(created.ok).toBe(true);
    const foreignStaging = `${created.path!}.tmp`;
    writeFileSync(foreignStaging, 'another writer owns this', 'utf8');
    const updated = writeSkill(proj, { ...input, body: procedureFixture('Updated procedure.') });
    expect(updated.ok).toBe(true);
    expect(readFileSync(created.path!, 'utf8')).toContain('Updated procedure.');
    expect(existsSync(foreignStaging)).toBe(true);
    expect(readFileSync(foreignStaging, 'utf8')).toBe('another writer owns this');
  });

  it('rejects empty required sections even when unrelated prose satisfies length checks', () => {
    const result = writeSkill(proj, {
      name: 'Empty Sections',
      description: 'Reject superficially structured but unusable generated procedures',
      body: [
        '## When to use',
        '## Procedure',
        '1. Inspect the failing implementation and reproduce the diagnostic.',
        '2. Identify affected callers before making a minimal compatible repair.',
        '3. Run the focused regression tests and inspect the resulting diff.',
        '## Pitfalls',
        '## Verification',
        '## Background',
        'This background paragraph is deliberately substantial, but it provides neither trigger conditions nor failure recovery nor a verification procedure for the empty sections above.',
      ].join('\n'),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('quality gate');
    expect(existsSync(join(skillsRoot(proj), 'empty-sections', 'SKILL.md'))).toBe(false);
  });

  it('rejects weak procedural skills with actionable quality feedback', () => {
    const r = writeSkill(proj, {
      name: 'Weak Skill',
      description: 'Does things',
      body: 'Run the command and finish.',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('quality gate');
    expect(r.error).toContain('When to use');
    expect(r.error).toContain('numbered');
    expect(r.error).toContain('Verification');
    expect(existsSync(join(skillsRoot(proj), 'weak-skill', 'SKILL.md'))).toBe(false);
  });

  it('accepts production-ready procedural skills and reports their quality', () => {
    const r = writeSkill(proj, {
      name: 'Strong Skill',
      description: 'Diagnose and repair TypeScript argument mismatch failures',
      body: [
        '# Strong Skill',
        '## When to use',
        'Use when TypeScript reports TS2345 after an API change.',
        '## Procedure',
        '1. Reproduce the failing typecheck and capture the exact diagnostic.',
        '2. Inspect the callee signature and every affected call site.',
        '3. Apply the smallest compatible patch and preserve public contracts.',
        '## Pitfalls',
        '- Do not cast to any or weaken compiler settings.',
        '## Verification',
        'Run `npm run typecheck` and the focused regression test; both must pass.',
      ].join('\n'),
    });
    expect(r.ok).toBe(true);
    expect(r.quality?.passed).toBe(true);
    expect(r.quality?.score).toBeGreaterThanOrEqual(80);
  });


  it('rejects a create missing description or body', () => {
    expect(writeSkill(proj, { name: 'x', description: '', body: procedureFixture('Fixture for storage and lifecycle assertions.') }).ok).toBe(false);
    expect(writeSkill(proj, { name: 'x', description: 'Reusable fixture for skill storage and lifecycle assertions', body: '' }).ok).toBe(false);
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
    const r = writeSkill(proj, { name: 'Dep', description: 'steps', body: procedureFixture('1. build\n2. ship') });
    const pr = patchSkill(proj, 'Dep', { name: 'Dep', path: r.path! }, '2. ship', '2. ship + changelog');
    expect(pr.ok).toBe(true);
    expect(readFileSync(r.path!, 'utf8')).toContain('2. ship + changelog');
    expect(loadUsage(proj).byName['Dep']?.patches).toBe(1);
  });

  it('rejects a patch that would degrade a valid skill and preserves the file', () => {
    const r = writeSkill(proj, {
      name: 'Protected',
      description: 'Protect high quality procedures from destructive patches',
      body: procedureFixture('Keep this procedure production ready.'),
    });
    const before = readFileSync(r.path!, 'utf8');
    const originalBody = parseFrontmatter(before)!.body;
    const pr = patchSkill(proj, 'Protected', { name: 'Protected', path: r.path! }, originalBody, 'tiny');
    expect(pr.ok).toBe(false);
    expect(pr.error).toContain('quality gate');
    expect(readFileSync(r.path!, 'utf8')).toBe(before);
    expect(loadUsage(proj).byName.Protected?.patches).toBe(0);
  });

  it('skill_manage edit reports quality failure instead of false success', async () => {
    const { skillManageTool } = await import('./skill-manager.js');
    const r = writeSkill(proj, {
      name: 'Editable',
      description: 'Safely edit production ready procedural memory skills',
      body: procedureFixture('Keep edit operations honest.'),
    });
    const ctx = { cwd: proj, workspace: { dir: proj } } as any;
    const result = await skillManageTool.execute({ action: 'edit', name: 'Editable', body: 'weak' }, ctx);
    expect(result).toContain('quality gate');
    expect(readFileSync(r.path!, 'utf8')).toContain('Keep edit operations honest.');
  });


  it('rejects ambiguous patches without changing the skill or usage registry', () => {
    const r = writeSkill(proj, {
      name: 'Ambiguous',
      description: 'Preserve procedures when patch targets are ambiguous',
      body: procedureFixture('Repeated marker.\nRepeated marker.'),
    });
    expect(r.ok).toBe(true);
    const before = readFileSync(r.path!, 'utf8');
    const usageBefore = loadUsage(proj);
    const result = patchSkill(proj, 'Ambiguous', { name: 'Ambiguous', path: r.path! }, 'Repeated marker.', 'Replacement marker.');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ambiguous|multiple|unique/i);
    expect(readFileSync(r.path!, 'utf8')).toBe(before);
    expect(loadUsage(proj)).toEqual(usageBefore);
  });

  it('rejects empty replace-all targets without changing skill contents or usage', () => {
    const r = writeSkill(proj, {
      name: 'Empty Target',
      description: 'Prevent empty patch targets from corrupting reusable procedures',
      body: procedureFixture('Preserve the complete procedure.'),
    });
    expect(r.ok).toBe(true);
    const before = readFileSync(r.path!, 'utf8');
    const usageBefore = loadUsage(proj);
    const result = patchSkill(proj, 'Empty Target', { name: 'Empty Target', path: r.path! }, '', '', true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/old_string.*empty|non-empty/i);
    expect(readFileSync(r.path!, 'utf8')).toBe(before);
    expect(loadUsage(proj)).toEqual(usageBefore);
  });

  it('returns not-found when patch old_string missing', () => {
    const r = writeSkill(proj, { name: 'Dep', description: 'steps', body: procedureFixture('abc') });
    const pr = patchSkill(proj, 'Dep', { name: 'Dep', path: r.path! }, 'nope', 'x');
    expect(pr.ok).toBe(false);
    expect(pr.error).toContain('not found');
  });

  it('marks agent-created and lists them', () => {
    writeSkill(proj, { name: 'A', description: 'Reusable fixture for skill storage and lifecycle assertions', body: procedureFixture('Fixture for storage and lifecycle assertions.') });
    markUsed(proj, 'A', { agentCreated: true });
    markUsed(proj, 'B', { agentCreated: false });
    const created = listAgentCreated(proj);
    expect(created.map((c) => c.name)).toContain('A');
    expect(created.map((c) => c.name)).not.toContain('B');
  });

  it('delete archives instead of hard-deleting', () => {
    const r = writeSkill(proj, { name: 'Z', description: 'Reusable fixture for skill storage and lifecycle assertions', body: procedureFixture('Fixture for storage and lifecycle assertions.') });
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
    writeSkill(proj, { name: 'Q', description: 'Reusable fixture for skill storage and lifecycle assertions', body: procedureFixture('Fixture for storage and lifecycle assertions.') });
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
    writeSkill(proj, { name: 'Net Skill', description: 'Reusable fixture for skill storage and lifecycle assertions', body: procedureFixture('Fixture for storage and lifecycle assertions.'), category: 'net' });
    const { snapshots } = scanSkills(proj, defaultCuratorConfig());
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.category).toBe('net');
  });

  it('runCurator archives agent-created idle skills and writes a report', () => {
    writeSkill(proj, { name: 'Old', description: 'Reusable fixture for skill storage and lifecycle assertions', body: procedureFixture('Fixture for storage and lifecycle assertions.') });
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