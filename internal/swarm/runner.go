package swarm

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"sync"
	"time"
)

// Runtime is the top-level orchestrator. It owns the DAG, the
// agent pool, the lock manager, the shared memory, the file
// indexer, the scheduler, and the SQLite store. A single Runtime
// instance runs one mission to completion.
//
// Runtime is the only public type most callers need. Construct
// it with [NewRuntime], call [Runtime.Run], and read the returned
// [Report].
type Runtime struct {
	config    Config
	runID     RunID
	dag       *DAG
	pool      *Pool
	locks     *LockManager
	mem       *Memory
	idx       *FileIndex
	scheduler *Scheduler
	store     *Store
	registry  *Registry
	events    chan SwarmEvent
	logger    *slog.Logger
	// factory is the agent factory used by the scheduler to
	// spawn new agents.
	factory AgentFactory
	// coordinator is the wrapped MOCHI coordinator passed in via
	// Options. ShellAgents call this to do their LLM work.
	coordinator CoordinatorAdapter
	// approvalWaiters tracks pending approval requests by ID so
	// the user (or the test) can resolve them via
	// ResolveApproval.
	approvalMu      sync.Mutex
	approvalWaiters map[string]chan ApprovalDecision
}

// Options bundles the construction parameters for [NewRuntime].
// Coordinator is the live MOCHI coordinator wrapped as a
// CoordinatorAdapter; Store is the SQLite layer (may be nil for
// ephemeral runs).
type Options struct {
	Config      Config
	Coordinator CoordinatorAdapter
	Store       *Store
	Logger      *slog.Logger
}

