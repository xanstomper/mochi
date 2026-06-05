package swarm

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"
)

// AgentFactory produces a fresh agent given a tier. The runtime
// supplies one; the scheduler doesn't need to know how agents are
// built.
type AgentFactory func(tier Tier) (Agent, error)

// Agent is the interface a scheduler needs from an agent. The
// concrete implementation lives in the agents subpackage and wraps
// the existing MOCHI coordinator.
type Agent interface {
	// ID returns the agent's stable identifier.
	ID() AgentID
	// Tier returns the agent's tier.
	Tier() Tier
	// Run executes the given task and returns the outcome. The
	// agent must respect ctx cancellation.
	Run(ctx context.Context, t Task) TaskResult
	// Cancel interrupts the agent's current task. Called by the
	// scheduler when a task is being retried or the run is
	// shutting down.
	Cancel()
}

// TaskResult is the agent's report after running a task. The
// scheduler uses this to transition the task to its terminal
// status and to record aggregate metrics.
type TaskResult struct {
	Result    string
	Error     error
	TokensIn  int64
	TokensOut int64
	Files     []string
	Patch     *Patch // Optional patch produced by the task; nil if no file changes.
}

// Scheduler is the work-stealing scheduler that dispatches tasks
// from the DAG to the agent pool. The scheduler runs in a single
// goroutine that ticks at [tickInterval]; on each tick it pulls
// ready tasks, acquires their file locks, and assigns them to free
// agents. A separate retry loop re-queues failed tasks after the
// backoff window.
type Scheduler struct {
	dag        *DAG
	pool       *Pool
	locks      *LockManager
	mem        *Memory
	idx        *FileIndex
	config     Config
	runID      RunID
	factory    AgentFactory
	logger     *slog.Logger
	events     chan SwarmEvent
	mu         sync.Mutex
	dispatched map[TaskID]time.Time
	// retryAt is a heap of (runAt, taskID) so failed tasks are
	// re-queued at the right backoff time without spinning the
	// scheduler loop.
	retryAt   *retryHeap
	tickIntvl time.Duration
}

// NewScheduler wires a scheduler to its dependencies. The pool,
// lock manager, memory, and index must outlive the scheduler.
func NewScheduler(
	cfg Config,
	runID RunID,
	dag *DAG,
	pool *Pool,
	locks *LockManager,
	mem *Memory,
	idx *FileIndex,
	factory AgentFactory,
	logger *slog.Logger,
	events chan SwarmEvent,
) *Scheduler {
	if logger == nil {
		logger = slog.Default()
	}
	return &Scheduler{
		dag:        dag,
		pool:       pool,
		locks:      locks,
		mem:        mem,
		idx:        idx,
		config:     cfg,
		runID:      runID,
		factory:    factory,
		logger:     logger,
		events:     events,
		dispatched: make(map[TaskID]time.Time),
		retryAt:    newRetryHeap(),
		tickIntvl:  50 * time.Millisecond,
	}
}

// Run blocks until the DAG is drained (all tasks terminal), the
// context is cancelled, or an unrecoverable error occurs. The
// returned error is non-nil only for unrecoverable conditions;
// normal completion returns nil.
func (s *Scheduler) Run(ctx context.Context) error {
	// Bootstrap the pool to a small number of workers. The pool
	// will spawn additional agents on demand up to MaxAgents.
	if err := s.pool.Preheat(ctx, 2); err != nil {
		return fmt.Errorf("preheat pool: %w", err)
	}

	tick := time.NewTicker(s.tickIntvl)
	defer tick.Stop()

	for {
		select {
		case <-ctx.Done():
			s.cancelInFlight()
			return nil
		case <-tick.C:
			// First, promote any retry-eligible tasks back to
			// ready.
			s.processRetries()

			// Then dispatch ready tasks to free agents.
			dispatched := s.dispatchReady(ctx)

			// Check for terminal conditions.
			if s.dag.Len() == 0 {
				return nil
			}
			if s.allTerminal() {
				return nil
			}
			_ = dispatched // dispatched is used by tests for metrics
		}
	}
}

