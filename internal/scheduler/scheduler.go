// Package scheduler provides a persistent SQLite-backed cron scheduler
// for running agent tasks on a schedule.
package scheduler

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"math/rand"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/mochi/mochi/internal/db"
)

// Job represents a scheduled agent task.
type Job struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Schedule  string    `json:"schedule"`  // cron expression or "@every 30m"
	Prompt    string    `json:"prompt"`    // agent prompt to execute
	Project   string    `json:"project"`   // working directory
	Enabled   bool      `json:"enabled"`
	LastRunAt time.Time `json:"last_run_at,omitempty"`
	NextRunAt time.Time `json:"next_run_at"`
	RunCount  int64     `json:"run_count"`
	CreatedAt time.Time `json:"created_at"`
}

// Result represents a single execution of a cron job.
type Result struct {
	ID         int64     `json:"id"`
	JobID      string    `json:"job_id"`
	StartedAt  time.Time `json:"started_at"`
	FinishedAt time.Time `json:"finished_at,omitempty"`
	Output     string    `json:"output"`
	Error      string    `json:"error,omitempty"`
	Success    bool      `json:"success"`
	DurationMs int64     `json:"duration_ms"`
}

// Handler is called when a job is due for execution.
type Handler func(ctx context.Context, job Job) (string, error)

// Scheduler runs cron jobs on a ticker with SQLite persistence.
type Scheduler struct {
	queries *db.ExecCronQueries
	handler Handler
	tick    time.Duration

	mu      sync.Mutex
	running bool
	stop    chan struct{}
	done    chan struct{}
}

// New creates a new scheduler with SQLite-backed persistence.
func New(conn *sql.DB, handler Handler) *Scheduler {
	return &Scheduler{
		queries: db.NewCronQueries(conn),
		handler: handler,
		tick:    30 * time.Second,
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}
}

// Start begins the scheduler loop in a background goroutine.
func (s *Scheduler) Start() {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	s.running = true
	s.mu.Unlock()

	go s.loop()
	slog.Info("Cron scheduler started", "tick", s.tick)
}

// Stop gracefully stops the scheduler.
func (s *Scheduler) Stop() {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return
	}
	s.running = false
	close(s.stop)
	s.mu.Unlock()
	<-s.done
}

func (s *Scheduler) loop() {
	defer close(s.done)

	t := time.NewTicker(s.tick)
	defer t.Stop()

	for {
		select {
		case <-s.stop:
			return
		case now := <-t.C:
			s.tickJobs(context.Background(), now)
		}
	}
}

func (s *Scheduler) tickJobs(ctx context.Context, now time.Time) {
	due, err := s.queries.ListDueJobs(ctx, now.UnixMilli())
	if err != nil {
		slog.Error("Failed to list due cron jobs", "error", err)
		return
	}
	for _, row := range due {
		job := fromRow(row)
		go s.runJob(context.Background(), job, row.ID)
	}
}

func (s *Scheduler) runJob(ctx context.Context, job Job, jobID string) {
	startedAt := time.Now()
	slog.Info("Running cron job", "id", job.ID, "name", job.Name)

	// Calculate next run time
	nextRunAt := nextRunTime(startedAt, job.Schedule)

	// Update job status
	_ = s.queries.UpdateJobAfterRun(ctx, jobID, startedAt.UnixMilli(), nextRunAt.UnixMilli())

	// Run the handler (if nil, just record the run)
	var output string
	var err error
	if s.handler != nil {
		output, err = s.handler(ctx, job)
	} else {
		slog.Debug("No handler set for cron scheduler — skipping execution", "job", job.Name)
	}
	finishedAt := time.Now()
	durationMs := finishedAt.Sub(startedAt).Milliseconds()

	success := err == nil
	errStr := ""
	if err != nil {
		errStr = err.Error()
		slog.Error("Cron job failed", "id", job.ID, "name", job.Name, "error", err)
	}

	_ = s.queries.InsertResult(ctx, jobID, startedAt.UnixMilli(), finishedAt.UnixMilli(),
		output, errStr, success, durationMs)
}

// --- Job CRUD ---

func (s *Scheduler) CreateJob(ctx context.Context, name, schedule, prompt, project string) (*Job, error) {
	id := uuid.NewString()
	now := time.Now()
	nextRun := nextRunTime(now, schedule)

	if err := s.queries.CreateJob(ctx, id, name, schedule, prompt, project, nextRun.UnixMilli()); err != nil {
		return nil, fmt.Errorf("create job: %w", err)
	}

	return &Job{
		ID:        id,
		Name:      name,
		Schedule:  schedule,
		Prompt:    prompt,
		Project:   project,
		Enabled:   true,
		NextRunAt: nextRun,
		CreatedAt: now,
	}, nil
}

func (s *Scheduler) GetJob(ctx context.Context, id string) (*Job, error) {
	row, err := s.queries.GetJob(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("get job: %w", err)
	}
	job := fromRow(row)
	return &job, nil
}

