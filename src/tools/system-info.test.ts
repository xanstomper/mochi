import { describe, it, expect } from 'vitest';
import { systemInfoTool } from './system-info.js';
import { Workspace } from '../workspace.js';
import { EventBus } from '../events.js';
import type { ToolContext } from './types.js';
import type { MochiConfig } from '../types.js';

describe('system-info tool', () => {
  it('reports OS, memory, and runtime toolchain versions', async () => {
    const ctx: ToolContext = {
      cwd: process.cwd(),
      workspace: new Workspace(process.cwd()),
      config: {} as MochiConfig,
      events: new EventBus(),
      agentId: 'test',
    };

    const res = await systemInfoTool.execute({}, ctx);
    expect(res).toContain('System & Runtime Environment');
    expect(res).toContain('OS Platform:');
    expect(res).toContain('Node.js:');
  });
});
