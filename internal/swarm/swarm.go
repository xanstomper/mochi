// Package swarm implements the MOCHI Hermes Swarm Runtime — a multi-agent
// orchestration layer that drives 1-30 specialist AI agents against a
// shared task DAG, persistent project memory, and a file lock manager.
//
// The runtime is the next layer up from a single SessionAgent. Where a
// SessionAgent runs a single LLM conversation per session, the swarm
// runtime:
//
//   - Plans work: a Planner agent decomposes a high-level mission into
//     a Task DAG with explicit dependencies.
//   - Schedules work: a work-stealing scheduler picks ready tasks and
//     hands them to a free agent in the pool, retrying on failure with
//     exponential backoff and self-healing blocked edges.
//   - Runs in parallel: the agent pool scales from 1 to 30 specialists
//     (master, planner, architect, backend, frontend, runtime, refactor,
//     qa, security, build, docs, integration) and spawns on-demand
//     specialists (rust, react, electron, compiler, db, ux, testing,
//     devops).
//   - Shares state: a persistent project memory (SQLite-backed) holds
//     architecture knowledge, build outcomes, and error patterns that
//     every agent in the pool can read and write.
//   - Edits safely: a file lock manager serialises concurrent edits to
//     the same path and a 3-way merge engine reconciles patches produced
//     by parallel specialists.
//   - Self-modifies: the runtime can analyse its own source, generate a
//     diff, validate it, rebuild, run tests, and deploy the change —
//     all without human intervention except for destructive operations.
//
// Design priorities (in order):
//
//   - Correctness of the DAG and lock manager over raw throughput.
//   - Throughput (RPM mode) is a configuration, not a default. The
//     scheduler always prefers correctness first.
//   - No global state. Every component is wired through explicit
//     dependencies and is safe to instantiate multiple times.
//   - All cross-component messaging goes through the existing
//     internal/pubsub broker so the TUI can subscribe to a single
//     stream of swarm events.
//
// Thread safety: the [Runtime] is safe for concurrent use after
// construction. Tasks may be submitted from any goroutine; the scheduler
// dispatches them to a free agent or queues them.
package swarm

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"
)

// Phase is the top-level state machine for a swarm run. The runtime
// transitions through these in order; a run never goes backwards.
type Phase string

const (
	// PhasePlanning: a single Planner agent decomposes the mission
	// into a Task DAG.
	PhasePlanning Phase = "planning"
	// PhaseExecuting: agents pull ready tasks and run them in
	// parallel.
	PhaseExecuting Phase = "executing"
	// PhaseValidating: QA, security, and integration agents audit the
	// merged changes. Validation tasks always run in their own tier
	// after the execution tier is drained.
	PhaseValidating Phase = "validating"
	// PhaseIntegrating: the integrator agent merges validated
	// changes, runs the build, runs tests, and (if self-modifying)
	// deploys.
	PhaseIntegrating Phase = "integrating"
	// PhaseDone: terminal state. Either all tasks completed or the
	// runtime was cancelled; check the run report for the outcome.
	PhaseDone Phase = "done"
)

// Mode controls the runtime's throughput vs. safety tradeoff. Plain
// [ModeBalanced] is the default; [ModeRPM] is the throughput-mode
// behaviour from the master spec — spawn-on-demand, max agents,
// prioritise completion over token savings.
type Mode string

const (
	// ModeBalanced is the default. Max parallel tasks = 4, agents
	// spawn only when a task of a new tier is queued, no
	// throughput-priority scheduling.
	ModeBalanced Mode = "balanced"
	// ModeRPM ("Revolutions Per Minute") is the throughput mode.
	// Max agents = 30, max parallel = 16, spawn-on-demand, no
	// approval for internal changes, auto-retry with capped
	// backoff. The runtime still asks for explicit approval before
	// destructive operations (deletes, external deploys).
	ModeRPM Mode = "rpm"
)

