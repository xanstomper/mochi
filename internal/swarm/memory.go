package swarm

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// MemoryScope identifies the lifetime of a memory entry. The runtime
// exposes four scopes so agents can pick the right one without
// leaking long-lived state into short-lived scopes.
type MemoryScope string

const (
	// ScopeTask is per-task; cleared when the task completes.
	ScopeTask MemoryScope = "task"
	// ScopeAgent is per-agent; cleared when the agent retires.
	ScopeAgent MemoryScope = "agent"
	// ScopeRun is per-run; cleared when the run finishes.
	ScopeRun MemoryScope = "run"
	// ScopeProject is permanent; survives across runs. Used for
	// architecture knowledge, build history, and error patterns.
	ScopeProject MemoryScope = "project"
)

// MemoryEntry is a single key-value record in the project memory.
// Key is namespaced as "<scope>:<agent-or-empty>:<name>".
type MemoryEntry struct {
	Key       string
	Scope     MemoryScope
	Owner     AgentID
	Name      string
	Value     []byte
	Version   uint64
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Memory is the shared project memory every agent can read and
// write. The runtime is responsible for serialising the memory to
// SQLite so entries persist across runs; the in-memory map is the
// working copy.
//
// Memory is safe for concurrent use. Reads are O(1); writes are
// O(1) and broadcast a pubsub event so the TUI can reflect the
// change immediately.
type Memory struct {
	mu      sync.RWMutex
	entries map[string]*MemoryEntry
	// history is a per-key changelog capped at 32 entries. Used
	// to debug "who wrote what" without re-reading the SQLite log.
	history map[string][]MemoryEntry
	// onWrite is called on every write so the runtime can
	// broadcast a pubsub event.
	onWrite func(MemoryEntry)
}

// NewMemory returns an empty Memory.
func NewMemory() *Memory {
	return &Memory{
		entries: make(map[string]*MemoryEntry),
		history: make(map[string][]MemoryEntry),
	}
}

// SetOnWrite installs a callback invoked on every write. The
// runtime uses this to emit memory.write events.
func (m *Memory) SetOnWrite(fn func(MemoryEntry)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onWrite = fn
}

// keyOf builds the canonical key for a memory entry.
func keyOf(scope MemoryScope, owner AgentID, name string) string {
	return string(scope) + ":" + string(owner) + ":" + name
}

// Write stores a value at the given key. The version is bumped and
// the entry's UpdatedAt is set. If the entry already exists, its
// previous version is preserved in the history.
func (m *Memory) Write(scope MemoryScope, owner AgentID, name string, value any) error {
	data, err := encodeValue(value)
	if err != nil {
		return fmt.Errorf("encode value: %w", err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	k := keyOf(scope, owner, name)
	now := time.Now()
	entry, ok := m.entries[k]
	if !ok {
		entry = &MemoryEntry{
			Key:       k,
			Scope:     scope,
			Owner:     owner,
			Name:      name,
			CreatedAt: now,
			UpdatedAt: now,
		}
		m.entries[k] = entry
	}
	entry.Value = data
	entry.Version++
	entry.UpdatedAt = now
	// Append to history.
	hist := m.history[k]
	hist = append(hist, *entry)
	if len(hist) > 32 {
		hist = hist[len(hist)-32:]
	}
	m.history[k] = hist
	if m.onWrite != nil {
		m.onWrite(*entry)
	}
	return nil
}

// Read returns the value at the given key. The boolean is false if
// the key is not present.
func (m *Memory) Read(scope MemoryScope, owner AgentID, name string, out any) (bool, error) {
	m.mu.RLock()
	entry, ok := m.entries[keyOf(scope, owner, name)]
	m.mu.RUnlock()
	if !ok {
		return false, nil
	}
	if err := decodeValue(entry.Value, out); err != nil {
		return true, fmt.Errorf("decode value: %w", err)
	}
	return true, nil
}

// ReadRaw returns the raw bytes of the entry. Useful for callers
// that want to stream the value without decoding.
func (m *Memory) ReadRaw(scope MemoryScope, owner AgentID, name string) ([]byte, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	entry, ok := m.entries[keyOf(scope, owner, name)]
	if !ok {
		return nil, false
	}
	cp := make([]byte, len(entry.Value))
	copy(cp, entry.Value)
	return cp, true
}

// Delete removes the entry. Returns true if the entry existed.
func (m *Memory) Delete(scope MemoryScope, owner AgentID, name string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := keyOf(scope, owner, name)
	if _, ok := m.entries[k]; !ok {
		return false
	}
	delete(m.entries, k)
	delete(m.history, k)
	return true
}

// List returns all entries in the given scope, sorted by name.
func (m *Memory) List(scope MemoryScope) []MemoryEntry {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]MemoryEntry, 0)
	for _, e := range m.entries {
		if e.Scope == scope {
			out = append(out, *e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// Search returns all entries whose name contains the given
// substring, case-insensitive. Useful for the TUI to find
// architecture notes.
func (m *Memory) Search(substr string) []MemoryEntry {
	m.mu.RLock()
	defer m.mu.RUnlock()
	needle := []byte(substr)
	out := make([]MemoryEntry, 0)
	for _, e := range m.entries {
		if containsFold([]byte(e.Name), needle) || containsFold(e.Value, needle) {
			out = append(out, *e)
		}
	}
	return out
}

// Snapshot returns a deep copy of all entries. Used to persist
// memory to SQLite.
func (m *Memory) Snapshot() []MemoryEntry {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]MemoryEntry, 0, len(m.entries))
	for _, e := range m.entries {
		out = append(out, *e)
	}
	return out
}

// Restore adds a batch of entries to the memory, preserving their
// versions. Used to load memory from SQLite on startup.
func (m *Memory) Restore(entries []MemoryEntry) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, e := range entries {
		cp := e
		m.entries[e.Key] = &cp
	}
}

// Clear removes all entries in the given scope. The runtime calls
// this on ScopeRun when a run finishes so the next run starts
// clean (ScopeProject is preserved).
func (m *Memory) Clear(scope MemoryScope) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for k, e := range m.entries {
		if e.Scope == scope {
			delete(m.entries, k)
			delete(m.history, k)
			n++
		}
	}
	return n
}

// encodeValue marshals arbitrary Go values to JSON, falling back
// to the raw bytes if the value is already []byte.
func encodeValue(v any) ([]byte, error) {
	switch x := v.(type) {
	case nil:
		return []byte("null"), nil
	case []byte:
		return x, nil
	case string:
		return []byte(x), nil
	default:
		return json.Marshal(v)
	}
}

// decodeValue unmarshals the given bytes into the output value.
func decodeValue(data []byte, out any) error {
	return json.Unmarshal(data, out)
}

// containsFold is a case-insensitive substring search that avoids
// importing strings just for one call.
func containsFold(haystack, needle []byte) bool {
	if len(needle) == 0 {
		return true
	}
	if len(needle) > len(haystack) {
		return false
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		match := true
		for j := 0; j < len(needle); j++ {
			a := haystack[i+j]
			b := needle[j]
			if a >= 'A' && a <= 'Z' {
				a += 32
			}
			if b >= 'A' && b <= 'Z' {
				b += 32
			}
			if a != b {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}

// HashKey returns a stable, content-addressed key for a memory
// name. Useful for storing computed facts (e.g. "checksum of
// go.mod") so duplicate writes from parallel agents collapse to
// the same entry.
func HashKey(prefix string, data []byte) string {
	h := sha256.Sum256(data)
	return prefix + ":" + hex.EncodeToString(h[:8])
}

// ErrMemoryNotFound is returned by helpers that want to distinguish
// missing entries from decode errors.
var ErrMemoryNotFound = errors.New("swarm: memory not found")

// MustRead is a convenience for Read that returns ErrMemoryNotFound
// when the entry is missing. The output is populated only on
// success.
func (m *Memory) MustRead(ctx context.Context, scope MemoryScope, owner AgentID, name string, out any) error {
	ok, err := m.Read(scope, owner, name, out)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("%w: scope=%s owner=%s name=%s", ErrMemoryNotFound, scope, owner, name)
	}
	return nil
}
