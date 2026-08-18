import { RetrievalEngine } from '../retrieval.js';
import type { Tool } from './types.js';
import { mutationGeneration } from './fs-signal.js';

// `inspect` is one of the most frequently re-issued read tools in an agent loop
// (the model re-inspects the same symbol/file repeatedly as it iterates). Each
// call used to re-walk the whole repo, re-read every file, and shell out to
// `git log` per relevant file. Identical repeat inspections are now served from
// a boundary-keyed cache exactly like `search` (see tools/search.ts). The key
// embeds a shared *mutation generation* that write/edit/delete bump, so a stale
// result can never survive a real filesystem change -- we cache reusable payload
// work, never cached truth. LRU-bounded so repeat `inspect` calls never grow
// memory without bound. Key computation is O(1); no tree re-walk on a hit.
const inspectCache = new Map<string, { result: string; gen: number }>();
const inspectCacheLru: string[] = [];
const INSPECT_CACHE_MAX_ENTRIES = 48;

function putInspect(cwd: string, query: string, limit: number, result: string, gen: number) {
  const k = `${cwd}\u0000${query}\u0000${limit}\u0000${gen}`;
  inspectCache.set(k, { result, gen });
  inspectCacheLru.push(k);
  if (inspectCacheLru.length > INSPECT_CACHE_MAX_ENTRIES) {
    const evict = inspectCacheLru.shift();
    if (evict && evict !== k) inspectCache.delete(evict);
  }
}

function getInspect(cwd: string, query: string, limit: number, gen: number): string | null {
  return inspectCache.get(`${cwd}\u0000${query}\u0000${limit}\u0000${gen}`)?.result ?? null;
}

export const inspectTool: Tool = {
  def: {
    name: 'inspect',
    description: 'Inspect a query across files, symbols, references, imports, and recent git history. Returns a ranked retrieval result.',
    parameters: [
      { name: 'query', type: 'string', description: 'Symbol, file, or concept to inspect', required: true },
      { name: 'limit', type: 'integer', description: 'Maximum results per category', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const query = String(args.query ?? '');
    if (!query) throw new Error('No query provided');
    const limit = args.limit ? Number(args.limit) : 5;
    const gen = mutationGeneration();
    const cached = getInspect(ctx.cwd, query, limit, gen);
    if (cached !== null) return cached;
    const engine = new RetrievalEngine(ctx.cwd);
    const result = await engine.inspect(query, limit);
    const json = JSON.stringify(result, null, 2);
    putInspect(ctx.cwd, query, limit, json, gen);
    return json;
  },
};