// Config is the user-facing configuration for a swarm run. Sensible
// defaults are applied by [DefaultConfig] so most callers can override
// only the fields they care about.
type Config struct {
	// Mode is the throughput/safety tradeoff. Default [ModeBalanced].
	Mode Mode
	// MaxAgents is the upper bound on the agent pool size. The
	// runtime will never spawn more than this many concurrent
	// agents. Default 4 in [ModeBalanced], 30 in [ModeRPM].
	MaxAgents int
	// MaxParallel is the upper bound on the number of tasks a single
	// scheduler tick may dispatch. Default 4 in [ModeBalanced], 16
	// in [ModeRPM].
	MaxParallel int
	// MaxRetries per task before it is marked blocked. Default 3 in
	// [ModeBalanced], 5 in [ModeRPM].
	MaxRetries int
	// BackoffBase is the initial retry backoff. Subsequent retries
	// use BackoffBase * 2^attempt, capped at BackoffMax. Default
	// 250ms.
	BackoffBase time.Duration
	// BackoffMax is the maximum backoff between retries. Default
	// 30s.
	BackoffMax time.Duration
	// WorkingDir is the project root. File locks, memory writes,
	// and the file indexer are scoped to this directory. Required.
	WorkingDir string
	// DataDir is where the swarm SQLite database is stored. If
	// empty, defaults to <WorkingDir>/.MOCHI/swarm.db.
	DataDir string
	// Mission is the high-level goal handed to the planner. Required.
	Mission string
	// RunID is stamped on every event emitted by the runtime. If
	// empty, [NewRuntime] generates a fresh one.
	RunID RunID
	// AutoApprove is the list of operation classes the runtime may
	// perform without prompting the user. The default zero value
	// auto-approves only internal refactors and memory writes; it
	// always asks for destructive deletes and external deploys.
	AutoApprove []OperationClass
}

// DefaultConfig returns a Config populated with sensible defaults for
// the requested mode. Callers can override individual fields after.
func DefaultConfig(mode Mode, workingDir, mission string) Config {
	c := Config{
		Mode:        mode,
		WorkingDir:  workingDir,
		Mission:     mission,
		BackoffBase: 250 * time.Millisecond,
		BackoffMax:  30 * time.Second,
	}
	switch mode {
	case ModeRPM:
		c.MaxAgents = 30
		c.MaxParallel = 16
		c.MaxRetries = 5
	default:
		c.MaxAgents = 4
		c.MaxParallel = 4
		c.MaxRetries = 3
	}
	return c
}

// OperationClass identifies a category of side effect so the runtime
// can decide whether to auto-approve, ask the user, or refuse.
type OperationClass string

const (
	// OpFileEdit covers non-destructive file modifications. Always
	// auto-approved in both modes.
	OpFileEdit OperationClass = "file_edit"
	// OpFileCreate covers creation of new files and directories.
	// Auto-approved in both modes.
	OpFileCreate OperationClass = "file_create"
	// OpFileDelete covers deletion of files or directories. Never
	// auto-approved; the runtime always asks the user, even in
	// RPM mode.
	OpFileDelete OperationClass = "file_delete"
	// OpShell covers non-destructive shell commands. Auto-approved.
	OpShell OperationClass = "shell"
	// OpBuild covers build/test/lint commands. Auto-approved.
	OpBuild OperationClass = "build"
	// OpNetwork covers outbound network calls. Auto-approved for
	// model APIs; otherwise requires user approval.
	OpNetwork OperationClass = "network"
	// OpDeploy covers external deployment (git push, package
	// publish). Never auto-approved; the runtime always asks.
	OpDeploy OperationClass = "deploy"
	// OpSelfMod covers modifications to the runtime's own source
	// code. Auto-approved when the change is internal and
	// well-tested; otherwise requires approval.
	OpSelfMod OperationClass = "self_mod"
)

// IsAutoApproved returns true if the runtime may perform an operation
// of the given class without prompting the user, given the current
// config.
func (c Config) IsAutoApproved(op OperationClass) bool {
	for _, a := range c.AutoApprove {
		if a == op {
			return true
		}
	}
	// Defaults: only the explicit AutoApprove list grants extra
	// permission. OpFileDelete and OpDeploy are NEVER auto-approved
	// regardless of the list.
	switch op {
	case OpFileDelete, OpDeploy:
		return false
	default:
		return true
	}
}

