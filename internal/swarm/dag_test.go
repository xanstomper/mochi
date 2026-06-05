package swarm

import (
	"testing"
	"time"
)

func TestDAG_AddAndReady(t *testing.T) {
	d := NewDAG()
	runID := NewRunID()

	root := Task{
		ID:        NewTaskID(runID),
		RunID:     runID,
		Title:     "root",
		Status:    TaskPending,
		Files:     []string{"main.go"},
		CreatedAt: time.Now(),
	}
	if err := d.Add(root); err != nil {
		t.Fatalf("add root: %v", err)
	}
	// A single pending task with no deps should be ready.
	if got := d.ReadyCount(); got != 1 {
		t.Fatalf("ready count = %d, want 1", got)
	}
	got, ok := d.Ready()
	if !ok {
		t.Fatal("Ready returned no task")
	}
	if got.Status != TaskRunning {
		t.Fatalf("status = %s, want running", got.Status)
	}
}

func TestDAG_DependencyUnblocks(t *testing.T) {
	d := NewDAG()
	runID := NewRunID()

	parent := Task{ID: NewTaskID(runID), RunID: runID, Title: "parent"}
	childID := NewTaskID(runID)
	child := Task{ID: childID, RunID: runID, Title: "child", Dependencies: []TaskID{parent.ID}}

	if err := d.Add(parent); err != nil {
		t.Fatal(err)
	}
	if err := d.Add(child); err != nil {
		t.Fatal(err)
	}
	// Child should be pending, not ready.
	if got := d.ReadyCount(); got != 1 {
		t.Fatalf("ready count = %d, want 1 (only parent)", got)
	}
	got, ok := d.Ready()
	if !ok || got.ID != parent.ID {
		t.Fatal("expected parent to be ready")
	}
	if err := d.Transition(parent.ID, TaskSucceeded); err != nil {
		t.Fatalf("transition: %v", err)
	}
	if got := d.ReadyCount(); got != 1 {
		t.Fatalf("after parent done, ready count = %d, want 1 (child)", got)
	}
	got, _ = d.Ready()
	if got.ID != childID {
		t.Fatalf("got %s, want child %s", got.ID, childID)
	}
}

func TestDAG_CycleRejected(t *testing.T) {
	d := NewDAG()
	runID := NewRunID()

	// The only cycle we can detect at Add time is a self-reference.
	selfID := NewTaskID(runID)
	a := Task{ID: selfID, RunID: runID, Title: "self", Dependencies: []TaskID{selfID}}
	if err := d.Add(a); err == nil {
		t.Fatal("expected self-reference cycle error, got nil")
	}

	// A task that depends on an existing task is fine, even if a
	// later task depends on it. This is a chain, not a cycle.
	b := Task{ID: NewTaskID(runID), RunID: runID, Title: "b"}
	c := Task{ID: NewTaskID(runID), RunID: runID, Title: "c", Dependencies: []TaskID{b.ID}}
	if err := d.Add(b); err != nil {
		t.Fatal(err)
	}
	if err := d.Add(c); err != nil {
		t.Fatalf("chain should not be a cycle: %v", err)
	}
}

func TestDAG_IllegalTransition(t *testing.T) {
	d := NewDAG()
	runID := NewRunID()
	a := Task{ID: NewTaskID(runID), RunID: runID, Title: "a"}
	if err := d.Add(a); err != nil {
		t.Fatal(err)
	}
	if err := d.Transition(a.ID, TaskSucceeded); err == nil {
		t.Fatal("expected illegal-transition error")
	}
}

func TestPriorityQueue_Ordering(t *testing.T) {
	q := newPriorityQueue()
	q.push("low", PriorityLow)
	q.push("crit", PriorityCritical)
	q.push("norm", PriorityNormal)
	q.push("high", PriorityHigh)

	want := []string{"crit", "high", "norm", "low"}
	for i, w := range want {
		got, ok := q.pop()
		if !ok {
			t.Fatalf("pop %d: empty", i)
		}
		if got != TaskID(w) {
			t.Fatalf("pop %d = %s, want %s", i, got, w)
		}
	}
}
