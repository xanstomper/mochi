// Session store (the Hermes insight): conversation history with full-text
// search and session lineage. The agent's transcript for a task is persisted
// as a session, so:
//   - a resumed goal can reconstruct the exact prior conversation (not just the
//     autopsy's terse failure summary)
//   - `mochi session search "rate limiter"` finds any past work by content
//   - sessions keep parent/child links across compactions (Hermes-style)
//
// Driver policy: node:sqlite (Node >= 22.5) / bun:sqlite when present. When
// neither exists (Node 22.0–22.4 satisfies mochi's `engines` but has no
// node:sqlite), a bounded JSON file takes over with the same API instead of
// silently degrading to a no-op store. Silent degradation meant EVERY prompt
// ran blind — the "mochi doesn't know the previous conversation" class — and
// the old driver-less constructor actually CRASHED (openDb throws without a
// driver). Conversation continuity is never optional.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDb, hasSqlite as driverAvailable, type SqliteDb, type Stmt } from '../sqlite.js';
import { mochiStateDir } from '../core/mochi-dir.js';
import { redact } from '../security/security.js';

export interface SessionMessage {
  role: string;
  content: string;
  t: number;
}

export function hasSqlite(): boolean {
  // MOCHI_SQLITE=off forces the JSON fallback even when a driver exists —
  // a test hook and a user escape hatch for sqlite trouble.
  if (process.env.MOCHI_SQLITE === 'off') return false;
  // node:sqlite (Node >= 22.5) or bun:sqlite (compiled binary).
  return driverAvailable();
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

// ---- JSON fallback (driver-less runtimes) ---------------------------------
// Bounded on purpose: the fallback exists for conversation continuity, not as
// an archive. Caps keep the file small and the per-turn atomic write fast.

/** Sessions kept on disk (oldest evicted past the cap). */
const MAX_FB_SESSIONS = 100;
/** Messages kept per session (the tail is what continuity injects anyway). */
const MAX_FB_MESSAGES = 60;
/** Per-message char cap — mirrors the sqlite path's truncation. */
const MAX_FB_MESSAGE_CHARS = 60_000;

interface FallbackMessage { role: string; content: string; t: number }
interface FallbackSession {
  id: string;
  parentId: string | null;
  goalId: string | null;
  role: string;
  objective: string;
  createdAt: number;
  updatedAt: number;
  status: string;
  summary?: string;
  messages: FallbackMessage[];
}
interface FallbackState { path: string; sessions: FallbackSession[] }

function loadFallback(path: string): FallbackState {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { sessions?: unknown };
    if (raw && Array.isArray(raw.sessions)) {
      const sessions = raw.sessions.filter((s): s is FallbackSession => {
        const c = s as FallbackSession | null;
        return !!c && typeof c.id === 'string' && Array.isArray(c.messages);
      });
      return { path, sessions };
    }
  } catch { /* missing or corrupt — start fresh */ }
  return { path, sessions: [] };
}

