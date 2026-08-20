// Embedded codebase SQL engine (spec section 3): expose the live code symbol
// graph as queryable tables. `sql_codebase_query` runs safe, read-only,
// LIMIT-capped SQL over the codegraph's in-memory SQLite DB (symbols, calls,
// relations) so a model can do multi-file symbol/dependency analysis in one
// query instead of many read/glob calls.
import { querySymbolGraph, hasSqlite } from './codegraph.js';
import type { Tool } from './tools/types.js';

export const sqlCodebaseTool: Tool = {
  def: {
    name: 'sql_codebase_query',
    description: 'Run read-only SQL over the code graph database. Tables: symbols(file,name,line,kind,rel,body), calls(callee,caller,file,rel,line), relations(src,dst,kind,file). E.g. SELECT file,name,line FROM symbols WHERE kind="function" AND name LIKE "%auth%". Queries are LIMIT-capped at 50 rows.',
    parameters: [
      { name: 'sql', type: 'string', description: 'SQL SELECT/WITH statement (read-only, auto LIMIT 50)', required: true },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const sql = String(args.sql ?? '');
    if (!sql) throw new Error('sql required');
    if (!hasSqlite()) throw new Error('node:sqlite unavailable (Node >= 22.5)');
    const out = querySymbolGraph(ctx.cwd, sql);
    if ('error' in out) throw new Error(out.error);
    return 'Rows: ' + out.rows.length + '\n' + JSON.stringify(out.rows, null, 2);
  },
};