// RunID is a unique identifier for a single swarm run. It is used to
// tag every task, memory write, and event emitted during the run so
// post-mortem analysis can isolate one run from another.
type RunID string

// NewRunID returns a fresh RunID. The format is intentionally short
// (no UUID dashes) so it fits in log lines and event payloads.
func NewRunID() RunID {
	var n uint64
	// Seed from nanosecond clock + atomic counter so two IDs
	// generated in the same nanosecond on the same machine still
	// differ.
	n = uint64(time.Now().UnixNano()) ^ atomic.AddUint64(&runIDSequence, 1)
	return RunID(fmt.Sprintf("swarm-%016x", n))
}

var runIDSequence uint64

// TaskID is a unique identifier for a single task within a run.
type TaskID string

// NewTaskID returns a fresh TaskID scoped to the given run. Two
// TaskIDs from different runs are guaranteed not to collide.
func NewTaskID(runID RunID) TaskID {
	return TaskID(string(runID) + "-" + fmt.Sprintf("%016x", atomic.AddUint64(&taskIDSequence, 1)))
}

var taskIDSequence uint64

// AgentID identifies a specific agent instance within the pool. It is
// stable for the lifetime of the agent; when the agent retires, its
// ID is freed back to the pool.
type AgentID string

// Tier classifies an agent by role. The first three are
// command-layer (always present); the rest are execution-layer and
// validation-layer (spawned on demand).
type Tier string

const (
	TierMaster    Tier = "master"
	TierPlanner   Tier = "planner"
	TierArchitect Tier = "architect"
	// Execution layer.
	TierBackend       Tier = "backend"
	TierFrontend      Tier = "frontend"
	TierRuntime       Tier = "runtime"
	TierRefactor      Tier = "refactor"
	TierDocumentation Tier = "docs"
	// Validation layer.
	TierQA          Tier = "qa"
	TierSecurity    Tier = "security"
	TierIntegration Tier = "integration"
	TierPerformance Tier = "performance"
	// Dynamic specialists — created on demand by the runtime when
	// no existing tier matches the task description.
	TierDynamic Tier = "dynamic"
)

// Priority hints how urgently a task should be picked up. The
// scheduler uses this as a tie-breaker when multiple tasks are ready.
type Priority int

const (
	PriorityLow      Priority = 0
	PriorityNormal   Priority = 1
	PriorityHigh     Priority = 2
	PriorityCritical Priority = 3
)

// TaskStatus is the per-task state machine.
//
//	Pending -> Ready -> Running -> (Succeeded | Failed | Blocked)
//
// Blocked tasks can transition back to Ready if a dependency
// unblocks; Failed tasks can transition to Pending for retry.
type TaskStatus string

const (
	TaskPending   TaskStatus = "pending"
	TaskReady     TaskStatus = "ready"
	TaskRunning   TaskStatus = "running"
	TaskSucceeded TaskStatus = "succeeded"
	TaskFailed    TaskStatus = "failed"
	TaskBlocked   TaskStatus = "blocked"
	TaskCancelled TaskStatus = "cancelled"
)

// IsTerminal returns true if the status is a final state that the
// scheduler will not transition out of.
func (s TaskStatus) IsTerminal() bool {
	switch s {
	case TaskSucceeded, TaskFailed, TaskCancelled:
		return true
	}
	return false
}

// IsStuck returns true if the task is in a non-terminal state that
// the scheduler should consider blocked. Tasks stuck in Running for
// too long are killed and reset to Ready.
func (s TaskStatus) IsStuck() bool {
	return s == TaskRunning
}

// Task is a single unit of work in the swarm DAG. The full set of
// fields is persisted in the swarm SQLite database so a crashed run
// can be resumed.
type Task struct {
	ID           TaskID
	RunID        RunID
	Title        string
	Description  string
	Tier         Tier
	Priority     Priority
	Status       TaskStatus
	Dependencies []TaskID
	Assignee     AgentID
	Attempts     int
	MaxAttempts  int
	Files        []string // Paths the task intends to modify; used by the lock manager.
	Result       string   // Final summary; populated on success.
	Error        string   // Last failure; cleared on success.
	CreatedAt    time.Time
	StartedAt    time.Time
	FinishedAt   time.Time
	TokensIn     int64
	TokensOut    int64
	Parent       TaskID // Non-empty when this task was decomposed from a larger one.
}

