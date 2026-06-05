package cmd

import (
	"context"
	"fmt"
	"strings"

	"charm.land/fantasy"
	"github.com/mochi/mochi/internal/agent"
	"github.com/mochi/mochi/internal/swarm"
)

// MOCHIAdapter wraps a real MOCHI agent.Coordinator so the swarm
// runtime can dispatch work to live LLM sessions. Each task gets
// its own sessionID (keyed by RunID + TaskID) so concurrent
// agents don't share message history.
type MOCHIAdapter struct {
	coord agent.Coordinator
}

func newMOCHIAdapter(coord agent.Coordinator) swarm.CoordinatorAdapter {
	return &MOCHIAdapter{coord: coord}
}

// sessionIDFor returns a stable, swarm-scoped session key for a
// given (run, task) pair. Using RunID and TaskID directly keeps
// sessions disjoint across concurrent runs and across tasks
// inside one run.
func (a *MOCHIAdapter) sessionIDFor(runID swarm.RunID, taskID swarm.TaskID) string {
	return fmt.Sprintf("swarm:%s:%s", runID, taskID)
}

// Run implements swarm.CoordinatorAdapter. It blocks until the
// underlying MOCHI agent finishes the turn, then returns the
// final response text. Errors are propagated verbatim so the
// scheduler can mark the task as failed and schedule a retry.
func (a *MOCHIAdapter) Run(ctx context.Context, sessionID, prompt string) (swarm.CoordinatorResult, error) {
	res, err := a.coord.Run(ctx, sessionID, prompt)
	if err != nil {
		return swarm.CoordinatorResult{}, err
	}
	return agentResultToSwarm(res), nil
}

func (a *MOCHIAdapter) Cancel(sessionID string) { a.coord.Cancel(sessionID) }
func (a *MOCHIAdapter) CancelAll()              { a.coord.CancelAll() }

// agentResultToSwarm flattens a fantasy.AgentResult into the
// shape the swarm runtime expects.
func agentResultToSwarm(res *fantasy.AgentResult) swarm.CoordinatorResult {
	if res == nil {
		return swarm.CoordinatorResult{}
	}
	var b strings.Builder
	// Per-step responses are mostly tool turns; we capture any
	// text the model emitted on each step so we can also see
	// intermediate reasoning, but the final response below is
	// what callers actually consume.
	for _, step := range res.Steps {
		if text := step.Response.Content.Text(); text != "" {
			b.WriteString(text)
			b.WriteString("\n")
		}
	}
	// The final response is what the agent decided to return to
	// the user. If it's non-empty, it wins; otherwise we fall
	// back to the concatenated step text.
	if final := res.Response.Content.Text(); final != "" {
		b.Reset()
		b.WriteString(final)
	}
	return swarm.CoordinatorResult{
		Text:      strings.TrimSpace(b.String()),
		TokensIn:  res.TotalUsage.InputTokens,
		TokensOut: res.TotalUsage.OutputTokens,
	}
}
