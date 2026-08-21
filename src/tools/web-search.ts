import type { Tool } from './types.js';

export const webSearchTool: Tool = {
  def: {
    name: 'web_search',
    description: 'Search the public web for documentation, library APIs, error messages, CVEs, or open-source patterns. Returns relevant titles, snippets, and source URLs.',
    parameters: [
      { name: 'query', type: 'string', description: 'The search query or keywords', required: true },
      { name: 'domain', type: 'string', description: 'Optional domain to restrict results to (e.g. "github.com", "docs.rs", "developer.mozilla.org")', required: false },
      { name: 'max_results', type: 'number', description: 'Maximum number of results to return (default: 5, max: 10)', required: false },
    ],
    permission: 'network',
  },
  async execute(args, ctx) {
    const rawQuery = String(args.query ?? '').trim();
    if (!rawQuery) return 'Error: search query cannot be empty.';

    const domain = args.domain ? String(args.domain).trim() : '';
    const maxResults = Math.min(10, Math.max(1, Number(args.max_results ?? 5)));
    const finalQuery = domain ? `${rawQuery} site:${domain}` : rawQuery;

    ctx.events.emit({
      type: 'tool:called',
      tool: 'web_search',
      args: { query: finalQuery, max_results: maxResults },
      agentId: ctx.agentId,
    });

    try {
      // 1. Fetch via DuckDuckGo Lite HTML interface (clean, zero-dependency, fast)
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(finalQuery)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html',
        },
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        return `Web search failed with HTTP status ${resp.status}. Try refining query or fetching direct URL with \`fetch\`.`;
      }

      const html = await resp.text();
      const results: Array<{ title: string; link: string; snippet: string }> = [];

      // Parse DuckDuckGo search result blocks
      const resultBlocks = html.split('<div class="result results_links');
      for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
        const block = resultBlocks[i];
        
        // Extract title & link
        const titleMatch = block.match(/<a class="result__url"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/) ||
                           block.match(/<a class="result__snippet"[^>]*href="([^"]+)"[^>]*>/) ||
                           block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        
        const snippetMatch = block.match(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/) ||
                             block.match(/<div class="result__snippet"[^>]*>([\s\S]*?)<\/div>/);

        if (titleMatch) {
          let link = titleMatch[1];
          // DuckDuckGo redirects through /l/?kh=-1&uddg=...
          const uddg = link.match(/uddg=([^&]+)/);
          if (uddg) {
            link = decodeURIComponent(uddg[1]);
          }

          const rawTitle = (titleMatch[2] || '').replace(/<[^>]+>/g, '').trim();
          const rawSnippet = (snippetMatch ? snippetMatch[1] : '').replace(/<[^>]+>/g, '').trim();

          if (link.startsWith('http') && (rawTitle || rawSnippet)) {
            results.push({
              title: rawTitle || link,
              link,
              snippet: rawSnippet,
            });
          }
        }
      }

      if (results.length === 0) {
        return `No web results found for query: "${finalQuery}".`;
      }

      const formatted = results.map((r, idx) => {
        return `### ${idx + 1}. [${r.title}](${r.link})\n**URL:** ${r.link}\n${r.snippet}\n`;
      }).join('\n');

      return `# Web Search Results: "${finalQuery}"\n\n${formatted}`;
    } catch (err) {
      return `Web search error: ${err instanceof Error ? err.message : String(err)}. You can also fetch specific URLs using the \`fetch\` tool.`;
    }
  },
};
