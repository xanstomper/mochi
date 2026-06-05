package swarm

import (
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"
)

// DAG is a thread-safe directed acyclic graph of [Task]s indexed by
// [TaskID]. The scheduler consults the DAG each tick to find ready
// tasks and to record results.
//
// The DAG is in-memory; the [Store] persists it to SQLite on every
// mutation so a crashed run can be resumed. The store is the source
// of truth across runs; the DAG is the in-memory working copy.
type DAG struct {
	mu    sync.RWMutex
	tasks map[TaskID]*Task
	// adjacency: for each task, the set of tasks that depend on it
	// (forward edges). Used to recompute downstream statuses when a
	// task transitions to terminal.
	dependents map[TaskID]map[TaskID]struct{}
	// ready: subset of tasks with no unresolved dependencies and
	// not-yet-running status. Maintained incrementally so the
	// scheduler can find ready work in O(1) per task instead of
	// recomputing the whole graph.
	ready *priorityQueue
	// statusCounts keeps cheap counters for the TUI and the report.
	statusCounts map[TaskStatus]int
}

// ErrTaskNotFound is returned by DAG methods when the requested
// task ID is not present.
var ErrTaskNotFound = errors.New("swarm: task not found")

// ErrDuplicateTask is returned by Add when a task with the same ID
// is already present.
var ErrDuplicateTask = errors.New("swarm: duplicate task id")

// ErrCyclicDependency is returned by Add when adding the task would
// introduce a cycle. Cycles are checked before insertion so the
// invariant is preserved.
var ErrCyclicDependency = errors.New("swarm: cyclic dependency")

// NewDAG returns an empty DAG.
func NewDAG() *DAG {
	return &DAG{
		tasks:        make(map[TaskID]*Task),
		dependents:   make(map[TaskID]map[TaskID]struct{}),
		ready:        newPriorityQueue(),
		statusCounts: make(map[TaskStatus]int, 6),
	}
}

// Add inserts a new task. The task is validated: the ID must be
// unique and the dependency list must not introduce a cycle. On
// success, the task is added to the ready queue if it has no
// outstanding dependencies and is in the Pending status.
func (d *DAG) Add(t Task) error {
	if t.ID == "" {
		return fmt.Errorf("swarm: task id empty")
	}
	if t.MaxAttempts <= 0 {
		t.MaxAttempts = 3
	}
	if t.Status == "" {
		t.Status = TaskPending
	}
	if t.CreatedAt.IsZero() {
		t.CreatedAt = time.Now()
	}

	d.mu.Lock()
	defer d.mu.Unlock()

	if _, exists := d.tasks[t.ID]; exists {
		return fmt.Errorf("%w: %s", ErrDuplicateTask, t.ID)
	}
	// Copy to keep callers from mutating the stored task via their
	// original reference.
	stored := t
	d.tasks[t.ID] = &stored
	d.statusCounts[t.Status]++

	// Build the dependents index. For each dependency, add t as a
	// downstream task so when the dep transitions to terminal we
	// can quickly re-evaluate t's ready status.
	for _, depID := range t.Dependencies {
		set, ok := d.dependents[depID]
		if !ok {
			set = make(map[TaskID]struct{})
			d.dependents[depID] = set
		}
		set[t.ID] = struct{}{}
	}

	// Cycle check. With pure forward-Add semantics (no mutation of
	// existing tasks' deps), the only cycle we can introduce is a
	// self-reference where t depends on itself. Existing tasks
	// cannot depend on t because t didn't exist before this call.
	if d.wouldCycle(t.ID) {
		// Roll back.
		delete(d.tasks, t.ID)
		for _, depID := range t.Dependencies {
			if set, ok := d.dependents[depID]; ok {
				delete(set, t.ID)
			}
		}
		d.statusCounts[t.Status]--
		return ErrCyclicDependency
	}

	// If t is pending and all its dependencies are already
	// succeeded, mark it ready.
	if t.Status == TaskPending {
		if d.allDepsSucceeded(t.ID) {
			t.Status = TaskReady
			d.statusCounts[TaskPending]--
			d.statusCounts[TaskReady]++
			d.tasks[t.ID].Status = TaskReady
			d.ready.push(t.ID, t.Priority)
		}
	}
	return nil
}

// Get returns a snapshot of the task with the given ID.
func (d *DAG) Get(id TaskID) (Task, error) {
	d.mu.RLock()
	defer d.mu.RUnlock()
	t, ok := d.tasks[id]
	if !ok {
		return Task{}, fmt.Errorf("%w: %s", ErrTaskNotFound, id)
	}
	return *t, nil
}

