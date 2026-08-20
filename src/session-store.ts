// Session store (the Hermes insight): SQLite-backed conversation history with
// FTS5 full-text search and session lineage. The agent's transcript for a task
// is persisted as a session, so:
//   - a resumed goal can reconstruct the exact prior conversation (not just the
//     autopsy's terse failure summary)
//   - `mochi session search "rate limiter"` finds any past work by content
//   - sessions keep parent/child links across compactions (Hermes-style)
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

process.removeAllListeners?.('warning');
const req = createRequire(import.meta.url);
const couldNotLoad = (() => {
  try { req('node:sqlite'); return false; } catch { return true; }
})();
const DatabaseSync = couldNotLoad ? (class {} as unknown as typeof DatabaseSyncT) : (req('node:sqlite').DatabaseSync as typeof DatabaseSyncT);

export interface SessionMessage {
  role: string;
  content: string;
  t: number;
}

export function hasSqlite(): boolean {
  // Must actually confirm node:sqlite loaded — on runtimes without it the
  // fallback class  succeeds vacuously, so a test on  alone would
  // wrongly report true.
  if (couldNotLoad) return false;
  try { new DatabaseSync(':memory:'); return true; } catch { return false; }
}

export interface SessionRow {
  id: string;
  parentId: string | null;
  goalId: string | null;
  role: string;
  objective: string;
  createdAt: number;
  updatedAt: number;
  status: 'open' | 'closed';
  summary?: string;
}


// `objective` is indexed alongside each message so a search like "rate limiter"
// can match a session's goal and surface its transcript rows (content is what
// callers get back, but the match can come from the objective).
const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  goal_id TEXT,
  role TEXT,
  objective TEXT,
  created_at INTEGER,
  updated_at INTEGER,
  status TEXT,
  summary TEXT,
  message_count INTEGER DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS session_messages USING fts5(
  session_id UNINDEXED, role UNINDEXED, content, objective, t UNINDEXED,
  tokenize = 'unicode61'
);
CREATE INDEX IF NOT EXISTS idx_sessions_goal ON sessions(goal_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);
`;

/** One store per Mochi workspace (.mochi/sessions.sqlite). */
export class SessionStore {
  private db: DatabaseSyncT;
  private dir: string;
  /** false when node:sqlite is unavailable; all reads return empty. */
  private available = true;

  constructor(dir: string) {
    this.dir = dir;
    // Guard: on runtimes without node:sqlite (Node < 22.5) this is a no-op
    // store so callers never crash — every method safely returns empty.
    if (!hasSqlite()) {
      this.available = false;
      this.db = new DatabaseSync(':memory:');
      return;
    }
    this.available = true;
    mkdirSync(resolve(dir, '.mochi'), { recursive: true });
    this.db = new DatabaseSync(resolve(dir, '.mochi', 'sessions.sqlite'));
    this.db.exec(DDL);
  }

  close(): void { if (this.db && typeof (this.db as { close?: unknown }).close === 'function') (this.db as { close: () => void }).close(); }

  /** Create a session; returns its id (or the existing id for a goal-id that
   *  already has one — makes `resume` idempotent). */
  begin(obj: { goalId?: string; role?: string; objective?: string; parentId?: string | null }): string {
    const existing = obj.goalId
      ? (this.db.prepare('SELECT id FROM sessions WHERE goal_id=? ORDER BY updated_at DESC LIMIT 1').get(obj.goalId) as { id: string } | undefined)
      : undefined;
    if (existing) {
      // Freshen objective/role so a later begin({goalId}) that omits them
      // doesn't leave a stale/empty objective row.
      if (obj.objective) this.db.prepare('UPDATE sessions SET objective=?, role=COALESCE(?,role) WHERE id=?').run(obj.objective, obj.role ?? null, existing.id);
      return existing.id;
    }
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(
      'INSERT OR IGNORE INTO sessions(id,parent_id,goal_id,role,objective,created_at,updated_at,status,summary) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(id, obj.parentId ?? null, obj.goalId ?? null, obj.role ?? 'coder', obj.objective ?? '', now, now, 'completed', null);
    return id;
  }

  /** Append one transcript message to a session. */
  append(sessionId: string, role: string, content: string): void {
    if (!this.available || !content) return;
    // Bound a single message so a giant tool dump doesn't bloat the index.
    const text = content.length > 60_000 ? content.slice(0, 60_000) + `\n…(${content.length - 60_000} more chars)` : content;
    // The session's objective is indexed alongside each message so a search
    // can match a goal ("rate limiter") and surface the transcript rows for it.
    const objective = (this.db.prepare('SELECT objective FROM sessions WHERE id=?').get(sessionId) as { objective: string } | undefined)?.objective ?? '';
    this.db.prepare('INSERT INTO session_messages(session_id,role,content,objective,t) VALUES(?,?,?,?,?)').run(sessionId, role, text, objective, Date.now());
    this.db.prepare('UPDATE sessions SET message_count=message_count+1, updated_at=? WHERE id=?').run(Date.now(), sessionId);
  }

  /** The full ordered transcript for a session. */
  messages(sessionId: string): SessionMessage[] {
    if (!this.available) return [];
    return this.db.prepare('SELECT role,content,t FROM session_messages WHERE session_id=? ORDER BY rowid').all(sessionId) as unknown as SessionMessage[];
  }

  /** Full-text search across every session (Hermes/FTS5 usage). */
  search(query: string, limit = 10): Array<{ sessionId: string; role: string; content: string; t: number }> {
    try {
      return this.db.prepare(
        `SELECT session_id AS sessionId, role, content, t
         FROM session_messages WHERE session_messages MATCH ?
         ORDER BY rowid LIMIT ?`,
      ).all(query, limit) as Array<{ sessionId: string; role: string; content: string; t: number }>;
    } catch {
      // Invalid FTS query (e.g. a bare operator) — treat as no match.
      return [];
    }
  }

  /** Recent sessions, newest first. */
  list(limit = 20): SessionRow[] {
    // Explicit columns + aliases: `goal_id` is stored snake_case but the
    // SessionRow contract is camelCase, so SELECT * would silently yield
    // undefined for `goalId` (and `parentId`).
    return this.db.prepare(
      `SELECT id, parent_id AS parentId, goal_id AS goalId, role, objective,
              created_at AS createdAt, updated_at AS updatedAt, status, summary
       FROM sessions ORDER BY updated_at DESC LIMIT ?`,
    ).all(limit) as unknown as SessionRow[];
  }

  session(id: string): SessionRow | undefined {
    if (!this.available) return undefined;
    return this.db.prepare(
      `SELECT id, parent_id AS parentId, goal_id AS goalId, role, objective,
              created_at AS createdAt, updated_at AS updatedAt, status, summary
       FROM sessions WHERE id=?`,
    ).get(id) as unknown as SessionRow | undefined;
  }

  markCompleted(id: string, status: 'completed'): void {
    if (!this.available) return;
    this.db.prepare("UPDATE sessions SET status='completed', updated_at=? WHERE id=?").run(Date.now(), id);
  }
}


/** Hash a goal objective into a stable session filename/id aid. */
export function sessionKey(objective: string): string {
  return createHash('sha1').update(objective).digest('hex').slice(0, 12);
}