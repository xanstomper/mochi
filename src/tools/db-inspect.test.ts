import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, hasSqlite } from '../sqlite.js';
import { dbInspectTool } from './db-inspect.js';
import { Workspace } from '../workspace.js';
import { EventBus } from '../events.js';
import type { ToolContext } from './types.js';
import type { MochiConfig } from '../types.js';

const describeIf = hasSqlite() ? describe : describe.skip;

describeIf('db-inspect tool', () => {
  let dir: string;
  let ctx: ToolContext;
  let dbFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-dbtest-'));
    dbFile = join(dir, 'test.db');
    const db = openDb(dbFile);
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO users (email) VALUES ('alice@example.com'), ('bob@example.com');
    `);
    db.close();

    const ws = new Workspace(dir);
    ws.ensure();
    ctx = { cwd: dir, workspace: ws, config: {} as MochiConfig, events: new EventBus(), agentId: 'test' };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists tables in database', async () => {
    const res = await dbInspectTool.execute({ db_path: 'test.db' }, ctx);
    expect(res).toContain('Database Schema: test.db');
    expect(res).toContain('users');
    expect(res).toContain('2 rows');
  });

  it('inspects detailed schema for a specific table', async () => {
    const res = await dbInspectTool.execute({ db_path: 'test.db', table: 'users' }, ctx);
    expect(res).toContain('Table Schema: "users"');
    expect(res).toContain('email (TEXT)');
    expect(res).toContain('PRIMARY KEY');
  });
});
