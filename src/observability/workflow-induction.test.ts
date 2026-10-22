// D9 falsifiable tests: a fixture corpus with a repeated winning spine
// yields a draft macro naming that spine; failed-only (or unverified)
// corpora yield none. Drafts are born on probation — never active.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrajectoryRecord, TrajectoryStep } from './trajectory.js';
import {
  mineWinningSpines, mineRecoverySequences, induceWorkflows, induceAndDraft, induceFromToolSeqs,
} from './workflow-induction.js';
import { loadSkillUsage } from '../skills/skills.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mochi-ind-'));
  dirs.push(d);
  return d;
}

let n = 0;
function rec(tools: Array<string | { tool: string; ok: boolean }>, status: string | null, kind = 'fix'): TrajectoryRecord {
  n += 1;
  const steps: TrajectoryStep[] = tools.map((t, i) => typeof t === 'string'
    ? { index: i, tool: t, args: null, argShape: 'none', ok: true, outputSnippet: '' }
    : { index: i, tool: t.tool, args: null, argShape: 'none', ok: t.ok, outputSnippet: '', ...(t.ok ? {} : { error: 'boom' }) });
  return {
    schemaVersion: 2,
    runId: `run-${n}`,
    taskKind: kind,
    verified: status === 'PASS' || status === 'FLAKY-PASS',
    cost: { totalUsd: 0.1, reportedUsd: 0.1, estimatedUsd: 0, totalTokens: 100, source: 'provider' },
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    task: { title: 'fixture' },
    steps,
    skills: [],
    verification: status === null ? null : { status, verdict: status === 'PASS' ? 'pass' : 'fail' },
    outcome: { completed: status === 'PASS' },
    usage: { totalTokens: 100, costUsd: 0.1 },
    failureTaxonomy: [],
  };
}

/** The winning spine read → search → edit → shell, embedded in varied runs. */
function winningCorpus(): TrajectoryRecord[] {
  return [
    rec(['read', 'search', 'edit', 'shell'], 'PASS'),
    rec(['glob', 'read', 'search', 'edit', 'shell'], 'PASS'),
    rec(['read', 'search', 'edit', 'shell', 'verify'], 'FLAKY-PASS'),
  ];
}

describe('workflow induction: winning spines', () => {
  it('a repeated winning spine yields exactly one macro naming that spine', () => {
    const macros = mineWinningSpines(winningCorpus());
    expect(macros).toHaveLength(1);
    expect(macros[0].kind).toBe('spine');
    expect(macros[0].spine).toEqual(['read', 'search', 'edit', 'shell']);
    expect(macros[0].name).toBe('spine-read-search-edit-shell');
    expect(macros[0].support).toBe(3);
    expect(macros[0].taskKinds).toEqual(['fix']);
    expect(macros[0].avgCostUsd).toBeCloseTo(0.1);
  });

  it('failed-only sequences yield none', () => {
    const failed = [
      rec(['read', 'search', 'edit', 'shell'], 'FAIL'),
      rec(['read', 'search', 'edit', 'shell'], 'FAIL'),
      rec(['read', 'search', 'edit', 'shell'], 'BLOCKED'),
    ];
    expect(induceWorkflows(failed)).toEqual([]);
  });

  it('completed-but-unverified runs yield none (the gate is the admission test)', () => {
    const unverified = [
      rec(['read', 'search', 'edit', 'shell'], null),
      rec(['read', 'search', 'edit', 'shell'], null),
      rec(['read', 'search', 'edit', 'shell'], null),
    ];
    expect(induceWorkflows(unverified)).toEqual([]);
  });

  it('a spine seen once is below min support and yields none', () => {
    expect(mineWinningSpines([rec(['read', 'search', 'edit', 'shell'], 'PASS')])).toEqual([]);
  });

  it('mines spines from v2 tool-seq records (verified successes only)', () => {
    const macros = induceFromToolSeqs([
      { tools: ['read', 'search', 'edit', 'shell'], outcome: 'success', verified: true, taskKind: 'fix' },
      { tools: ['read', 'search', 'edit', 'shell'], outcome: 'success', verified: true, taskKind: 'fix' },
      { tools: ['read', 'search', 'edit', 'shell'], outcome: 'success', verified: false, taskKind: 'fix' },
      { tools: ['read', 'search', 'edit', 'shell'], outcome: 'failure', verified: false, taskKind: 'fix' },
    ]);
    expect(macros).toHaveLength(1);
    expect(macros[0].name).toBe('spine-read-search-edit-shell');
    expect(macros[0].support).toBe(2);
  });
});

describe('workflow induction: recovery sequences', () => {
  it('mines the fail→fix window: shell fails, edit intervenes, shell passes', () => {
    const corpus = [
      rec(['read', { tool: 'shell', ok: false }, 'edit', 'shell'], 'PASS'),
      rec([{ tool: 'shell', ok: false }, 'edit', 'shell', 'verify'], 'PASS'),
      rec(['read', 'search', 'edit', 'shell'], 'PASS'),
    ];
    const macros = mineRecoverySequences(corpus);
    expect(macros).toHaveLength(1);
    expect(macros[0].kind).toBe('recovery');
    expect(macros[0].failedTool).toBe('shell');
    expect(macros[0].spine).toEqual(['shell', 'edit', 'shell']);
    expect(macros[0].name).toBe('recovery-shell-via-edit-shell');
    expect(macros[0].support).toBe(2);
  });

  it('a failure that never recovers inside a verified run yields no recovery macro', () => {
    const corpus = [
      rec([{ tool: 'shell', ok: false }, 'edit', 'read'], 'PASS'),
      rec([{ tool: 'shell', ok: false }, 'edit', 'read'], 'PASS'),
    ];
    expect(mineRecoverySequences(corpus)).toEqual([]);
  });
});

describe('draft emission (Phase B probation owns promotion)', () => {
  it('drafts the winning spine as a probation-born skill naming the spine; re-run drafts nothing new', () => {
    const dir = tempDir();
    const drafts = induceAndDraft(dir, winningCorpus());
    expect(drafts).toHaveLength(1);
    expect(drafts[0].slug).toBe('spine-read-search-edit-shell');
    expect(drafts[0].state).toBe('probation'); // draft state only — never active
    expect(existsSync(drafts[0].path)).toBe(true);
    const body = readFileSync(drafts[0].path, 'utf8');
    expect(body).toContain('read → search → edit → shell');
    expect(body).toContain('DRAFT');
    // The Phase B registry agrees: born on probation, not active.
    const usage = loadSkillUsage(dir);
    expect(usage.get('spine-read-search-edit-shell')?.state).toBe('probation');
    expect(usage.get('spine-read-search-edit-shell')?.agentCreated).toBe(true);
    // Idempotent: same corpus again -> the skill exists, nothing re-drafted.
    expect(induceAndDraft(dir, winningCorpus())).toEqual([]);
  });

  it('a failed-only corpus drafts nothing and writes no skill files', () => {
    const dir = tempDir();
    const failed = [
      rec(['read', 'search', 'edit', 'shell'], 'FAIL'),
      rec(['read', 'search', 'edit', 'shell'], 'FAIL'),
    ];
    expect(induceAndDraft(dir, failed)).toEqual([]);
    expect(existsSync(join(dir, '.mochi', 'skills'))).toBe(false);
  });
});
