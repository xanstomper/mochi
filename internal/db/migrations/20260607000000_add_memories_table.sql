-- +goose Up
-- +goose StatementBegin

-- Persistent cross-session memory store
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    project TEXT DEFAULT '',
    source TEXT DEFAULT '',
    importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0.0 AND importance <= 1.0),
    access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE INDEX IF NOT EXISTS idx_memories_key ON memories (key);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories (category);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories (project);
CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories (importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories (updated_at DESC);

CREATE TRIGGER IF NOT EXISTS update_memories_updated_at
AFTER UPDATE ON memories
BEGIN
    UPDATE memories SET updated_at = (unixepoch() * 1000)
    WHERE id = new.id;
END;

CREATE TRIGGER IF NOT EXISTS increment_memories_access_count
AFTER UPDATE OF access_count ON memories
BEGIN
    UPDATE memories SET access_count = access_count + 1
    WHERE id = new.id;
END;

-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
DROP TRIGGER IF EXISTS update_memories_updated_at;
DROP TRIGGER IF EXISTS increment_memories_access_count;
DROP INDEX IF EXISTS idx_memories_key;
DROP INDEX IF EXISTS idx_memories_category;
DROP INDEX IF EXISTS idx_memories_project;
DROP INDEX IF EXISTS idx_memories_importance;
DROP INDEX IF EXISTS idx_memories_updated;
DROP TABLE IF EXISTS memories;
-- +goose StatementEnd