// IsReady returns true if the task has no unresolved dependencies.
func (t Task) IsReady(deps map[TaskID]TaskStatus) bool {
	for _, d := range t.Dependencies {
		if deps[d] != TaskSucceeded {
			return false
		}
	}
	return true
}

// Report is the summary returned by [Runtime.Run]. It captures the
// final state of the DAG, the per-tier outcome counts, and the
// aggregate cost.
type Report struct {
	RunID          RunID
	Mode           Mode
	Mission        string
	WorkingDir     string
	StartedAt      time.Time
	FinishedAt     time.Time
	TasksTotal     int
	TasksSucceeded int
	TasksFailed    int
	TasksBlocked   int
	TokensIn       int64
	TokensOut      int64
	CostUSD        float64
	FilesChanged   []string
	Reason         string // Empty on success; populated on failure or cancellation.
}

// Duration returns the wall-clock duration of the run.
func (r Report) Duration() time.Duration {
	return r.FinishedAt.Sub(r.StartedAt)
}

// ApprovalRequest is a request from the runtime to the user for
// permission to perform a non-auto-approved operation. The runtime
// blocks until the request is resolved via [Runtime.ResolveApproval].
type ApprovalRequest struct {
	ID          string
	Op          OperationClass
	Summary     string
	Detail      string
	RequestedAt time.Time
	// Resolved is closed by ResolveApproval. The first value sent
	// on the channel is the resolution.
	Resolved chan ApprovalDecision
}

// ApprovalDecision captures the user's response to an approval
// request.
type ApprovalDecision struct {
	Approved bool
	Reason   string
}

// ErrMissionEmpty is returned by [Runtime.Run] if the mission string
// is empty. A non-empty mission is required so the planner has
// something to decompose.
var ErrMissionEmpty = fmt.Errorf("swarm: mission must not be empty")

// ErrWorkingDirMissing is returned by [Runtime.Run] if WorkingDir is
// empty or does not exist.
var ErrWorkingDirMissing = fmt.Errorf("swarm: working dir must exist")

// ErrRuntimeClosed is returned by operations performed on a Runtime
// whose context has been cancelled.
var ErrRuntimeClosed = fmt.Errorf("swarm: runtime closed")

// ctxKey is an unexported type for context values scoped to this
// package. Using a dedicated type prevents collisions with other
// packages' context keys.
type ctxKey int

const (
	ctxKeyRunID ctxKey = iota + 1
	ctxKeyTaskID
	ctxKeyAgentID
)

// WithRunID returns a copy of ctx tagged with the given run ID.
// Downstream goroutines can recover it with [RunIDFromContext].
func WithRunID(ctx context.Context, id RunID) context.Context {
	return context.WithValue(ctx, ctxKeyRunID, id)
}

// RunIDFromContext returns the RunID stored in ctx, or empty string
// if none.
func RunIDFromContext(ctx context.Context) RunID {
	if v, ok := ctx.Value(ctxKeyRunID).(RunID); ok {
		return v
	}
	return ""
}

// WithTaskID returns a copy of ctx tagged with the given task ID.
func WithTaskID(ctx context.Context, id TaskID) context.Context {
	return context.WithValue(ctx, ctxKeyTaskID, id)
}

// TaskIDFromContext returns the TaskID stored in ctx, or empty string
// if none.
func TaskIDFromContext(ctx context.Context) TaskID {
	if v, ok := ctx.Value(ctxKeyTaskID).(TaskID); ok {
		return v
	}
	return ""
}

// WithAgentID returns a copy of ctx tagged with the given agent ID.
func WithAgentID(ctx context.Context, id AgentID) context.Context {
	return context.WithValue(ctx, ctxKeyAgentID, id)
}

// AgentIDFromContext returns the AgentID stored in ctx, or empty
// string if none.
func AgentIDFromContext(ctx context.Context) AgentID {
	if v, ok := ctx.Value(ctxKeyAgentID).(AgentID); ok {
		return v
	}
	return ""
}
