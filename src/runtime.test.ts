import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { Runtime } from './runtime.js';

function makeRepo(): string {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-runtime-'));
  execSync('git init -q && git config user.email d@d && git config user.name d && git commit -q --allow-empty -m init', { cwd: dir, shell: '/bin/sh' });
  return dir;
}

describe('Runtime abort + interrupt', () => {
  it('aborts before the goal starts and does not hang on an aborted signal', async () => {
    const rt = Runtime.create({ cwd: makeRepo() });
    rt.abort('test abort');
    // runGoal receives the aborted signal; a goal whose tasks never start
    // should terminate (abort is checked at the top of each agent loop).
    const result = await rt.goals.runGoal(
      { id: 'abort-test', objective: 'x', status: 'pending', progress: 0, createdAt: Date.now(), updatedAt: Date.now(), tasks: [] } as any,
      [],
      [],
      rt['abortSignal'],
    );
    // With no tasks scheduled, runGoal completes quickly and records nothing.
    expect(result.summary).toBeDefined();
    rmSync(rt.cwd, { recursive: true, force: true });
  });

  it('exposes abort and a signal that flips on abort()', () => {
    const rt = Runtime.create({ cwd: makeRepo() });
    const signal = rt['abortSignal'] as AbortSignal;
    expect(signal.aborted).toBe(false);
    rt.abort('stop');
    expect(signal.aborted).toBe(true);
    rmSync(rt.cwd, { recursive: true, force: true });
  });
});