// Snapshot returns a slice with one entry per task in deterministic
// order (sorted by ID). The slice is freshly allocated; mutating it
// does not affect the DAG.
func (d *DAG) Snapshot() []Task {
	d.mu.RLock()
	defer d.mu.RUnlock()
	out := make([]Task, 0, len(d.tasks))
	ids := make([]TaskID, 0, len(d.tasks))
	for id := range d.tasks {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		out = append(out, *d.tasks[id])
	}
	return out
}

// Len returns the total number of tasks in the DAG (any status).
func (d *DAG) Len() int {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return len(d.tasks)
}

// Count returns the number of tasks currently in the given status.
func (d *DAG) Count(status TaskStatus) int {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.statusCounts[status]
}

// Transition atomically updates a task's status and re-evaluates
// downstream ready status. The new status must be a legal
// transition from the current one; see [LegalTransition].
//
// On a transition to a terminal status, the function walks the
// downstream dependents and re-evaluates their ready status: any
// dependent that was Pending and now has all-succeeded deps is
// moved to Ready and pushed onto the ready queue.
func (d *DAG) Transition(id TaskID, next TaskStatus) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.tasks[id]
	if !ok {
		return fmt.Errorf("%w: %s", ErrTaskNotFound, id)
	}
	if !LegalTransition(t.Status, next) {
		return fmt.Errorf("swarm: illegal transition %s -> %s for %s", t.Status, next, id)
	}
	d.statusCounts[t.Status]--
	d.statusCounts[next]++
	t.Status = next
	now := time.Now()
	switch next {
	case TaskRunning:
		t.StartedAt = now
	case TaskSucceeded, TaskFailed, TaskCancelled, TaskBlocked:
		t.FinishedAt = now
	}

	// Propagate downstream: a task transitioning to terminal may
	// unblock downstream tasks.
	if next.IsTerminal() {
		for depID := range d.dependents[id] {
			dep, ok := d.tasks[depID]
			if !ok || dep.Status != TaskPending {
				continue
			}
			if d.allDepsSucceeded(depID) {
				dep.Status = TaskReady
				d.statusCounts[TaskPending]--
				d.statusCounts[TaskReady]++
				d.ready.push(depID, dep.Priority)
			}
		}
	}
	return nil
}

// Ready pops the next ready task from the queue, atomically
// transitioning it from Ready to Running and returning it. Returns
// ok=false if the ready queue is empty.
func (d *DAG) Ready() (Task, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	id, ok := d.ready.pop()
	if !ok {
		return Task{}, false
	}
	t, ok := d.tasks[id]
	if !ok {
		return Task{}, false
	}
	d.statusCounts[TaskReady]--
	d.statusCounts[TaskRunning]++
	t.Status = TaskRunning
	t.StartedAt = time.Now()
	return *t, true
}

// ReadyCount returns the number of tasks currently in the ready
// queue. O(1).
func (d *DAG) ReadyCount() int {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.ready.len()
}

// Requeue pushes a task back onto the ready queue, transitioning it
// from Ready back to Ready (a no-op for status) but bumping its
// priority. Used by the scheduler to re-insert a task that was
// returned to the pool without being executed (e.g. the agent
// process died before starting).
func (d *DAG) Requeue(id TaskID, p Priority) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.tasks[id]
	if !ok {
		return fmt.Errorf("%w: %s", ErrTaskNotFound, id)
	}
	if t.Status != TaskReady && t.Status != TaskRunning {
		return fmt.Errorf("swarm: cannot requeue %s in status %s", id, t.Status)
	}
	if t.Status == TaskRunning {
		d.statusCounts[TaskRunning]--
		d.statusCounts[TaskReady]++
		t.Status = TaskReady
	}
	t.Priority = p
	d.ready.push(id, p)
	return nil
}

// IncrementAttempts bumps the attempt counter for the given task.
// Returns the new attempt count.
func (d *DAG) IncrementAttempts(id TaskID) (int, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.tasks[id]
	if !ok {
		return 0, fmt.Errorf("%w: %s", ErrTaskNotFound, id)
	}
	t.Attempts++
	return t.Attempts, nil
}

// SetResult sets the result/error fields on a task. Used after a
// task completes execution.
func (d *DAG) SetResult(id TaskID, result, errMsg string, tokensIn, tokensOut int64) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.tasks[id]
	if !ok {
		return fmt.Errorf("%w: %s", ErrTaskNotFound, id)
	}
	t.Result = result
	t.Error = errMsg
	t.TokensIn += tokensIn
	t.TokensOut += tokensOut
	return nil
}

// SetAssignee records which agent picked up the task. Cleared when
// the task transitions to a terminal status (the scheduler does
// this).
func (d *DAG) SetAssignee(id TaskID, agent AgentID) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.tasks[id]
	if !ok {
		return fmt.Errorf("%w: %s", ErrTaskNotFound, id)
	}
	t.Assignee = agent
	return nil
}