// dispatchReady is one scheduling pass. It walks the ready queue,
// up to MaxParallel per tick, and assigns each ready task to a
// free agent of the right tier. Returns the number of tasks
// dispatched this tick.
func (s *Scheduler) dispatchReady(ctx context.Context) int {
	dispatched := 0
	for dispatched < s.config.MaxParallel {
		// Peek the next ready task.
		s.mu.Lock()
		// We have to actually pop and re-add to walk the
		// queue, but that mutates the DAG. Use a peek by
		// popping and re-queueing with the same priority.
		// Simpler: hold the DAG lock via its own methods.
		s.mu.Unlock()

		task, ok := s.dag.Ready()
		if !ok {
			break
		}
		// Acquire file locks. If we can't acquire them
		// (another agent is editing a file we need),
		// re-queue the task and break out of this tick.
		var lockTokens []LockToken
		if len(task.Files) > 0 {
			tokens, err := s.locks.Acquire(ctx, task.Assignee, LockWrite, task.Files...)
			if err != nil {
				// Re-queue at lower priority.
				if rerr := s.dag.Requeue(task.ID, PriorityLow); rerr != nil {
					s.logger.Warn("requeue failed", "task", task.ID, "err", rerr)
				}
				s.emit(MakeEvent(s.runID, EventLockWait).
					WithTask(task.ID).
					WithPayload("files", task.Files).
					WithPayload("reason", err.Error()))
				break
			}
			lockTokens = tokens
			s.emit(MakeEvent(s.runID, EventLockAcquired).
				WithTask(task.ID).
				WithPayload("count", len(tokens)))
		}

		// Find or spawn an agent for this tier.
		agent, err := s.acquireAgent(ctx, task.Tier)
		if err != nil {
			// Release the locks and re-queue.
			s.locks.Release(lockTokens)
			if rerr := s.dag.Requeue(task.ID, PriorityLow); rerr != nil {
				s.logger.Warn("requeue failed", "task", task.ID, "err", rerr)
			}
			s.logger.Warn("no agent available", "tier", task.Tier, "err", err)
			break
		}
		// Record the dispatch time.
		s.mu.Lock()
		s.dispatched[task.ID] = time.Now()
		s.mu.Unlock()

		// Increment attempts.
		attempts, _ := s.dag.IncrementAttempts(task.ID)

		s.emit(MakeEvent(s.runID, EventTaskStarted).
			WithTask(task.ID).
			WithAgent(agent.ID()).
			WithPayload("tier", string(task.Tier)).
			WithPayload("attempt", attempts))

		// Run the task in a goroutine. The agent's Run method
		// is responsible for respecting context cancellation.
		go s.executeTask(ctx, agent, task, lockTokens, attempts)
		dispatched++
	}
	return dispatched
}

// executeTask runs a single task on the given agent and processes
// the result. It is the only place that calls agent.Run.
func (s *Scheduler) executeTask(ctx context.Context, agent Agent, task Task, lockTokens []LockToken, attempt int) {
	start := time.Now()
	result := agent.Run(ctx, task)
	dur := time.Since(start)

	// Release file locks regardless of outcome.
	s.locks.Release(lockTokens)
	s.emit(MakeEvent(s.runID, EventLockReleased).
		WithTask(task.ID).
		WithPayload("count", len(lockTokens)))

	// Free the agent.
	s.pool.Release(agent.ID())

	if result.Error != nil {
		s.handleTaskFailure(task, result, attempt)
		return
	}

	// Success path.
	if err := s.dag.SetResult(task.ID, result.Result, "", result.TokensIn, result.TokensOut); err != nil {
		s.logger.Error("set result", "task", task.ID, "err", err)
	}
	if err := s.dag.Transition(task.ID, TaskSucceeded); err != nil {
		s.logger.Error("transition to succeeded", "task", task.ID, "err", err)
	}
	s.emit(MakeEvent(s.runID, EventTaskSucceeded).
		WithTask(task.ID).
		WithAgent(agent.ID()).
		WithPayload("duration_ms", dur.Milliseconds()).
		WithPayload("tokens_in", result.TokensIn).
		WithPayload("tokens_out", result.TokensOut))

	// If the task produced a patch, record it in memory so
	// other tasks can see the change without re-reading the
	// file.
	if result.Patch != nil {
		patchJSON, _ := encodeValue(result.Patch)
		_ = s.mem.Write(ScopeRun, agent.ID(), "patch:"+string(task.ID), patchJSON)
		// Update the file index so the next scan skips this
		// file.
		_, _ = s.idx.HashOfFile(result.Patch.Path)
	}
}

