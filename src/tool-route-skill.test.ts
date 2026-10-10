import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadToolSeqs, saveToolSeq } from './tool-sequence.js';
import { draftSkillFromToolRoutes } from './skill-curator.js';

const dir = mkdtempSync(join(tmpdir(), 'mochi-route-skill-'));
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

describe('draftSkillFromToolRoutes (MCH-55)', () => {
  it('returns null when no habitual route exists', async () => {
    mkdirSync(join(dir, 'empty'), { recursive: true });
    expect(await draftSkillFromToolRoutes(join(dir, 'empty'))).toBeNull();
  });

  it('drafts a skill when an opening route repeats >= minCount times', async () => {
    const ws = join(dir, 'ws');
    mkdirSync(ws, { recursive: true });
    const store = loadToolSeqs(ws);
    for (let i = 0; i < 3; i++) {
      saveToolSeq(ws, store, ['read', 'grep', 'edit', 'run']);
    }
    expect(loadToolSeqs(ws).seqs.length).toBe(3);
    const slug = await draftSkillFromToolRoutes(ws);
    expect(slug).not.toBeNull();
    // Skill file should exist under the auto-drafted skills root.
    expect(slug).toMatch(/tool-route/);
    const { globSync } = await import('node:fs');
    const hits = globSync(join(ws, '.mochi', '**', `${slug}.md`));
    expect(hits.length).toBeGreaterThan(0);
    // Idempotent-ish: a second draft either returns the same slug or a deduped variant — must not throw.
    const slug2 = await draftSkillFromToolRoutes(ws);
    expect(typeof slug2 === 'string' || slug2 === null).toBe(true);
  });

  it('does not draft when routes are diverse', async () => {
    const ws = join(dir, 'diverse');
    mkdirSync(ws, { recursive: true });
    const store = loadToolSeqs(ws);
    const openings = [
      ['read', 'grep', 'edit', 'run'],
      ['run', 'read', 'edit', 'grep'],
      ['grep', 'read', 'run', 'edit'],
    ];
    for (const o of openings) saveToolSeq(ws, store, o);
    expect(await draftSkillFromToolRoutes(ws)).toBeNull();
  });
});
