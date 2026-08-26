import type { Tool } from './types.js';
import { wikiSummary } from '../wiki.js';

const userAgent = 'mochi-agent/1.0 (https://github.com/mochi-ai/mochi)';

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
    const { markdown } = await wikiSummary(query, lang || 'en', {
      userAgent,
      searchTag: ' (search result)',
      emptyMessage: (q) => `No Wikipedia article found for: "${q}"`,
      strict: true,
    });
    return markdown;
  },
};
