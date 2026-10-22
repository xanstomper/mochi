import { describe, it, expect } from 'vitest';
import { subagentTool } from './subagent.js';
import { collectAgentTool, cancelAgentTool, reviewFleetTool } from './agent-fleet.js';
import type { ToolContext } from './types.js';

function ctx(overrides: Partial<ToolContext>): ToolContext {
  return {
    cwd: '/tmp',
    workspace: {} as never,
    config: {} as never,
    events: {} as never,
    agentId: 't',
    ...overrides,
  };
}

describe('subagent tool background mode', () => {
  it('background=true returns the handle immediately via spawnAgentAsync', async () => {
    let seen: unknown;
    const result = await subagentTool.execute(
      { prompt: 'Research the caching layer', preset: 'researcher', background: true },
      ctx({
        spawnAgentAsync: async (spec) => {
          seen = spec;
          return { id: 'sub-abc123', status: 'running', note: 'Running in the background.' };
        },
      }),
    );
    expect(result).toContain('sub-abc123');
    expect(result).toContain('collect_agent');
    expect(seen).toMatchObject({ prompt: 'Research the caching layer', preset: 'researcher' });
  });

  it('background=true without an async spawner degrades to a clear message', async () => {
    const result = await subagentTool.execute(
      { prompt: 'x', background: true },
      ctx({ spawnSubagent: async () => 'sync result' }),
    );
    expect(result).toContain('not available');
  });

  it('sync calls pass preset through to the spawner', async () => {
    let seen: { preset?: string } | undefined;
    const result = await subagentTool.execute(
      { prompt: 'Write tests for parser', preset: 'tester' },
      ctx({
        spawnSubagent: async (_prompt, opts) => {
          seen = opts;
          return 'done';
        },
      }),
    );
    expect(result).toContain('Subagent result:');
    expect(seen?.preset).toBe('tester');
  });
});

describe('collect_agent / cancel_agent / review_fleet tools', () => {
  it('collect_agent forwards id + waitMs + apply', async () => {
    let seen: unknown;
    const out = await collectAgentTool.execute(
      { id: 'sub-1', waitMs: 5000, apply: true },
      ctx({
        collectAgent: async (id, opts) => {
          seen = { id, opts };
          return 'digest';
        },
      }),
    );
    expect(out).toBe('digest');
    expect(seen).toEqual({ id: 'sub-1', opts: { waitMs: 5000, apply: true } });
  });

  it('collect_agent requires an id', async () => {
    await expect(collectAgentTool.execute({}, ctx({}))).rejects.toThrow('requires the subagent id');
  });

  it('cancel_agent forwards the id and degrades without a runtime', async () => {
    const out = await cancelAgentTool.execute(
      { id: 'sub-9' },
      ctx({ cancelAgent: async (id) => `cancelled ${id}` }),
    );
    expect(out).toBe('cancelled sub-9');
    const degraded = await cancelAgentTool.execute({ id: 'sub-9' }, ctx({}));
    expect(degraded).toContain('not available');
  });

  it('review_fleet parses JSON-string lenses and forwards them', async () => {
    let seen: unknown;
    const out = await reviewFleetTool.execute(
      { target: 'working', lenses: '["correctness","security"]', instructions: 'Focus on auth' },
      ctx({
        reviewFleet: async (spec) => {
          seen = spec;
          return 'fleet report';
        },
      }),
    );
    expect(out).toBe('fleet report');
    expect(seen).toEqual({ target: 'working', lenses: ['correctness', 'security'], instructions: 'Focus on auth' });
  });

  it('review_fleet degrades without a runtime', async () => {
    const out = await reviewFleetTool.execute({}, ctx({}));
    expect(out).toContain('not available');
  });
});
