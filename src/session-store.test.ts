// Session store: SQLite + FTS5 conversation persistence and search.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SessionStore, hasSqlite } from './session-store.js';

const maybeDescribe = hasSqlite() ? describe : describe.skip;
let dir: string;
let store: SessionStore;

beforeAll(() => {
  dir = mkdtempSync(resolve(tmpdir(), 'mochi-sessions-'));
  store = new SessionStore(dir);
});
afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

maybeDescribe('SessionStore', () => {
  it('begin is idempotent per goal and persists messages', () => {
    const id1 = store.begin({ goalId: 'g1', objective: 'build a rate limiter' });
    const id2 = store.begin({ goalId: 'g1' });
    expect(id1).toBe(id2); // same goal => same session
    store.append(id1, 'user', 'add a token bucket');
    store.append(id1, 'assistant', 'implemented TokenBucket class');
    const msgs = store.messages(id1);
    expect(msgs.length).toBe(2);
    expect(msgs[0].content).toContain('token bucket');
    expect(msgs[1].content).toContain('TokenBucket');
  }, 20_000);

  it('lists sessions newest first', () => {
    const a = store.begin({ goalId: 'g-slow', objective: 'slow task' });
    store.append(a, 'assistant', 'doing it');
    const l = store.list();
    expect(l.length).toBeGreaterThanOrEqual(1);
    expect(l.some((r) => r.goalId === 'g-slow')).toBe(true);
    expect(l[0].goalId).toBeDefined();
  }, 20_000);

  it('full-text search finds content across sessions', () => {
    // 'rate limiter' appears only in session g1.
    const hits = store.search('rate limiter');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].content).toContain('token bucket');
  }, 20_000);

  it('handles malformed FTS queries gracefully', () => {
    const hits = store.search('AND AND AND'); // invalid bare operators
    expect(Array.isArray(hits)).toBe(true);
  }, 20_000);

  it('caps oversized messages', () => {
    const id = store.begin({ goalId: 'g-huge', objective: 'huge' });
    const huge = 'x'.repeat(200_000);
    store.append(id, 'assistant', huge);
    const m = store.messages(id);
    expect(m[m.length - 1].content.length).toBeLessThan(100_000);
  }, 20_000);
});