func (s *Scheduler) ListJobs(ctx context.Context) ([]Job, error) {
	rows, err := s.queries.ListJobs(ctx)
	if err != nil {
		return nil, fmt.Errorf("list jobs: %w", err)
	}
	jobs := make([]Job, len(rows))
	for i, row := range rows {
		jobs[i] = fromRow(row)
	}
	return jobs, nil
}

func (s *Scheduler) UpdateJob(ctx context.Context, id, name, schedule, prompt, project string) error {
	return s.queries.UpdateJob(ctx, id, name, schedule, prompt, project)
}

func (s *Scheduler) EnableJob(ctx context.Context, id string) error {
	return s.queries.EnableJob(ctx, id)
}

func (s *Scheduler) DisableJob(ctx context.Context, id string) error {
	return s.queries.DisableJob(ctx, id)
}

func (s *Scheduler) DeleteJob(ctx context.Context, id string) error {
	return s.queries.DeleteJob(ctx, id)
}

func (s *Scheduler) ListResults(ctx context.Context, jobID string, limit int) ([]Result, error) {
	rows, err := s.queries.ListResults(ctx, jobID, int64(limit))
	if err != nil {
		return nil, fmt.Errorf("list results: %w", err)
	}
	results := make([]Result, len(rows))
	for i, r := range rows {
		results[i] = Result{
			ID:         r.ID,
			JobID:      r.JobID,
			StartedAt:  msToTime(r.StartedAt),
			FinishedAt: msToTime(r.FinishedAt.Int64),
			Output:     r.Output,
			Error:      r.Error,
			Success:    r.Success == 1,
			DurationMs: r.DurationMs,
		}
	}
	return results, nil
}

// --- Helpers ---

func fromRow(r db.CronJobRow) Job {
	j := Job{
		ID:        r.ID,
		Name:      r.Name,
		Schedule:  r.Schedule,
		Prompt:    r.Prompt,
		Project:   r.Project,
		Enabled:   r.Enabled == 1,
		RunCount:  r.RunCount,
		NextRunAt: msToTime(r.NextRunAt),
		CreatedAt: msToTime(r.CreatedAt),
	}
	if r.LastRunAt.Valid {
		j.LastRunAt = msToTime(r.LastRunAt.Int64)
	}
	return j
}

func msToTime(ms int64) time.Time {
	return time.UnixMilli(ms)
}

// nextRunTime calculates the next run time based on schedule format.
func nextRunTime(from time.Time, schedule string) time.Time {
	s := strings.TrimSpace(schedule)

	// "@every <duration>" format
	if strings.HasPrefix(s, "@every ") {
		dur, err := time.ParseDuration(s[7:])
		if err == nil {
			return from.Add(dur)
		}
	}

	// Simple presets
	switch s {
	case "@every 1m", "* * * * *":
		return from.Add(1 * time.Minute)
	case "@every 5m", "*/5 * * * *":
		return from.Add(5 * time.Minute)
	case "@every 15m", "*/15 * * * *":
		return from.Add(15 * time.Minute)
	case "@every 30m", "*/30 * * * *":
		return from.Add(30 * time.Minute)
	case "@hourly", "0 * * * *":
		return truncateToHour(from).Add(1 * time.Hour)
	case "@daily", "0 0 * * *":
		return truncateToDay(from).Add(24 * time.Hour)
	case "@weekly", "0 0 * * 0":
		next := truncateToDay(from)
		for next.Weekday() != time.Sunday {
			next = next.Add(24 * time.Hour)
		}
		return next
	case "@monthly", "0 0 1 * *":
		return time.Date(from.Year(), from.Month()+1, 1, 0, 0, 0, 0, from.Location())
	default:
		// Try as duration string
		dur, err := time.ParseDuration(s)
		if err == nil {
			return from.Add(dur)
		}
		// Default: hourly
		return truncateToHour(from).Add(1 * time.Hour)
	}
}

func truncateToHour(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), 0, 0, 0, t.Location())
}

func truncateToDay(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}

// ValidSchedule returns true if the schedule string is recognized.
func ValidSchedule(schedule string) bool {
	s := strings.TrimSpace(schedule)

	// @every <duration> format
	if strings.HasPrefix(s, "@every ") {
		_, err := time.ParseDuration(s[7:])
		return err == nil
	}

	_, err := time.ParseDuration(s)
	if err == nil {
		return true
	}

	switch s {
	case "@every 1m", "@every 5m", "@every 15m", "@every 30m",
		"* * * * *", "*/5 * * * *", "*/15 * * * *", "*/30 * * * *",
		"@hourly", "0 * * * *",
		"@daily", "0 0 * * *",
		"@weekly", "0 0 * * 0",
		"@monthly", "0 0 1 * *":
		return true
	}
	return false
}

// randomID is a fallback ID generator (unused, uuid used instead).
var _ = rand.Intn