// SetFiles records the file paths the task intends to modify. The
// lock manager uses this list to acquire per-path locks before
// dispatching the task.
func (d *DAG) SetFiles(id TaskID, files []string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	t, ok := d.tasks[id]
	if !ok {
		return fmt.Errorf("%w: %s", ErrTaskNotFound, id)
	}
	// Copy to prevent external mutation.
	cp := make([]string, len(files))
	copy(cp, files)
	t.Files = cp
	return nil
}

// AllDepsSucceeded returns true if every dependency of id is in
// the Succeeded status.
func (d *DAG) AllDepsSucceeded(id TaskID) bool {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.allDepsSucceeded(id)
}

// allDepsSucceeded is the unlocked variant; the caller must hold
// d.mu (read or write).
func (d *DAG) allDepsSucceeded(id TaskID) bool {
	t, ok := d.tasks[id]
	if !ok {
		return false
	}
	for _, depID := range t.Dependencies {
		dep, ok := d.tasks[depID]
		if !ok || dep.Status != TaskSucceeded {
			return false
		}
	}
	return true
}

// wouldCycle returns true if adding the task with the given id
// would introduce a cycle. With pure forward-Add semantics, the
// only possible cycle is a self-reference (the task depends on
// itself). The caller must hold d.mu.
//
// We do not need to walk the broader graph: a freshly-added task t
// can only add edges of the form dep -> t, so any cycle would
// require an existing path t -> dep. But t is new, so no such path
// can exist except via a self-edge.
func (d *DAG) wouldCycle(id TaskID) bool {
	t, ok := d.tasks[id]
	if !ok {
		return false
	}
	for _, dep := range t.Dependencies {
		if dep == id {
			return true
		}
	}
	return false
}

// LegalTransition returns true if the transition from->to is
// allowed by the task state machine.
//
//	Pending   -> Ready, Running, Cancelled
//	Ready     -> Running, Pending, Cancelled
//	Running   -> Succeeded, Failed, Blocked, Ready (re-queued), Cancelled
//	Blocked   -> Ready, Cancelled
//	Succeeded, Failed, Cancelled -> (terminal; no transitions)
func LegalTransition(from, to TaskStatus) bool {
	if from == to {
		return true
	}
	if from.IsTerminal() {
		return false
	}
	switch from {
	case TaskPending:
		return to == TaskReady || to == TaskRunning || to == TaskCancelled
	case TaskReady:
		return to == TaskRunning || to == TaskPending || to == TaskCancelled
	case TaskRunning:
		return to == TaskSucceeded || to == TaskFailed || to == TaskBlocked || to == TaskReady || to == TaskCancelled
	case TaskBlocked:
		return to == TaskReady || to == TaskCancelled
	}
	return false
}

// priorityQueue is a min-heap of TaskIDs keyed by Priority (higher
// priority = smaller number in the min-heap sense = popped first).
// Tie-breaks on insertion order so behaviour is deterministic.
type priorityQueue struct {
	mu    sync.Mutex
	items []pqItem
	seq   uint64
}

type pqItem struct {
	id  TaskID
	pri Priority
	seq uint64
}

func newPriorityQueue() *priorityQueue {
	return &priorityQueue{items: make([]pqItem, 0, 16)}
}

func (q *priorityQueue) push(id TaskID, p Priority) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.seq++
	q.items = append(q.items, pqItem{id: id, pri: p, seq: q.seq})
	// Sift up.
	i := len(q.items) - 1
	for i > 0 {
		parent := (i - 1) / 2
		if q.less(i, parent) {
			q.items[i], q.items[parent] = q.items[parent], q.items[i]
			i = parent
			continue
		}
		break
	}
}

func (q *priorityQueue) pop() (TaskID, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.items) == 0 {
		return "", false
	}
	id := q.items[0].id
	n := len(q.items) - 1
	q.items[0] = q.items[n]
	q.items = q.items[:n]
	// Sift down.
	i := 0
	for {
		left := 2*i + 1
		right := 2*i + 2
		smallest := i
		if left < len(q.items) && q.less(left, smallest) {
			smallest = left
		}
		if right < len(q.items) && q.less(right, smallest) {
			smallest = right
		}
		if smallest == i {
			break
		}
		q.items[i], q.items[smallest] = q.items[smallest], q.items[i]
		i = smallest
	}
	return id, true
}

func (q *priorityQueue) len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}

// less orders higher priority first, then earlier insertion first.
func (q *priorityQueue) less(a, b int) bool {
	if q.items[a].pri != q.items[b].pri {
		return q.items[a].pri > q.items[b].pri
	}
	return q.items[a].seq < q.items[b].seq
}
