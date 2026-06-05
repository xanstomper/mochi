package swarm

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// IndexEntry is a single file's record in the incremental index.
// Hash is the SHA-256 of the file content at the time of the
// snapshot.
type IndexEntry struct {
	Path    string
	Size    int64
	ModTime time.Time
	Hash    string
}

// FileIndex tracks file hashes for a project so the runtime can
// detect which files have changed since the last agent read them.
// The index is the foundation of "incremental indexing" from the
// spec: agents ask the index "what changed since X" instead of
// re-reading the whole tree.
//
// The index is in-memory; persistence to SQLite is handled by the
// runtime. On startup, the runtime hydrates the index from the
// database; on shutdown, it persists the current state.
type FileIndex struct {
	mu      sync.RWMutex
	root    string
	entries map[string]IndexEntry
	// ignore lists patterns that should be skipped. The runtime
	// installs a sensible default (node_modules, .git, target,
	// dist, .MOCHI).
	ignore []string
	// scanCount tracks the number of full scans; useful for the
	// TUI to show "last scan at X".
	scanCount uint64
	lastScan  time.Time
}

// NewFileIndex returns an empty FileIndex rooted at root. If root
// does not exist, the index still works — scans simply return no
// entries until the directory is created.
func NewFileIndex(root string) *FileIndex {
	return &FileIndex{
		root:    root,
		entries: make(map[string]IndexEntry),
		ignore: []string{
			".git", "node_modules", "target", "dist", "build", ".MOCHI",
			".next", ".nuxt", "vendor", "__pycache__", ".venv",
		},
	}
}

// SetIgnore replaces the ignore-list. Call this to customise which
// paths the scanner skips.
func (i *FileIndex) SetIgnore(patterns []string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.ignore = append([]string{}, patterns...)
}

// Scan walks the root directory and rebuilds the index. It is
// incremental: unchanged files are not re-hashed because we use
// size+mtime as a quick filter and only hash on size/mtime
// mismatch.
//
// Returns the number of files indexed and the number of files
// that were added or changed (delta).
func (i *FileIndex) Scan() (total, changed int, err error) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.scanCount++
	// Collect new entries into a fresh map; entries that no
	// longer exist on disk are dropped at the end.
	next := make(map[string]IndexEntry)
	err = filepath.WalkDir(i.root, func(path string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			// Don't abort the whole walk on a single
			// permission error; just skip the offending
			// subtree.
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if i.shouldIgnore(path) {
				return filepath.SkipDir
			}
			return nil
		}
		if i.shouldIgnore(path) {
			return nil
		}
		info, infoErr := d.Info()
		if infoErr != nil {
			return nil
		}
		// Quick filter: if size+mtime match the existing entry,
		// reuse the previous hash without reading the file.
		rel, _ := filepath.Rel(i.root, path)
		if prev, ok := i.entries[rel]; ok {
			if prev.Size == info.Size() && prev.ModTime.Equal(info.ModTime()) {
				next[rel] = prev
				return nil
			}
		}
		// Read and hash.
		data, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		h := sha256.Sum256(data)
		entry := IndexEntry{
			Path:    rel,
			Size:    info.Size(),
			ModTime: info.ModTime(),
			Hash:    hex.EncodeToString(h[:]),
		}
		next[rel] = entry
		if _, existed := i.entries[rel]; !existed || i.entries[rel].Hash != entry.Hash {
			changed++
		}
		return nil
	})
	if err != nil {
		return 0, 0, err
	}
	i.entries = next
	i.lastScan = time.Now()
	return len(next), changed, nil
}

// Get returns the index entry for a relative path. The boolean is
// false if the file is not in the index.
func (i *FileIndex) Get(rel string) (IndexEntry, bool) {
	i.mu.RLock()
	defer i.mu.RUnlock()
	e, ok := i.entries[rel]
	return e, ok
}

// ChangedSince returns the list of files whose hash differs from
// the given previous index. If prev is nil, all indexed files are
// returned. The returned paths are sorted for determinism.
func (i *FileIndex) ChangedSince(prev map[string]string) []string {
	i.mu.RLock()
	defer i.mu.RUnlock()
	out := make([]string, 0)
	for rel, entry := range i.entries {
		old, existed := prev[rel]
		if !existed || old != entry.Hash {
			out = append(out, rel)
		}
	}
	sort.Strings(out)
	return out
}

// HashOfFile computes the SHA-256 of a single file and updates
// the index in place. Useful for one-off re-hashes after an agent
// edits a file outside the normal scan path.
func (i *FileIndex) HashOfFile(absPath string) (string, error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(data)
	sum := hex.EncodeToString(h[:])
	rel, _ := filepath.Rel(i.root, absPath)
	info, _ := os.Stat(absPath)
	i.mu.Lock()
	if info != nil {
		i.entries[rel] = IndexEntry{
			Path:    rel,
			Size:    info.Size(),
			ModTime: info.ModTime(),
			Hash:    sum,
		}
	}
	i.mu.Unlock()
	return sum, nil
}

// Snapshot returns a copy of the current index entries. Used to
// persist the index to SQLite and to give agents a baseline for
// "what changed since".
func (i *FileIndex) Snapshot() map[string]IndexEntry {
	i.mu.RLock()
	defer i.mu.RUnlock()
	out := make(map[string]IndexEntry, len(i.entries))
	for k, v := range i.entries {
		out[k] = v
	}
	return out
}

// Restore replaces the index with the given entries. Used on
// startup to hydrate the in-memory index from SQLite.
func (i *FileIndex) Restore(entries map[string]IndexEntry) {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.entries = make(map[string]IndexEntry, len(entries))
	for k, v := range entries {
		i.entries[k] = v
	}
}

// LastScan returns the timestamp of the most recent successful
// scan, or the zero time if no scan has been performed.
func (i *FileIndex) LastScan() time.Time {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.lastScan
}

// ScanCount returns the number of scans performed.
func (i *FileIndex) ScanCount() uint64 {
	i.mu.RLock()
	defer i.mu.RUnlock()
	return i.scanCount
}

// shouldIgnore reports whether a path matches any of the ignore
// patterns. Patterns are matched against the path's components
// (not the full path) so "node_modules" anywhere in the tree is
// skipped.
func (i *FileIndex) shouldIgnore(path string) bool {
	parts := strings.Split(filepath.ToSlash(path), "/")
	for _, p := range parts {
		for _, pattern := range i.ignore {
			if p == pattern {
				return true
			}
		}
	}
	return false
}
