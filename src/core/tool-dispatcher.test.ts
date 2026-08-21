import { describe, it, expect } from 'vitest';
import { CapabilityRegistry } from './capability-registry.js';
import { ToolDispatcher } from './tool-dispatcher.js';
import type { CapabilityContext } from './capability.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';

describe('ToolDispatcher', () => {
  it('dispatches read-only calls concurrently and mutating calls sequentially', async () => {
    const registry = new CapabilityRegistry();
    const executionOrder: string[] = [];

    registry.register({
      id: 'read1',
      name: 'read1',
      kind: 'native',
      description: 'read1',
      schema: { name: 'read1', description: 'r1', parameters: [] },
      isReadOnly: true,
      execute: async (req) => {
        executionOrder.push(`start:${req.name}`);
        await new Promise((r) => setTimeout(r, 20));
        executionOrder.push(`end:${req.name}`);
        return { callId: req.callId, name: req.name, output: 'r1-done', durationMs: 20, truncated: false, rawTokensEstimate: 2 };
      },
    });

    registry.register({
      id: 'read2',
      name: 'read2',
      kind: 'native',
      description: 'read2',
      schema: { name: 'read2', description: 'r2', parameters: [] },
      isReadOnly: true,
      execute: async (req) => {
        executionOrder.push(`start:${req.name}`);
        await new Promise((r) => setTimeout(r, 20));
        executionOrder.push(`end:${req.name}`);
        return { callId: req.callId, name: req.name, output: 'r2-done', durationMs: 20, truncated: false, rawTokensEstimate: 2 };
      },
    });

    registry.register({
      id: 'write1',
      name: 'write1',
      kind: 'native',
      description: 'write1',
      schema: { name: 'write1', description: 'w1', parameters: [] },
      isReadOnly: false,
      execute: async (req) => {
        executionOrder.push(`start:${req.name}`);
        executionOrder.push(`end:${req.name}`);
        return { callId: req.callId, name: req.name, output: 'w1-done', durationMs: 5, truncated: false, rawTokensEstimate: 2 };
      },
    });

    const dispatcher = new ToolDispatcher(registry);
    const context: CapabilityContext = {
      cwd: process.cwd(),
      workspace: new Workspace(process.cwd(), '.mochi'),
      config: {} as any,
      events: new EventBus(),
      agentId: 'test-agent',
      log: () => {},
    };

    const results = await dispatcher.dispatchBatch([
      { id: 'c1', name: 'read1', arguments: {} },
      { id: 'c2', name: 'read2', arguments: {} },
      { id: 'c3', name: 'write1', arguments: {} },
    ], context);

    expect(results.length).toBe(3);
    expect(results[0].output).toBe('r1-done');
    expect(results[1].output).toBe('r2-done');
    expect(results[2].output).toBe('w1-done');

    // Both reads started before the reads ended (parallel)
    expect(executionOrder.indexOf('start:read1')).toBeLessThan(executionOrder.indexOf('end:read2'));
  });
});
