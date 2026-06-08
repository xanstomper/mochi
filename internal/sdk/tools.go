package sdk

import "context"

// ToolRegistry is the primitive for registering and managing tools.
type ToolRegistry interface {
	Register(name string, tool Tool) error
	Get(name string) (Tool, bool)
	List() []string
}

type Tool interface {
	Name() string
	Description() string
	Execute(ctx context.Context, args map[string]any) (ToolResult, error)
}

type ToolResult struct {
	Data  any
	Error error
}
