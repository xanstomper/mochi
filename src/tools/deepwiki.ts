import type { Tool } from './types.js';

const WIKI_BASE = 'https://{lang}.wikipedia.org';

async function wikiSummary(query: string, lang: string): Promise<string> {
  const encoded = encodeURIComponent(query.replace(/ /g, '_'));
  const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
  let res = await fetch(summaryUrl, {
    headers: { 'User-Agent': 'mochi-agent/1.0 (https://github.com/mochi-ai/mochi)' },
  });
  if (res.ok) {
    const data = (await res.json()) as { title?: string; extract?: string; description?: string };
    const title = data.title ?? query;
    const extract = (data.extract ?? '').slice(0, 2000);
    return `**${title}**\n\n${extract}`;
  }

  // Fallback: search API
  const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1`;
  res = await fetch(searchUrl, {
    headers: { 'User-Agent': 'mochi-agent/1.0 (https://github.com/mochi-ai/mochi)' },
  });
  if (!res.ok) throw new Error(`Wikipedia search failed: HTTP ${res.status}`);
  const data = (await res.json()) as {
    query?: { search?: Array<{ title?: string; snippet?: string }> };
  };
  const results = data?.query?.search ?? [];
  if (results.length === 0) return `No Wikipedia article found for: "${query}"`;
  const top = results[0];
  const snippet = (top.snippet ?? '').replace(/<[^>]*>/g, ''); // strip HTML tags
  return `**${top.title ?? query}** (search result)\n\n${snippet}`;
}

export const deepwikiTool: Tool = {
  def: {
    name: 'deepwiki',
    description:
      'Look up a topic on Wikipedia and return a concise summary. Useful for quick research, definitions, and background knowledge. ' +
      'Returns the article title and first ~2000 characters of the summary.',
    parameters: [
      { name: 'query', type: 'string', description: 'Search term or Wikipedia article title', required: true },
      { name: 'lang', type: 'string', description: 'Wikipedia language code (default: "en")', required: false },
    ],
    permission: 'network',
  },
  async execute(args) {
    const query = String(args.query ?? '').trim();
    if (!query) throw new Error('query is required');
    const lang = String(args.lang ?? 'en').replace(/[^a-z-]/gi, '');
    return await wikiSummary(query, lang || 'en');
  },
};
