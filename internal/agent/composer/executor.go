package composer

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Plan represents a workflow composed of ordered steps.
type Plan struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Steps     []Step    `json:"steps"`
}

// Step is a single unit of work inside a Plan.
type Step struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Status   string `json:"status"`
	Priority int    `json:"priority"`
}

// DefaultPlanner builds simple linear plans from a goal.
type DefaultPlanner struct{}

// Plan builds a new Plan for the given goal.
func (p *DefaultPlanner) Plan(_ context.Context, goal string) (*Plan, error) {
	now := time.Now()
	return &Plan{
		ID:        "plan-" + now.Format("20060102150405"),
		Name:      goal,
		Status:    "planned",
		CreatedAt: now,
		UpdatedAt: now,
		Steps: []Step{
			{ID: "step-1", Title: "Inspect codebase context", Status: "pending", Priority: 1},
			{ID: "step-2", Title: "Identify risks and constraints", Status: "pending", Priority: 2},
			{ID: "step-3", Title: "Apply minimal change", Status: "pending", Priority: 3},
			{ID: "step-4", Title: "Verify and summarize", Status: "pending", Priority: 4},
		},
	}, nil
}

// DefaultExecutor runs a Plan step by step.
type DefaultExecutor struct {
	mu     sync.RWMutex
	runner func(ctx context.Context, step Step) (string, error)
}

// NewDefaultExecutor returns an executor without a runner attached.
func NewDefaultExecutor() *DefaultExecutor {
	return &DefaultExecutor{}
}

// WithRunner attaches a default runner to the executor.
func (e *DefaultExecutor) WithRunner(runner func(ctx context.Context, step Step) (string, error)) *DefaultExecutor {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.runner = runner
	return e
}

func (e *DefaultExecutor) runnerFor(step Step) func(ctx context.Context, step Step) (string, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.runner
}

// Execute runs the Plan to completion or first failure.
func (e *DefaultExecutor) Execute(ctx context.Context, plan *Plan) error {
	if plan == nil {
		return errors.New("plan is nil")
	}

	plan.Status = "running"
	plan.UpdatedAt = time.Now()

	for idx := range plan.Steps {
		step := &plan.Steps[idx]
		if step == nil {
			continue
		}
		step.Status = "running"

		runner := e.runnerFor(*step)
		if runner == nil {
			step.Status = "skipped"
			continue
		}

		_, err := runner(ctx, *step)
		plan.UpdatedAt = time.Now()
		if err != nil {
			step.Status = "failed"
			plan.Status = "failed"
			return err
		}
		step.Status = "completed"
	}

	plan.Status = "completed"
	plan.UpdatedAt = time.Now()
	return nil
}

// ExecutePlan is a compatibility wrapper used by older call sites.
func (e *DefaultExecutor) ExecutePlan(ctx context.Context, plan *Plan) error {
	return e.Execute(ctx, plan)
}
