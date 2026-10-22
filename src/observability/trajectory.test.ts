import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { TraceEntry } from './trace.js';
import { buildTrajectory, exportTrajectory, upgradeTrajectoryRecord } from './trajectory.js';

describe('buildTrajectory', () => {
  it('pairs tool calls with completions/failures into ordered steps and extracts task + outcome', () => {
    const entries: TraceEntry[] = [
      { t: 1000, kind: 'task:started', task: { id: 't1', title: 'Fix bug', description: 'Fix the failing test' } },
      { t: 1100, kind: 'tool:called', tool: 'shell', args: { command: 'npm test' } },
      { t: 1300, kind: 'tool:completed', tool: 'shell', result: { toolCallId: 'c1', name: 'shell', output: 'all passing', durationMs: 200 } },
      { t: 1400, kind: 'tool:called', tool: 'read', args: { path: 'a.ts' } },
      { t: 1500, kind: 'tool:failed', tool: 'read', error: 'ENOENT: a.ts' },
      { t: 1600, kind: 'task:completed', stopReason: 'completed' },
    ];
    const rec = buildTrajectory(entries, { runId: 'run1' });

    expect(rec.schemaVersion).toBe(2); // D9: buildTrajectory emits the v2 schema
    expect(rec.runId).toBe('run1');
    expect(rec.startedAt).toBe(1000);
    expect(rec.endedAt).toBe(1600);
    expect(rec.durationMs).toBe(600);
    expect(rec.task).toEqual({ title: 'Fix bug', prompt: 'Fix the failing test' });

    expect(rec.steps).toHaveLength(2);
    expect(rec.steps[0]).toMatchObject({ index: 0, tool: 'shell', args: { command: 'npm test' }, ok: true, outputSnippet: 'all passing', durationMs: 200 });
    // No result.durationMs on a failure: duration derives from entry timestamps.
    expect(rec.steps[1]).toMatchObject({ index: 1, tool: 'read', ok: false, error: 'ENOENT: a.ts', durationMs: 100 });

    expect(rec.outcome).toEqual({ completed: true, stopReason: 'completed' });
    expect(rec.failureTaxonomy).toEqual([{ label: 'tool_errors', count: 1 }]);
  });

  it('extracts a failed outcome with its reason and stopReason', () => {
    const rec = buildTrajectory([
      { t: 10, kind: 'task:started', task: { title: 'Ship it' } },
      { t: 20, kind: 'task:failed', reason: 'tests still red', stopReason: 'verification_failed' },
    ], { runId: 'run2' });
    expect(rec.outcome).toEqual({ completed: false, stopReason: 'verification_failed', reason: 'tests still red' });
    expect(rec.failureTaxonomy).toContainEqual({ label: 'verification_failed', count: 1 });
  });

  it('labels tool_loop / stuck_no_progress stop reasons', () => {
    const loop = buildTrajectory([
      { t: 1, kind: 'task:failed', reason: 'loop', stopReason: 'tool_loop' },
    ], { runId: 'r-loop' });
    expect(loop.failureTaxonomy).toContainEqual({ label: 'tool_loop', count: 1 });

    const stuck = buildTrajectory([
      { t: 1, kind: 'task:failed', reason: 'no progress', stopReason: 'stuck_no_progress' },
    ], { runId: 'r-stuck' });
    expect(stuck.failureTaxonomy).toContainEqual({ label: 'stuck_no_progress', count: 1 });
  });

  it('flags repeated identical tool+args calls at >=3, but not at 2', () => {
    const call = (t: number): TraceEntry[] => [
      { t, kind: 'tool:called', tool: 'read', args: { path: 'same.ts' } },
      { t: t + 1, kind: 'tool:completed', tool: 'read', result: { toolCallId: '', name: 'read', output: 'x', durationMs: 1 } },
    ];
    const three = buildTrajectory([...call(10), ...call(20), ...call(30)], { runId: 'r3' });
    expect(three.failureTaxonomy).toContainEqual({ label: 'repeated_tool_calls', count: 1 });

    const two = buildTrajectory([...call(10), ...call(20)], { runId: 'r2' });
    expect(two.failureTaxonomy.map((f) => f.label)).not.toContain('repeated_tool_calls');
    expect(two.failureTaxonomy).toEqual([]);
  });

  it('aggregates usage from usage:updated events and nested usage objects, and is null when absent', () => {
    const withUsage = buildTrajectory([
      { t: 1, kind: 'usage:updated', inputTokens: 10, outputTokens: 5, cacheTokens: 2, totalTokens: 17, costUsd: 0.01 },
      { t: 2, kind: 'usage:updated', inputTokens: 20, outputTokens: 7, cacheTokens: 0, totalTokens: 27, costUsd: 0.02 },
      { t: 3, kind: 'agent:iteration', usage: { promptTokens: 100, completionTokens: 40, cachedTokens: 10, totalTokens: 140, costUsd: 0.05 } },
    ], { runId: 'r-usage' });
    expect(withUsage.usage?.inputTokens).toBe(130);
    expect(withUsage.usage?.outputTokens).toBe(52);
    expect(withUsage.usage?.cacheTokens).toBe(12);
    expect(withUsage.usage?.totalTokens).toBe(184);
    expect(withUsage.usage?.costUsd).toBeCloseTo(0.08);

    const without = buildTrajectory([{ t: 1, kind: 'agent:log', message: 'hi' }], { runId: 'r-none' });
    expect(without.usage).toBeNull();
  });

  it('C5: $0-cost trace with model + token split surfaces a separate price-table estimate', () => {
    const rec = buildTrajectory([
      { t: 1, kind: 'usage:updated', model: 'gpt-4o', inputTokens: 800_000, outputTokens: 100_000, cacheTokens: 200_000, totalTokens: 1_100_000, costUsd: 0 },
    ], { runId: 'r-est' });
    expect(rec.usage?.costUsd).toBe(0); // recorded cost untouched
    expect(rec.usage?.estimatedCostUsd).toBeCloseTo(3.25, 8);
    expect(rec.usage?.costSource).toBe('estimated');
  });

  it('caps output snippets at 500 chars and keeps uncompleted / orphan steps in order', () => {
    const rec = buildTrajectory([
      { t: 1, kind: 'tool:called', tool: 'shell', args: { command: 'x' } },
      { t: 2, kind: 'tool:completed', tool: 'shell', result: { toolCallId: '', name: 'shell', output: 'y'.repeat(1000), durationMs: 1 } },
      { t: 3, kind: 'tool:completed', tool: 'read', result: { toolCallId: '', name: 'read', output: 'orphan', durationMs: 1 } },
      { t: 4, kind: 'tool:called', tool: 'write', args: { path: 'b.ts' } },
    ], { runId: 'r-cap' });
    expect(rec.steps).toHaveLength(3);
    expect(rec.steps[0].outputSnippet).toHaveLength(500);
    expect(rec.steps[1]).toMatchObject({ tool: 'read', ok: true, outputSnippet: 'orphan', args: null });
    expect(rec.steps[2]).toMatchObject({ tool: 'write', ok: false });
    expect(rec.steps[2].error).toBeUndefined();
  });

  it('handles an empty trace without inventing task, usage, or failures', () => {
    const rec = buildTrajectory([], { runId: 'r-empty' });
    expect(rec.startedAt).toBeNull();
    expect(rec.endedAt).toBeNull();
    expect(rec.durationMs).toBe(0);
    expect(rec.task).toBeNull();
    expect(rec.steps).toEqual([]);
    expect(rec.outcome).toEqual({ completed: false });
    expect(rec.usage).toBeNull();
    expect(rec.failureTaxonomy).toEqual([]);
  });
});

