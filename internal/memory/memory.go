// Package memory provides cross-session persistent memory for the agent.
//
// The memory service stores key-value pairs with categories, projects,
// importance scoring, and automatic access tracking. Memories are SQLite-backed
// and survive process restarts.
//
// The agent automatically saves memories when it detects important facts
// (user preferences, project conventions, environment quirks) and retrieves
// relevant memories for system prompt injection.
package memory

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/mochi/mochi/internal/db"
	"github.com/mochi/mochi/internal/pubsub"
)

// Entry is a single memory entry stored in the memory service.
type Entry struct {
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

// Predefined memory categories for consistent tagging.
const (
	CategoryUserPref   = "user_pref"
	CategoryProject    = "project"
	CategoryConvention = "convention"
	CategoryFact       = "fact"
	CategoryError      = "error"
	CategoryGeneral    = "general"
)

// Default importance levels.
const (
	ImportanceLow    = 0.3
	ImportanceMedium = 0.5
	ImportanceHigh   = 0.8
	ImportanceMax    = 1.0
)

// Service is the interface for persistent memory operations.
type Service interface {
	// Store creates or updates a memory entry by key (upsert).
	Store(ctx context.Context, key, value, category, project, source string, importance float64) (Entry, error)

	// Get retrieves a memory entry by ID.
	Get(ctx context.Context, id string) (Entry, error)

	// GetByKey retrieves a memory entry by its key.
	GetByKey(ctx context.Context, key string) (Entry, error)

	// List returns all memory entries, most recently updated first.
	List(ctx context.Context, limit int) ([]Entry, error)

	// Search performs LIKE-based search on key and value.
	Search(ctx context.Context, query string, limit int) ([]Entry, error)

	// Update modifies an existing memory entry.
	Update(ctx context.Context, id, value, category, project, source string, importance float64) error

	// Delete removes a memory entry.
	Delete(ctx context.Context, id string) error

	// Clear removes all memories.
	Clear(ctx context.Context) error

	// Count returns the number of stored memories.
	Count(ctx context.Context) (int64, error)

	// ListByCategory returns memories filtered by category.
	ListByCategory(ctx context.Context, category string, limit int) ([]Entry, error)

	// GetTop returns the most important/frequently accessed memories.
	GetTop(ctx context.Context, limit int) ([]Entry, error)

	// GetRecent returns the most recently updated memories.
	GetRecent(ctx context.Context, limit int) ([]Entry, error)

	// Prune removes old, low-importance memories.
	Prune(ctx context.Context, olderThan time.Duration, minImportance float64) (int, error)

	// RetrieveRelevant returns a formatted string of memories relevant to the given context.
	RetrieveRelevant(ctx context.Context, limit int) (string, error)
}

type service struct {
	*pubsub.Broker[Entry]
	q *db.ExecMemoryQueries
}

var _ Service = (*service)(nil)

// NewService creates a new SQLite-backed memory service.
func NewService(conn *sql.DB) Service {
	return &service{
		Broker: pubsub.NewBroker[Entry](),
		q:      db.NewMemoryQueries(conn),
	}
}

func (s *service) Store(ctx context.Context, key, value, category, project, source string, importance float64) (Entry, error) {
	if key == "" {
		return Entry{}, errors.New("memory key cannot be empty")
	}
	if importance < 0 || importance > 1 {
		return Entry{}, errors.New("importance must be between 0 and 1")
	}
	if category == "" {
		category = CategoryGeneral
	}

	// Check if a memory with this key already exists
	existing, err := s.q.GetMemoryByKey(ctx, key)
	if err == nil {
		// Update existing
		err = s.q.UpdateMemory(ctx, existing.ID, value, category, project, source, importance)
		if err != nil {
			return Entry{}, fmt.Errorf("update memory: %w", err)
		}
		row, err := s.q.GetMemory(ctx, existing.ID)
		if err != nil {
			return Entry{}, fmt.Errorf("get updated memory: %w", err)
		}
		entry := fromRow(row)
		s.Broker.Publish(pubsub.UpdatedEvent, entry)
		return entry, nil
	}

	// Create new
	row, err := s.q.CreateMemory(ctx, key, value, category, project, source, importance)
	if err != nil {
		return Entry{}, fmt.Errorf("create memory: %w", err)
	}
	entry := fromRow(row)
	s.Broker.Publish(pubsub.CreatedEvent, entry)
	return entry, nil
}

func (s *service) Get(ctx context.Context, id string) (Entry, error) {
	row, err := s.q.GetMemory(ctx, id)
	if err != nil {
		return Entry{}, fmt.Errorf("get memory: %w", err)
	}
	return fromRow(row), nil
}

func (s *service) GetByKey(ctx context.Context, key string) (Entry, error) {
	row, err := s.q.GetMemoryByKey(ctx, key)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Entry{}, fmt.Errorf("memory key %q not found", key)
		}
		return Entry{}, fmt.Errorf("get memory by key: %w", err)
	}
	// Bump access count
	_ = s.q.UpdateMemoryAccess(ctx, row.ID)
	return fromRow(row), nil
}

