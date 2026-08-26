import { describe, it, expect, vi, afterEach } from 'vitest';
import { wikiSummary } from './wiki.js';

const TOOL_OPTS = {
  userAgent: 'mochi-agent/1.0',
  searchTag: ' (search result)',
  emptyMessage: (q: string) => `No Wikipedia article found for: "${q}"`,
  strict: true,
};
const SERVER_OPTS = {
  userAgent: 'mochi-deepwiki-mcp/1.0',
  searchTag: ' (search)',
  emptyMessage: (q: string) => `No result found for: ${q}`,
  strict: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string) => any) {
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(impl(String(url)))));
}

describe('wikiSummary (shared lookup)', () => {
  it('returns the REST summary markdown and passes the User-Agent', async () => {
    let sawUrl = '';
    stubFetch((url) => {
      sawUrl = url;
      return { ok: true, json: async () => ({ title: 'TypeScript', extract: 'A typed language.' }) };
    });
    const { markdown, source } = await wikiSummary('TypeScript', 'en', TOOL_OPTS);
    expect(source).toBe('summary');
    expect(markdown).toBe('**TypeScript**\n\nA typed language.');
    expect(sawUrl).toContain('page/summary/TypeScript');
  });

  it('truncates the extract to 2000 chars', async () => {
    stubFetch(() => ({ ok: true, json: async () => ({ title: 'X', extract: 'a'.repeat(5000) }) }));
    const { markdown } = await wikiSummary('X', 'en', TOOL_OPTS);
    expect(markdown.length).toBeLessThanOrEqual(2000 + '**X**\n\n'.length);
  });

  it('falls back to the search API when the summary 404s, tagging the title', async () => {
    const calls: string[] = [];
    stubFetch((url) => {
      calls.push(url);
      if (url.includes('page/summary')) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ query: { search: [{ title: 'TS lang', snippet: '<b>typed</b> code' }] } }) };
    });
    const { markdown, source } = await wikiSummary('TypeScript', 'en', TOOL_OPTS);
    expect(source).toBe('search');
    expect(markdown).toBe('**TS lang** (search result)\n\ntyped code');
    expect(calls).toHaveLength(2);
  });

  it('server tags search fallbacks with "(search)" not "(search result)"', async () => {
    stubFetch((url) => {
      if (url.includes('page/summary')) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ query: { search: [{ title: 'TS', snippet: 'hi' }] } }) };
    });
    const { markdown } = await wikiSummary('TypeScript', 'en', SERVER_OPTS);
    expect(markdown).toContain('**TS** (search)');
  });

  it('returns the graceful empty message (non-strict) when nothing resolves', async () => {
    stubFetch((url) => {
      if (url.includes('page/summary')) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ query: { search: [] } }) };
    });
    const { markdown, source } = await wikiSummary('zzz', 'en', SERVER_OPTS);
    expect(source).toBe('empty');
    expect(markdown).toBe('No result found for: zzz');
  });

  it('strict returns the tool-styled empty message', async () => {
    stubFetch((url) => {
      if (url.includes('page/summary')) return { ok: false, status: 404 };
      return { ok: true, json: async () => ({ query: { search: [] } }) };
    });
    const { markdown } = await wikiSummary('zzz', 'en', TOOL_OPTS);
    expect(markdown).toBe('No Wikipedia article found for: "zzz"');
  });

  it('strict throws on a hard search-API failure', async () => {
    stubFetch((url) => {
      if (url.includes('page/summary')) return { ok: false, status: 404 };
      return { ok: false, status: 500 };
    });
    await expect(wikiSummary('x', 'en', TOOL_OPTS)).rejects.toThrow('Wikipedia search failed: HTTP 500');
  });

  it('non-strict does NOT throw on a hard search-API failure', async () => {
    stubFetch((url) => {
      if (url.includes('page/summary')) return { ok: false, status: 404 };
      return { ok: false, status: 500 };
    });
    const { source } = await wikiSummary('x', 'en', SERVER_OPTS);
    expect(source).toBe('empty');
  });

  it('falls back to the default language for a purely-invalid lang', async () => {
    let sawUrl = '';
    stubFetch((url) => {
      sawUrl = url;
      return { ok: false, status: 404 };
    });
    await wikiSummary('x', '123', SERVER_OPTS);
    expect(sawUrl).toContain('https://en.wikipedia.org');
  });

  it('strips dangerous path-injection characters from the language code', async () => {
    let sawUrls: string[] = [];
    stubFetch((url) => {
      sawUrls.push(url);
      return { ok: false, status: 404 };
    });
    // `:` `/` `.` would otherwise allow scheme/host injection into the URL
    // template `https://${lang}.wikipedia.org/...`; they must be removed.
    await wikiSummary('x', 'en://evil.com', SERVER_OPTS);
    expect(sawUrls[0]).toMatch(/^https:\/\/[a-z-]+\.wikipedia\.org/);
    expect(sawUrls[0]).not.toContain('://evil');
  });
});