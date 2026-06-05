package swarm

import "time"

// SwarmEvent is the wire format for everything the runtime publishes
// to subscribers (TUI, telemetry, audit log). Every event carries
// the run ID and a timestamp so out-of-order delivery from a busy
// broker can still be reassembled.
type SwarmEvent struct {
	RunID     RunID
	TaskID    TaskID
	AgentID   AgentID
	Phase     Phase
	Type      string // See event-type constants below.
	Timestamp time.Time
	// Payload is the event-specific data. Kept as a generic map so
	// new event types don't require schema migrations.
	Payload map[string]any
}

// Event-type constants. The constants are intentionally short so
// they fit comfortably in log lines and TUI table columns.
const (
	EventRunStarted     = "run.started"
	EventRunFinished    = "run.finished"
	EventPhaseChanged   = "phase.changed"
	EventTaskCreated    = "task.created"
	EventTaskReady      = "task.ready"
	EventTaskStarted    = "task.started"
	EventTaskRetried    = "task.retried"
	EventTaskSucceeded  = "task.succeeded"
	EventTaskFailed     = "task.failed"
	EventTaskBlocked    = "task.blocked"
	EventTaskCancelled  = "task.cancelled"
	EventAgentSpawned   = "agent.spawned"
	EventAgentRetired   = "agent.retired"
	EventAgentIdle      = "agent.idle"
	EventAgentBusy      = "agent.busy"
	EventMemoryWrite    = "memory.write"
	EventMemoryRead     = "memory.read"
	EventLockAcquired   = "lock.acquired"
	EventLockReleased   = "lock.released"
	EventLockWait       = "lock.wait"
	EventPatchApplied   = "patch.applied"
	EventPatchConflict  = "patch.conflict"
	EventApprovalAsked  = "approval.asked"
	EventApprovalGiven  = "approval.given"
	EventApprovalDenied = "approval.denied"
)

// MakeEvent constructs a SwarmEvent with the run ID and current
// timestamp pre-populated. Callers fill in Type and Payload.
func MakeEvent(runID RunID, eventType string) SwarmEvent {
	return SwarmEvent{
		RunID:     runID,
		Type:      eventType,
		Timestamp: time.Now(),
		Payload:   make(map[string]any, 4),
	}
}

// WithTask returns a copy of e with the given task ID attached.
func (e SwarmEvent) WithTask(id TaskID) SwarmEvent {
	e.TaskID = id
	return e
}

// WithAgent returns a copy of e with the given agent ID attached.
func (e SwarmEvent) WithAgent(id AgentID) SwarmEvent {
	e.AgentID = id
	return e
}

// WithPhase returns a copy of e with the given phase attached.
func (e SwarmEvent) WithPhase(p Phase) SwarmEvent {
	e.Phase = p
	return e
}

// WithPayload returns a copy of e with the given key/value added to
// the payload map. Existing keys are overwritten.
func (e SwarmEvent) WithPayload(k string, v any) SwarmEvent {
	if e.Payload == nil {
		e.Payload = make(map[string]any, 4)
	}
	e.Payload[k] = v
	return e
}
