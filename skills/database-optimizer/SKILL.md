---
name: database-optimizer
description: Database optimization workflow — EXPLAIN ANALYZE inspection, index design, N+1 detection, query plan reading, and schema tuning. Use when a query or schema is slow or when asked to optimize persistence.
tools: [read, glob, search, shell, sql_codebase_query]
---

# Database Optimizer Skill

## Diagnose first
- Identify the slow query (from logs or a reported endpoint). If it comes from an ORM, translate it to the raw SQL the ORM emits before analyzing.
- Run `EXPLAIN ANALYZE` (Postgres), `EXPLAIN QUERY PLAN` (SQLite), or the engine's equivalent. Read the plan:
  - Full table scans on large tables → candidate for an index or a better query shape.
  - Nested loops feeding the same table → possible N+1.
  - Sort/group/hash after a filtered scan → consider a covering or composite index.

## Common fixes
- **N+1**: replace loop-per-row queries with an `IN (...)` or a join; with an ORM, use eager loading (`select_related`/`prefetch_related`, `include`, `relations`).
- **Indexes**: add the smallest index that serves the query's WHERE + ORDER BY; prefer composite `(a, b)` over two single-column indexes when queries filter both. Avoid over-indexing hot write tables.
- **Missing filters**: if a query fetches a wide rowset for one row, add a binding for the primary key.

## Verify
- Re-run `EXPLAIN` after the change and confirm the plan row estimate dropped or the scan became an index lookup.
- If the project has a test suite, add/keep a regression test that exercises the query path.

## Constraints
- Never suggest a schema change (migration) without checking the migration history and existing indexes first.
- Prefer query changes to schema changes when either would work.