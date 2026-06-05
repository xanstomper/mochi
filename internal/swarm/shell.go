package swarm

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// CoordinatorAdapter is the minimal interface a swarm agent needs
// from the MOCHI coordinator. Defining it here (rather than
// importing the MOCHI agent package) avoids an import cycle: the
// swarm package needs to know the Agent interface, the agents
// subpackage implements ShellAgent which calls the coordinator,
// and the runtime's caller wires the concrete coordinator in.
type CoordinatorAdapter interface {
	Run(ctx context.Context, sessionID, prompt string) (CoordinatorResult, error)
	Cancel(sessionID string)
	CancelAll()
}

// CoordinatorResult is the subset of the MOCHI agent result that
// the swarm cares about. The concrete coordinator implementation
// adapts its full result type to this minimal shape.
type CoordinatorResult struct {
	Text      string
	TokensIn  int64
	TokensOut int64
}

// TierSpec describes a single agent tier: its display name and the
// system prompt fragment that biases the LLM toward the tier's
// specialty. The full set of tools is the union of every tool the
// MOCHI coordinator exposes; per-tier permission scoping is a
// follow-up.
type TierSpec struct {
	Tier         Tier
	Name         string
	PromptHeader string
	AllowedTools []string
	IsSubAgent   bool
}

// DefaultRegistry returns a Registry pre-populated with the
// standard tier set.
func DefaultRegistry() *Registry {
	r := &Registry{specs: make(map[Tier]TierSpec)}
	for _, s := range builtinTierSpecs() {
		r.specs[s.Tier] = s
	}
	return r
}

// Registry is the catalogue of all known tiers.
type Registry struct {
	mu    sync.RWMutex
	specs map[Tier]TierSpec
}

// Spec returns the TierSpec for the given tier.
func (r *Registry) Spec(t Tier) (TierSpec, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.specs[t]
	return s, ok
}

// Register adds or overrides a tier spec.
func (r *Registry) Register(s TierSpec) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.specs[s.Tier] = s
}

// All returns all registered tier specs.
func (r *Registry) All() []TierSpec {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]TierSpec, 0, len(r.specs))
	for _, s := range r.specs {
		out = append(out, s)
	}
	return out
}

// builtinTierSpecs returns the canonical tier set.
func builtinTierSpecs() []TierSpec {
	return []TierSpec{
		{Tier: TierMaster, Name: "Master Orchestrator", PromptHeader: "You are the Master Orchestrator. Plan and orchestrate; do not write code directly.", IsSubAgent: true},
		{Tier: TierPlanner, Name: "Planner", PromptHeader: "You are the Planner. Break a mission into a dependency-aware task DAG. Do not write code.", IsSubAgent: true},
		{Tier: TierArchitect, Name: "Architect", PromptHeader: "You are the Architect. Review designs for correctness, scalability, and consistency.", IsSubAgent: true},
		{Tier: TierBackend, Name: "Backend Specialist", PromptHeader: "You are the Backend Specialist. Write Go, Rust, Python, and other server-side code."},
		{Tier: TierFrontend, Name: "Frontend Specialist", PromptHeader: "You are the Frontend Specialist. Write TypeScript, React, and CSS."},
		{Tier: TierRuntime, Name: "Runtime Specialist", PromptHeader: "You are the Runtime Specialist. Work on the agent runtime, scheduler, and orchestration layers."},
		{Tier: TierRefactor, Name: "Refactor Specialist", PromptHeader: "You are the Refactor Specialist. Improve existing code without changing behaviour."},
		{Tier: TierDocumentation, Name: "Documentation Specialist", PromptHeader: "You are the Documentation Specialist. Write and update documentation."},
		{Tier: TierQA, Name: "QA Specialist", PromptHeader: "You are the QA Specialist. Write and run tests; do not modify production code."},
		{Tier: TierSecurity, Name: "Security Specialist", PromptHeader: "You are the Security Specialist. Audit for OWASP Top 10 and secrets; do not auto-fix."},
		{Tier: TierIntegration, Name: "Integration Specialist", PromptHeader: "You are the Integration Specialist. Merge parallel changes, resolve conflicts, run the build."},
		{Tier: TierPerformance, Name: "Performance Specialist", PromptHeader: "You are the Performance Specialist. Profile, benchmark, optimise; never change behaviour."},
	}
}

// ShellAgent is a swarm.Agent that wraps a MOCHI coordinator. The
// adapter is supplied at construction time; the agent creates a
// sub-session per task, runs the LLM with a tier-specific system
// prompt, and returns the outcome.
type ShellAgent struct {
	id        AgentID
	tier      Tier
	spec      TierSpec
	coord     CoordinatorAdapter
	mu        sync.Mutex
	cancelled bool
	logger    *slog.Logger
}

// NewShellAgent constructs a ShellAgent.
func NewShellAgent(id AgentID, tier Tier, spec TierSpec, coord CoordinatorAdapter, logger *slog.Logger) *ShellAgent {
	if logger == nil {
		logger = slog.Default()
	}
	return &ShellAgent{
		id:     id,
		tier:   tier,
		spec:   spec,
		coord:  coord,
		logger: logger,
	}
}

// ID implements Agent.
func (a *ShellAgent) ID() AgentID { return a.id }

// Tier implements Agent.
func (a *ShellAgent) Tier() Tier { return a.tier }

// Spec returns the tier spec the agent was built with.
func (a *ShellAgent) Spec() TierSpec { return a.spec }

// Cancel interrupts the agent's current task.
func (a *ShellAgent) Cancel() {
	a.mu.Lock()
	a.cancelled = true
	a.mu.Unlock()
	a.coord.CancelAll()
}

// Run executes a single task.
func (a *ShellAgent) Run(ctx context.Context, t Task) TaskResult {
	a.mu.Lock()
	a.cancelled = false
	a.mu.Unlock()

	// Build the prompt with the tier header prepended.
	prompt := a.spec.PromptHeader + "\n\n" + t.Description
	if t.Result != "" {
		prompt += "\n\nPrior result:\n" + t.Result
	}

	// Use the task ID as the session ID. The MOCHI coordinator
	// keys sessions by string; we want each agent task to have
	// its own session so a follow-up task can resume from the
	// prior result. For now, every task gets a fresh session.
	sessionID := fmt.Sprintf("swarm-%s-%d", t.ID, time.Now().UnixNano())

	res, err := a.coord.Run(ctx, sessionID, prompt)
	if err != nil {
		return TaskResult{Error: err}
	}
	return TaskResult{
		Result:    res.Text,
		TokensIn:  res.TokensIn,
		TokensOut: res.TokensOut,
	}
}
