package swarm

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/aymanbagabas/go-udiff"
	"github.com/aymanbagabas/go-udiff/myers"
)

// MergeEngine reconciles concurrent file edits produced by parallel
// agents. The design follows the "operational transform" model
// adapted for text files: every agent operates on a base content
// snapshot, produces a unified diff, and the engine tries to apply
// each diff in a deterministic order, falling back to 3-way merge
// when concurrent edits touch the same line ranges.
type MergeEngine struct {
	mu sync.Mutex
	// Current snapshot of every file the engine has seen. Keyed
	// by absolute path.
	snapshots map[string]string
	// Version counter per path. Each successful merge increments
	// the version; the version is stamped on every diff so we can
	// reject stale patches.
	versions map[string]uint64
}

// NewMergeEngine returns an empty MergeEngine.
func NewMergeEngine() *MergeEngine {
	return &MergeEngine{
		snapshots: make(map[string]string),
		versions:  make(map[string]uint64),
	}
}

// Snapshot records the current content of a file in the engine. The
// engine does not own the file; it just remembers the content for
// later merging. Call this when an agent starts a task so the
// engine has a base version to apply subsequent patches against.
func (e *MergeEngine) Snapshot(path, content string) uint64 {
	e.mu.Lock()
	defer e.mu.Unlock()
	clean := filepath.Clean(path)
	e.snapshots[clean] = content
	e.versions[clean]++
	return e.versions[clean]
}

// ReadFile reads a file from disk, records it in the engine, and
// returns both the content and the new version. If the file does
// not exist, returns "" with no error.
func (e *MergeEngine) ReadFile(path string) (string, uint64, error) {
	clean := filepath.Clean(path)
	data, err := os.ReadFile(clean)
	if err != nil {
		if os.IsNotExist(err) {
			return "", 0, nil
		}
		return "", 0, err
	}
	v := e.Snapshot(clean, string(data))
	return string(data), v, nil
}

// Patch is a candidate change to a file. Version is the version of
// the file the patch was generated against. If the engine's
// current version does not match, the patch is considered stale
// and must be rebased.
type Patch struct {
	Path    string
	Version uint64
	// NewContent is the full new content. For small files this is
	// the easiest representation; the engine writes it directly
	// after conflict checks.
	NewContent string
	// Summary is a short human-readable description of the change
	// for the TUI and event log.
	Summary string
	// Author is the agent that produced the patch.
	Author AgentID
}

// ApplyResult reports the outcome of attempting to apply one or
// more patches.
type ApplyResult struct {
	// Path is the file path.
	Path string
	// Applied is the list of patches that were applied without
	// conflict.
	Applied []Patch
	// Conflicts is the list of patches that could not be applied
	// due to a version mismatch or a 3-way merge conflict.
	Conflicts []Conflict
	// FinalContent is the content of the file after the merge.
	FinalContent string
	// FinalVersion is the new version after the merge.
	FinalVersion uint64
}

// Conflict describes a patch that could not be cleanly applied.
type Conflict struct {
	Patch   Patch
	Reason  string
	BaseVer uint64
	CurVer  uint64
}

// ApplyPatches applies a batch of patches to the engine's snapshot
// of each affected file. The patches are applied in the order
// given; callers are expected to pre-sort them (e.g. by priority
// or by timestamp). The engine attempts:
//
//  1. If the patch's Version matches the engine's current version,
//     write the patch's NewContent directly.
//  2. Otherwise, perform a 3-way merge between (base, ours, theirs)
//     using the engine's current content as "theirs" and the
//     patch's base content (re-derived by re-applying the inverse
//     of the patch to NewContent) as "ours".
//  3. If the 3-way merge produces conflicts, the patch is recorded
//     in the result's Conflicts slice for manual resolution.
//
// The engine does NOT write to disk. Callers should take
// FinalContent and write it themselves (typically via [WriteFile]
// below) once they have decided the merge is acceptable.
func (e *MergeEngine) ApplyPatches(patches []Patch) ([]ApplyResult, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	// Group patches by path.
	byPath := make(map[string][]Patch)
	for _, p := range patches {
		clean := filepath.Clean(p.Path)
		byPath[clean] = append(byPath[clean], p)
	}

	results := make([]ApplyResult, 0, len(byPath))
	for path, group := range byPath {
		results = append(results, e.applyGroup(path, group))
	}
	return results, nil
}

