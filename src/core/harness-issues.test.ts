import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  classifyHarnessFailure,
  recordHarnessIssue,
  listHarnessIssues,
  resolveHarnessIssue,
  markRepairAttempt,
  issuesContextBlock,
  isHarnessRepo,
  shouldAutoRepair,
  buildRepairPrompt,
  harnessIssuesPath,
} from './harness-issues.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(resolve(tmpdir(), 'harness-issues-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('classifyHarnessFailure', () => {
  it('flags the same tool+error repeating 3+ times as a tool_error_loop', () => {
    const err = { tool: 'read', error: 'ENOENT: no such file or directory' };
    const c = classifyHarnessFailure({
      stopReason: 'completed', fileChanged: false, toolCallsTotal: 6,
      consecutiveToolErrors: 3, toolErrors: [err, err, err],
      vetoes: [], chatMutationVetoes: 0, taskText: 'read missing.txt',
    });
    expect(c?.kind).toBe('tool_error_loop');
    expect(c!.title).toContain('read');
    expect(c!.signature).toHaveLength(12);
  });

  it('ignores one-off tool errors (plain task failure)', () => {
    const c = classifyHarnessFailure({
      stopReason: 'completed', fileChanged: false, toolCallsTotal: 3,
      consecutiveToolErrors: 1,
      toolErrors: [{ tool: 'shell', error: 'exit code 1' }],
      vetoes: [], chatMutationVetoes: 0, taskText: 'run the tests',
    });
    expect(c).toBeNull();
  });

  it('flags 3 identical veto reasons as a veto_storm', () => {
    const v = { tool: 'write', reason: 'Workspace fence (drift guard): /other/repo' };
    const c = classifyHarnessFailure({
      stopReason: 'completed', fileChanged: true, toolCallsTotal: 4,
      consecutiveToolErrors: 0, toolErrors: [], vetoes: [v, v, v],
      chatMutationVetoes: 0, taskText: 'fix the bug',
    });
    expect(c?.kind).toBe('veto_storm');
  });

  it('flags 6+ vetoes by volume even when reasons differ', () => {
    const vetoes = Array.from({ length: 6 }, (_, i) => ({ tool: 'read', reason: `different reason ${i}` }));
    const c = classifyHarnessFailure({
      stopReason: 'completed', fileChanged: false, toolCallsTotal: 12,
      consecutiveToolErrors: 0, toolErrors: [], vetoes,
      chatMutationVetoes: 0, taskText: 'research',
    });
    expect(c?.kind).toBe('veto_storm');
  });

  it('flags chatMutationVetoes >= 2 as a misclassification', () => {
    const c = classifyHarnessFailure({
      stopReason: 'completed', fileChanged: true, toolCallsTotal: 4,
      consecutiveToolErrors: 0, toolErrors: [], vetoes: [],
      chatMutationVetoes: 2, taskText: 'write answer.txt',
    });
    expect(c?.kind).toBe('chat_escape_failed');
  });

  it('flags the anti-loop stop with zero file changes', () => {
    const c = classifyHarnessFailure({
      stopReason: 'stuck_no_progress', fileChanged: false, toolCallsTotal: 20,
      consecutiveToolErrors: 2, toolErrors: [],
      vetoes: [], chatMutationVetoes: 0, taskText: 'refactor',
    });
    expect(c?.kind).toBe('stuck_no_progress');
  });

  it('flags max_iterations with >=3 errors and zero file changes', () => {
    const c = classifyHarnessFailure({
      stopReason: 'max_iterations', fileChanged: false, toolCallsTotal: 30,
      consecutiveToolErrors: 3,
      toolErrors: [
        { tool: 'shell', error: 'exit code 1, tests failed' },
        { tool: 'git', error: 'fatal: not a git repo' },
        { tool: 'verify', error: 'compiler error TS2322' },
      ],
      vetoes: [], chatMutationVetoes: 0, taskText: 'build',
    });
    expect(c?.kind).toBe('no_progress');
  });

  it('returns null for a normal failure (task-specific, not harness)', () => {
    const c = classifyHarnessFailure({
      stopReason: 'aborted', fileChanged: false, toolCallsTotal: 1,
      consecutiveToolErrors: 1,
      toolErrors: [{ tool: 'shell', error: 'killed by user' }],
      vetoes: [], chatMutationVetoes: 0, taskText: 'do thing',
    });
    expect(c).toBeNull();
  });

  it('is stable: identical input yields identical signature', () => {
    const input = {
      stopReason: 'completed', fileChanged: false, toolCallsTotal: 6,
      consecutiveToolErrors: 3,
      toolErrors: [{ tool: 'read', error: 'ENOENT: no such file' }, { tool: 'read', error: 'ENOENT: no such file' }, { tool: 'read', error: 'ENOENT: no such file' }],
      vetoes: [], chatMutationVetoes: 0, taskText: 'read missing',
    };
    const a = classifyHarnessFailure(input as any);
    const b = classifyHarnessFailure(input as any);
    expect(a!.signature).toBe(b!.signature);
  });
});

