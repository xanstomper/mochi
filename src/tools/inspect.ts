import { RetrievalEngine } from '../retrieval.js';
import type { Tool } from './types.js';

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
    const engine = new RetrievalEngine(ctx.cwd);
    const result = await engine.inspect(query, limit);
    return JSON.stringify(result, null, 2);
  },
};