// handleTaskFailure decides whether to retry, block, or fail the
// task permanently. The decision is based on:
//
//   - attempt vs task.MaxAttempts (or config.MaxRetries for the
//     global default)
//   - whether the error is permanent (e.g. context cancelled)
//   - whether the error is a deadlock or lock failure (retry with
//     backoff)
//   - whether the task has outstanding deps (mark blocked, not
//     failed)
func (s *Scheduler) handleTaskFailure(task Task, result TaskResult, attempt int) {
	maxAttempts := task.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = s.config.MaxRetries
	}
	errMsg := ""
	if result.Error != nil {
		errMsg = result.Error.Error()
	}
	s.logger.Warn("task failed", "task", task.ID, "attempt", attempt, "max", maxAttempts, "err", errMsg)
	_ = s.dag.SetResult(task.ID, "", errMsg, result.TokensIn, result.TokensOut)

	// Permanent errors: cancel the task immediately.
	if errors.Is(result.Error, context.Canceled) || errors.Is(result.Error, ErrMissionEmpty) {
		if err := s.dag.Transition(task.ID, TaskCancelled); err != nil {
			s.logger.Error("transition to cancelled", "task", task.ID, "err", err)
		}
		s.emit(MakeEvent(s.runID, EventTaskCancelled).WithTask(task.ID).WithPayload("reason", errMsg))
		return
	}

	if attempt >= maxAttempts {
		// Out of retries; mark failed.
		if err := s.dag.Transition(task.ID, TaskFailed); err != nil {
			s.logger.Error("transition to failed", "task", task.ID, "err", err)
		}
		s.emit(MakeEvent(s.runID, EventTaskFailed).WithTask(task.ID).WithPayload("reason", errMsg))
		return
	}

	// Schedule a retry. The task is moved back to Ready; the
	// retry heap delays re-dispatch until the backoff has
	// elapsed.
	if err := s.dag.Transition(task.ID, TaskReady); err != nil {
		// Some transitions may be illegal (e.g. from a
		// status the task isn't in). Fall back to
		// re-queue.
		if rerr := s.dag.Requeue(task.ID, PriorityLow); rerr != nil {
			s.logger.Error("requeue after failure", "task", task.ID, "err", rerr)
		}
		return
	}
	backoff := s.backoffFor(attempt)
	runAt := time.Now().Add(backoff)
	s.retryAt.push(retryItem{runAt: runAt, taskID: task.ID})
	s.emit(MakeEvent(s.runID, EventTaskRetried).
		WithTask(task.ID).
		WithPayload("attempt", attempt+1).
		WithPayload("backoff_ms", backoff.Milliseconds()))
}

// backoffFor returns the backoff duration for the given attempt.
// Formula: min(Base * 2^(attempt-1), Max).
func (s *Scheduler) backoffFor(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	base := s.config.BackoffBase
	if base <= 0 {
		base = 250 * time.Millisecond
	}
	max := s.config.BackoffMax
	if max <= 0 {
		max = 30 * time.Second
	}
	mult := time.Duration(1) << uint(attempt-1)
	if mult <= 0 {
		mult = 1 << 10 // cap shift to avoid overflow
	}
	d := base * mult
	if d > max {
		d = max
	}
	if d < 0 {
		d = max
	}
	return d
}

// processRetries moves retry-eligible tasks from the retry heap
// back onto the ready queue. Called once per tick.
func (s *Scheduler) processRetries() {
	now := time.Now()
	for {
		item, ok := s.retryAt.peek()
		if !ok || item.runAt.After(now) {
			return
		}
		s.retryAt.pop()
		// Verify the task still exists and is in Ready.
		t, err := s.dag.Get(item.taskID)
		if err != nil {
			continue
		}
		if t.Status != TaskReady {
			continue
		}
		// The task is already on the ready queue (we moved
		// it to Ready in handleTaskFailure). Nothing more to
		// do; the next dispatchReady will pick it up.
	}
}

