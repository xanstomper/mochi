package swarm

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// MasterOrchestrator decomposes a mission into a Task DAG. The
// default implementation is a deterministic stub that returns a
// 3-task minimal DAG; callers that have a CoordinatorAdapter
// available should call PlanWithCoordinator instead, which asks
// the LLM to produce a structured plan.
type MasterOrchestrator struct{}

// NewMasterOrchestrator returns a master orchestrator.
func NewMasterOrchestrator() *MasterOrchestrator {
	return &MasterOrchestrator{}
}

// Plan is the output of the orchestrator.
type Plan struct {
	Tasks []Task
}

// PlanMission decomposes the mission into a Plan using the
// deterministic stub. Use PlanWithCoordinator for LLM-driven
// decomposition.
func (m *MasterOrchestrator) PlanMission(ctx context.Context, runID RunID, mission string) (*Plan, error) {
	return stubPlan(runID, mission), nil
}

// PlanWithCoordinator asks the LLM to decompose the mission.
// The LLM is prompted to return JSON: an object with a
// `tasks` array; each task has id, title, description, tier,
// priority, depends_on (array of ids). When the LLM response
// can't be parsed as JSON, the function falls back to the
// deterministic stub so the run can still proceed.
func (m *MasterOrchestrator) PlanWithCoordinator(ctx context.Context, runID RunID, mission string, coord CoordinatorAdapter) (*Plan, error) {
	if mission == "" {
		return nil, ErrMissionEmpty
	}
	if coord == nil {
		return stubPlan(runID, mission), nil
	}
	prompt := buildPlannerPrompt(mission)
	sessionID := fmt.Sprintf("swarm-plan:%s", runID)
	res, err := coord.Run(ctx, sessionID, prompt)
	if err != nil {
		return stubPlan(runID, mission), nil
	}
	plan, perr := parsePlannerJSON(res.Text, runID)
	if perr != nil || plan == nil || len(plan.Tasks) == 0 {
		return stubPlan(runID, mission), nil
	}
	return plan, nil
}

// stubPlan is the deterministic fallback used when the LLM
// either isn't available or returned unparseable JSON. It
// produces the canonical 3-task DAG: implement, validate,
// integrate.
func stubPlan(runID RunID, mission string) *Plan {
	root := Task{
		ID:          NewTaskID(runID),
		RunID:       runID,
		Title:       "Implement mission",
		Description: fmt.Sprintf("Decompose and execute the following mission. Break it into small, testable, file-scoped changes; never modify files outside the scope of a single task. Mission: %s", mission),
		Tier:        TierRuntime,
		Priority:    PriorityHigh,
		Status:      TaskPending,
		MaxAttempts: 3,
	}
	validation := Task{
		ID:           NewTaskID(runID),
		RunID:        runID,
		Title:        "Validate merged changes",
		Description:  "Run the build, the test suite, and a security review. Report any issues as new tasks; do not modify production code.",
		Tier:         TierQA,
		Priority:     PriorityNormal,
		Status:       TaskPending,
		MaxAttempts:  2,
		Dependencies: []TaskID{root.ID},
	}
	integration := Task{
		ID:           NewTaskID(runID),
		RunID:        runID,
		Title:        "Integrate and rebuild",
		Description:  "Resolve any merge conflicts, run go build / go test, and (if self-modification is enabled) rebuild the MOCHI binary.",
		Tier:         TierIntegration,
		Priority:     PriorityNormal,
		Status:       TaskPending,
		MaxAttempts:  2,
		Dependencies: []TaskID{root.ID, validation.ID},
	}
	return &Plan{Tasks: []Task{root, validation, integration}}
}

// buildPlannerPrompt asks the LLM to return a strict JSON plan.
// The instruction is deliberately directive so we can rely on
// the JSON parser rather than a regex scraper.
func buildPlannerPrompt(mission string) string {
	return fmt.Sprintf(`Decompose the following software-engineering mission into a directed
acyclic graph of tasks. Return ONLY a single JSON object with
this exact shape, no prose, no Markdown:

{
  "tasks": [
    {
      "id": "t1",
      "title": "Short verb-led title",
      "description": "Full task description, file paths, acceptance criteria",
      "tier": "research|planner|coder|reviewer|qa|tester|integrator|docs|security|infra|selfmod|designer|runtime",
      "priority": "low|normal|high|critical",
      "depends_on": ["t2"]
    }
  ]
}

Constraints:
  * Every task must have a unique id (t1, t2, ...).
  * depends_on is a list of task ids; the graph must be a DAG
    (no cycles).
  * Descriptions should be concrete: file paths, function
    names, expected behaviour. Vague tasks will be rejected.
  * Prefer 3-12 tasks; smaller is better than larger.
  * If the mission requires validation or rebuild, add a
    tier=qa task at the end and a tier=integrator task after
    that.

Mission:
%s
`, mission)
}

