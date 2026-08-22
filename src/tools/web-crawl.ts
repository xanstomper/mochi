import type { Tool } from './types.js';

// Web crawler: fetch a seed URL, extract links, and follow them breadth-first
// up to a page budget/depth. Returns readable text (tags stripped) per page
// with same-URL and off-seed-host filtering so the model gets a coherent
// research corpus instead of one giant HTML blob.

const MAX_PAGES = 12;
const MAX_PAGE_BYTES = 24 * 1024;
const FETCH_TIMEOUT_MS = 12_000;

interface CrawledPage {
  url: string;
  status: number;
  text: string;
}

function normalizeUrl(raw: string, base?: string): string | null {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    // Drop common non-content assets.
    if (/\.(png|jpe?g|gif|svg|ico|css|js|mjs|zip|tar|gz|pdf|mp4|webm|woff2?)$/i.test(u.pathname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const u = normalizeUrl(m[1], baseUrl);
    if (u) out.push(u);
  }
  return out;
}

/** Very small HTML-to-text: drop script/style/head noise, tags, entities. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

async function fetchPage(url: string): Promise<{ status: number; html: string; finalUrl: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 MochiCrawler/1.0',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    const html = await res.text();
    return { status: res.status, html, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

export const webCrawlTool: Tool = {
  def: {
    name: 'web_crawl',
    description:
      'Crawl a website for research: fetch the seed page, extract its links, and follow them (breadth-first) up to a page budget. Returns readable text per page. Use for documentation sites, wikis, blogs, and API references. For a single URL use fetch; for search use web_search.',
    parameters: [
      { name: 'url', type: 'string', description: 'Seed URL to start crawling from', required: true },
      { name: 'max_pages', type: 'number', description: `Maximum pages to fetch (default 5, max ${MAX_PAGES})`, required: false },
      { name: 'depth', type: 'number', description: 'Link-follow depth from the seed (default 1, max 2)', required: false },
      { name: 'include_pattern', type: 'string', description: 'Optional regex; only crawl URLs whose path matches (e.g. "docs/")', required: false },
      { name: 'same_host', type: 'boolean', description: 'Only crawl URLs on the seed page hostname (default true)', required: false },
    ],
    permission: 'network',
  },
  async execute(args) {
    const seed = normalizeUrl(String(args.url ?? ''));
    if (!seed) return 'Error: a valid http(s) URL is required.';
    const maxPages = Math.min(MAX_PAGES, Math.max(1, Number(args.max_pages ?? 5)));
    const maxDepth = Math.min(2, Math.max(1, Number(args.depth ?? 1)));
    const sameHost = args.same_host === undefined ? true : Boolean(args.same_host);
    let pattern: RegExp | null = null;
    if (args.include_pattern) {
      try { pattern = new RegExp(String(args.include_pattern), 'i'); } catch { return 'Error: include_pattern is not a valid regex.'; }
    }

    const seedHost = new URL(seed).host;
    const seen = new Set<string>([seed]);
    const queue: Array<{ url: string; depth: number }> = [{ url: seed, depth: 0 }];
    const pages: CrawledPage[] = [];

    while (queue.length > 0 && pages.length < maxPages) {
      const { url, depth } = queue.shift()!;
      let fetched: Awaited<ReturnType<typeof fetchPage>>;
      try {
        fetched = await fetchPage(url);
      } catch (err) {
        pages.push({ url, status: 0, text: `(fetch failed: ${err instanceof Error ? err.message : String(err)})` });
        continue;
      }
      const isHtml = /html/i.test(fetched.html.slice(0, 500)) || fetched.html.includes('<');
      const text = isHtml ? htmlToText(fetched.html) : fetched.html;
      pages.push({ url, status: fetched.status, text: text.length > MAX_PAGE_BYTES ? text.slice(0, MAX_PAGE_BYTES) + '\n...[truncated]' : text });

      if (depth < maxDepth && pages.length < maxPages) {
        for (const link of extractLinks(fetched.html, fetched.finalUrl)) {
          if (seen.has(link) || queue.some((q) => q.url === link)) continue;
          if (sameHost && new URL(link).host !== seedHost) continue;
          if (pattern && !pattern.test(new URL(link).pathname + new URL(link).search)) continue;
          seen.add(link);
          queue.push({ url: link, depth: depth + 1 });
          if (pages.length + queue.length >= maxPages) break;
        }
      }
    }

    const parts = pages.map((p) => `## ${p.url} (HTTP ${p.status})\n${p.text || '(empty)'}`);
    const header = `Crawled ${pages.length} page(s) from ${seed} (depth<=${maxDepth}${sameHost ? ', same host' : ''}${pattern ? `, pattern ${pattern}` : ''}).\n\n`;
    return header + parts.join('\n\n---\n\n');
  },
};
