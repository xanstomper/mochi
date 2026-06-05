package swarm

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Store is the swarm's SQLite-backed persistence layer. Safe for
// concurrent use. The schema is intentionally small: the runtime's
// hot path is the in-memory DAG, lock manager, and memory store;
// SQLite is only consulted on startup (to hydrate state) and on
// shutdown (to persist state).
type Store struct {
	mu sync.Mutex
	db *sql.DB
}

// Open opens (or creates) the swarm database at the given path.
// WAL mode is enabled for concurrent read performance.
func OpenStore(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir: %w", err)
	}
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)")
	if err != nil {
		return nil, fmt.Errorf("open: %w", err)
	}
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("ping: %w", err)
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

// Close releases the underlying connection.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) migrate() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS runs (
			run_id TEXT PRIMARY KEY,
			mode TEXT NOT NULL,
			mission TEXT NOT NULL,
			working_dir TEXT NOT NULL,
			started_at INTEGER NOT NULL,
			finished_at INTEGER,
			reason TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS tasks (
			task_id TEXT PRIMARY KEY,
			run_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT NOT NULL,
			tier TEXT NOT NULL,
			priority INTEGER NOT NULL,
			status TEXT NOT NULL,
			dependencies TEXT NOT NULL,
			assignee TEXT,
			attempts INTEGER NOT NULL DEFAULT 0,
			max_attempts INTEGER NOT NULL DEFAULT 3,
			files TEXT NOT NULL,
			result TEXT,
			error TEXT,
			created_at INTEGER NOT NULL,
			started_at INTEGER,
			finished_at INTEGER,
			tokens_in INTEGER NOT NULL DEFAULT 0,
			tokens_out INTEGER NOT NULL DEFAULT 0,
			parent TEXT,
			FOREIGN KEY(run_id) REFERENCES runs(run_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id)`,
		`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
		`CREATE TABLE IF NOT EXISTS memory (
			key TEXT PRIMARY KEY,
			scope TEXT NOT NULL,
			owner TEXT NOT NULL,
			name TEXT NOT NULL,
			value BLOB NOT NULL,
			version INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope)`,
		`CREATE TABLE IF NOT EXISTS file_index (
			path TEXT PRIMARY KEY,
			size INTEGER NOT NULL,
			mod_time INTEGER NOT NULL,
			hash TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			run_id TEXT NOT NULL,
			task_id TEXT,
			agent_id TEXT,
			phase TEXT,
			type TEXT NOT NULL,
			ts INTEGER NOT NULL,
			payload TEXT
		)`,
		`CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id)`,
		`CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts)`,
	}
	for _, stmt := range stmts {
		if _, err := s.db.Exec(stmt); err != nil {
			return fmt.Errorf("exec: %w", err)
		}
	}
	return nil
}

func (s *Store) SaveRun(ctx context.Context, r Report) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
		INSERT OR REPLACE INTO runs (run_id, mode, mission, working_dir, started_at, finished_at, reason)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, string(r.RunID), string(r.Mode), r.Mission, r.WorkingDir, r.StartedAt.Unix(), r.FinishedAt.Unix(), r.Reason)
	return err
}

