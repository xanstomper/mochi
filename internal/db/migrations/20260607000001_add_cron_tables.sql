-- +goose Up
-- +goose StatementBegin

-- Cron jobs — persisted scheduled agent tasks
CREATE TABLE IF NOT EXISTS cron_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    schedule TEXT NOT NULL,         -- cron expression (5-field), ISO duration, or "@every 30m"
    prompt TEXT NOT NULL,
    project TEXT DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER,            -- Unix timestamp in milliseconds
    next_run_at INTEGER NOT NULL,   -- Unix timestamp in milliseconds
    run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_cron_jobs_next_run ON cron_jobs (next_run_at);
CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs (enabled);

CREATE TRIGGER IF NOT EXISTS update_cron_jobs_updated_at
AFTER UPDATE ON cron_jobs
BEGIN
    UPDATE cron_jobs SET updated_at = (unixepoch() * 1000)
    WHERE id = new.id;
END;

-- Cron run results — history of job executions
CREATE TABLE IF NOT EXISTS cron_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    output TEXT DEFAULT '',
    error TEXT DEFAULT '',
    success INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cron_results_job_id ON cron_results (job_id);
CREATE INDEX IF NOT EXISTS idx_cron_results_started ON cron_results (started_at DESC);

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TABLE IF EXISTS cron_results;
DROP TABLE IF EXISTS cron_jobs;
-- +goose StatementEnd
