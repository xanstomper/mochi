---
name: implementation
description: Procedure for writing code changes - read before editing, surgical diffs, matching conventions, and verifying. Use for building features, fixing code, and any file change.
---

# Implementation Procedure

## 1. Read before you write
- Read the target file (or the relevant symbol) BEFORE editing. Every "simple" edit that breaks something skipped this.
- Read ONE neighboring module to absorb the conventions: naming, error style, exports, test shape.
- Check who calls what you're changing (`find_callers`) — the blast radius decides how careful to be.

## 2. Choose the cheapest correct edit
- One precise replacement → `edit` (make oldText unique with surrounding context).
- Rewrite a whole function/class → `replace_symbol`.
- Multi-file / several edits → `patch` (one call, atomic).
- New file / full rewrite → `write`.

## 3. Fit in
- Match types, idioms, and patterns already in the file. Do not introduce new dependencies without need.
- Keep diffs minimal: no drive-by reformat, no unrelated renames.
- Complete code only: no placeholders, no "TODO: implement".

## 4. Verify proportionately
- Code with behavior → run the narrowest proof (the specific test, a one-off invocation).
- Docs/config/data → direct check only (test -f, grep).
- Never claim done on unseen results.

## 5. Building something new ("make a calculator")
- Deliver SOURCE CODE written to files — never launch GUI applications.
- Minimal skeleton first: entrypoint + core logic + one test. Then iterate.
- Prefer stdlib; the repo's package manager for deps (and install them for real).

## When blocked
- If an edit fails to match 2x, re-`read` the file — it changed or your anchor is stale.
- If tests fail, switch to the debugging procedure (reproduce → localize).
- If the task feels huge, write the todo list first and delegate self-contained pieces to `subagent`.
