// semantic_search tool (Wave J): hybrid vector+lexical retrieval over the
// persistent semantic code index (.mochi/index), re-ranked by the repo
// map's task conditioning. Where `search` finds literal text, this finds
// the code that IMPLEMENTS a concept — including files that share no exact
// tokens with the query but sit in the concept's call neighbourhood.
//
// The tool ensures the index is current before searching (incremental:
// unchanged files are never re-embedded). The header always names the
// embedder that built the index; the local fallback is labelled
// lexical-fallback — its vectors are hashed token/trigram features, NOT
// trained semantic embeddings.
import type { Tool, ToolContext } from './types.js';
import { clipToolOutput } from './output-budget.js';
import {
  aggregateHitsToFiles,
  ensureSemanticIndex,
  indexStatus,
  semanticSearchForTask,
} from '../repo/semantic-index.js';

export const semanticSearchTool: Tool = {
  def: {
    name: 'semantic_search',
    description:
      'Search the codebase by CONCEPT, not literal text: hybrid vector+lexical retrieval over the persistent semantic index, re-ranked by task conditioning (PageRank + call-graph neighbourhood). Returns the chunks that implement an idea (e.g. "where are retries with backoff scheduled", "how is a lease renewed") with file:line and symbol. Builds/refreshes the index incrementally on first use. Use `search` instead for exact strings/regex.',
    parameters: [
      { name: 'query', type: 'string', description: 'Natural-language description of the concept/code to find', required: true },
      { name: 'limit', type: 'integer', description: 'Maximum chunk hits to return (default 12)', required: false },
    ],
    permission: 'read',
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const query = String(args.query ?? '').trim();
    if (!query) throw new Error('No query provided');
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 12;
    const root = ctx.cwd;

    const stats = await ensureSemanticIndex(root, { config: ctx.config });
    if (!stats) {
      return 'Semantic index unavailable (disabled via config/env, or no SQLite driver on this runtime). Use `search` for literal text search.';
    }
    const result = await semanticSearchForTask(root, query, { config: ctx.config, limit: limit * 4 });
    const status = indexStatus(root);
    const embedderLabel = stats.embedderKind === 'provider'
      ? `${stats.embedderId} (provider embeddings)`
      : `${stats.embedderId} (LEXICAL-FALLBACK — local hashed token/trigram vectors, not trained semantic embeddings; configure retrieval.embeddingModel for provider embeddings)`;
    const header = `[semantic index: embedder=${embedderLabel} | files=${status.files ?? stats.filesTotal} chunks=${status.chunks ?? stats.chunksTotal} | refresh: ${stats.filesUpdated} updated, ${stats.filesSkipped} unchanged, ${stats.chunksEmbedded} embedded, ${stats.chunksReused} reused]`;
    if (!result || result.hits.length === 0) {
      return `${header}\nNo matches for "${query}".`;
    }
    // Rank FILES (aggregated over their chunks — file discovery is the
    // point of the tool), showing each file's best chunk.
    const fileHits = aggregateHitsToFiles(result.hits, limit);
    const lines = fileHits.map((f) => {
      const h = f.best;
      const loc = h.symbol ? `${h.rel}:${h.startLine}-${h.endLine} \`${h.symbol}\` (${h.kind})` : `${h.rel}:${h.startLine}-${h.endLine} (${h.kind})`;
      return `- ${loc} — file score ${f.fileScore.toFixed(3)} (best chunk: vector ${h.vectorScore}, lexical ${h.lexicalScore}, ${f.chunkCount} chunk(s) matched)\n  ${h.snippet}`;
    });
    return clipToolOutput(`${header}\n${lines.join('\n')}`);
  },
};
