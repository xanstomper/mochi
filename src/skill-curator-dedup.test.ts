// Skill curator consolidation (dedup) tests — pins the real merge behavior:
// near-duplicate agent-created skills merge into the older skill (which keeps
// its usage history), the newer body is absorbed under a heading, and the
// newer SKILL.md is archived. The `consolidate` flag was previously vaporware
// (declared in CuratorConfig, never consumed).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { skillSimilarity, consolidateSkills, defaultCuratorConfig, scanSkills, runCurator } from './skill-curator.js';
import { saveUsage } from './skill-manager.js';

let dir: string;

const BODY = (name: string, extra = '') => `---
name: ${name}
description: deploy the worker
---

# ${name}

Deploy the worker with wrangler, run the smoke check, then verify tail logs.
${extra}
`;

/** Register skills as agent-created in the usage registry — the curator only
 *  ever touches agent-created skills (bundled skills are untouchable). */
function markAgentCreated(...names: string[]): void {
  const now = Date.now();
  const byName: Record<string, unknown> = {};
  for (const n of names) byName[n] = { name: n, agentCreated: true, patches: 0, createdAt: now, lastUsedAt: now };
  saveUsage(dir, { byName } as any);
}

function mkSkill(name: string, body: string, mtimeMs?: number): string {
  const p = resolve(dir, '.mochi', 'skills', name);
  mkdirSync(p, { recursive: true });
  writeFileSync(resolve(p, 'SKILL.md'), body, 'utf8');
  return p;
}

describe('skill dedup / consolidation', () => {
  beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), 'mochi-curator-dedup-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('skillSimilarity scores identical bodies 1 and unrelated bodies low', () => {
    const a = BODY('deploy-worker');
    const b = BODY('deploy-worker-two');
    const c = '# cooking\n\nBoil pasta, salt the water, drain, add sauce.';
    expect(skillSimilarity(a, b)).toBeGreaterThan(0.7);
    expect(skillSimilarity(a, c)).toBeLessThan(0.2);
  });

  it('consolidateSkills merges a near-duplicate into the older skill and archives the newer', () => {
    mkSkill('deploy-worker', BODY('deploy-worker'));
    mkSkill('worker-deploy-guide', BODY('worker-deploy-guide'));
    const cfg = { ...defaultCuratorConfig(), consolidate: true };
    const { snapshots } = scanSkills(dir, cfg);
    const merged = consolidateSkills(snapshots, cfg);
    expect(merged.length).toBe(1);
    // The kept body now carries the absorbed content.
    const kept = readFileSync(resolve(dir, '.mochi', 'skills', 'deploy-worker', 'SKILL.md'), 'utf8');
    expect(kept).toContain('Absorbed from');
    expect(kept).toContain('worker-deploy-guide');
    // The loser is gone from the live tree.
    expect(existsSync(resolve(dir, '.mochi', 'skills', 'worker-deploy-guide'))).toBe(false);
  });

  it('consolidate: false disables merging; unrelated skills never merge', () => {
    mkSkill('deploy-worker', BODY('deploy-worker'));
    mkSkill('pasta-recipe', '# cooking\n\nBoil pasta, salt the water, drain, add sauce.');
    const cfgOff = { ...defaultCuratorConfig(), consolidate: false };
    const { snapshots: s1 } = scanSkills(dir, cfgOff);
    expect(consolidateSkills(s1, cfgOff)).toEqual([]);

    const cfgOn = { ...defaultCuratorConfig(), consolidate: true };
    const { snapshots: s2 } = scanSkills(dir, cfgOn);
    expect(consolidateSkills(s2, cfgOn)).toEqual([]);
  });

  it('runCurator reports consolidations and archives the merged skill', () => {
    mkSkill('deploy-worker', BODY('deploy-worker'));
    mkSkill('worker-deploy-guide', BODY('worker-deploy-guide'));
    markAgentCreated('deploy-worker', 'worker-deploy-guide');
    const cfg = defaultCuratorConfig();
    const out = runCurator(dir, cfg);
    expect(out.consolidated.length).toBe(1);
    expect(out.consolidated[0].merged).toBe('worker-deploy-guide');
    expect(out.consolidated[0].kept).toBe('deploy-worker');
  });
});