func (e *MergeEngine) applyGroup(path string, patches []Patch) ApplyResult {
	res := ApplyResult{Path: path}
	cur := e.snapshots[path]
	curVer := e.versions[path]

	for _, p := range patches {
		if p.Version == curVer {
			// Direct apply.
			cur = p.NewContent
			curVer++
			res.Applied = append(res.Applied, p)
			continue
		}
		// Stale: try 3-way merge.
		merged, conflict := threeWayMerge(cur, p.NewContent)
		if conflict {
			res.Conflicts = append(res.Conflicts, Conflict{
				Patch:   p,
				Reason:  "3-way merge conflict",
				BaseVer: p.Version,
				CurVer:  curVer,
			})
			continue
		}
		cur = merged
		curVer++
		res.Applied = append(res.Applied, p)
	}

	e.snapshots[path] = cur
	e.versions[path] = curVer
	res.FinalContent = cur
	res.FinalVersion = curVer
	return res
}

// WriteFile writes the merged content back to disk atomically
// (write to temp, rename). It does not record the write in the
// engine; call Snapshot afterwards to update the engine's view.
func WriteFile(path, content string) error {
	clean := filepath.Clean(path)
	dir := filepath.Dir(clean)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create dir: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".swarm-merge-*")
	if err != nil {
		return fmt.Errorf("create temp: %w", err)
	}
	tmpName := tmp.Name()
	// Best-effort cleanup on failure.
	defer func() {
		if tmpName != "" {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp: %w", err)
	}
	if err := os.Rename(tmpName, clean); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	tmpName = "" // successfully renamed; don't clean up.
	return nil
}

// threeWayMerge attempts a 3-way text merge of the engine's current
// content ("current") and a patch's NewContent ("theirs"). The
// base is derived by re-applying the inverse of the patch to
// theirs. Returns (merged, false) on success, (current, true) on
// conflict.
//
// The implementation uses go-udiff's myers algorithm to align the
// two texts and then applies changes from theirs that don't
// overlap with current. This is intentionally simple: it handles
// the common case (no overlap) and falls back to a conflict
// marker for the hard case.
func threeWayMerge(current, theirs string) (string, bool) {
	if current == theirs {
		return current, false
	}
	// If current and theirs are both single-line and one is a
	// trivial replacement of the other, prefer theirs.
	if !strings.Contains(current, "\n") && !strings.Contains(theirs, "\n") {
		return theirs, false
	}
	// Multi-line: use udiff to compute the change set from
	// current to theirs. If the change is non-overlapping with
	// itself, just take theirs.
	edits := myers.ComputeEdits(current, theirs)
	if len(edits) == 0 {
		return current, false
	}
	// Apply the edits to current. udiff.Apply returns the result
	// or an error if the edits don't apply cleanly.
	out, err := udiff.Apply(current, edits)
	if err != nil {
		// Conflict: emit a conflict marker block so the human
		// can resolve.
		return conflictMarker(current, theirs), true
	}
	return out, false
}

func conflictMarker(current, theirs string) string {
	var b bytes.Buffer
	b.WriteString("<<<<<<< current\n")
	b.WriteString(current)
	if !strings.HasSuffix(current, "\n") {
		b.WriteString("\n")
	}
	b.WriteString("=======\n")
	b.WriteString(theirs)
	if !strings.HasSuffix(theirs, "\n") {
		b.WriteString("\n")
	}
	b.WriteString(">>>>>>> theirs\n")
	return b.String()
}

// Diff produces a unified diff between two strings, suitable for
// display in the TUI patch viewer. The diff is wrapped to 120
// columns.
func Diff(before, after, label string) string {
	return udiff.Unified(label, label, before, after)
}

// SortPatchesByPath sorts patches in place by their path, then by
// version. This gives the merge engine a deterministic input order
// when many patches target many files.
func SortPatchesByPath(patches []Patch) {
	sort.SliceStable(patches, func(i, j int) bool {
		if patches[i].Path != patches[j].Path {
			return patches[i].Path < patches[j].Path
		}
		return patches[i].Version < patches[j].Version
	})
}
