// D9: trajectory v2 — buildTrajectory emits taskKind / verified / cost /
// per-step argShape, and the reader upgrades v1 exports without loss.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import type { TraceEntry } from './trace.js';
import {
  buildTrajectory, upgradeTrajectoryRecord, parseTrajectoryJsonl,
  readTrajectoryExport, isVerifiedRecord, deriveTrajectoryCost,
} from './trajectory.js';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mochi-trajv2-'));
  dirs.push(d);
  return d;
}

describe('buildTrajectory v2 fields', () => {
  it('lifts taskKind from the attribution entry, marks verified, rolls up cost, shapes args', () => {
    const entries: TraceEntry[] = [
      { t: 1000, kind: 'task:started', task: { title: 'Fix it', description: 'fix the test' } },
      { t: 1100, kind: 'tool:called', tool: 'shell', args: { command: 'npm test --secret-flag' } },
      { t: 1200, kind: 'tool:completed', tool: 'shell', result: { toolCallId: 'c1', name: 'shell', output: 'ok', durationMs: 100 } },
      { t: 1300, kind: 'usage:updated', inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.02 },
      { t: 1400, kind: 'skills:attributed', agentId: undefined, skills: [{ id: 's1', verdict: 'pass' }], verifyStatus: 'PASS', taskKind: 'fix' },
      { t: 1500, kind: 'task:completed', stopReason: 'completed' },
    ];
    const rec = buildTrajectory(entries, { runId: 'v2run' });
    expect(rec.schemaVersion).toBe(2);
    expect(rec.taskKind).toBe('fix');
    expect(rec.verified).toBe(true);
    expect(isVerifiedRecord(rec)).toBe(true);
    expect(rec.cost).toEqual({ totalUsd: 0.02, reportedUsd: 0.02, estimatedUsd: 0, totalTokens: 150, source: 'provider' });
    // Arg shape carries keys/types only — the arg VALUE never leaks into it.
    expect(rec.steps[0].argShape).toBe('{command:string}');
    expect(rec.steps[0].argShape).not.toContain('secret');
  });

  it('unverified runs: verified=false, taskKind unknown, cost null without usage', () => {
    const rec = buildTrajectory([
      { t: 1, kind: 'task:started', task: { title: 'Chat' } },
      { t: 2, kind: 'task:completed', stopReason: 'completed' },
    ], { runId: 'plain' });
    expect(rec.verified).toBe(false);
    expect(rec.taskKind).toBe('unknown');
    expect(rec.cost).toBeNull();
    expect(deriveTrajectoryCost(null)).toBeNull();
  });
});

describe('v1 backwards-compatible reader', () => {
  const v1 = {
    schemaVersion: 1,
    runId: 'legacy1',
    startedAt: 10,
    endedAt: 20,
    durationMs: 10,
    task: { title: 'Old run' },
    steps: [
      { index: 0, tool: 'read', args: { path: 'a.ts' }, ok: true, outputSnippet: 'x' },
      { index: 1, tool: 'shell', args: { command: 'ls', timeout: 5 }, ok: false, outputSnippet: '', error: 'boom' },
    ],
    skills: [{ id: 's1', verdict: 'pass' }],
    verification: { status: 'PASS', verdict: 'pass' },
    outcome: { completed: true, stopReason: 'completed' },
    usage: { totalTokens: 42, costUsd: 0.5 },
    failureTaxonomy: [{ label: 'tool_errors', count: 1 }],
  };

  it('upgrades a v1 record: provenance kept, v2 fields derived', () => {
    const rec = upgradeTrajectoryRecord(v1);
    expect(rec).not.toBeNull();
    expect(rec!.schemaVersion).toBe(1); // original version preserved as provenance
    expect(rec!.taskKind).toBe('unknown'); // v1 carried no kind — not invented
    expect(rec!.verified).toBe(true); // derived from verification PASS
    expect(rec!.cost).toEqual({ totalUsd: 0.5, reportedUsd: 0.5, estimatedUsd: 0, totalTokens: 42, source: 'provider' });
    expect(rec!.steps[0].argShape).toBe('{path:string}');
    expect(rec!.steps[1].argShape).toBe('{command:string,timeout:number}');
    expect(rec!.steps[1].error).toBe('boom');
  });

  it('parseTrajectoryJsonl skips malformed lines and rejects shapeless records', () => {
    const text = `${JSON.stringify(v1)}\nnot json\n{"runId": 7}\n`;
    const recs = parseTrajectoryJsonl(text);
    expect(recs).toHaveLength(1);
    expect(recs[0].runId).toBe('legacy1');
    expect(upgradeTrajectoryRecord(null)).toBeNull();
    expect(upgradeTrajectoryRecord({ runId: 'x' })).toBeNull(); // steps missing
  });

  it('readTrajectoryExport reads a v1 file from <workspace>/exports/', () => {
    const dir = tempDir();
    mkdirSync(resolve(dir, 'exports'), { recursive: true });
    writeFileSync(resolve(dir, 'exports', 'trajectory-legacy1.jsonl'), JSON.stringify(v1) + '\n');
    const rec = readTrajectoryExport(dir, 'legacy1');
    expect(rec?.runId).toBe('legacy1');
    expect(rec?.verified).toBe(true);
    expect(readTrajectoryExport(dir, 'missing')).toBeNull();
  });
});
