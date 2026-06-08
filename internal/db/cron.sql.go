package db

import (
	"context"
	"database/sql"
)

// CronJobRow represents a row in the cron_jobs table.
type CronJobRow struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	Schedule   string         `json:"schedule"`
	Prompt     string         `json:"prompt"`
	Project    string         `json:"project"`
	Enabled    int64          `json:"enabled"`
	LastRunAt  sql.NullInt64  `json:"last_run_at"`
	NextRunAt  int64          `json:"next_run_at"`
	RunCount   int64          `json:"run_count"`
	CreatedAt  int64          `json:"created_at"`
	UpdatedAt  int64          `json:"updated_at"`
}

// CronResultRow represents a row in the cron_results table.
type CronResultRow struct {
	ID         int64  `json:"id"`
	JobID      string `json:"job_id"`
	StartedAt  int64  `json:"started_at"`
	FinishedAt sql.NullInt64 `json:"finished_at"`
	Output     string `json:"output"`
	Error      string `json:"error"`
	Success    int64  `json:"success"`
	DurationMs int64  `json:"duration_ms"`
}

const createCronJob = `INSERT INTO cron_jobs (id, name, schedule, prompt, project, next_run_at)
VALUES (?, ?, ?, ?, ?, ?)`

const getCronJob = `SELECT id, name, schedule, prompt, project, enabled, last_run_at, next_run_at, run_count, created_at, updated_at
FROM cron_jobs WHERE id = ?`

const listCronJobs = `SELECT id, name, schedule, prompt, project, enabled, last_run_at, next_run_at, run_count, created_at, updated_at
FROM cron_jobs ORDER BY next_run_at ASC`

const listDueCronJobs = `SELECT id, name, schedule, prompt, project, enabled, last_run_at, next_run_at, run_count, created_at, updated_at
FROM cron_jobs WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 10`

const updateCronJobAfterRun = `UPDATE cron_jobs SET last_run_at = ?, next_run_at = ?, run_count = run_count + 1 WHERE id = ?`

const updateCronJob = `UPDATE cron_jobs SET name = ?, schedule = ?, prompt = ?, project = ? WHERE id = ?`

const enableCronJob = `UPDATE cron_jobs SET enabled = 1 WHERE id = ?`

const disableCronJob = `UPDATE cron_jobs SET enabled = 0 WHERE id = ?`

const deleteCronJob = `DELETE FROM cron_jobs WHERE id = ?`

const insertCronResult = `INSERT INTO cron_results (job_id, started_at, finished_at, output, error, success, duration_ms)
VALUES (?, ?, ?, ?, ?, ?, ?)`

const listCronResults = `SELECT id, job_id, started_at, finished_at, output, error, success, duration_ms
FROM cron_results WHERE job_id = ? ORDER BY started_at DESC LIMIT ?`

func scanCronJobRow(row interface{ Scan(dest ...any) error }) (CronJobRow, error) {
	var r CronJobRow
	err := row.Scan(&r.ID, &r.Name, &r.Schedule, &r.Prompt, &r.Project,
		&r.Enabled, &r.LastRunAt, &r.NextRunAt, &r.RunCount, &r.CreatedAt, &r.UpdatedAt)
	return r, err
}

func scanCronJobRows(rows *sql.Rows) ([]CronJobRow, error) {
	defer rows.Close()
	var items []CronJobRow
	for rows.Next() {
		r, err := scanCronJobRow(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, r)
	}
	return items, rows.Err()
}

// ExecCronQueries provides raw SQL access for the scheduler service.
type ExecCronQueries struct {
	db *sql.DB
}

func NewCronQueries(db *sql.DB) *ExecCronQueries {
	return &ExecCronQueries{db: db}
}

func (q *ExecCronQueries) CreateJob(ctx context.Context, id, name, schedule, prompt, project string, nextRunAt int64) error {
	_, err := q.db.ExecContext(ctx, createCronJob, id, name, schedule, prompt, project, nextRunAt)
	return err
}

func (q *ExecCronQueries) GetJob(ctx context.Context, id string) (CronJobRow, error) {
	row := q.db.QueryRowContext(ctx, getCronJob, id)
	return scanCronJobRow(row)
}

func (q *ExecCronQueries) ListJobs(ctx context.Context) ([]CronJobRow, error) {
	rows, err := q.db.QueryContext(ctx, listCronJobs)
	if err != nil {
		return nil, err
	}
	return scanCronJobRows(rows)
}

func (q *ExecCronQueries) ListDueJobs(ctx context.Context, now int64) ([]CronJobRow, error) {
	rows, err := q.db.QueryContext(ctx, listDueCronJobs, now)
	if err != nil {
		return nil, err
	}
	return scanCronJobRows(rows)
}

func (q *ExecCronQueries) UpdateJobAfterRun(ctx context.Context, id string, lastRunAt, nextRunAt int64) error {
	_, err := q.db.ExecContext(ctx, updateCronJobAfterRun, lastRunAt, nextRunAt, id)
	return err
}

func (q *ExecCronQueries) UpdateJob(ctx context.Context, id, name, schedule, prompt, project string) error {
	_, err := q.db.ExecContext(ctx, updateCronJob, name, schedule, prompt, project, id)
	return err
}

func (q *ExecCronQueries) EnableJob(ctx context.Context, id string) error {
	_, err := q.db.ExecContext(ctx, enableCronJob, id)
	return err
}

func (q *ExecCronQueries) DisableJob(ctx context.Context, id string) error {
	_, err := q.db.ExecContext(ctx, disableCronJob, id)
	return err
}

func (q *ExecCronQueries) DeleteJob(ctx context.Context, id string) error {
	_, err := q.db.ExecContext(ctx, deleteCronJob, id)
	return err
}

func (q *ExecCronQueries) InsertResult(ctx context.Context, jobID string, startedAt, finishedAt int64, output, errStr string, success bool, durationMs int64) error {
	s := 0
	if success {
		s = 1
	}
	_, err := q.db.ExecContext(ctx, insertCronResult, jobID, startedAt, finishedAt, output, errStr, s, durationMs)
	return err
}

func (q *ExecCronQueries) ListResults(ctx context.Context, jobID string, limit int64) ([]CronResultRow, error) {
	rows, err := q.db.QueryContext(ctx, listCronResults, jobID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var items []CronResultRow
	for rows.Next() {
		var r CronResultRow
		if err := rows.Scan(&r.ID, &r.JobID, &r.StartedAt, &r.FinishedAt, &r.Output, &r.Error, &r.Success, &r.DurationMs); err != nil {
			return nil, err
		}
		items = append(items, r)
	}
	return items, rows.Err()
}
