import { describe, it, expect } from 'vitest';
import { CapabilityRegistry } from './capability-registry.js';
import { ToolDispatcher } from './tool-dispatcher.js';
import { ExecutionRegistry, argsKey } from './execution-registry.js';
import type { CapabilityContext, CapabilityExecutionResponse } from './capability.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';

function makeContext(overrides: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    cwd: process.cwd(),
    workspace: new Workspace(process.cwd(), '.mochi'),
    config: {} as CapabilityContext['config'],
    events: new EventBus(),
    agentId: 'test-agent',
    log: () => {},
    ...overrides,
  };
}

function ok(callId: string, name: string, output = 'done'): CapabilityExecutionResponse {
  return { callId, name, output, durationMs: 1, truncated: false, rawTokensEstimate: 1 };
}

describe('ExecutionRegistry', () => {
  it('flags an identical in-flight request as duplicate', () => {
    const r = new ExecutionRegistry();
    const a = r.register({ toolName: 'shell', args: { command: 'npm test' } });
    expect(a.duplicate).toBeFalsy();
    const b = r.register({ toolName: 'shell', args: { command: 'npm test' } });
    expect(b.duplicate).toBe(true);
    expect(b.executionId).toBe(a.executionId);
    expect(b.attempt).toBe(2);
    expect(r.stats().duplicatesPrevented).toBe(1);
  });

  it('treats different args as distinct work', () => {
    const r = new ExecutionRegistry();
    const a = r.register({ toolName: 'shell', args: { command: 'npm test' } });
    const b = r.register({ toolName: 'shell', args: { command: 'npm run build' } });
    expect(b.duplicate).toBeFalsy();
    expect(b.executionId).not.toBe(a.executionId);
  });

  it('replays a completed executionId instead of re-running (idempotency)', () => {
    const r = new ExecutionRegistry();
    const a = r.register({ toolName: 'read', args: { path: 'a.ts' }, executionId: 'call-1' });
    r.markCompleted(a.executionId, ok('call-1', 'read'));
    const replay = r.register({ toolName: 'read', args: { path: 'a.ts' }, executionId: 'call-1' });
    expect(replay.duplicate).toBe(true);
    expect(replay.result).toEqual(ok('call-1', 'read'));
    expect(r.stats().replaysServed).toBe(1);
  });

  it('allows re-running the same args after the dedupe window', () => {
    const r = new ExecutionRegistry({ dedupeWindowMs: 0 });
    const a = r.register({ toolName: 'shell', args: { command: 'x' } });
    r.markCompleted(a.executionId, 'ok');
    const b = r.register({ toolName: 'shell', args: { command: 'x' } });
    expect(b.duplicate).toBeFalsy();
  });

  it('cancelAll cancels every in-flight execution', () => {
    const r = new ExecutionRegistry();
    const a = r.register({ toolName: 'shell', args: { command: 'sleep 30' } });
    const b = r.register({ toolName: 'shell', args: { command: 'sleep 31' } });
    const n = r.cancelAll('user pressed ctrl-c');
    expect(n).toBe(2);
    expect(r.get(a.executionId)?.status).toBe('canceled');
    expect(r.get(b.executionId)?.status).toBe('canceled');
    expect(r.stats().active).toBe(0);
  });

  it('bounds completed records (drop-oldest)', () => {
    const r = new ExecutionRegistry({ completedLimit: 3, dedupeWindowMs: 0 });
    for (let i = 0; i < 6; i++) {
      const rec = r.register({ toolName: 't', args: { i } });
      r.markCompleted(rec.executionId, i);
    }
    expect(r.stats().completed).toBe(3);
  });

  it('argsKey is order-independent', () => {
    expect(argsKey({ a: 1, b: 2 })).toBe(argsKey({ b: 2, a: 1 }));
  });
});

describe('ToolDispatcher execution authority', () => {
  it('executes an identical duplicated call ONCE', async () => {
    const capabilities = new CapabilityRegistry();
    let calls = 0;
    capabilities.register({
      id: 'shellx', name: 'shellx', kind: 'native', description: 'shell',
      schema: { name: 'shellx', description: 's', parameters: [] },
      isReadOnly: true,
      execute: async (req) => { calls++; return ok(req.callId, req.name, 'ran'); },
    });
    const dispatcher = new ToolDispatcher(capabilities);
    const ctx = makeContext();
    const results = await dispatcher.dispatchBatch([
      { id: 'a1', name: 'shellx', arguments: { command: 'open calculator' } },
      { id: 'a2', name: 'shellx', arguments: { command: 'open calculator' } },
      { id: 'a3', name: 'shellx', arguments: { command: 'open calculator' } },
    ], ctx);
    expect(calls).toBe(1);
    expect(results[0].output).toBe('ran');
    expect(results[1].metadata?.duplicate).toBe(true);
    expect(results[2].metadata?.duplicate).toBe(true);
    expect(dispatcher.executions.stats().duplicatesPrevented).toBe(2);
  });

  it('refuses to execute anything when the abort signal already fired', async () => {
    const capabilities = new CapabilityRegistry();
    let calls = 0;
    capabilities.register({
      id: 'w', name: 'w', kind: 'native', description: 'mutating',
      schema: { name: 'w', description: 'w', parameters: [] },
      isReadOnly: false,
      execute: async (req) => { calls++; return ok(req.callId, req.name); },
    });
    const dispatcher = new ToolDispatcher(capabilities);
    const ac = new AbortController();
    ac.abort();
    const results = await dispatcher.dispatchBatch([{ id: 'x1', name: 'w', arguments: {} }], makeContext({ abortSignal: ac.signal }));
    expect(calls).toBe(0);
    expect(results[0].metadata?.canceled).toBe(true);
  });

  it('cancels remaining mutating calls when abort fires mid-batch', async () => {
    const capabilities = new CapabilityRegistry();
    const done: string[] = [];
    const makeCap = (name: string) => capabilities.register({
      id: name, name, kind: 'native' as const, description: name,
      schema: { name, description: name, parameters: [] },
      isReadOnly: false,
      execute: async (req) => {
        done.push(req.callId);
        if (name === 'm0') ac.abort();
        return ok(req.callId, name);
      },
    });
    const ac = new AbortController();
    makeCap('m0');
    makeCap('m1');
    const dispatcher = new ToolDispatcher(capabilities);
    const results = await dispatcher.dispatchBatch([
      { id: 'f1', name: 'm0', arguments: {} },
      { id: 'f2', name: 'm1', arguments: {} },
    ], makeContext({ abortSignal: ac.signal }));
    expect(done).toEqual(['f1']);
    expect(results[1].metadata?.canceled).toBe(true);
    expect(dispatcher.executions.stats().canceled).toBe(1);
  });
});