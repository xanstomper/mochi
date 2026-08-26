/**
 * Shared Wikipedia lookup — the single source of truth for the `deepwiki`
 * tool (in-process) and the `wiki_lookup` MCP server (standalone process).
 *
 * These two call sites used to each carry their own copy of the summary +
 * search-fallback fetch logic, which had already drifted (different
 * User-Agents, different search-result tags and error messages). This module
 * centralizes the network + formatting so both stay in lockstep, while
 * `WikiLookupOptions` carries the only per-context differences.
 */

export interface WikiLookupOptions {
  /** Sent as the User-Agent header (each integrated caller identifies itself). */
  userAgent: string;
  /** Tag appended to a search-fallback title, e.g. `(search result)` vs `(search)`. */
  searchTag: string;
  /** What to return when no article or search hit resolves. The tool and the
   *  MCP server historically phrased this differently. */
  emptyMessage: (query: string) => string;
  /** When true (agent tool), a hard search-API failure throws; when false
   *  (MCP server), it returns the graceful `emptyMessage` instead. */
  strict?: boolean;
}

export interface WikiSummaryResult {
  /** Fully-formatted markdown summary ready to show the caller. */
  markdown: string;
  /** Whether the summary came from the primary REST endpoint or the search fallback. */
  source: 'summary' | 'search' | 'empty';
}

const DEFAULT_LANG = 'en';

/** Fetch the REST summary endpoint; returns null if it 404s or is malformed. */
async function fetchSummary(query: string, lang: string, userAgent: string): Promise<string | null> {
  const encoded = encodeURIComponent(query.replace(/ /g, '_'));
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
  const res = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) return null;
  const data = (await res.json()) as { title?: string; extract?: string };
  const title = data.title ?? query;
  const extract = (data.extract ?? '').slice(0, 2000);
  return `**${title}**\n\n${extract}`;
}

/** Fetch the search API fallback.
 *  Returns `{ hit: string }` on a usable result, `{ empty: true }` when the
 *  API answered but had no results, or `{ error: status }` when the API itself
 *  failed (non-OK). Never throws. */
async function fetchSearch(query: string, lang: string, userAgent: string, searchTag: string): Promise<{ hit: string } | { empty: true } | { error: number }> {
  const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1`;
  const res = await fetch(searchUrl, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) return { error: res.status };
  const data = (await res.json()) as { query?: { search?: Array<{ title?: string; snippet?: string }> } };
  const top = data?.query?.search?.[0];
  if (!top) return { empty: true };
  const snippet = (top.snippet ?? '').replace(/<[^>]*>/g, ''); // strip HTML tags
  return { hit: `**${top.title ?? query}**${searchTag}\n\n${snippet}` };
}

/**
 * Look up a topic on Wikipedia and return a concise summary.
 *
 * Primary path is the REST summary endpoint; falls back to the search API
 * when the article fails to resolve. With `strict` (the agent tool), a hard
 * search-API failure throws so the error surfaces to the model; without it
 * (the MCP server), every failure resolves to the graceful `emptyMessage`.
 */
export async function wikiSummary(
  query: string,
  lang: string,
  opts: WikiLookupOptions,
): Promise<WikiSummaryResult> {
  const cleanLang = lang.replace(/[^a-z-]/gi, '') || DEFAULT_LANG;

  const summary = await fetchSummary(query, cleanLang, opts.userAgent);
  if (summary !== null) {
    return { markdown: summary, source: 'summary' };
  }

  const fallback = await fetchSearch(query, cleanLang, opts.userAgent, opts.searchTag);
  if ('hit' in fallback) {
    return { markdown: fallback.hit, source: 'search' };
  }

  // The article did not resolve. A search-API error is a hard failure under
  // `strict`; the MCP server (non-strict) never throws and reports gracefully.
  if ('error' in fallback && opts.strict) {
    throw new Error(`Wikipedia search failed: HTTP ${fallback.error}`);
  }
  return { markdown: opts.emptyMessage(query), source: 'empty' };
}