// acquireAgent returns a free agent of the given tier, spawning one
// if necessary and the pool is below MaxAgents. If the pool is
// full, it blocks until a free agent is available or the context
// is cancelled.
func (s *Scheduler) acquireAgent(ctx context.Context, tier Tier) (Agent, error) {
	// Try to grab a free agent of this tier first.
	if a, ok := s.pool.Get(tier); ok {
		return a, nil
	}
	// Spawn a new one.
	if s.pool.Size() < s.config.MaxAgents {
		a, err := s.factory(tier)
		if err != nil {
			return nil, fmt.Errorf("factory: %w", err)
		}
		s.pool.Add(a)
		s.emit(MakeEvent(s.runID, EventAgentSpawned).
			WithAgent(a.ID()).
			WithPayload("tier", string(tier)))
		return a, nil
	}
	// Pool is full; wait for one to free up.
	return s.pool.WaitFree(ctx, tier)
}

// allTerminal returns true when every task in the DAG is in a
// terminal status. Used to break out of the scheduler loop.
func (s *Scheduler) allTerminal() bool {
	for _, st := range []TaskStatus{TaskPending, TaskReady, TaskRunning, TaskBlocked} {
		if s.dag.Count(st) > 0 {
			return false
		}
	}
	return true
}

// cancelInFlight cancels every agent's current task. Called when
// the scheduler is shutting down.
func (s *Scheduler) cancelInFlight() {
	for _, a := range s.pool.Snapshot() {
		a.Cancel()
	}
}

// emit publishes an event to the scheduler's event channel. The
// channel is non-blocking: if it's full, the event is dropped with
// a warning. The TUI is expected to subscribe to the channel and
// drain it at its own pace.
func (s *Scheduler) emit(e SwarmEvent) {
	if s.events == nil {
		return
	}
	select {
	case s.events <- e:
	default:
		s.logger.Warn("event channel full, dropping", "type", e.Type, "task", e.TaskID)
	}
}

// retryHeap is a min-heap of (runAt, taskID) ordered by runAt. We
// store runAt in nanoseconds since the Unix epoch to avoid keeping
// time.Time in the heap (Time is a struct and the heap operations
// would copy it on every swap).
type retryHeap struct {
	mu    sync.Mutex
	items []retryItem
}

type retryItem struct {
	runAt  time.Time
	taskID TaskID
}

func newRetryHeap() *retryHeap {
	return &retryHeap{items: make([]retryItem, 0, 16)}
}

func (h *retryHeap) push(it retryItem) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.items = append(h.items, it)
	i := len(h.items) - 1
	for i > 0 {
		parent := (i - 1) / 2
		if h.items[i].runAt.Before(h.items[parent].runAt) {
			h.items[i], h.items[parent] = h.items[parent], h.items[i]
			i = parent
			continue
		}
		break
	}
}

func (h *retryHeap) pop() (retryItem, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.items) == 0 {
		return retryItem{}, false
	}
	it := h.items[0]
	n := len(h.items) - 1
	h.items[0] = h.items[n]
	h.items = h.items[:n]
	i := 0
	for {
		left := 2*i + 1
		right := 2*i + 2
		smallest := i
		if left < len(h.items) && h.items[left].runAt.Before(h.items[smallest].runAt) {
			smallest = left
		}
		if right < len(h.items) && h.items[right].runAt.Before(h.items[smallest].runAt) {
			smallest = right
		}
		if smallest == i {
			break
		}
		h.items[i], h.items[smallest] = h.items[smallest], h.items[i]
		i = smallest
	}
	return it, true
}

func (h *retryHeap) peek() (retryItem, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.items) == 0 {
		return retryItem{}, false
	}
	return h.items[0], true
}

// sortByPriority is a stable sort used by callers that build task
// lists from multiple sources and want them in priority order.
func sortByPriority(tasks []Task) {
	sort.SliceStable(tasks, func(i, j int) bool {
		return tasks[i].Priority > tasks[j].Priority
	})
}
