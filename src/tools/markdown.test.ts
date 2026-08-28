import { describe, it, expect } from 'vitest';
import { markdownTool } from './markdown.js';

const ctx = { cwd: '/tmp', workspace: {} as any, config: {} as any, events: {} as any, agentId: 'test' };

describe('markdown tool', () => {
  it('renders markdown to ANSI', async () => {
    const result = await markdownTool.execute({ action: 'render', content: '# Title\n**bold** text' }, ctx);
    expect(result).toContain('Title');
    expect(result).toContain('bold');
  });

  it('extracts table of contents', async () => {
    const md = '# Section One\n## Section Two\n### Section Three';
    const result = await markdownTool.execute({ action: 'toc', content: md }, ctx);
    expect(result).toContain('Section One');
    expect(result).toContain('Section Two');
  });

  it('extracts links', async () => {
    const md = 'See [GitHub](https://github.com) and [Docs](https://docs.example.com)';
    const result = await markdownTool.execute({ action: 'links', content: md }, ctx);
    expect(result).toContain('GitHub');
    expect(result).toContain('https://github.com');
  });

  it('validates markdown structure', async () => {
    const result = await markdownTool.execute({ action: 'validate', content: '# Good markdown\n\nParagraph text.' }, ctx);
    expect(result).toContain('valid');
  });

  it('throws for missing content and file', async () => {
    await expect(markdownTool.execute({ action: 'render' }, ctx)).rejects.toThrow();
  });
});
