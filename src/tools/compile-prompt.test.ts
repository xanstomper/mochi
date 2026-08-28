import { describe, it, expect } from 'vitest';
import { compilePromptTool } from './compile-prompt.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';

describe('compile_prompt tool', () => {
  it('executes compile_prompt and returns full blueprint markdown', async () => {
    const events = new EventBus();
    const ctx = {
      cwd: process.cwd(),
      workspace: new Workspace(process.cwd()),
      config: { model: { provider: 'test', model: 'test' } } as any,
      events,
      agentId: 'test-agent',
    };

    const result = await compilePromptTool.execute({ prompt: 'fix authentication jwt expiry bug' }, ctx);

    expect(result).toContain('# MOCHI MASTER EXECUTION BLUEPRINT');
    expect(result).toContain('Phase 0');
    expect(result).toContain('Phase 3');
    expect(result).toContain('Anti-Loop');
  });

  it('throws when prompt parameter is empty', async () => {
    const events = new EventBus();
    const ctx = {
      cwd: process.cwd(),
      workspace: new Workspace(process.cwd()),
      config: { model: { provider: 'test', model: 'test' } } as any,
      events,
      agentId: 'test-agent',
    };

    await expect(compilePromptTool.execute({ prompt: '' }, ctx)).rejects.toThrow('prompt parameter is required');
  });
});
