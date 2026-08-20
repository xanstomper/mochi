// codebase SQL engine: querySymbolGraph + sql_codebase_query tool.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { querySymbolGraph, hasSqlite } from './codegraph.js';
import { sqlCodebaseTool } from './codebase-sql.js';

const maybe = hasSqlite() ? describe : describe.skip;
let dir: string;
const ctx = () => ({ cwd: dir, workspace: {} as any, config: {} as any, events: { emit: () => {} } as any, agentId: 's' });

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-sql-'));
  mkdirSync(resolve(dir, 'src'), { recursive: true });
  writeFileSync(resolve(dir, 'src', 'auth.ts'), 'export function login(email: string) { return true; }\nexport function signup(email: string) { return true; }\n');
  writeFileSync(resolve(dir, 'src', 'util.ts'), 'export function log(msg: string) { return msg; }\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

maybe('codebase SQL', () => {
  it('queries symbols by kind and name', () => {
    const out = querySymbolGraph(dir, "SELECT file, name, line FROM symbols WHERE kind='function' ORDER BY name LIMIT 10");
    if ('error' in out) { throw new Error(out.error); }
    const rows = out.rows as Array<{ name: string }>;
    expect(rows.some((r) => r.name === 'login')).toBe(true);
    expect(rows.some((r) => r.name === 'log')).toBe(true);
  });

  it('refuses non-read-only statements', () => {
    const out = querySymbolGraph(dir, 'DROP TABLE symbols');
    expect('error' in out).toBe(true);
    if ('error' in out) expect(out.error).toMatch(/read-only/);
  });

  it('auto-applies a LIMIT', () => {
    const out = querySymbolGraph(dir, 'SELECT * FROM symbols');
    expect('error' in out ? false : (out.rows as unknown[]).length <= 50).toBe(true);
  });

  it('sql_codebase_query tool returns rows JSON', async () => {
    const out = String(await sqlCodebaseTool.execute({ sql: 'SELECT name FROM symbols' }, ctx()));
    expect(out).toContain('login');
  });
});