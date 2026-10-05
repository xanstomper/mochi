// MCH-19: kill-9 fidelity test — verifies that after a SIGKILL mid-task, the
// workspace checkpoint is intact and can be loaded for resume.
//
// We don't actually SIGKILL a real process here (that would require a child
// agent process), but we simulate the exact same scenario: an agent writes a
// checkpoint mid-task, the process "dies" (we drop the agent object), and then
// a new agent picks up the checkpoint on the next invocation — exactly what
// `mochi resume` does.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';

describe('kill-9 fidelity (checkpoint survive-and-resume)', () => {
  it('checkpoint written mid-task survives workspace reopen and is loaded on resume', () => {
    // ---------- Phase 1: "First session" (before SIGKILL) ----------
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-kill9-'));
    const ws1 = new Workspace(dir, '.mochi');
    ws1.ensure();

    const task = createTask('Refactor auth module', 'extract OAuth logic into oauth.ts');
    const goalId = task.id;

    // Simulate mid-task checkpoint (normally written by checkpointAndCompact
    // or the abort/budget handlers in loop.ts).
    const checkpointText = [
      `Goal: ${task.title}`,
      'Progress: Identified 3 files to change (auth.ts, session.ts, index.ts).',
      'Completed: auth.ts refactored, OAuth class extracted.',
      'Remaining: session.ts import update, index.ts barrel re-export.',
      'Next: Run "mochi resume" to continue.',
    ].join('\n');

    ws1.saveCheckpoint(goalId, checkpointText);

    // -------- Phase 2: "SIGKILL" — drop the agent, simulate process death --------
    // (In real kill-9, the in-memory state is lost; only the on-disk checkpoint survives.)
    // We simulate by opening a brand-new Workspace instance pointing to the same dir.

    const ws2 = new Workspace(dir, '.mochi');

    // ---------- Phase 3: "mochi resume" — new session reloads checkpoint ----------
    const loaded = ws2.loadCheckpoint(goalId);

    expect(loaded).not.toBeNull();
    expect(loaded!.goalId).toBe(goalId);
    expect(loaded!.checkpoint).toContain('Completed: auth.ts refactored');
    expect(loaded!.checkpoint).toContain('Remaining: session.ts import update');
    expect(loaded!.savedAt).toBeGreaterThan(0);
  });

  it('checkpoint is goal-scoped — loading with wrong goalId returns null (no cross-task bleed)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-kill9-scope-'));
    const ws = new Workspace(dir, '.mochi');
    ws.ensure();

    const task1 = createTask('Task A', 'do A');
    const task2 = createTask('Task B', 'do B');

    ws.saveCheckpoint(task1.id, 'Checkpoint for task A');

    // Loading with the wrong goal ID must return null — we must not resume
    // the wrong task's context.
    const wrongLoad = ws.loadCheckpoint(task2.id);
    expect(wrongLoad).toBeNull();

    // Loading with the correct goal ID must succeed.
    const rightLoad = ws.loadCheckpoint(task1.id);
    expect(rightLoad).not.toBeNull();
    expect(rightLoad!.checkpoint).toContain('Checkpoint for task A');
  });

  it('clearCheckpoint removes the checkpoint so a fresh task starts clean', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-kill9-clear-'));
    const ws = new Workspace(dir, '.mochi');
    ws.ensure();

    const task = createTask('Task C', 'do C');
    ws.saveCheckpoint(task.id, 'Checkpoint for task C');

    // Verify it's there.
    expect(ws.loadCheckpoint(task.id)).not.toBeNull();

    // Clear it (done after a successful finish to prevent stale resume).
    ws.clearCheckpoint();

    // Must be gone now.
    expect(ws.loadCheckpoint(task.id)).toBeNull();
  });

  it('checkpoint file is human-readable JSON on disk (not binary)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-kill9-disk-'));
    const ws = new Workspace(dir, '.mochi');
    ws.ensure();

    const task = createTask('Disk format test', 'verify checkpoint is JSON');
    ws.saveCheckpoint(task.id, 'Progress: step 1 done.');

    // Read the raw file to confirm it's parseable JSON — required so operators
    // can inspect or manually edit checkpoints during incident response.
    const cpFile = resolve(dir, '.mochi', 'state', 'checkpoint.json');
    const raw = readFileSync(cpFile, 'utf8');
    const parsed = JSON.parse(raw);

    expect(parsed).toHaveProperty('goalId', task.id);
    expect(parsed).toHaveProperty('checkpoint');
    expect(parsed).toHaveProperty('savedAt');
    expect(typeof parsed.savedAt).toBe('number');
  });
});
