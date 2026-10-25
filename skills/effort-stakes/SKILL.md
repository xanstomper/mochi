---
name: effort-stakes
description: Spend reasoning in proportion to stakes — classify a task's irreversibility and blast radius first, then set the deliberation budget: single pass for reversible work, plan plus review for broad work, jury plus approval for irreversible work.
tools: [read, search, glob, verify]
---

# Effort Scales With Stakes

Agents today spend roughly flat effort on everything: a one-line comment
edit gets the same deliberation as a database migration. That wastes tokens
on the trivial and underthinks the dangerous. This skill sets the reasoning
budget from the stakes before acting.

## When to use it

At the start of any task that changes files, state, permissions, or
anything outside the current session — before the first edit.

## Protocol

1. **Classify the stakes.** Score the task on three axes, honestly:
   - Irreversibility: can this be undone with one command (low), with
     effort (medium), or not at all / only by a human (high)?
   - Blast radius: one file and its tests (low), a subsystem (medium),
     the whole repo, production, or other people's systems (high)?
   - Cost of error: a failed test catches it (low), a silent wrong
     behavior ships (medium), data loss, a security hole, or a broken
     release (high)?
2. **Set the tier from the highest axis, not the average.** Any single
   high axis makes the task Tier 2. Unknown blast radius counts as high
   until evidence lowers it.
   - Tier 0 — all axes low (reads, local edits covered by tests, docs):
     single pass. No extra deliberation, no review round. Speed is the
     point.
   - Tier 1 — any axis medium, none high (multi-file refactors,
     dependency changes, new public APIs): write a short plan, execute it,
     then run one self-review pass over the diff before verifying.
   - Tier 2 — any axis high (deletes, migrations, publishes, pushes,
     permission or secret changes, production actions): full protocol —
     plan, competing-hypotheses check on the risky steps, two independent
     passes that must agree before acting, and the harness approval gate
     where one applies. Never silently downgrade a Tier 2 task because
     the fix looks small.
3. **Record the tier and why, in one line, in the working notes.**
   ("Tier 2: migration, irreversible, blast radius whole repo.") The
   record is what makes cost-per-solve analysis possible later: without
   it, nobody can tell whether effort matched stakes.
4. **Spend the budget, then stop.** A Tier 0 task that grows deliberation
   rounds is the same failure as a Tier 2 task that skips them. When the
   tier's protocol is complete and verification passes, finish — do not
   add a "just to be safe" review round to low-stakes work.
5. **Re-classify when the task changes shape.** If a Tier 0 edit reveals
   a Tier 2 consequence (the "comment fix" touches a migration file),
   stop and re-classify before continuing. The tier follows the work,
   not the original request.

## Rules

- Never spend jury-level effort on reversible work — that is how
  cost-per-solve balloons without any gain in success rate.
- Never spend single-pass effort on irreversible work — that is how
  small tasks cause large damage.
- When in doubt between two tiers, take the higher one. Downgrading on
  optimism is the specific error this skill exists to prevent.
