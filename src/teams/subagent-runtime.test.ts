import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  parseChildResult,
  aggregateReviews,
  ChildRunStore,
  formatChildDigest,
  formatFleetReport,
  canSpawnAtDepth,
  resolveMaxConcurrentSubagents,
  resolveMaxSubagentDepth,
  type ChildRunRecord,
  type ChildRunResult,
} from './subagent-runtime.js';
import { Workspace } from '../workspace.js';

const fb = (over: Partial<Parameters<typeof parseChildResult>[1]> = {}) => ({
  success: true,
  filesModified: [] as string[],
  tokensUsed: 100,
  toolCalls: 3,
  durationMs: 1200,
  ...over,
});

describe('parseChildResult', () => {
  it('parses the structured JSON contract (findings + verdict + artifacts)', () => {
    const summary = [
      'Reviewed the change.',
      '```json',
      JSON.stringify({
        status: 'done',
        summary: 'Two issues found.',
        findings: [{ severity: 'HIGH', file: 'src/a.ts', line: 42, message: 'Null deref' }],
        verdict: 'request-changes',
        artifacts: [],
      }),
      '```',
    ].join('\n');
    const r = parseChildResult(summary, fb({ filesModified: ['src/a.ts'] }));
    expect(r.status).toBe('done');
    expect(r.summary).toBe('Two issues found.');
    expect(r.verdict).toBe('request-changes');
    expect(r.findings).toEqual([{ severity: 'high', file: 'src/a.ts', line: 42, message: 'Null deref' }]);
    expect(r.usage).toEqual({ tokens: 100, toolCalls: 3, durationMs: 1200 });
  });

  it('harness failure downgrades a claimed "done" to partial', () => {
    const summary = '```json\n{"status":"done","summary":"all good","findings":[],"artifacts":[]}\n```';
    const r = parseChildResult(summary, fb({ success: false }));
    expect(r.status).toBe('partial');
  });

  it('parses the legacy <result> footer', () => {
    const summary = 'Work finished.\n<result>\nSTATUS: done\nFILES: src/x.ts, src/y.ts\nRESULT: Did the thing.\n</result>';
    const r = parseChildResult(summary, fb());
    expect(r.status).toBe('done');
    expect(r.summary).toBe('Did the thing.');
    expect(r.artifacts).toEqual(['src/x.ts', 'src/y.ts']);
  });

  it('falls back to run outcome for free-text summaries', () => {
    const r = parseChildResult('Plain prose answer.', fb({ success: false, filesModified: ['a.ts'] }));
    expect(r.status).toBe('failed');
    expect(r.summary).toBe('Plain prose answer.');
    expect(r.artifacts).toEqual(['a.ts']);
  });

  it('survives malformed JSON in the fence', () => {
    const r = parseChildResult('```json\n{not json}\n```', fb());
    expect(r.status).toBe('done');
    expect(r.findings).toEqual([]);
  });
});

function reviewResult(over: Partial<ChildRunResult> = {}): ChildRunResult {
  return {
    status: 'done',
    summary: 'ok',
    findings: [],
    artifacts: [],
    usage: { tokens: 1, toolCalls: 1, durationMs: 1 },
    ...over,
  };
}

describe('aggregateReviews', () => {
  it('dedupes findings pointing at the same file+line+issue and keeps the worst severity', () => {
    const agg = aggregateReviews([
      { lens: 'correctness', result: reviewResult({ verdict: 'comment', findings: [{ severity: 'medium', file: 'src/a.ts', line: 10, message: 'Race condition on cache write' }] }) },
      { lens: 'security', result: reviewResult({ verdict: 'request-changes', findings: [{ severity: 'high', file: 'src/a.ts', line: 10, message: 'Race condition on cache write' }] }) },
    ]);
    expect(agg.findings).toHaveLength(1);
    expect(agg.findings[0].severity).toBe('high');
    expect(agg.duplicatesMerged).toBe(1);
  });

  it('any request-changes wins the merged verdict', () => {
    const agg = aggregateReviews([
      { lens: 'correctness', result: reviewResult({ verdict: 'approve' }) },
      { lens: 'security', result: reviewResult({ verdict: 'request-changes' }) },
      { lens: 'tests', result: reviewResult({ verdict: 'approve' }) },
    ]);
    expect(agg.verdict).toBe('request-changes');
  });

  it('approve requires every reviewer to approve', () => {
    const all = aggregateReviews([
      { lens: 'a', result: reviewResult({ verdict: 'approve' }) },
      { lens: 'b', result: reviewResult({ verdict: 'approve' }) },
    ]);
    expect(all.verdict).toBe('approve');
    const mixed = aggregateReviews([
      { lens: 'a', result: reviewResult({ verdict: 'approve' }) },
      { lens: 'b', result: reviewResult({}) },
    ]);
    expect(mixed.verdict).toBe('comment');
  });

  it('sorts findings most-severe first', () => {
    const agg = aggregateReviews([
      {
        lens: 'a',
        result: reviewResult({
          findings: [
            { severity: 'low', message: 'nit' },
            { severity: 'critical', message: 'boom' },
            { severity: 'medium', message: 'meh' },
          ],
        }),
      },
    ]);
    expect(agg.findings.map((f) => f.severity)).toEqual(['critical', 'medium', 'low']);
  });
});