function fbSave(st: FallbackState): void {
  if (st.sessions.length > MAX_FB_SESSIONS) {
    st.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    st.sessions.length = MAX_FB_SESSIONS;
  }
  const tmp = `${st.path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, sessions: st.sessions }));
  renameSync(tmp, st.path);
}

function fbNewSession(id: string, obj: { parentId?: string | null; goalId?: string; role?: string; objective?: string }): FallbackSession {
  const now = Date.now();
  return {
    id,
    parentId: obj.parentId ?? null,
    goalId: obj.goalId ?? null,
    role: obj.role ?? 'coder',
    objective: obj.objective ?? '',
    createdAt: now,
    updatedAt: now,
    status: 'open',
    messages: [],
  };
}

/** Satisfies the non-null `db` field in fallback mode without openDb's
 *  guaranteed throw — every method branches to the JSON store before touching
 *  `db`, so none of these stubs are ever exercised. */
const NULL_DB: SqliteDb = {
  exec() { /* noop */ },
  prepare(): Stmt {
    return {
      get: () => undefined,
      all: () => [],
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
    };
  },
  close() { /* noop */ },
};

/** One store per Mochi workspace (.mochi/sessions.sqlite, or
 *  .mochi/sessions-fallback.json on driver-less runtimes). */
export class SessionStore {
  private db: SqliteDb;
  /** false only when even the JSON fallback could not initialize (unreadable
   *  state dir) — every method then safely returns empty. */
  private available = true;
  /** JSON-file mode active (no sqlite driver). */
  private fb: FallbackState | null = null;

  constructor(dir: string) {
    if (!hasSqlite()) {
      try {
        const stateDir = mochiStateDir(dir);
        mkdirSync(stateDir, { recursive: true });
        this.fb = loadFallback(resolve(stateDir, 'sessions-fallback.json'));
        this.db = NULL_DB;
        this.available = true;
      } catch {
        this.fb = null;
        this.db = NULL_DB;
        this.available = false;
      }
      return;
    }
    this.available = true;
    const stateDir = mochiStateDir(dir);
    mkdirSync(stateDir, { recursive: true });
    this.db = openDb(resolve(stateDir, 'sessions.sqlite'));
    this.db.exec(DDL);
  }

  /** True when transcripts persist (sqlite OR the JSON fallback). */
  works(): boolean {
    return this.available;
  }

  close(): void { if (this.db && typeof (this.db as { close?: unknown }).close === 'function') (this.db as { close: () => void }).close(); }

  /** Create a session; returns its id (or the existing id for a goal-id that
   *  already has one — makes `resume` idempotent). */
  begin(obj: { id?: string; goalId?: string; role?: string; objective?: string; parentId?: string | null }): string {
    // Objectives are persisted AND FTS-indexed alongside every message —
    // redact on write, same posture as transcript content and traces.
    if (obj.objective) obj = { ...obj, objective: redact(obj.objective) };
    if (this.fb) {
      const st = this.fb;
      const byId = obj.id ? st.sessions.find((s) => s.id === obj.id) : undefined;
      const byGoal = !byId && obj.goalId ? st.sessions.find((s) => s.goalId === obj.goalId) : undefined;
      const existing = byId ?? byGoal;
      if (existing) {
        if (obj.objective) {
          existing.objective = obj.objective;
          existing.role = obj.role ?? existing.role;
          existing.updatedAt = Date.now();
          fbSave(st);
        }
        return existing.id;
      }
      const id = obj.id ?? randomUUID();
      st.sessions.push(fbNewSession(id, obj));
      fbSave(st);
      return id;
    }
    if (obj.id) {
      const existingById = this.db.prepare('SELECT id FROM sessions WHERE id=?').get(obj.id) as { id: string } | undefined;
      if (existingById) {
        if (obj.objective) this.db.prepare('UPDATE sessions SET objective=COALESCE(?,objective), role=COALESCE(?,role), updated_at=? WHERE id=?').run(obj.objective, obj.role ?? null, Date.now(), existingById.id);
        return existingById.id;
      }
      const now = Date.now();
      this.db.prepare(
        'INSERT OR IGNORE INTO sessions(id,parent_id,goal_id,role,objective,created_at,updated_at,status,summary) VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(obj.id, obj.parentId ?? null, obj.goalId ?? null, obj.role ?? 'coder', obj.objective ?? '', now, now, 'open', null);
      return obj.id;
    }
    const existing = obj.goalId
      ? (this.db.prepare('SELECT id FROM sessions WHERE goal_id=? ORDER BY updated_at DESC LIMIT 1').get(obj.goalId) as { id: string } | undefined)
      : undefined;
    if (existing) {
      // Freshen objective/role so a later begin({goalId}) that omits them
      // doesn't leave a stale/empty objective row.
      if (obj.objective) this.db.prepare('UPDATE sessions SET objective=?, role=COALESCE(?,role), updated_at=? WHERE id=?').run(obj.objective, obj.role ?? null, Date.now(), existing.id);
      return existing.id;
    }
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(
      'INSERT OR IGNORE INTO sessions(id,parent_id,goal_id,role,objective,created_at,updated_at,status,summary) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(id, obj.parentId ?? null, obj.goalId ?? null, obj.role ?? 'coder', obj.objective ?? '', now, now, 'open', null);
    return id;
  }

  /** Append one transcript message to a session. */
  append(sessionId: string, role: string, content: string): void {
    if (!this.available || !content) return;
    // Redact BEFORE persisting: traces have always been redacted on write,
    // but transcripts were stored raw — the same run's secrets landed here
    // unscrubbed (SQLite FTS + JSON fallback alike; this one point covers
    // both). Reads stay backward-compatible: already-stored rows are
    // returned as-is, only new writes are scrubbed.
    const scrubbed = redact(content);
    // Bound a single message so a giant tool dump doesn't bloat the index.
    const text = scrubbed.length > MAX_FB_MESSAGE_CHARS ? scrubbed.slice(0, MAX_FB_MESSAGE_CHARS) + `\n…(${scrubbed.length - MAX_FB_MESSAGE_CHARS} more chars)` : scrubbed;
    if (this.fb) {
      const st = this.fb;
      let s = st.sessions.find((x) => x.id === sessionId);
      if (!s) {
        s = fbNewSession(sessionId, {});
        st.sessions.push(s);
      }
      s.messages.push({ role, content: text, t: Date.now() });
      if (s.messages.length > MAX_FB_MESSAGES) s.messages.splice(0, s.messages.length - MAX_FB_MESSAGES);
      s.updatedAt = Date.now();
      fbSave(st);
      return;
    }
    // The session's objective is indexed alongside each message so a search
    // can match a goal ("rate limiter") and surface the transcript rows for it.
    const objective = (this.db.prepare('SELECT objective FROM sessions WHERE id=?').get(sessionId) as { objective: string } | undefined)?.objective ?? '';
    this.db.prepare('INSERT INTO session_messages(session_id,role,content,objective,t) VALUES(?,?,?,?,?)').run(sessionId, role, text, objective, Date.now());
    this.db.prepare('UPDATE sessions SET message_count=message_count+1, updated_at=? WHERE id=?').run(Date.now(), sessionId);
  }

  /** The full ordered transcript for a session. */
  messages(sessionId: string): SessionMessage[] {
    if (!this.available) return [];
    if (this.fb) {
      const s = this.fb.sessions.find((x) => x.id === sessionId);
      return s ? s.messages.map((m) => ({ ...m })) : [];
    }
    return this.db.prepare('SELECT role,content,t FROM session_messages WHERE session_id=? ORDER BY rowid').all(sessionId) as unknown as SessionMessage[];
  }

  /** Full-text search across every session (Hermes/FTS5 usage). The JSON
   *  fallback approximates FTS AND-semantics: every whitespace-separated word
   *  must appear (case-insensitive) in the message or its session objective. */
  search(query: string, limit = 10): Array<{ sessionId: string; role: string; content: string; t: number }> {
    if (this.fb) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (words.length === 0) return [];
      const out: Array<{ sessionId: string; role: string; content: string; t: number }> = [];
      for (const s of this.fb.sessions) {
        const obj = s.objective.toLowerCase();
        for (const m of s.messages) {
          const hay = `${obj}\n${m.content}`.toLowerCase();
          if (words.every((w) => hay.includes(w))) {
            out.push({ sessionId: s.id, role: m.role, content: m.content, t: m.t });
            if (out.length >= limit) return out;
          }
        }
      }
      return out;
    }
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
    if (this.fb) {
      return [...this.fb.sessions]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((s) => ({
          id: s.id,
          parentId: s.parentId ?? null,
          goalId: s.goalId ?? null,
          role: s.role,
          objective: s.objective,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          // Raw status, exactly like the sqlite path returns it.
          status: s.status as SessionRow['status'],
          summary: s.summary,
        }));
    }
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
    if (this.fb) {
      return this.list(Number.MAX_SAFE_INTEGER).find((s) => s.id === id);
    }
    return this.db.prepare(
      `SELECT id, parent_id AS parentId, goal_id AS goalId, role, objective,
              created_at AS createdAt, updated_at AS updatedAt, status, summary
       FROM sessions WHERE id=?`,
    ).get(id) as unknown as SessionRow | undefined;
  }

  markCompleted(id: string, _status: 'completed'): void {
    if (!this.available) return;
    if (this.fb) {
      const s = this.fb.sessions.find((x) => x.id === id);
      if (s) { s.status = 'completed'; s.updatedAt = Date.now(); fbSave(this.fb); }
      return;
    }
    this.db.prepare("UPDATE sessions SET status='completed', updated_at=? WHERE id=?").run(Date.now(), id);
  }

  rename(id: string, objective: string): void {
    if (!this.available) return;
    const scrubbed = redact(objective);
    if (this.fb) {
      const s = this.fb.sessions.find((x) => x.id === id);
      if (s) { s.objective = scrubbed; s.updatedAt = Date.now(); fbSave(this.fb); }
      return;
    }
    this.db.prepare('UPDATE sessions SET objective=?, updated_at=? WHERE id=?').run(scrubbed, Date.now(), id);
  }

  /** Recent session summaries for ambient agent context injection. */
  recentSummaries(limit = 5): Array<{ id: string; objective: string; role: string; summary?: string; messageCount: number; updatedAt: number }> {
    if (!this.available) return [];
    if (this.fb) {
      return [...this.fb.sessions]
        .filter((s) => s.objective)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((s) => ({ id: s.id, objective: s.objective, role: s.role, summary: s.summary, messageCount: s.messages.length, updatedAt: s.updatedAt }));
    }
    try {
      return this.db.prepare(
        `SELECT id, role, objective, summary, message_count AS messageCount, updated_at AS updatedAt
         FROM sessions WHERE objective IS NOT NULL AND objective != ''
         ORDER BY updated_at DESC LIMIT ?`,
      ).all(limit) as Array<{ id: string; objective: string; role: string; summary?: string; messageCount: number; updatedAt: number }>;
    } catch {
      return [];
    }
  }

  /** ms timestamp of a session's last recorded activity (its updatedAt),
   *  or undefined when the session is unknown or the store is down.
   *  G11 idle detection reads this clock: every append/begin/rename
   *  bumps updatedAt, so it is the session's true last-activity time. */
  lastActivityAt(sessionId: string): number | undefined {
    return this.session(sessionId)?.updatedAt;
  }

  /** ms since a session's last activity at `now`; undefined when the
   *  session is unknown or the store is down (callers must not compact
   *  on an unknown clock — see shouldIdleCompact's unknown-activity
   *  verdict). */
  idleDurationMs(sessionId: string, now = Date.now()): number | undefined {
    const at = this.lastActivityAt(sessionId);
    return at === undefined ? undefined : Math.max(0, now - at);
  }

  /** Full formatted transcript of a session. */
  fullTranscript(sessionId: string): string {
    const msgs = this.messages(sessionId);
    if (!msgs.length) return '';
    return msgs.map((m) => {
      const time = new Date(m.t).toISOString().replace('T', ' ').slice(0, 19);
      return `[${time}] ${m.role.toUpperCase()}:\n${m.content}`;
    }).join('\n\n---\n\n');
  }

  delete(id: string): void {
    if (!this.available) return;
    if (this.fb) {
      const st = this.fb;
      const before = st.sessions.length;
      st.sessions = st.sessions.filter((s) => s.id !== id);
      if (st.sessions.length !== before) fbSave(st);
      return;
    }
    try {
      this.db.prepare('DELETE FROM session_messages WHERE session_id=?').run(id);
      this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    } catch {}
  }
}

