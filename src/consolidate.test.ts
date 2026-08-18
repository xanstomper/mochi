import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { consolidate, consolidateReason } from './consolidate.js';
import type { GoalResult } from './goals/goal.js';
import type { Task } from './types.js';

function failedTask(over: Partial<Task> = {}): Task {
  return {
    id: 't1',
    title: 'Add widget',
    description: '',
    role: 'coder',
    status: 'failed',
    priority: 1,
    dependencies: [],
    acceptanceCriteria: [],
    attempts: [
      { id: 'a1', strategy: 'x', actions: [], result: 'failure', failureReason: 'test did not run: missing add.js', timestamp: 1 },
    ],
    output: 'Agent could not create widget.',
    createdAt: Date.now(),
    ...over,
  };
}

function failedResult(failed: Task[]): GoalResult {
  return {
    success: failed.length === 0,
    failedTasks: failed,
    completedTasks: [],
    summary: 'Goal failed.',
    tokensUsed: 0,
    costUsd: 0,
    durationMs: 0,
    goal: {} as never,
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-consolidate-'));
});

describe('consolidate (auto persistent memory)', () => {
  it('writes a real failure memory for a failed run', () => {
    const r = consolidate(dir, failedResult([failedTask()]));
    expect(r.added).toBe(1);
    const content = readFileSync(resolve(dir, 'memory/failures.md'), 'utf8');
    expect(content).toContain('## failure: Failed: Add widget');
    expect(content).toContain('test did not run: missing add.js');
  });

  it('writes nothing for a successful run', () => {
    const r = consolidate(dir, failedResult([]));
    expect(r.added).toBe(0);
    expect(existsSync(resolve(dir, 'memory/failures.md'))).toBe(false);
  });

  it('dedups across repeated runs of the same failing task', () => {
    const res = failedResult([failedTask()]);
    const first = consolidate(dir, res);
    const second = consolidate(dir, res);
    expect(first.added).toBe(1);
    expect(second.added).toBe(0);
    const body = readFileSync(resolve(dir, 'memory/failures.md'), 'utf8');
    // Only one "## failure" block, not two.
    expect((body.match(/^## /gm) || []).length).toBe(1);
  });

  it('falls back to task.output and bounds the body length', () => {
    const t = failedTask({
      attempts: [],
      output: 'Y'.repeat(10_000),
    });
    const r = consolidate(dir, failedResult([t]));
    expect(r.added).toBe(1);
    const body = readFileSync(resolve(dir, 'memory/failures.md'), 'utf8');
    // The stored body is capped well below the 10k output.
    expect(body.length).toBeLessThan(700);
  });

  it('exposes the real reason helper for tests/logs', () => {
    const t = failedTask();
    expect(consolidateReason(t)).toContain('missing add.js');
  });
});