package tools

import (
	"context"
	_ "embed"
	"fmt"
	"strings"

	"charm.land/fantasy"

	"github.com/mochi/mochi/internal/memory"
)

const MemoryToolName = "memory"

// MemoryParams defines the parameters for the memory tool.
type MemoryParams struct {
	// Action is one of: save, search, list, delete.
	Action string `json:"action" description:"The action to perform: save, search, list, delete"`

	// Key is the memory key (required for save, delete).
	Key string `json:"key,omitempty" description:"Memory key (required for save and delete)"`

	// Value is the memory value (required for save).
	Value string `json:"value,omitempty" description:"Memory value to store (required for save)"`

	// Category is the optional memory category (save only).
	Category string `json:"category,omitempty" description:"Memory category: user_pref, project, convention, fact, error, general (default: general)"`

	// Importance is the importance score 0.0-1.0 (save only, default: 0.5).
	Importance float64 `json:"importance,omitempty" description:"Importance score 0.0-1.0 (default: 0.5)"`

	// Query is the search string (required for search).
	Query string `json:"query,omitempty" description:"Search query (required for search)"`

	// Limit is the max number of results (optional, default: 10).
	Limit int `json:"limit,omitempty" description:"Max results (default: 10)"`
}

//go:embed memory.md
var memoryDescription string

func NewMemoryTool(memService memory.Service) fantasy.AgentTool {
	return fantasy.NewAgentTool(
		MemoryToolName,
		memoryDescription,
		func(ctx context.Context, params MemoryParams, call fantasy.ToolCall) (fantasy.ToolResponse, error) {
			action := strings.ToLower(params.Action)
			switch action {
			case "save":
				return handleMemorySave(ctx, memService, params)
			case "search":
				return handleMemorySearch(ctx, memService, params)
			case "list":
				return handleMemoryList(ctx, memService, params)
			case "delete":
				return handleMemoryDelete(ctx, memService, params)
			default:
				return fantasy.NewTextErrorResponse(
					fmt.Sprintf("Unknown memory action %q. Valid actions: save, search, list, delete", params.Action),
				), nil
			}
		},
	)
}

func handleMemorySave(ctx context.Context, memService memory.Service, params MemoryParams) (fantasy.ToolResponse, error) {
	if params.Key == "" {
		return fantasy.NewTextErrorResponse("key is required for save action"), nil
	}
	if params.Value == "" {
		return fantasy.NewTextErrorResponse("value is required for save action"), nil
	}

	category := params.Category
	if category == "" {
		category = memory.CategoryGeneral
	}
	importance := params.Importance
	if importance <= 0 || importance > 1 {
		importance = memory.ImportanceMedium
	}

	entry, err := memService.Store(ctx, params.Key, params.Value, category, "", "", importance)
	if err != nil {
		return fantasy.NewTextErrorResponse(fmt.Sprintf("Failed to save memory: %s", err)), nil
	}

	return fantasy.NewTextResponse(fmt.Sprintf(
		"Saved memory [%s] %s = %s (importance: %.1f)",
		entry.Category, entry.Key, truncateMemory(entry.Value, 80), entry.Importance,
	)), nil
}

func handleMemorySearch(ctx context.Context, memService memory.Service, params MemoryParams) (fantasy.ToolResponse, error) {
	if params.Query == "" {
		return fantasy.NewTextErrorResponse("query is required for search action"), nil
	}

	limit := params.Limit
	if limit <= 0 {
		limit = 10
	}

	entries, err := memService.Search(ctx, params.Query, limit)
	if err != nil {
		return fantasy.NewTextErrorResponse(fmt.Sprintf("Failed to search memories: %s", err)), nil
	}

	if len(entries) == 0 {
		return fantasy.NewTextResponse("No matching memories found."), nil
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Found %d memories:\n", len(entries))
	for _, e := range entries {
		fmt.Fprintf(&b, "  [%s] %s: %s (importance: %.1f)\n",
			e.Category, e.Key, truncateMemory(e.Value, 120), e.Importance)
	}
	return fantasy.NewTextResponse(b.String()), nil
}

func handleMemoryList(ctx context.Context, memService memory.Service, params MemoryParams) (fantasy.ToolResponse, error) {
	limit := params.Limit
	if limit <= 0 {
		limit = 10
	}

	entries, err := memService.GetTop(ctx, limit)
	if err != nil {
		return fantasy.NewTextErrorResponse(fmt.Sprintf("Failed to list memories: %s", err)), nil
	}

	if len(entries) == 0 {
		return fantasy.NewTextResponse("No memories stored yet."), nil
	}

	var b strings.Builder
	fmt.Fprintf(&b, "Top %d memories:\n", len(entries))
	for _, e := range entries {
		fmt.Fprintf(&b, "  [%s] %s: %s (importance: %.1f, key: %s)\n",
			e.Category, e.Key, truncateMemory(e.Value, 80), e.Importance, e.Key)
	}
	fmt.Fprintf(&b, "\nTip: Use action=search with query=<term> to find specific memories.\n")
	return fantasy.NewTextResponse(b.String()), nil
}

func handleMemoryDelete(ctx context.Context, memService memory.Service, params MemoryParams) (fantasy.ToolResponse, error) {
	// Try deleting by key first.
	if params.Key != "" {
		entry, err := memService.GetByKey(ctx, params.Key)
		if err == nil {
			if err := memService.Delete(ctx, entry.ID); err != nil {
				return fantasy.NewTextErrorResponse(fmt.Sprintf("Failed to delete memory: %s", err)), nil
			}
			return fantasy.NewTextResponse(fmt.Sprintf("Deleted memory %q (key: %s)", params.Key, entry.Key)), nil
		}
		return fantasy.NewTextErrorResponse(fmt.Sprintf("Memory with key %q not found", params.Key)), nil
	}

	return fantasy.NewTextErrorResponse("key is required for delete action"), nil
}

func truncateMemory(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