// plannerTask is the JSON shape we ask the LLM to emit.
type plannerTask struct {
	ID          string   `json:"id"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Tier        string   `json:"tier"`
	Priority    string   `json:"priority"`
	DependsOn   []string `json:"depends_on"`
}

type plannerResponse struct {
	Tasks []plannerTask `json:"tasks"`
}

var jsonFenceRE = regexp.MustCompile("(?s)```(?:json)?\\s*(\\{.*?\\})\\s*```")

// parsePlannerJSON extracts a plan from the LLM's text. The LLM
// occasionally wraps JSON in code fences or prefixes it with
// prose; we tolerate both.
func parsePlannerJSON(text string, runID RunID) (*Plan, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, fmt.Errorf("empty planner response")
	}
	// Try the whole string first; if that fails, try every
	// fenced JSON block; if that still fails, give up.
	var lastErr error
	tryParse := func(s string) (*plannerResponse, error) {
		var pr plannerResponse
		if err := json.Unmarshal([]byte(s), &pr); err != nil {
			return nil, err
		}
		return &pr, nil
	}
	if pr, err := tryParse(text); err == nil {
		return planFromResponse(pr, runID)
	} else {
		lastErr = err
	}
	for _, m := range jsonFenceRE.FindAllStringSubmatch(text, -1) {
		if pr, err := tryParse(m[1]); err == nil {
			return planFromResponse(pr, runID)
		} else {
			lastErr = err
		}
	}
	return nil, lastErr
}

// planFromResponse converts a parsed JSON response into a
// swarm.Plan, mapping the LLM's loose tier/priority strings
// onto the typed enums and rewriting ids into RunID-scoped
// TaskIDs so collisions across concurrent runs are impossible.
func planFromResponse(pr *plannerResponse, runID RunID) (*Plan, error) {
	idMap := make(map[string]TaskID, len(pr.Tasks))
	tasks := make([]Task, 0, len(pr.Tasks))
	for i, pt := range pr.Tasks {
		shortID := strings.TrimSpace(pt.ID)
		if shortID == "" {
			shortID = fmt.Sprintf("t%d", i+1)
		}
		tid := NewTaskID(runID)
		idMap[shortID] = tid
		tasks = append(tasks, Task{
			ID:          tid,
			RunID:       runID,
			Title:       strings.TrimSpace(pt.Title),
			Description: strings.TrimSpace(pt.Description),
			Tier:        parseTier(pt.Tier),
			Priority:    parsePriority(pt.Priority),
			Status:      TaskPending,
			MaxAttempts: 2,
		})
	}
	for i := range tasks {
		pt := pr.Tasks[i]
		if len(pt.DependsOn) == 0 {
			continue
		}
		deps := make([]TaskID, 0, len(pt.DependsOn))
		for _, dep := range pt.DependsOn {
			if tid, ok := idMap[strings.TrimSpace(dep)]; ok {
				deps = append(deps, tid)
			}
		}
		tasks[i].Dependencies = deps
	}
	if len(tasks) == 0 {
		return nil, fmt.Errorf("planner returned zero tasks")
	}
	return &Plan{Tasks: tasks}, nil
}

// parseTier maps the LLM's string to a Tier. Unknown tiers
// fall back to TierDynamic, which the runtime can then promote
// to a new specialist at runtime.
func parseTier(s string) Tier {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "research", "discovery":
		return TierMaster
	case "planner", "plan":
		return TierPlanner
	case "architect", "reviewer", "review":
		return TierArchitect
	case "coder", "backend", "implement", "code":
		return TierBackend
	case "frontend", "ui":
		return TierFrontend
	case "runtime", "agent", "shell":
		return TierRuntime
	case "refactor":
		return TierRefactor
	case "docs", "doc", "documentation":
		return TierDocumentation
	case "qa", "test", "tester":
		return TierQA
	case "security", "sec":
		return TierSecurity
	case "integrator", "integration":
		return TierIntegration
	case "performance", "perf", "bench":
		return TierPerformance
	case "infra", "devops", "deploy":
		return TierDynamic
	case "selfmod", "self-mod", "self_modify":
		return TierDynamic
	case "designer", "design":
		return TierDynamic
	default:
		return TierDynamic
	}
}

// parsePriority maps the LLM's string to a Priority. Unknown
// values fall back to PriorityNormal.
func parsePriority(s string) Priority {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "low":
		return PriorityLow
	case "high":
		return PriorityHigh
	case "critical", "crit":
		return PriorityCritical
	default:
		return PriorityNormal
	}
}