func (s *Store) SaveTask(ctx context.Context, t Task) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	deps, _ := json.Marshal(t.Dependencies)
	files, _ := json.Marshal(t.Files)
	_, err := s.db.ExecContext(ctx, `
		INSERT OR REPLACE INTO tasks (
			task_id, run_id, title, description, tier, priority, status,
			dependencies, assignee, attempts, max_attempts, files,
			result, error, created_at, started_at, finished_at,
			tokens_in, tokens_out, parent
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		string(t.ID), string(t.RunID), t.Title, t.Description, string(t.Tier), int(t.Priority), string(t.Status),
		string(deps), string(t.Assignee), t.Attempts, t.MaxAttempts, string(files),
		t.Result, t.Error, t.CreatedAt.Unix(),
		nullableTime(t.StartedAt), nullableTime(t.FinishedAt),
		t.TokensIn, t.TokensOut, string(t.Parent),
	)
	return err
}

func (s *Store) SaveTasks(ctx context.Context, tasks []Task) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, `
		INSERT OR REPLACE INTO tasks (
			task_id, run_id, title, description, tier, priority, status,
			dependencies, assignee, attempts, max_attempts, files,
			result, error, created_at, started_at, finished_at,
			tokens_in, tokens_out, parent
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
	if err != nil {
		tx.Rollback()
		return err
	}
	defer stmt.Close()
	for _, t := range tasks {
		deps, _ := json.Marshal(t.Dependencies)
		files, _ := json.Marshal(t.Files)
		_, err := stmt.ExecContext(ctx,
			string(t.ID), string(t.RunID), t.Title, t.Description, string(t.Tier), int(t.Priority), string(t.Status),
			string(deps), string(t.Assignee), t.Attempts, t.MaxAttempts, string(files),
			t.Result, t.Error, t.CreatedAt.Unix(),
			nullableTime(t.StartedAt), nullableTime(t.FinishedAt),
			t.TokensIn, t.TokensOut, string(t.Parent),
		)
		if err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) LoadTasks(ctx context.Context, runID RunID) ([]Task, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
		SELECT task_id, run_id, title, description, tier, priority, status,
			dependencies, assignee, attempts, max_attempts, files,
			result, error, created_at, started_at, finished_at,
			tokens_in, tokens_out, parent
		FROM tasks WHERE run_id = ? ORDER BY created_at ASC
	`, string(runID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Task
	for rows.Next() {
		var t Task
		var deps, files string
		var startedAt, finishedAt sql.NullInt64
		var assignee sql.NullString
		if err := rows.Scan(
			&t.ID, &t.RunID, &t.Title, &t.Description, &t.Tier, &t.Priority, &t.Status,
			&deps, &assignee, &t.Attempts, &t.MaxAttempts, &files,
			&t.Result, &t.Error, &t.CreatedAt,
			&startedAt, &finishedAt,
			&t.TokensIn, &t.TokensOut, &t.Parent,
		); err != nil {
			return nil, err
		}
		if assignee.Valid {
			t.Assignee = AgentID(assignee.String)
		}
		if startedAt.Valid {
			t.StartedAt = time.Unix(startedAt.Int64, 0)
		}
		if finishedAt.Valid {
			t.FinishedAt = time.Unix(finishedAt.Int64, 0)
		}
		_ = json.Unmarshal([]byte(deps), &t.Dependencies)
		_ = json.Unmarshal([]byte(files), &t.Files)
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) SaveMemoryEntry(ctx context.Context, e MemoryEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.ExecContext(ctx, `
		INSERT OR REPLACE INTO memory (key, scope, owner, name, value, version, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`, e.Key, string(e.Scope), string(e.Owner), e.Name, e.Value, e.Version, e.CreatedAt.Unix(), e.UpdatedAt.Unix())
	return err
}

func (s *Store) LoadMemory(ctx context.Context) ([]MemoryEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
		SELECT key, scope, owner, name, value, version, created_at, updated_at
		FROM memory ORDER BY updated_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []MemoryEntry
	for rows.Next() {
		var e MemoryEntry
		var scope string
		if err := rows.Scan(&e.Key, &scope, &e.Owner, &e.Name, &e.Value, &e.Version, &e.CreatedAt, &e.UpdatedAt); err != nil {
			return nil, err
		}
		e.Scope = MemoryScope(scope)
		e.CreatedAt = time.Unix(e.CreatedAt.Unix(), 0)
		e.UpdatedAt = time.Unix(e.UpdatedAt.Unix(), 0)
		out = append(out, e)
	}
	return out, rows.Err()
}

func (s *Store) SaveFileIndex(ctx context.Context, entries map[string]IndexEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM file_index`); err != nil {
		tx.Rollback()
		return err
	}
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO file_index (path, size, mod_time, hash) VALUES (?, ?, ?, ?)`)
	if err != nil {
		tx.Rollback()
		return err
	}
	defer stmt.Close()
	for _, e := range entries {
		if _, err := stmt.ExecContext(ctx, e.Path, e.Size, e.ModTime.Unix(), e.Hash); err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) LoadFileIndex(ctx context.Context) (map[string]IndexEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `SELECT path, size, mod_time, hash FROM file_index`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]IndexEntry)
	for rows.Next() {
		var e IndexEntry
		var modTime int64
		if err := rows.Scan(&e.Path, &e.Size, &modTime, &e.Hash); err != nil {
			return nil, err
		}
		e.ModTime = time.Unix(modTime, 0)
		out[e.Path] = e
	}
	return out, rows.Err()
}

func (s *Store) LogEvent(ctx context.Context, e SwarmEvent) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	payload, _ := json.Marshal(e.Payload)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO events (run_id, task_id, agent_id, phase, type, ts, payload)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, string(e.RunID), string(e.TaskID), string(e.AgentID), string(e.Phase), e.Type, e.Timestamp.Unix(), string(payload))
	return err
}

func (s *Store) LoadEvents(ctx context.Context, runID RunID) ([]SwarmEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.QueryContext(ctx, `
		SELECT run_id, task_id, agent_id, phase, type, ts, payload
		FROM events WHERE run_id = ? ORDER BY ts ASC, id ASC
	`, string(runID))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SwarmEvent
	for rows.Next() {
		var e SwarmEvent
		var taskID, agentID, phase sql.NullString
		var ts int64
		var payload sql.NullString
		if err := rows.Scan(&e.RunID, &taskID, &agentID, &phase, &e.Type, &ts, &payload); err != nil {
			return nil, err
		}
		if taskID.Valid {
			e.TaskID = TaskID(taskID.String)
		}
		if agentID.Valid {
			e.AgentID = AgentID(agentID.String)
		}
		if phase.Valid {
			e.Phase = Phase(phase.String)
		}
		e.Timestamp = time.Unix(ts, 0)
		if payload.Valid {
			_ = json.Unmarshal([]byte(payload.String), &e.Payload)
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ErrStoreNotFound is returned when a load operation finds no rows.
var ErrStoreNotFound = errors.New("swarm store: not found")

// nullableTime returns 0 for zero time.Time values so we can store
// them as NULL in SQLite.
func nullableTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t.Unix()
}
