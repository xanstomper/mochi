import { describe, it, expect } from 'vitest';
import { perfTool } from './perf-tool.js';
import type { ToolContext, MochiConfig } from '../types.js';

describe('perf tool', () => {
  const cfg: MochiConfig = {
    safety: { mode: 'ask', maxIterations: 10, maxRuntimeMinutes: 60, contextBudgetTokens: 10000, commandTimeoutSeconds: 120, maxConcurrentAgents: 3 },
  } as MochiConfig;

  function ctx(cwd: string): ToolContext {
    return {
      cwd,
      workspace: { dir: cwd, root: cwd } as any,
      config: cfg,
      events: {} as any,
      agentId: 'test',
    };
  }

  it('reports performance stats', async () => {
    const out = await perfTool.execute({ action: 'stats' }, ctx('/tmp'));
    expect(out).toContain('Performance Stats');
  });

  it('measures a command', async () => {
    const out = await perfTool.execute({ action: 'measure', command: 'echo test' }, ctx('/tmp'));
    expect(out).toContain('Duration');
  });
});
