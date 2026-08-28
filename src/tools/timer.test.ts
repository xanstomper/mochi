import { describe, it, expect } from 'vitest';
import { timerTool } from './timer.js';

const ctx = { cwd: '/tmp', workspace: {} as any, config: {} as any, events: {} as any, agentId: 'test' };

describe('timer tool', () => {
  it('starts and stops a timer', async () => {
    await timerTool.execute({ action: 'start', name: 'test-timer' }, ctx);
    const result = await timerTool.execute({ action: 'stop', name: 'test-timer' }, ctx);
    expect(result).toContain('stopped');
    expect(result).toContain('ms');
  });

  it('lists active timers', async () => {
    await timerTool.execute({ action: 'start', name: 'my-timer' }, ctx);
    const result = await timerTool.execute({ action: 'list' }, ctx);
    expect(result).toContain('my-timer');
  });

  it('resets a timer', async () => {
    await timerTool.execute({ action: 'start', name: 'reset-me' }, ctx);
    const result = await timerTool.execute({ action: 'reset', name: 'reset-me' }, ctx);
    expect(result).toContain('reset');
  });

  it('throws for unknown action', async () => {
    await expect(timerTool.execute({ action: 'fly', name: 'x' }, ctx)).rejects.toThrow();
  });
});
