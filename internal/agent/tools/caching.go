// Package tools provides MOCHI's built-in agent tools. This file
// adds a small read-only-result caching middleware that wraps the
// inner function of a fantasy.AgentTool. The model's tool-call
// loop frequently re-invokes the same read tools with the same
// arguments as it reasons about a workspace. Caching the tool
// responses for a few seconds collapses those duplicates into a
// single filesystem access and a single tool-result round-trip
// in the conversation, which compounds into a significant
// speedup over a multi-step task.
package tools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"

	"charm.land/fantasy"
)

// ToolResultCache is a thread-safe TTL cache for read-only tool
// responses. Mutating tools (edit, write, multiedit) call
// InvalidateAll to drop the cache on every successful mutation.
type ToolResultCache struct {
	mu    sync.RWMutex
	items map[string]cacheEntry
	ttl   time.Duration
	hits  uint64
	miss  uint64
}

type cacheEntry struct {
	resp      fantasy.ToolResponse
	expiresAt time.Time
}

// NewToolResultCache returns a cache with the given TTL. A TTL
// of 0 or less means 2 seconds.
func NewToolResultCache(ttl time.Duration) *ToolResultCache {
	if ttl <= 0 {
		ttl = 2 * time.Second
	}
	return &ToolResultCache{
		items: make(map[string]cacheEntry),
		ttl:   ttl,
	}
}

// Stats returns cumulative hit and miss counts.
func (c *ToolResultCache) Stats() (uint64, uint64) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.hits, c.miss
}

// InvalidateAll drops every cached entry.
func (c *ToolResultCache) InvalidateAll() {
	c.mu.Lock()
	c.items = make(map[string]cacheEntry)
	c.mu.Unlock()
}

func (c *ToolResultCache) get(key string) (fantasy.ToolResponse, bool) {
	c.mu.RLock()
	e, ok := c.items[key]
	c.mu.RUnlock()
	if !ok {
		c.mu.Lock()
		c.miss++
		c.mu.Unlock()
		return fantasy.ToolResponse{}, false
	}
	if time.Now().After(e.expiresAt) {
		c.mu.Lock()
		delete(c.items, key)
		c.miss++
		c.mu.Unlock()
		return fantasy.ToolResponse{}, false
	}
	c.mu.Lock()
	c.hits++
	c.mu.Unlock()
	return e.resp, true
}

func (c *ToolResultCache) put(key string, resp fantasy.ToolResponse) {
	c.mu.Lock()
	c.items[key] = cacheEntry{
		resp:      resp,
		expiresAt: time.Now().Add(c.ttl),
	}
	c.mu.Unlock()
}

func cacheKey(name string, params any) string {
	b, err := json.Marshal(params)
	if err != nil {
		return name
	}
	h := sha256.New()
	h.Write([]byte(name))
	h.Write([]byte{0})
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil))[:32]
}

// WithResultCache returns a fantasy.AgentTool that delegates to
// inner and caches its (name, args) -> response mapping for the
// cache's TTL. Errors are not cached.
func WithResultCache[T any](
	cache *ToolResultCache,
	inner fantasy.AgentTool,
) fantasy.AgentTool {
	return fantasy.NewAgentTool(
		inner.Info().Name,
		inner.Info().Description,
		func(ctx context.Context, params T, call fantasy.ToolCall) (fantasy.ToolResponse, error) {
			key := cacheKey(inner.Info().Name, params)
			if resp, ok := cache.get(key); ok {
				return resp, nil
			}
			resp, err := inner.Run(ctx, call)
			if err == nil {
				cache.put(key, resp)
			}
			return resp, err
		},
	)
}

// WithSpeculativeReadAhead wraps inner with both a result cache
// and a speculative pre-executor. After inner returns a
// response, the wrapper scans it for file paths (via the
// supplied extractor) and schedules speculative view calls on
// the first N files in the background. The speculative views
// land in the same cache, so a subsequent view call for one of
// those files returns instantly.
//
// extractor is a function that takes the response and returns
// the list of file paths to speculate on. Typical extractors
// are ExtractFilePathsFromLS and ExtractFilePathsFromGrep.
func WithSpeculativeReadAhead[T any](
	cache *ToolResultCache,
	speculator *Speculator,
	view fantasy.AgentTool,
	inner fantasy.AgentTool,
) fantasy.AgentTool {
	// Pick the right extractor based on the inner tool's name.
	var extractor func(string) []string
	switch inner.Info().Name {
	case "ls":
		extractor = ExtractFilePathsFromLS
	case "grep":
		extractor = ExtractFilePathsFromGrep
	case "glob":
		extractor = ExtractFilePathsFromGrep
	}
	return fantasy.NewAgentTool(
		inner.Info().Name,
		inner.Info().Description,
		func(ctx context.Context, params T, call fantasy.ToolCall) (fantasy.ToolResponse, error) {
			key := cacheKey(inner.Info().Name, params)
			if resp, ok := cache.get(key); ok {
				return resp, nil
			}
			resp, err := inner.Run(ctx, call)
			if err == nil {
				cache.put(key, resp)
				// Speculative read-ahead: scan the response
				// for file paths and pre-view the first N in
				// the background.
				if speculator != nil && extractor != nil {
					if paths := extractPathsFromResponse(resp, extractor); len(paths) > 0 {
						speculator.PreReadFiles(ctx, view, cache, paths)
					}
				}
			}
			return resp, err
		},
	)
}

// extractPathsFromResponse runs the extractor over the
// response's content string.
func extractPathsFromResponse(resp fantasy.ToolResponse, extractor func(string) []string) []string {
	if resp.Content == "" {
		return nil
	}
	return extractor(resp.Content)
}
