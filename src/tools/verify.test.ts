import { describe, it, expect } from 'vitest';
import { verifyTool } from './verify.js';
import type { ToolContext, MochiConfig } from '../types.js';

describe('verify tool', () => {
  function ctx(cwd: string): ToolContext {
    return {
      cwd,
      workspace: { dir: cwd, root: cwd } as any,
      config: {} as MochiConfig,
      events: {} as any,
      agentId: 'test',
    };
  }

  it('runs a test command and reports success', async () => {
    const dir = '/tmp';
    const out = await verifyTool.execute({ command: 'echo ok' }, ctx(dir));
    expect(out).toContain('PASSED');
  });
});
