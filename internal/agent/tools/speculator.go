// Package tools provides MOCHI's built-in agent tools. This file
// adds speculative tool execution: when the model calls ls or
// grep and the response contains a list of file paths, we
// speculatively pre-read the first N files in the background.
// The pre-reads go into the read-tool cache, so a subsequent
// view call for one of those files returns instantly.
//
// This is "speculative" in the same sense as CPU branch
// prediction: we make an educated guess about what the model
// will do next, and we pre-do the work. If the guess is right,
// we saved a tool round-trip (and a filesystem access). If the
// guess is wrong, we wasted some background work that has no
// side effects (read-only tool calls are idempotent and
// sandboxed). The win on the right guess is much larger than
// the cost of the wrong guess, so this is a positive-EV
// optimization.
//
// Only read-only tools participate. Mutating tools (edit,
// write, multiedit) are never speculated.
package tools

import (
	"context"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"charm.land/fantasy"
)

// Speculator runs background tool executions after the model
// calls a list-producing tool (ls, grep) and pre-populates the
// read-tool cache with the likely next tool calls. It is safe
// for concurrent use; a zero-value Speculator is a no-op.
type Speculator struct {
	// maxFiles caps how many files are pre-read per call. The
	// default is 5; more is wasted work for typical reasoning
	// chains where the model only views 1-2 files.
	maxFiles int
	// viewTimeout caps each speculative view call. Default 5s.
	viewTimeout time.Duration
	// inflight tracks running speculative calls so we can
	// cancel them on shutdown.
	inflight sync.WaitGroup
}

// NewSpeculator returns a Speculator with sensible defaults.
func NewSpeculator() *Speculator {
	return &Speculator{
		maxFiles:    5,
		viewTimeout: 5 * time.Second,
	}
}

// Shutdown waits for all in-flight speculative calls to finish
// or for the context to be cancelled.
func (s *Speculator) Shutdown(ctx context.Context) {
	done := make(chan struct{})
	go func() {
		s.inflight.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// PreReadFiles speculatively reads up to maxFiles files using
// the given cache (so the pre-reads populate the cache) and
// returns immediately. Errors are swallowed because
// speculative work is best-effort.
func (s *Speculator) PreReadFiles(
	ctx context.Context,
	view fantasy.AgentTool,
	cache *ToolResultCache,
	files []string,
) {
	if s == nil || len(files) == 0 {
		return
	}
	limit := len(files)
	if s.maxFiles > 0 && limit > s.maxFiles {
		limit = s.maxFiles
	}
	for i := 0; i < limit; i++ {
		f := files[i]
		// Skip non-files quickly.
		if f == "" || strings.HasSuffix(f, "/") {
			continue
		}
		// Capture loop var.
		file := f
		s.inflight.Add(1)
		go func() {
			defer s.inflight.Done()
			cctx, cancel := context.WithTimeout(ctx, s.viewTimeout)
			defer cancel()
			// Pre-call directly using the inner function so we
			// bypass the wrap-and-cache path and can populate
			// the cache explicitly with the same key the next
			// view call will use.
			key := cacheKey(view.Info().Name, ViewParams{FilePath: file})
			if _, ok := cache.get(key); ok {
				return // already cached
			}
			resp, err := view.Run(cctx, fantasy.ToolCall{
				Name:  view.Info().Name,
				Input: `{"file_path":"` + filepath.ToSlash(file) + `"}`,
			})
			if err != nil {
				return
			}
			cache.put(key, resp)
		}()
	}
}

// ExtractFilePathsFromLS scans an LS-style tool response for
// file paths. The LS tool formats its output as a tree; we
// look for non-indented lines or lines starting at column 0
// that contain plausible file suffixes.
func ExtractFilePathsFromLS(text string) []string {
	if text == "" {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		// LS tree lines look like:
		//   "├── foo.go"
		//   "└── bar/"
		//   "baz.txt"
		// We strip the tree chrome and keep anything that
		// looks like a path.
		cleaned := stripTreeChrome(line)
		if cleaned == "" {
			continue
		}
		if !looksLikeFilePath(cleaned) {
			continue
		}
		if !seen[cleaned] {
			seen[cleaned] = true
			out = append(out, cleaned)
		}
	}
	return out
}

// ExtractFilePathsFromGrep scans a Grep-style tool response
// for file paths. Grep output looks like:
//
//	./internal/foo.go:42:matched text
//	internal/bar.go:17:another match
var grepFileLineRe = regexp.MustCompile(`^([^\s:]+?\.[a-zA-Z0-9]{1,8})(?::\d+)?:`)

func ExtractFilePathsFromGrep(text string) []string {
	if text == "" {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	for _, line := range strings.Split(text, "\n") {
		m := grepFileLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		path := strings.TrimPrefix(m[1], "./")
		if !seen[path] {
			seen[path] = true
			out = append(out, path)
		}
	}
	return out
}

func stripTreeChrome(line string) string {
	// Common tree-output prefixes: "├── ", "└── ", "│   ", "    ".
	for _, prefix := range []string{"├── ", "└── ", "│   ", "│   ", "    "} {
		line = strings.TrimPrefix(line, prefix)
	}
	// Drop trailing annotations like "(symlink)".
	if idx := strings.Index(line, " ("); idx > 0 {
		line = line[:idx]
	}
	return strings.TrimSpace(line)
}

func looksLikeFilePath(s string) bool {
	if s == "" || strings.ContainsAny(s, " \t\"") {
		return false
	}
	// Must have a slash OR a file extension.
	if strings.Contains(s, "/") {
		return true
	}
	if strings.Contains(s, ".") && !strings.HasPrefix(s, ".") {
		return true
	}
	return false
}
