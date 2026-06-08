package sdk

import "context"

// Agent describes the core agent runtime primitive.
type Agent interface {
	Run(ctx context.Context, req RunRequest) (RunResult, error)
}

type RunRequest struct {
	Prompt     string
	SessionID  string
	MaxTokens  int
}

type RunResult struct {
	Output string
	Tokens int
}
