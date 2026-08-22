import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { webCrawlTool } from './web-crawl.js';

// Local site: seed page linking to 3 children; one child links deeper.
function startSite() {
  const pages: Record<string, string> = {
    '/': `<html><body><h1>Docs Home</h1><a href="/guide">Guide</a> <a href="/api">API</a> <a href="https://elsewhere.example/x">Off-site</a></body></html>`,
    '/guide': `<html><body><h1>Guide</h1><p>Step one.</p><a href="/guide/advanced">Advanced</a></body></html>`,
    '/api': `<html><body><h1>API</h1><script>evil()</script><p>POST /foo returns bar.</p></body></html>`,
    '/guide/advanced': `<html><body><h1>Advanced</h1><p>Deep page.</p></body></html>`,
    '/assets/app.js': `console.log('not content')`,
  };
  const server = http.createServer((req, res) => {
    const body = pages[req.url ?? '/'] ?? '<html><body>404</body></html>';
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, () => resolve({ port: (server.address() as any).port, close: () => new Promise<void>((r) => server.close(() => r())) }));
  });
}

describe('web_crawl', () => {
  let site: Awaited<ReturnType<typeof startSite>> | null = null;
  afterEach(async () => { if (site) await site.close(); site = null; });

  it('crawls the seed and same-host links, returning readable text', async () => {
    site = await startSite();
    const out = await webCrawlTool.execute({ url: `http://localhost:${site.port}/`, max_pages: 3, depth: 1 }, {} as any);
    expect(out).toContain('Docs Home');
    expect(out).toContain('Guide');
    // Followed same-host links.
    expect(out).toContain(`http://localhost:${site.port}/guide`);
    // Off-site link NOT crawled.
    expect(out).not.toContain('elsewhere.example/x');
    // Script content stripped.
    expect(out).not.toContain('evil()');
    // Readable text preserved.
    expect(out).toContain('POST /foo returns bar.');
  });

  it('depth=1 follows only direct links of the seed (not links-of-links)', async () => {
    site = await startSite();
    // Seed /guide links to /guide/advanced only. Crawl seed only (depth 1):
    // /guide/advanced is a direct child so it IS included, but nothing deeper.
    const out = await webCrawlTool.execute({ url: `http://localhost:${site.port}/guide`, max_pages: 5, depth: 1 }, {} as any);
    expect(out).toContain('Advanced');
    // From the site root with depth 1: /guide and /api are direct children,
    // /guide/advanced (child of /guide) is NOT fetched.
    const out2 = await webCrawlTool.execute({ url: `http://localhost:${site.port}/`, max_pages: 2, depth: 1 }, {} as any);
    expect(out2).toContain('Guide');
    expect(out2).not.toContain('Deep page.');
  });

  it('rejects invalid urls and bad patterns', async () => {
    const bad = await webCrawlTool.execute({ url: 'not-a-url' }, {} as any);
    expect(bad).toContain('Error');
    const badRe = await webCrawlTool.execute({ url: 'https://example.com', include_pattern: '(' }, {} as any);
    expect(badRe).toContain('Error');
  });
});
