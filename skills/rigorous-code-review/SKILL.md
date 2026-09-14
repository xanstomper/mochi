---
name: rigorous-code-review
description: Exhaustive multi-pass code review focusing on race conditions, memory leaks, OWASP top 10, and architectural integrity. Use when asked for a deep audit, root-cause review, or security vetting of a change or codebase.
tools: [read, diff, git, glob, search, verify, grep]
---

# Rigorous Code Review & Security Audit

## Multi-pass review order
1. **Architecture & design:** Does the change fit the existing module boundaries, dependency direction, and documented conventions (AGENTS.md/ARCHITECTURE.md)? Flag layering violations and over-abstraction.
2. **Concurrency & correctness under load:** Data races, async deadlocks, missing awaits, TOCTOU windows, shared-state mutation without guards, unbounded queues, lost wakeups. Check that shared caches/locks are scoped correctly.
3. **Security (OWASP top 10):** Input sanitation, command injection, path traversal, SSRF, SQL/NoSQL injection, insecure deserialization, cryptographic misuse, missing authz on internal endpoints, secrets in logs or diffs.
4. **Performance:** Algorithmic complexity (accidental $O(N^2)$), N+1 queries, unindexed lookups in hot paths, redundant allocations/round-trips, blocking calls on async/render threads.
5. **Resource lifecycle:** Memory/file/socket/connection/repl leaks on every return path, error paths that skip cleanup, unclosed streams, listener leaks on hot module reload.
6. **Test coverage & negative paths:** Are failure branches, empty-input, authz-denied, and boundary cases asserted, or only the happy path?

## Report format
Produce a structured markdown audit with columns **Severity** (CRITICAL / HIGH / MEDIUM / LOW), **Location** (file:line), **Issue**, and a **Drop-in remediation diff** (exact patch) for each finding. End with a priority-ordered fix list and a "verified clean" checklist so the fixer can tick issues off.

## Constraints
- Never fix silently without flagging the finding first; report exists to be reviewed.
- Distinguish security MUST-fixes from style SHOULD-notes clearly.
- Confirm every claimed positive ("no leak here") with evidence, not vibes.
