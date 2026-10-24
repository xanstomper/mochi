---
name: proactive-rot
description: Hunt rot before it becomes a bug — scan for dead code, stale docs, broken references, slow or flaky tests, and outdated dependencies, fix the trivial reversible set unasked, and report the rest with a plan.
tools: [read, search, glob, verify]
---

# Proactive Rot: Fix the Small Decay Before It Compounds

Codebases rot quietly: dead exports accumulate, docs drift from code,
references break, tests slow down and flake, dependencies age out. Left
alone, rot becomes the next debugging session. This skill makes rot
hunting a routine pass with a strict fix boundary.

## When to use it

At the start of a session on a repo you maintain, on a schedule, or
whenever a task touches an area that smells stale — before the main
work, not instead of it.

## Protocol

1. **Scan the five rot classes.** Check each one, briefly:
   - Dead code: exports, functions, and flags nothing references.
   - Stale docs: docs that describe behavior the code no longer has.
   - Broken references: links, imports, and paths that no longer
     resolve.
   - Slow or flaky tests: tests that take disproportionate time or fail
     intermittently.
   - Outdated dependencies: pinned versions with known fixes available.
   Record what you find per class, even if the answer is "none."
2. **Triage by reversibility and blast radius.** Two buckets only:
   - Fix now: trivial, reversible, test-covered, and confined to one
     rot class.
   - Report with a plan: behavior-changing, broad, or needing a human
     decision. Never fix these unasked.
3. **Fix the trivial set, one rot class per change.** Each fix gets
   its own small, verifiable change — dead exports in one, stale doc
   lines in another. Batching unrelated rot into one change makes the
   diff unreviewable and the rollback painful.
4. **Verify each fix with tests.** A rot fix that breaks the suite is
   not a fix. Run the affected tests before moving to the next class.
5. **Report both lists.** What was fixed (with the verification), and
   what was deferred with the reason and the fix plan. A rot scan that
   reports nothing fixed and nothing deferred did not happen.

## Rules

- Never fix rot that changes behavior without a test pinning the old
  behavior first. "Cleanup" that silently changes behavior is a
  regression with good intentions.
- Never let a rot scan become a redesign. Fix decay; do not rework
  working systems because they look old.
- Never fix rot outside the task's repo or scope without being asked.
  Rot hunting is maintenance, not a license to roam.
- Never skip the report. Unreported fixes are indistinguishable from
  unmade ones in the next session.
