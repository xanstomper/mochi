import { describe, it, expect } from 'vitest';
import { tuiBuilderTool } from './tui-builder.js';

const ctx = { cwd: '/tmp', workspace: {} as any, config: {} as any, events: {} as any, agentId: 'test' };

describe('tui_builder tool', () => {
  it('renders a progress bar', async () => {
    const result = await tuiBuilderTool.execute({ component: 'progress-bar', options: { current: 70, total: 100, label: 'Loading' } }, ctx);
    expect(result).toContain('70%');
    expect(result).toContain('Loading');
  });

  it('renders a table', async () => {
    const result = await tuiBuilderTool.execute({
      component: 'table',
      options: { headers: ['Name', 'Value'], rows: [['foo', '42'], ['bar', '99']] }
    }, ctx);
    expect(result).toContain('Name');
    expect(result).toContain('foo');
  });

  it('renders a box', async () => {
    const result = await tuiBuilderTool.execute({ component: 'box', options: { content: 'Hello', title: 'Test' } }, ctx);
    expect(result).toContain('Hello');
  });

  it('renders a banner', async () => {
    const result = await tuiBuilderTool.execute({ component: 'banner', options: { text: 'MOCHI' } }, ctx);
    expect(result).toContain('MOCHI');
  });

  it('throws for unknown component', async () => {
    await expect(tuiBuilderTool.execute({ component: 'unknown' }, ctx)).rejects.toThrow();
  });
});