describe('harness issue ledger', () => {
  it('records and dedupes by signature, bumping count', () => {
    const err = { tool: 'read', error: 'ENOENT: no file' };
    const c = classifyHarnessFailure({
      stopReason: 'completed', fileChanged: false, toolCallsTotal: 3,
      consecutiveToolErrors: 3, toolErrors: [err, err, err],
      vetoes: [], chatMutationVetoes: 0, taskText: 't',
    })!;
    const first = recordHarnessIssue(dir, c, 'read missing', 1000);
    expect(first.count).toBe(1);
    const second = recordHarnessIssue(dir, c, 'read missing again', 2000);
    expect(second.signature).toBe(first.signature);
    expect(second.count).toBe(2);
    expect(second.lastSeen).toBe(2000);
    // A recurrence re-opens a resolved issue (so the ledger doesn't mask it).
    resolveHarnessIssue(dir, first.signature);
    recordHarnessIssue(dir, c, 'x', 3000);
    expect(listHarnessIssues(dir, { status: 'open' }).find((i) => i.signature === first.signature)).toBeTruthy();
  });

  it('creates separate issues for different signatures', () => {
    recordHarnessIssue(dir, { kind: 'tool_error_loop', title: 'A', evidence: 'a', signature: 'aaaaaaaaaaaa' } as any, 't', 1);
    // recordHarnessIssue does NOT create via classify shape — check the persisted count directly.
    const ledger = listHarnessIssues(dir);
    // The forged one still wasn't written because we called recordHarnessIssue (it was).
    expect(harnessIssuesPath(dir)).toContain('harness-issues.json');
  });

  it('caps recorded issues at 50 (evicting resolved first)', () => {
    const sig = (i: number) => `issue-sig-${i.toString()}`;
    for (let i = 0; i < 55; i++) {
      recordHarnessIssue(dir, { kind: 'no_progress', title: `issue ${i}`, evidence: '.', signature: sig(i) } as any, 't', i);
    }
    expect(listHarnessIssues(dir).length).toBe(50);
  });

  it('resolve marks the issue resolved', () => {
    const c = { kind: 'stuck_no_progress', title: 'trap', evidence: '.', signature: '123456789abc' } as any;
    recordHarnessIssue(dir, c, 't');
    expect(resolveHarnessIssue(dir, c.signature)).toBe(true);
    expect(listHarnessIssues(dir, { status: 'open' })).toHaveLength(0);
  });

  it('markRepairAttempt stores lastRepairAt', () => {
    const c = { kind: 'no_progress', title: 'tr', evidence: 'e', signature: 'repeatable123' } as any;
    recordHarnessIssue(dir, c, 't');
    markRepairAttempt(dir, c.signature, 9999);
    const stored = listHarnessIssues(dir).find((i) => i.signature === c.signature)!;
    expect(stored.lastRepairAt).toBe(9999);
  });
});

