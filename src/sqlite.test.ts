import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { hasSqlite, sqliteSource, openDb } from './sqlite.js';
import { SessionStore, hasSqlite as storeHasSqlite } from './session-store.js';

describe('sqlite driver adapter', () => {
  it('detects a driver on this runtime (node:sqlite or bun:sqlite)', () => {
    // CI runs Node 20 + 22: 22 has node:sqlite; 20 has neither (bun not used
    // under vitest), so accept both outcomes but the source must be honest.
    if (hasSqlite()) {
      expect(['node:sqlite', 'bun:sqlite']).toContain(sqliteSource());
    } else {
      expect(sqliteSource()).toBe('');
    }
  });

  it('openDb runs real SQL end to end when a driver exists', () => {
    if (!hasSqlite()) return;
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-sqlite-'));
    const db = openDb(resolve(dir, 't.sqlite'));
    db.exec('CREATE TABLE t(id INTEGER, name TEXT)');
    db.prepare('INSERT INTO t VALUES(?,?)').run(1, 'mochi');
    const row = db.prepare('SELECT * FROM t WHERE id=?').get(1) as { name: string };
    expect(row.name).toBe('mochi');
    const rows = db.prepare('SELECT * FROM t').all();
    expect(rows).toHaveLength(1);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('session store agrees with the driver', () => {
    expect(storeHasSqlite()).toBe(hasSqlite());
  });
});

describe('SessionStore on the adapter', () => {
  it('persists and searches sessions when a driver exists', () => {
    if (!hasSqlite()) return;
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-sess-'));
    const store = new SessionStore(dir);
    const sid = store.begin({ goalId: 'g1', role: 'coder', objective: 'rate limiter work' });
    store.append(sid, 'user', 'fix the rate limiter retry backoff');
    store.append(sid, 'assistant', 'adjusted exponential backoff in client.ts');
    const msgs = store.messages(sid);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toContain('rate limiter');
    const hits = store.search('backoff');
    expect(hits.length).toBeGreaterThan(0);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});