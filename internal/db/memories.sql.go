package db

import (
	"context"
	"database/sql"
)

// Memory queries — hand-written to avoid regenerating sqlc for now.

const createMemory = `INSERT INTO memories (key, value, category, project, source, importance)
VALUES (?, ?, ?, ?, ?, ?) RETURNING id, key, value, category, project, source, importance, access_count, created_at, updated_at`

const getMemory = `SELECT id, key, value, category, project, source, importance, access_count, created_at, updated_at FROM memories WHERE id = ?`

const getMemoryByKey = `SELECT id, key, value, category, project, source, importance, access_count, created_at, updated_at FROM memories WHERE key = ? LIMIT 1`

const listMemories = `SELECT id, key, value, category, project, source, importance, access_count, created_at, updated_at FROM memories ORDER BY updated_at DESC LIMIT ?`

const searchMemories = `SELECT id, key, value, category, project, source, importance, access_count, created_at, updated_at FROM memories WHERE key LIKE ? OR value LIKE ? ORDER BY importance DESC, updated_at DESC LIMIT ?`

const updateMemoryData = `UPDATE memories SET value = ?, category = ?, project = ?, source = ?, importance = ? WHERE id = ?`

const updateMemoryAccess = `UPDATE memories SET access_count = access_count + 1 WHERE id = ?`

const deleteMemory = `DELETE FROM memories WHERE id = ?`

const clearMemories = `DELETE FROM memories`

const countMemories = `SELECT COUNT(*) FROM memories`

const getRecentMemories = `SELECT id, key, value, category, project, source, importance, access_count, created_at, updated_at FROM memories ORDER BY updated_at DESC LIMIT ?`

const getTopMemories = `SELECT id, key, value, category, project, source, importance, access_count, created_at, updated_at FROM memories ORDER BY importance DESC, access_count DESC LIMIT ?`

const listMemoriesByCategory = `SELECT id, key, value, category, project, source, importance, access_count, created_at, updated_at FROM memories WHERE category = ? ORDER BY updated_at DESC LIMIT ?`

const pruneOldMemories = `DELETE FROM memories WHERE updated_at < ? AND importance < ?`

// MemoryRow represents a row in the memories table.
type MemoryRow struct {
	ID          string  `json:"id"`
	Key         string  `json:"key"`
	Value       string  `json:"value"`
	Category    string  `json:"category"`
	Project     string  `json:"project"`
	Source      string  `json:"source"`
	Importance  float64 `json:"importance"`
	AccessCount int64   `json:"access_count"`
	CreatedAt   int64   `json:"created_at"`
	UpdatedAt   int64   `json:"updated_at"`
}

func scanMemoryRow(scanner interface {
	Scan(dest ...any) error
}) (MemoryRow, error) {
	var m MemoryRow
	err := scanner.Scan(
		&m.ID, &m.Key, &m.Value, &m.Category, &m.Project, &m.Source,
		&m.Importance, &m.AccessCount, &m.CreatedAt, &m.UpdatedAt,
	)
	return m, err
}

func scanMemoryRows(rows *sql.Rows) ([]MemoryRow, error) {
	defer rows.Close()
	var items []MemoryRow
	for rows.Next() {
		m, err := scanMemoryRow(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

// ExecMemoryQueries provides raw SQL access for the memory service.
type ExecMemoryQueries struct {
	db *sql.DB
}

func NewMemoryQueries(db *sql.DB) *ExecMemoryQueries {
	return &ExecMemoryQueries{db: db}
}

func (q *ExecMemoryQueries) CreateMemory(ctx context.Context, key, value, category, project, source string, importance float64) (MemoryRow, error) {
	row := q.db.QueryRowContext(ctx, createMemory, key, value, category, project, source, importance)
	return scanMemoryRow(row)
}

func (q *ExecMemoryQueries) GetMemory(ctx context.Context, id string) (MemoryRow, error) {
	row := q.db.QueryRowContext(ctx, getMemory, id)
	return scanMemoryRow(row)
}

func (q *ExecMemoryQueries) GetMemoryByKey(ctx context.Context, key string) (MemoryRow, error) {
	row := q.db.QueryRowContext(ctx, getMemoryByKey, key)
	return scanMemoryRow(row)
}

func (q *ExecMemoryQueries) ListMemories(ctx context.Context, limit int64) ([]MemoryRow, error) {
	rows, err := q.db.QueryContext(ctx, listMemories, limit)
	if err != nil {
		return nil, err
	}
	return scanMemoryRows(rows)
}

func (q *ExecMemoryQueries) SearchMemories(ctx context.Context, query string, limit int64) ([]MemoryRow, error) {
	pattern := "%" + query + "%"
	rows, err := q.db.QueryContext(ctx, searchMemories, pattern, pattern, limit)
	if err != nil {
		return nil, err
	}
	return scanMemoryRows(rows)
}

func (q *ExecMemoryQueries) UpdateMemory(ctx context.Context, id, value, category, project, source string, importance float64) error {
	_, err := q.db.ExecContext(ctx, updateMemoryData, value, category, project, source, importance, id)
	return err
}

func (q *ExecMemoryQueries) UpdateMemoryAccess(ctx context.Context, id string) error {
	_, err := q.db.ExecContext(ctx, updateMemoryAccess, id)
	return err
}

func (q *ExecMemoryQueries) DeleteMemory(ctx context.Context, id string) error {
	_, err := q.db.ExecContext(ctx, deleteMemory, id)
	return err
}

func (q *ExecMemoryQueries) ClearMemories(ctx context.Context) error {
	_, err := q.db.ExecContext(ctx, clearMemories)
	return err
}

func (q *ExecMemoryQueries) CountMemories(ctx context.Context) (int64, error) {
	var count int64
	err := q.db.QueryRowContext(ctx, countMemories).Scan(&count)
	return count, err
}

func (q *ExecMemoryQueries) GetRecentMemories(ctx context.Context, limit int64) ([]MemoryRow, error) {
	rows, err := q.db.QueryContext(ctx, getRecentMemories, limit)
	if err != nil {
		return nil, err
	}
	return scanMemoryRows(rows)
}

func (q *ExecMemoryQueries) GetTopMemories(ctx context.Context, limit int64) ([]MemoryRow, error) {
	rows, err := q.db.QueryContext(ctx, getTopMemories, limit)
	if err != nil {
		return nil, err
	}
	return scanMemoryRows(rows)
}

func (q *ExecMemoryQueries) ListMemoriesByCategory(ctx context.Context, category string, limit int64) ([]MemoryRow, error) {
	rows, err := q.db.QueryContext(ctx, listMemoriesByCategory, category, limit)
	if err != nil {
		return nil, err
	}
	return scanMemoryRows(rows)
}

func (q *ExecMemoryQueries) PruneOldMemories(ctx context.Context, olderThanUnixMs int64, minImportance float64) error {
	_, err := q.db.ExecContext(ctx, pruneOldMemories, olderThanUnixMs, minImportance)
	return err
}
