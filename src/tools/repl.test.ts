import { describe, it, expect } from 'vitest';
import { replTool } from './repl.js';
import type { ToolContext } from './types.js';

describe('repl tool', () => {
  const ctx: ToolContext = { cwd: process.cwd(), workspace: {} as any, config: {} as any, events: {} as any, agentId: 'test' };

  it('evaluates JavaScript expressions and logs', async () => {
    const res = await replTool.execute({ code: 'console.log("hello repl"); 2 + 3' }, ctx);
    expect(res).toContain('hello repl');
    expect(res).toContain('=> 5');
  });

  it('preserves state across executions unless reset', async () => {
    await replTool.execute({ code: 'globalThis.x = 42;' }, ctx);
    const res = await replTool.execute({ code: 'globalThis.x * 2' }, ctx);
    expect(res).toContain('=> 84');
  });

  it('catches execution errors gracefully', async () => {
    const res = await replTool.execute({ code: 'throw new Error("test failure")' }, ctx);
    expect(res).toContain('[REPL ERROR]');
    expect(res).toContain('test failure');
  });
});