func (s *service) List(ctx context.Context, limit int) ([]Entry, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := s.q.ListMemories(ctx, int64(limit))
	if err != nil {
		return nil, fmt.Errorf("list memories: %w", err)
	}
	return fromRows(rows), nil
}

func (s *service) Search(ctx context.Context, query string, limit int) ([]Entry, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := s.q.SearchMemories(ctx, query, int64(limit))
	if err != nil {
		return nil, fmt.Errorf("search memories: %w", err)
	}
	return fromRows(rows), nil
}

func (s *service) Update(ctx context.Context, id, value, category, project, source string, importance float64) error {
	if category == "" {
		category = CategoryGeneral
	}
	if err := s.q.UpdateMemory(ctx, id, value, category, project, source, importance); err != nil {
		return fmt.Errorf("update memory: %w", err)
	}
	row, err := s.q.GetMemory(ctx, id)
	if err != nil {
		return fmt.Errorf("get updated memory: %w", err)
	}
	s.Broker.Publish(pubsub.UpdatedEvent, fromRow(row))
	return nil
}

func (s *service) Delete(ctx context.Context, id string) error {
	// Fetch before deleting so we can publish the deleted entry
	row, err := s.q.GetMemory(ctx, id)
	if err != nil {
		return fmt.Errorf("get memory for delete: %w", err)
	}
	if err := s.q.DeleteMemory(ctx, id); err != nil {
		return fmt.Errorf("delete memory: %w", err)
	}
	s.Broker.Publish(pubsub.DeletedEvent, fromRow(row))
	return nil
}

func (s *service) Clear(ctx context.Context) error {
	return s.q.ClearMemories(ctx)
}

func (s *service) Count(ctx context.Context) (int64, error) {
	return s.q.CountMemories(ctx)
}

func (s *service) ListByCategory(ctx context.Context, category string, limit int) ([]Entry, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := s.q.ListMemoriesByCategory(ctx, category, int64(limit))
	if err != nil {
		return nil, fmt.Errorf("list memories by category: %w", err)
	}
	return fromRows(rows), nil
}

func (s *service) GetTop(ctx context.Context, limit int) ([]Entry, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := s.q.GetTopMemories(ctx, int64(limit))
	if err != nil {
		return nil, fmt.Errorf("get top memories: %w", err)
	}
	return fromRows(rows), nil
}

func (s *service) GetRecent(ctx context.Context, limit int) ([]Entry, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := s.q.GetRecentMemories(ctx, int64(limit))
	if err != nil {
		return nil, fmt.Errorf("get recent memories: %w", err)
	}
	return fromRows(rows), nil
}

func (s *service) Prune(ctx context.Context, olderThan time.Duration, minImportance float64) (int, error) {
	cutoff := time.Now().Add(-olderThan).UnixMilli()
	if err := s.q.PruneOldMemories(ctx, cutoff, minImportance); err != nil {
		return 0, fmt.Errorf("prune memories: %w", err)
	}
	// We could return the count of deleted rows, but this is good enough
	return 0, nil
}

func (s *service) RetrieveRelevant(ctx context.Context, limit int) (string, error) {
	if limit <= 0 || limit > 30 {
		limit = 10
	}
	rows, err := s.q.GetTopMemories(ctx, int64(limit))
	if err != nil {
		return "", fmt.Errorf("retrieve relevant memories: %w", err)
	}
	if len(rows) == 0 {
		return "", nil
	}

	var result string
	for _, r := range rows {
		result += fmt.Sprintf("  - [%s] %s: %s (importance: %.1f)\n", r.Category, r.Key, truncate(r.Value, 120), r.Importance)
	}
	return result, nil
}

func fromRow(r db.MemoryRow) Entry {
	return Entry{
		ID:          r.ID,
		Key:         r.Key,
		Value:       r.Value,
		Category:    r.Category,
		Project:     r.Project,
		Source:      r.Source,
		Importance:  r.Importance,
		AccessCount: r.AccessCount,
		CreatedAt:   r.CreatedAt,
		UpdatedAt:   r.UpdatedAt,
	}
}

func fromRows(rows []db.MemoryRow) []Entry {
	entries := make([]Entry, len(rows))
	for i, r := range rows {
		entries[i] = fromRow(r)
	}
	return entries
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
