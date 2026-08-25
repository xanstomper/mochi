import type { Tool } from './types.js';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { openDb, hasSqlite } from '../sqlite.js';

export const dbInspectTool: Tool = {
  def: {
    name: 'db_inspect',
    description: 'Inspect SQLite database schema (tables, columns, indexes, foreign keys, row counts).',
    parameters: [
      { name: 'db_path', type: 'string', description: 'Relative path to SQLite database file (.db, .sqlite, .sqlite3)', required: true },
      { name: 'table', type: 'string', description: 'Optional specific table name to inspect in detail', required: false },
      { name: 'query', type: 'string', description: 'Optional read-only SQL query to execute (SELECT/PRAGMA only, max 50 rows)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const rawPath = String(args.db_path ?? '').trim();
    if (!rawPath) return 'Error: db_path parameter is required.';

    const fullPath = resolve(ctx.cwd, rawPath);
    if (!existsSync(fullPath)) {
      return `Error: database file not found at "${rawPath}".`;
    }
    if (!hasSqlite()) {
      return 'Error: SQLite driver unavailable on this runtime (needs Node >= 22.5).';
    }

    try {
      const db = openDb(fullPath);

      if (args.query) {
        const sql = String(args.query).trim();
        if (!/^SELECT\b/i.test(sql) && !/^PRAGMA\b/i.test(sql) && !/^EXPLAIN\b/i.test(sql)) {
          db.close();
          return 'Error: Only read-only queries (SELECT, PRAGMA, EXPLAIN) are permitted with db_inspect.';
        }
        const stmt = db.prepare(sql);
        const rows = stmt.all() as any[];
        db.close();
        const capped = rows.slice(0, 50);
        return `# Query Results (${capped.length} rows):\n\`\`\`json\n${JSON.stringify(capped, null, 2)}\n\`\`\``;
      }

      if (args.table) {
        const tableName = String(args.table).trim();
        const schemaQuery = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?");
        const schemaRow = schemaQuery.get(tableName) as { sql?: string } | undefined;

        if (!schemaRow || !schemaRow.sql) {
          db.close();
          return `Table "${tableName}" not found in ${rawPath}.`;
        }

        const countQuery = db.prepare(`SELECT COUNT(*) as count FROM "${tableName.replace(/"/g, '""')}"`);
        const countRow = countQuery.get() as { count: number };

        const colsQuery = db.prepare(`PRAGMA table_info("${tableName.replace(/"/g, '""')}")`);
        const cols = colsQuery.all() as Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: any; pk: number }>;

        db.close();

        const colTable = cols.map((c) => `  - ${c.name} (${c.type || 'BLOB'})${c.pk ? ' [PRIMARY KEY]' : ''}${c.notnull ? ' [NOT NULL]' : ''}`).join('\n');

        return `# Table Schema: "${tableName}" (${countRow.count} rows)\n\n## Columns:\n${colTable}\n\n## SQL Definition:\n\`\`\`sql\n${schemaRow.sql}\n\`\`\``;
      }

      // List all tables
      const tablesQuery = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
      const tables = tablesQuery.all() as Array<{ name: string; type: string }>;

      const summaries: string[] = [];
      for (const t of tables) {
        try {
          const countQuery = db.prepare(`SELECT COUNT(*) as count FROM "${t.name.replace(/"/g, '""')}"`);
          const countRow = countQuery.get() as { count: number };
          summaries.push(`- **${t.name}** (${t.type}): ${countRow.count} rows`);
        } catch {
          summaries.push(`- **${t.name}** (${t.type})`);
        }
      }

      db.close();

      return `# Database Schema: ${rawPath}\n\n${summaries.join('\n') || '(no user tables found)'}\n\n*Tip: Pass \`table\` argument to inspect column definitions.*`;
    } catch (err) {
      return `Database inspection error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