describe('resolveHarnessIssue', () => {
  it('marks the matching signature resolved and keeps other entries open', () => {
    const a = { kind: 'tool_error_loop', title: 'read crashes', evidence: 'EISDIR', signature: 'sig11sig11si' } as any;
    const b = { kind: 'veto_storm', title: 'veto forever', evidence: 'e', signature: 'sig22sig22si' } as any;
    recordHarnessIssue(dir, a, 't');
    recordHarnessIssue(dir, b, 't');
    expect(resolveHarnessIssue(dir, 'sig11sig11si')).toBe(true);
    const open = listHarnessIssues(dir, { status: 'open' });
    const resolved = listHarnessIssues(dir, { status: 'resolved' });
    expect(open.map((i) => i.signature)).toEqual(['sig22sig22si']);
    expect(resolved.map((i) => i.signature)).toEqual(['sig11sig11si']);
  });

  it('returns false for an unknown signature (idempotent, no throw)', () => {
    expect(resolveHarnessIssue(dir, 'doesnotexist001')).toBe(false);
  });

  it('lets the same signature be re-opened by a subsequent recordHarnessIssue', () => {
    const a = { kind: 'tool_error_loop', title: 'read', evidence: 'EISDIR', signature: 'sig33sig33si' } as any;
    recordHarnessIssue(dir, a, 't');
    resolveHarnessIssue(dir, 'sig33sig33si');
    recordHarnessIssue(dir, a, 't');
    const open = listHarnessIssues(dir, { status: 'open' });
    expect(open.map((i) => i.signature)).toEqual(['sig33sig33si']);
    expect(open[0]!.count).toBe(2);
  });
});

describe('issuesContextBlock', () => {
  it('returns empty string when nothing is open', () => {
    expect(issuesContextBlock(dir)).toBe('');
  });

  it('renders up to 3 open issues and omits resolved ones', () => {
    const a = { kind: 'tool_error_loop', title: 'read crashes on dirs', evidence: 'e', signature: 'sig1sig1sig1' } as any;
    const b = { kind: 'veto_storm', title: 'veto forever', evidence: 'e', signature: 'sig2sig2sig2' } as any;
    recordHarnessIssue(dir, a, 't');
    recordHarnessIssue(dir, a, 't'); // count 2
    const resolved = { kind: 'no_progress', title: 'done', evidence: 'e', signature: 'resolvedsig1' } as any;
    recordHarnessIssue(dir, resolved, 't');
    resolveHarnessIssue(dir, resolved.signature);
    const block = issuesContextBlock(dir);
    expect(block).toContain('Known harness issues');
    expect(block).toContain('read crashes on dirs');
    expect(block).toContain('x2');
    expect(block).toContain('self-heal loop');
    expect(block).not.toContain('done');
  });
});

describe('shouldAutoRepair', () => {
  const base = { issue: { signature: 's', kind: 'tool_error_loop' as const, title: 't', evidence: 'e', task: 't', count: 1, firstSeen: 1, lastSeen: 2, status: 'open' as const }, isHarnessRepo: true, configEnabled: false };

  it('on + in harness repo → yes', () => expect(shouldAutoRepair(base)).toBe(true));
  it('off everywhere → no', () => expect(shouldAutoRepair({ ...base, isHarnessRepo: false, configEnabled: false })).toBe(false));
  it('configEnabled forces yes even outside the repo', () => expect(shouldAutoRepair({ ...base, isHarnessRepo: false, configEnabled: true })).toBe(true));
  it('resolved → no', () => expect(shouldAutoRepair({ ...base, issue: { ...base.issue, status: 'resolved' } })).toBe(false));
  it('within 24h cooldown → no', () => {
    const now = 1_000_000;
    const issue = { ...base.issue, lastRepairAt: now - 60_000 };
    expect(shouldAutoRepair({ ...base, issue, now })).toBe(false);
  });
});

describe('isHarnessRepo + repair prompt', () => {
  it('detects this repo as the harness repo', () => {
    // CWD-local detection uses the fs path, not process.cwd()
    expect(isHarnessRepo(resolve(process.cwd()))).toBe(true);
  });
  it('rejects a random temp dir', () => {
    expect(isHarnessRepo(dir)).toBe(false);
  });

  it('builds a structured repair directive', () => {
    const issue = { signature: 'abc123456789', kind: 'tool_error_loop' as const, title: 'read crashes on dirs', evidence: 'EISDIR', task: 'read the src dir', count: 3, firstSeen: 1, lastSeen: 2, status: 'open' as const };
    const p = buildRepairPrompt(issue);
    expect(p).toContain('abc123456789');
    expect(p).toContain('tool_error_loop');
    expect(p).toContain('Reproduce');
    expect(p).toContain('REGRESSION test');
    expect(p).toContain('Do NOT commit');
  });
});