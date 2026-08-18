import { describe, it, expect } from 'vitest';
import { chameleonTool } from './chameleon.js';

describe('chameleon tool definition', () => {
  it('exposes a valid OpenAI-style tool schema', () => {
    expect(chameleonTool.def.name).toBe('chameleon');
    expect(chameleonTool.def.permission).toBe('network');
    const task = chameleonTool.def.parameters.find((p) => p.name === 'task');
    expect(task).toBeDefined();
    expect(task?.required).toBe(true);
  });

  it('rejects missing task at execution', async () => {
    const ctx: any = { cwd: process.cwd(), config: { safety: { mode: 'auto' } } };
    await expect(chameleonTool.execute({ task: '   ' }, ctx)).rejects.toThrow(/requires a task/);
  });
});