// NewRuntime wires up a Runtime and all its components. The
// returned Runtime is ready to call Run on.
func NewRuntime(opts Options) (*Runtime, error) {
	if opts.Config.Mission == "" {
		return nil, ErrMissionEmpty
	}
	if opts.Config.WorkingDir == "" {
		return nil, ErrWorkingDirMissing
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	runID := opts.Config.RunID
	if runID == "" {
		runID = NewRunID()
		opts.Config.RunID = runID
	}

	// Apply mode defaults if the caller didn't override.
	def := DefaultConfig(opts.Config.Mode, opts.Config.WorkingDir, opts.Config.Mission)
	if opts.Config.MaxAgents == 0 {
		opts.Config.MaxAgents = def.MaxAgents
	}
	if opts.Config.MaxParallel == 0 {
		opts.Config.MaxParallel = def.MaxParallel
	}
	if opts.Config.MaxRetries == 0 {
		opts.Config.MaxRetries = def.MaxRetries
	}

	registry := DefaultRegistry()
	dag := NewDAG()
	pool := NewPool(opts.Config.MaxAgents)
	locks := NewLockManager()
	mem := NewMemory()
	idx := NewFileIndex(opts.Config.WorkingDir)

	events := make(chan SwarmEvent, 1024)
	mem.SetOnWrite(func(e MemoryEntry) {
		events <- MakeEvent(runID, EventMemoryWrite).
			WithPayload("key", e.Key).
			WithPayload("scope", string(e.Scope))
	})

	coord := opts.Coordinator
	if coord == nil {
		coord = noopCoordinator{}
	}

	r := &Runtime{
		config:          opts.Config,
		runID:           runID,
		dag:             dag,
		pool:            pool,
		locks:           locks,
		mem:             mem,
		idx:             idx,
		store:           opts.Store,
		registry:        registry,
		events:          events,
		logger:          opts.Logger,
		approvalWaiters: make(map[string]chan ApprovalDecision),
		coordinator:     coord,
	}
	r.factory = func(tier Tier) (Agent, error) {
		return r.spawnAgent(tier)
	}
	r.scheduler = NewScheduler(
		opts.Config, runID, dag, pool, locks, mem, idx,
		r.factory, opts.Logger, events,
	)
	return r, nil
}

// RunID returns the runtime's unique identifier.
func (r *Runtime) RunID() RunID { return r.runID }

// Events returns a receive-only channel of swarm events. The TUI
// subscribes to this channel.
func (r *Runtime) Events() <-chan SwarmEvent { return r.events }

// DAG returns the runtime's DAG. Exposed for the TUI to render
// the task graph.
func (r *Runtime) DAG() *DAG { return r.dag }

// Pool returns the runtime's agent pool. Exposed for the TUI to
// render the agent monitor.
func (r *Runtime) Pool() *Pool { return r.pool }

// Memory returns the runtime's memory store. Exposed for the TUI
// to render the project knowledge panel.
func (r *Runtime) Memory() *Memory { return r.mem }

// Index returns the runtime's file index. Exposed for the TUI to
// render the "what changed" view.
func (r *Runtime) Index() *FileIndex { return r.idx }

// Locks returns the runtime's lock manager. Exposed for the TUI
// to render the lock state.
func (r *Runtime) Locks() *LockManager { return r.locks }

// Run executes the mission to completion. It returns the final
// report and an unrecoverable error (if any).
func (r *Runtime) Run(ctx context.Context) (Report, error) {
	start := time.Now()
	r.emit(MakeEvent(r.runID, EventRunStarted).
		WithPayload("mode", string(r.config.Mode)).
		WithPayload("mission", r.config.Mission).
		WithPayload("max_agents", r.config.MaxAgents).
		WithPayload("max_parallel", r.config.MaxParallel))

	// Hydrate from the store if we have one. This makes a
	// re-run pick up the in-progress DAG instead of starting
	// from scratch.
	if r.store != nil {
		if err := r.hydrate(ctx); err != nil {
			r.logger.Warn("hydrate from store", "err", err)
		}
	}

	// Phase 1: Planning. The master orchestrator decomposes the
	// mission into a DAG and inserts it. If the DAG is empty
	// (e.g. the run was already executed in a prior session),
	// skip planning.
	r.advancePhase(PhasePlanning)
	if r.dag.Len() == 0 {
		master := NewMasterOrchestrator()
		var plan *Plan
		var err error
		if r.coordinator != nil {
			plan, err = master.PlanWithCoordinator(ctx, r.runID, r.config.Mission, r.coordinator)
			if plan == nil || len(plan.Tasks) == 0 {
				// LLM path failed or returned no tasks; fall
				// back to the deterministic stub.
				plan, _ = master.PlanMission(ctx, r.runID, r.config.Mission)
			}
		} else {
			plan, err = master.PlanMission(ctx, r.runID, r.config.Mission)
		}
		if err != nil {
			return r.finishWithError(ctx, start, fmt.Errorf("plan: %w", err))
		}
		for _, t := range plan.Tasks {
			if err := r.dag.Add(t); err != nil {
				return r.finishWithError(ctx, start, fmt.Errorf("dag add %s: %w", t.ID, err))
			}
		}
		r.persistTasks(ctx, plan.Tasks)
	}

	// Phase 2: Execution. The scheduler dispatches tasks until
	// the DAG is drained or the context is cancelled.
	r.advancePhase(PhaseExecuting)
	if err := r.scheduler.Run(ctx); err != nil {
		return r.finishWithError(ctx, start, err)
	}

	// Phase 3 & 4 are already represented as tasks in the DAG
	// produced by the master (validation and integration). The
	// scheduler ran them in the execution phase. We just need
	// to compute the report.
	rep := r.buildReport(start, "")
	r.persistReport(ctx, rep)
	r.emit(MakeEvent(r.runID, EventRunFinished).
		WithPayload("succeeded", rep.TasksSucceeded).
		WithPayload("failed", rep.TasksFailed).
		WithPayload("blocked", rep.TasksBlocked))
	return rep, nil
}

// advancePhase emits a phase-change event. The runtime uses
// these events to drive the TUI's phase indicator.
func (r *Runtime) advancePhase(p Phase) {
	r.emit(MakeEvent(r.runID, EventPhaseChanged).WithPhase(p))
}

// spawnAgent constructs a fresh agent for the given tier. The
// scheduler calls this when it needs a new agent of a tier that
// the pool doesn't already have.
func (r *Runtime) spawnAgent(tier Tier) (Agent, error) {
	spec, ok := r.registry.Spec(tier)
	if !ok {
		// Dynamic tier. Register a generic spec.
		spec = TierSpecFor(tier)
		r.registry.Register(spec)
	}
	id := AgentID(fmt.Sprintf("%s-%d", tier, time.Now().UnixNano()))
	return NewShellAgent(id, tier, spec, r.coordinator, r.logger), nil
}

// TierSpecFor returns a generic TierSpec for a tier that isn't in
// the registry. Used as a fallback when a dynamic specialist is
// requested.
func TierSpecFor(tier Tier) TierSpec {
	return TierSpec{
		Tier:         tier,
		Name:         string(tier),
		PromptHeader: fmt.Sprintf("You are a %s specialist. Perform the task to the best of your ability.", tier),
		AllowedTools: nil,
	}
}

// noopCoordinator is a stand-in for the MOCHI coordinator when
// the runtime is constructed without a real MOCHI backend. Used
// for tests and for ephemeral runs (e.g. demos) where the agent's
// actual LLM call is not desired.
type noopCoordinator struct{}

// Run implements CoordinatorAdapter by returning a canned error.
func (noopCoordinator) Run(ctx context.Context, sessionID, prompt string) (CoordinatorResult, error) {
	return CoordinatorResult{Text: "(no coordinator wired)"}, nil
}

// Cancel implements CoordinatorAdapter.
func (noopCoordinator) Cancel(sessionID string) {}

// CancelAll implements CoordinatorAdapter.
func (noopCoordinator) CancelAll() {}

// buildReport aggregates the final state of the run into a Report.
func (r *Runtime) buildReport(start time.Time, reason string) Report {
	rep := Report{
		RunID:      r.runID,
		Mode:       r.config.Mode,
		Mission:    r.config.Mission,
		WorkingDir: r.config.WorkingDir,
		StartedAt:  start,
		Reason:     reason,
	}
	for _, t := range r.dag.Snapshot() {
		rep.TasksTotal++
		rep.TokensIn += t.TokensIn
		rep.TokensOut += t.TokensOut
		switch t.Status {
		case TaskSucceeded:
			rep.TasksSucceeded++
		case TaskFailed:
			rep.TasksFailed++
		case TaskBlocked:
			rep.TasksBlocked++
		}
		if len(t.Files) > 0 {
			rep.FilesChanged = append(rep.FilesChanged, t.Files...)
		}
	}
	rep.FinishedAt = time.Now()
	return rep
}

// finishWithError builds a report with the error reason and
// persists it.
func (r *Runtime) finishWithError(ctx context.Context, start time.Time, err error) (Report, error) {
	rep := r.buildReport(start, err.Error())
	r.persistReport(ctx, rep)
	return rep, err
}

// persistReport writes the final report to the store. No-op if
// the store is nil (ephemeral run).
func (r *Runtime) persistReport(ctx context.Context, rep Report) {
	if r.store == nil {
		return
	}
	if err := r.store.SaveRun(ctx, rep); err != nil {
		r.logger.Warn("save run", "err", err)
	}
}

// persistTasks writes the given tasks to the store. No-op if
// the store is nil.
func (r *Runtime) persistTasks(ctx context.Context, tasks []Task) {
	if r.store == nil {
		return
	}
	if err := r.store.SaveTasks(ctx, tasks); err != nil {
		r.logger.Warn("save tasks", "err", err)
	}
}

// hydrate loads any persisted state for this run from the store
// and inserts it into the in-memory DAG. Used on resume.
func (r *Runtime) hydrate(ctx context.Context) error {
	if r.store == nil {
		return nil
	}
	tasks, err := r.store.LoadTasks(ctx, r.runID)
	if err != nil {
		return err
	}
	for _, t := range tasks {
		if err := r.dag.Add(t); err != nil {
			r.logger.Warn("hydrate add task", "id", t.ID, "err", err)
		}
	}
	mem, err := r.store.LoadMemory(ctx)
	if err == nil {
		r.mem.Restore(mem)
	}
	idx, err := r.store.LoadFileIndex(ctx)
	if err == nil {
		r.idx.Restore(idx)
	}
	return nil
}

// RequestApproval is called by an agent when it needs explicit
// user permission. The runtime blocks the calling goroutine until
// ResolveApproval is called with the matching ID.
func (r *Runtime) RequestApproval(ctx context.Context, op OperationClass, summary, detail string) (ApprovalDecision, error) {
	id := fmt.Sprintf("approval-%d", time.Now().UnixNano())
	ch := make(chan ApprovalDecision, 1)
	r.approvalMu.Lock()
	r.approvalWaiters[id] = ch
	r.approvalMu.Unlock()
	r.emit(MakeEvent(r.runID, EventApprovalAsked).
		WithPayload("op", string(op)).
		WithPayload("summary", summary).
		WithPayload("detail", detail).
		WithPayload("id", id))
	select {
	case d := <-ch:
		if d.Approved {
			r.emit(MakeEvent(r.runID, EventApprovalGiven).WithPayload("id", id))
		} else {
			r.emit(MakeEvent(r.runID, EventApprovalDenied).WithPayload("id", id).WithPayload("reason", d.Reason))
		}
		return d, nil
	case <-ctx.Done():
		return ApprovalDecision{}, ctx.Err()
	}
}

// ResolveApproval unblocks a pending RequestApproval call. The
// runtime uses this from the TUI or the CLI when the user makes
// a decision.
func (r *Runtime) ResolveApproval(id string, decision ApprovalDecision) {
	r.approvalMu.Lock()
	ch, ok := r.approvalWaiters[id]
	if ok {
		delete(r.approvalWaiters, id)
	}
	r.approvalMu.Unlock()
	if ok {
		ch <- decision
	}
}

// ResolvePath resolves a relative path against the runtime's
// working directory and returns an absolute path. Used by tools
// that need to open files.
func (r *Runtime) ResolvePath(p string) string {
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Clean(filepath.Join(r.config.WorkingDir, p))
}

// emit publishes an event on the runtime's event channel.
func (r *Runtime) emit(e SwarmEvent) {
	select {
	case r.events <- e:
	default:
		r.logger.Warn("event channel full, dropping", "type", e.Type)
	}
}
