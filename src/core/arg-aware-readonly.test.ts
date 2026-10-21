// B27 restructure: arg-aware capability classification. The static
// isReadOnly downgrade (fetch/verify removed from READ_ONLY_TOOLS) kept ALL
// their calls sequential — sound but over-broad: GET/HEAD fetch is a read.
// toolToCapability now supplies an isReadOnlyForArgs predicate (fetch only;
// verify deliberately has none — classifyCommand is too coarse to soundly
// admit shell commands) and the dispatcher admits arg-verified reads into
// the concurrent batch while mutating calls stay sequential.
import { describe, it, expect } from 'vitest';
import { createDefaultCapabilityRegistry, toolToCapability } from './capability-registry.js';
import { ToolDispatcher } from './tool-dispatcher.js';
import type { CapabilityContext } from './capability.js';

function fakeContext(): CapabilityContext {
  return { cwd: '/tmp', events: undefined, config: {} } as unknown as CapabilityContext;
}

describe('arg-aware capability read-only classification (B27 restructure)', () => {
  it('fetch capability: GET read-only for args, POST not', () => {
    const cap = toolToCapability({ def: { name: 'fetch', description: 'x', parameters: [] } } as never);
    expect(cap.isReadOnly).toBe(false); // static flag stays conservative
    expect(cap.isReadOnlyForArgs?.({ url: 'https://x' })).toBe(true);
    expect(cap.isReadOnlyForArgs?.({ url: 'https://x', method: 'GET' })).toBe(true);
    expect(cap.isReadOnlyForArgs?.({ url: 'https://x', method: 'HEAD' })).toBe(true);
    expect(cap.isReadOnlyForArgs?.({ url: 'https://x', method: 'POST' })).toBe(false);
    expect(cap.isReadOnlyForArgs?.({ url: 'https://x', method: ['POST'] })).toBe(false); // coercion-divergence safe
  });

  // Note: 'verify' has NO isReadOnlyForArgs predicate — on main's registry it
  // is statically read-only, and its sequential-batch fate is decided by the
  // capability-registry PR (#22), not here. classifyCommand() is too coarse
  // (builds/tests classify 'low') to soundly admit shell commands by args.

  it('dispatcher admits GET fetch to the concurrent read batch; POST runs after it', async () => {
    // Ordering discriminator via a recording wrapper around the real registry.
    // Batch: [POST fetch, GET fetch, read]. With the restructure, the
    // dispatcher's read-only phase runs FIRST (GET + read concurrently), so
    // the POST starts only after both reads completed. The pre-restructure
    // code classified everything by the static flag → strict FIFO sequential:
    // the POST (calls[0]) would start first.
    const real = createDefaultCapabilityRegistry();
    const starts: string[] = [];
    const wrapped = {
      get: (name: string) => real.get(name),
      execute: async (name: string, args: unknown, ctx: CapabilityContext, id?: string) => {
        starts.push(`${name}:${(args as { method?: string }).method ?? ''}`);
        return real.execute(name, args as Record<string, unknown>, ctx, id);
      },
    } as unknown as typeof real;
    const dispatcher = new ToolDispatcher(wrapped);
    const ctx = fakeContext();

    const results = await dispatcher.dispatchBatch(
      [
        { id: 'p1', name: 'fetch', arguments: { url: 'http://127.0.0.1:9/slow', method: 'POST', body: 'x', allow_private: true } },
        { id: 'r1', name: 'fetch', arguments: { url: 'http://127.0.0.1:9/fast', method: 'GET', allow_private: true } },
        { id: 'r2', name: 'read', arguments: { path: '/tmp/does-not-exist-b27' } },
      ],
      ctx,
    );

    expect(results).toHaveLength(3);
    // POST (a mutating call) must START last: both reads ran in the
    // concurrent phase ahead of it.
    expect(starts[starts.length - 1]).toContain('POST');
    expect(starts.filter((s) => s !== starts[starts.length - 1])).toHaveLength(2);
  });
});
