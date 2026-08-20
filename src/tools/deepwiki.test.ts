import { describe, it, expect, vi, afterEach } from 'vitest';
import { deepwikiTool } from './deepwiki.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

function makeCtx(cwd: string) {
  return { cwd, workspace: new Workspace(cwd, '.mochi'), events: new EventBus(), config: { permissions: { network: true }, safety: { mode: 'auto' } } as any, agentId: 'test' };
}

const MOCK_SUMMARY = {
  title: 'TypeScript',
  extract: 'TypeScript is a strongly typed programming language that builds on JavaScript.',
};

describe('deepwikiTool', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('returns article title and extract from Wikipedia summary endpoint', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-wiki-'));
    const ctx = makeCtx(dir);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => MOCK_SUMMARY,
    }));
    const result = await deepwikiTool.execute({ query: 'TypeScript' }, ctx);
    expect(result).toContain('TypeScript');
    expect(result).toContain('strongly typed');
  });

  it('falls back to search API when summary endpoint fails', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-wiki-'));
    const ctx = makeCtx(dir);
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: { search: [{ title: 'TypeScript language', snippet: 'A typed superset of JavaScript.' }] },
        }),
      });
    vi.stubGlobal('fetch', mockFetch);
    const result = await deepwikiTool.execute({ query: 'TypeScript' }, ctx);
    expect(result).toContain('TypeScript language');
    expect(result).toContain('typed superset');
  });
});