describe('exportTrajectory', () => {
  it('writes the record as one JSON line under <workspace>/exports/ and returns it', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-traj-'));
    mkdirSync(resolve(dir, 'traces'), { recursive: true });
    const lines: TraceEntry[] = [
      { t: 100, kind: 'task:started', task: { title: 'Export me', description: 'do it' } },
      { t: 110, kind: 'tool:called', tool: 'shell', args: { command: 'ls' } },
      { t: 120, kind: 'tool:completed', tool: 'shell', result: { toolCallId: '', name: 'shell', output: 'done', durationMs: 10 } },
      { t: 130, kind: 'task:completed', stopReason: 'completed' },
    ];
    writeFileSync(resolve(dir, 'traces', 'runX.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const out = exportTrajectory(dir, 'runX');
    expect(out).not.toBeNull();
    expect(out!.path).toBe(resolve(dir, 'exports', 'trajectory-runX.jsonl'));
    expect(existsSync(out!.path)).toBe(true);
    // Outside traces/, so pruneTraces never reaps it.
    expect(out!.path).not.toContain(resolve(dir, 'traces'));

    const fileLines = readFileSync(out!.path, 'utf8').split('\n').filter(Boolean);
    expect(fileLines).toHaveLength(1);
    const parsed = JSON.parse(fileLines[0]);
    expect(parsed).toMatchObject({ schemaVersion: 2, runId: 'runX' });
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.outcome.completed).toBe(true);
    expect(out!.record.runId).toBe('runX');
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null for a missing trace and writes nothing', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-traj-missing-'));
    expect(exportTrajectory(dir, 'nope')).toBeNull();
    expect(existsSync(resolve(dir, 'exports', 'trajectory-nope.jsonl'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('lifts edit telemetry into editStats, absent when the run made no edits', () => {
    const rec = buildTrajectory([
      { t: 1, kind: 'task:started', task: { title: 'Edit things' } },
      { t: 2, kind: 'edit:applied', path: 'a.ts', strategy: 'exact', attempts: 1, integrity: 'passed' },
      { t: 3, kind: 'edit:applied', path: 'b.ts', strategy: 'anchored', attempts: 4, integrity: 'passed' },
      { t: 4, kind: 'edit:applied', path: 'c.ts', strategy: 'exact', attempts: 1, integrity: 'pre-existing-errors' },
      { t: 5, kind: 'edit:failed', path: 'd.ts', failureKind: 'not-found', attempts: 4, nearMisses: 2 },
      { t: 6, kind: 'edit:failed', path: 'e.ts', failureKind: 'ambiguous', attempts: 2, nearMisses: 0 },
      { t: 7, kind: 'edit:reverted', path: 'f.ts', strategy: 'exact', errors: 'Unclosed bracket' },
      { t: 8, kind: 'task:completed', stopReason: 'completed' },
    ], { runId: 'run-edits' });
    expect(rec.editStats).toEqual({
      applied: 3,
      byStrategy: { exact: 2, normalized: 0, relaxed: 0, anchored: 1 },
      failed: 2,
      notFound: 1,
      ambiguous: 1,
      noChange: 0,
      reverted: 1,
    });

    const noEdits = buildTrajectory([{ t: 1, kind: 'agent:log', message: 'hi' }], { runId: 'run-noedits' });
    expect(noEdits.editStats).toBeUndefined();

    // Reader path: a stored record's editStats survive the upgrade round-trip.
    const upgraded = upgradeTrajectoryRecord(JSON.parse(JSON.stringify(rec)));
    expect(upgraded?.editStats).toEqual(rec.editStats);
  });
});
