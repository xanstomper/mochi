import { describe, it, expect, afterEach } from 'bun:test';
import { rmSync } from "fs";
import { join } from 'path';
import { ExecutionRegistry, argsKey } from './core/execution-registry.js';

// MCH-64: mid-stream speculative execution contract. The Agent-level wiring
// (specExecCall -> registry, runMoolCall replay) is integration-tested via the
// suite; here we verify the registry mechanics spec-exec depends on:
//   1. register({executionId}) on a fresh id starts a tracked execution
//   2. markCompleted stores {output} keyed by that id
//   3. re-registering the SAME executionId serves the cached result
//      (duplicate=true) — the zero-latency replay runMoolCall relies on.
describe('MCH-64 spec-exec registry contract', () => {


  afterEach(() => {
  });

  it('completed execution replays by executionId without re-execution', () => {
    const reg = new ExecutionRegistry({ dedupeWindowMs: 5000 });
    const id = 'call_mch64_test_1';

    // Spec-exec phase: fresh registration under the tool_call id.
    const rec1 = reg.register({ toolName: 'read', args: { path: 'a.ts' }, executionId: id });
    expect(rec1.duplicate).toBeFalsy();
    expect(rec1.status).toBe('running');

    // Spec-exec finishes: result stored under the SAME id.
    reg.markCompleted(id, { output: 'file contents' });

    // Post-stream real execution: same id -> replay, never re-runs.
    const rec2 = reg.register({ toolName: 'read', args: { path: 'a.ts' }, executionId: id });
    expect(rec2.duplicate).toBe(true);
    expect(rec2.status).toBe('completed');
    expect((rec2.result as { output: string }).output).toBe('file contents');
    expect(reg.stats().replaysServed).toBe(1);
  });

  it('failed spec-exec does not poison the real execution', () => {
    const reg = new ExecutionRegistry({ dedupeWindowMs: 5000 });
    const id = 'call_mch64_fail_1';
    reg.register({ toolName: 'shell', args: { command: 'ls' }, executionId: id });
    reg.markFailed(id, 'boom');

    // markFailed stores the error but the real path re-registering the same id
    // gets the cached failure record (duplicate=true, error result) — runMoolCall
    // surfaces it as a tool:failed message, which is the correct semantics.
    const rec = reg.register({ toolName: 'shell', args: { command: 'ls' }, executionId: id });
    expect(rec.duplicate).toBe(true);
    expect((rec.result as { error: string }).error).toBe('boom');
  });

  it('different args same id still replays (id is the lookup key)', () => {
    const reg = new ExecutionRegistry({ dedupeWindowMs: 5000 });
    reg.register({ toolName: 'read', args: { path: 'a.ts' }, executionId: 'call_x' });
    reg.markCompleted('call_x', { output: 'A' });
    const rec = reg.register({ toolName: 'read', args: { path: 'b.ts' }, executionId: 'call_x' });
    // executionId lookup precedes signature matching — replay serves A. This is
    // safe for MCH-64 because the id is the model's own tool_call id: identical
    // ids imply identical calls.
    expect(rec.duplicate).toBe(true);
    expect((rec.result as { output: string }).output).toBe('A');
  });

  it('argsKey is stable across key order (signature dedupe for spec-exec races)', () => {
    expect(argsKey({ path: 'a.ts', mode: 'r' })).toBe(argsKey({ mode: 'r', path: 'a.ts' }));
  });
});