describe('ChildRunStore', () => {
  it('persists records a fresh store instance can read back (restart durability)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-childstore-'));
    try {
      const ws = new Workspace(dir, '.mochi');
      ws.ensure();
      const rec: ChildRunRecord = {
        id: 'sub-deadbeef',
        parentAgentId: 'parent-1',
        role: 'researcher',
        preset: 'researcher',
        promptPreview: 'investigate X',
        status: 'done',
        access: 'read-only',
        cwd: dir,
        createdAt: 1000,
        finishedAt: 2000,
        result: {
          status: 'done',
          summary: 'X is implemented in src/x.ts',
          findings: [],
          artifacts: [],
          usage: { tokens: 42, toolCalls: 2, durationMs: 900 },
        },
      };
      new ChildRunStore(ws).save(rec);
      expect(existsSync(resolve(dir, '.mochi/state/subagents/sub-deadbeef.json'))).toBe(true);
      // A brand-new store over the same workspace = a restarted parent.
      const fresh = new ChildRunStore(ws);
      expect(fresh.load('sub-deadbeef')?.result?.summary).toContain('src/x.ts');
      expect(fresh.list().map((r) => r.id)).toEqual(['sub-deadbeef']);
      expect(fresh.load('sub-missing')).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('digests + caps helpers', () => {
  it('formatChildDigest renders status, verdict, findings and worktree apply hint', () => {
    const rec: ChildRunRecord = {
      id: 'sub-zz',
      parentAgentId: 'p',
      role: 'coder',
      preset: 'coder',
      promptPreview: 'x',
      status: 'done',
      access: 'worktree',
      cwd: '/repo',
      createdAt: 1,
      worktree: { id: 'w1', branch: 'mochi/worktree/w1', path: '/repo/.mochi/worktrees/w1', baseSha: 'abc' },
      diffSummary: '1 file(s): a.ts',
      result: {
        status: 'done',
        summary: 'Built it.',
        findings: [{ severity: 'high', file: 'a.ts', line: 3, message: 'Careful here' }],
        artifacts: ['a.ts'],
        usage: { tokens: 500, toolCalls: 4, durationMs: 2500 },
      },
    };
    const digest = formatChildDigest(rec);
    expect(digest).toContain('DONE');
    expect(digest).toContain('[high] a.ts:3');
    expect(digest).toContain('NOT applied');
    expect(digest).toContain('apply: true');
  });

  it('depth rule: spawn allowed strictly below the cap', () => {
    expect(canSpawnAtDepth(0, 2)).toBe(true);
    expect(canSpawnAtDepth(1, 2)).toBe(true);
    expect(canSpawnAtDepth(2, 2)).toBe(false);
    expect(canSpawnAtDepth(0, 0)).toBe(false);
  });

  it('cap resolvers fall back to documented defaults', () => {
    const bare = { safety: {} } as never;
    expect(resolveMaxSubagentDepth(bare)).toBe(2);
    expect(resolveMaxConcurrentSubagents(bare)).toBe(4);
    const cfg = { safety: { maxConcurrentSubagents: 7, maxSubagentDepth: 1 } };
    expect(resolveMaxSubagentDepth(cfg as never)).toBe(1);
    expect(resolveMaxConcurrentSubagents(cfg as never)).toBe(7);
  });

  it('formatFleetReport leads with the merged verdict', () => {
    const agg = aggregateReviews([
      { lens: 'security', result: reviewResult({ verdict: 'request-changes', summary: 'bad', findings: [{ severity: 'critical', file: 's.ts', line: 1, message: 'SQLi' }] }) },
    ]);
    const report = formatFleetReport(agg, { target: 'working tree vs HEAD', reviewers: 1 });
    expect(report).toContain('REQUEST-CHANGES');
    expect(report).toContain('SQLi');
  });
});
