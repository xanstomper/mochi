import { describe, it, expect } from 'vitest';
import { subagentTool } from './subagent.js';
import type { ToolContext } from './types.js';

// The subagent tool is a thin, dependency-free delegation primitive: it passes
// the prompt (and optional role) to the injected spawner and returns whatever
// the child agent produced. These tests verify that contract end to end: the
// input is forwarded, the child's result is surfaced, validation rejects empty
// prompts, and a missing spawner degrades to a clear message instead of throwing.

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

describe('subagent tool', () => {
  it('forwards the prompt to the spawner and returns the result', async () => {
    const seen: string[] = [];
    const result = await subagentTool.execute(
      { prompt: 'Refactor the parser module', role: 'reviewer' },
      ctx({
        spawnSubagent: async (prompt, opts) => {
          seen.push(prompt);
          return `reviewed; success; ${opts?.role}`;
        },
      }),
    );
    expect(seen).toEqual(['Refactor the parser module']);
    expect(result).toContain('reviewed');
    expect(result).toContain('reviewer');
  });

  it('rejects an empty prompt', async () => {
    await expect(
      subagentTool.execute({ prompt: '   ' }, ctx({})),
    ).rejects.toThrow('non-empty prompt');
  });

  it('reports cleanly when no spawner is injected', async () => {
    const result = await subagentTool.execute({ prompt: 'do x' }, ctx({}));
    expect(result).toContain('not available');
  });

  it('surfaces child failures as errors', async () => {
    await expect(
      subagentTool.execute(
        { prompt: 'x' },
        ctx({
          spawnSubagent: async () => {
            throw new Error('child blew up');
          },
        }),
      ),
    ).rejects.toThrow('child blew up');
  });

  it('handles batch concurrent subagents with spawnSubagents', async () => {
    const tasks = [
      { prompt: 'Research indexing strategies', role: 'researcher' },
      { prompt: 'Write unit test', role: 'tester' },
    ];
    const result = await subagentTool.execute(
      { tasks },
      ctx({
        spawnSubagents: async (items) => {
          return items.map((t, idx) => `[Subagent #${idx + 1} (${t.role})]: completed subtask for ${t.prompt}`);
        },
      }),
    );
    expect(result).toContain('Concurrent subagents (2 agents)');
    expect(result).toContain('researcher');
    expect(result).toContain('tester');
    expect(result).toContain('Research indexing strategies');
  });

  it('handles batch concurrent subagents with JSON string tasks fallback', async () => {
    const tasksJson = JSON.stringify([
      { prompt: 'Security audit auth.ts', role: 'security' },
      { prompt: 'Check DB migration', role: 'db_admin' },
    ]);
    const result = await subagentTool.execute(
      { tasks: tasksJson },
      ctx({
        spawnSubagent: async (prompt, opts) => {
          return `done: ${prompt} (${opts?.role})`;
        },
      }),
    );
    expect(result).toContain('Concurrent subagents (2 agents)');
    expect(result).toContain('security');
    expect(result).toContain('db_admin');
  });

  it('passes scratchpad and timeoutMs to spawnSubagent', async () => {
    let capturedOpts: { role?: string; timeoutMs?: number; scratchpad?: string } | undefined;
    const result = await subagentTool.execute(
      { prompt: 'Optimize query', role: 'db_admin', scratchpad: 'DB is postgres 15', timeoutMs: 5000 },
      ctx({
        spawnSubagent: async (prompt, opts) => {
          capturedOpts = opts;
          return `optimized: ${prompt}`;
        },
      }),
    );
    expect(result).toContain('Subagent result:');
    expect(capturedOpts?.role).toBe('db_admin');
    expect(capturedOpts?.scratchpad).toBe('DB is postgres 15');
    expect(capturedOpts?.timeoutMs).toBe(5000);
  });
});