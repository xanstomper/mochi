import { describe, it, expect } from 'vitest';
import { thinkTool } from './think.js';
import { EventBus } from '../events.js';
import type { ToolContext } from './types.js';

function ctx(bus?: EventBus): ToolContext {
  return {
    cwd: '/tmp',
    workspace: { dir: '/tmp', root: '/' } as any,
    config: {} as any,
    events: (bus ?? new EventBus()) as never,
    agentId: 'test',
  };
}

describe('think tool', () => {
  it('records a reasoning note as a system message and acks', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('message', (e: any) => seen.push(e.content));
    const out = await thinkTool.execute({ thought: 'Consider using the sqlite adapter.' }, ctx(bus));
    expect(out).toContain('acknowledged');
    expect(seen).toContain('[think] Consider using the sqlite adapter.');
  });

  it('rejects an empty thought gracefully', async () => {
    expect(await thinkTool.execute({ thought: '   ' }, ctx())).toContain('Nothing recorded');
  });
});