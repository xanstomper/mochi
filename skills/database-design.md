---
name: database-design
description: Database schema design, normalization, indexing, query optimization, and migration patterns for PostgreSQL, SQLite, MySQL, MongoDB, and Redis. Use when creating, evolving, or troubleshooting a data model.
tools:
  - shell
  - db-inspect
  - write
  - edit
---

# Database Design & Migration Skill

## When to Use
- Designing a fresh schema for a feature or service.
- Adding a column/table/index and its migration.
- Diagnosing slow queries or N+1 access patterns.
- Choosing between relational and document storage.

## Schema Design Principles
- **Model the domain, not the UI.** Keep entities and relationships faithful to the problem; design queries around the entities, not the other way around.
- **Normalize by default (3NF), denormalize deliberately.** You may add a redundant column for read-heavy hot paths, but only after measuring and documenting the tradeoff.
- **Pick identifiers consistently.** Prefer `id TEXT PRIMARY KEY` (ULID/UUID) for distributed writes or `BIGSERIAL`/`INTEGER` for tight single-node workloads; never use a mutable natural key as a PK.
- **Use the right column types.** Store money as numeric/decimal, not float; timestamps in `TIMESTAMPTZ` UTC; enums as lookup tables or native enums only when the set is frozen.

## Indexing Guidance
- Index **foreign keys** referenced in joins, and any column used in `WHERE`, `ORDER BY`, or `JOIN` on high-cardinality values.
- Prefer **composite indexes** matching the exact query column order `(a, b, c)`; avoid wide indexes that are never fully used.
- Beware **implicit type casts** that defeat an index (e.g. comparing a `VARCHAR` PK to an integer literal).
- `EXPLAIN ANALYZE` every new query path; watch for Seq Scan on large tables, index-only scans that require sort, and row estimates wildly off actuals (stale `ANALYZE`).

## Constraints & Integrity
- Enforce invariants in the database layer (`NOT NULL`, `UNIQUE`, `CHECK`, `FOREIGN KEY`), not only in app code.
- Keep **foreign keys indexed** to avoid full-table scans on cascade lookups.
- Use `ON DELETE` strategies explicitly (`RESTRICT` by default; `CASCADE`/`SET NULL` only after reasoning about orphaning).

## Query Optimization
- Detect and fix **N+1** (per-row queries) by fetching collections with a single join or `IN`/`ANY` list.
- Prefer **set-based operations** over row-by-row loops; batch bulk writes into a single transaction.
- Use `EXPLAIN (ANALYZE, BUFFERS)` to separate planning from execution and to find missing indexes.
- Profile pagination with keyset/seek pagination (`WHERE id > $last ORDER BY id LIMIT n`) instead of large `OFFSET`.

## Migrations (Drizzle / Prisma / Alembic)
- **One logical change per migration**, always reversible where practical (a down migration).
- Migrations run **before** code is deployed that depends on them; prefer additive changes (new column, nullable, + backfill) over destructive ones for zero-downtime rollouts.
- Generate migrations from the schema definition and **commit them**, never apply ad-hoc DDL to prod.

## When to Pick a NoSQL Store
- **MongoDB:** flexible/evolving document shapes, read-dominant access by natural hierarchy.
- **Redis:** hot caches, rate limits, sessions, leaderboards, pub/sub, and ephemeral data with TTLs.
- Only move off PostgreSQL/SQLite after a clear, measured reason; a relational DB with JSONB/`json` columns covers a large share of "schema-less" needs.

## Database Workflow
1. **Understand** the access patterns and cardinality before writing DDL.
2. **Write** the schema + migration, keeping constraints and indexes explicit.
3. **Inspect** the result with `db-inspect` and review the generated DDL for hidden full scans.
4. **Verify** with `EXPLAIN` on the actual hot queries and a small seed dataset.
5. **Document** the model (entity list, key invariants, known denormalization) in the project README or an ADR.