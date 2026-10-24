---
name: redteam-review
description: A review pass that must try to find a flaw — attack a plan or patch along correctness, security, edge-case, performance, test, and reversibility axes, and approve only with named checks, never with a bare looks-good.
tools: [read, search, glob, verify]
---

# Red-Team Review: Find a Flaw or Name Your Checks

Most self-review is theater: the reviewer already agrees with the author,
so it reports "looks good" and the defect ships. This skill makes review
adversarial by construction. It does not ask the reviewer to be negative —
it requires the reviewer to ATTACK, and to prove the attack happened.

## When to use it

Before presenting any plan, patch, or design that a user, a test gate, or
another agent will rely on — and always after a fix for a previously found
flaw (re-review the changed parts, not just the flaw area).

## Protocol

1. **Scope the review.** State exactly what is under review: the diff, the
   plan, or the design, with file paths. A review without a stated scope
   drifts into vibes.
2. **Attack along six axes, one at a time.** For each axis, either produce
   a concrete flaw or record an explicit pass with the check performed:
   - Correctness: does the change do what it claims, on every path?
   - Security: untrusted input, secrets, permissions, injection surfaces?
   - Edge cases: empty, null, huge, concurrent, off-by-one, time-zone and
     encoding boundaries?
   - Performance: new hot loops, N+1 patterns, unbounded growth?
   - Tests: does a test pin the behavior, or only the happy path? Would
     the test fail if the fix were reverted?
   - Reversibility: can this be undone, and what breaks if it must be?
3. **A flaw must be concrete.** File and line (or plan step), the
   mechanism by which it fails, and a severity: blocking (wrong behavior,
   security hole, data loss) or non-blocking (style, minor inefficiency).
   A vague worry ("this feels fragile") is not a flaw — turn it into a
   mechanism or drop it.
4. **A pass must name its checks.** "Looks good" is a failed review.
   A pass reads: "Correctness: checked paths A, B, C against spec lines
   X–Y. Security: inputs sanitized at Z. Edge cases: empty and overflow
   covered by tests T1, T2." If you cannot name the check, you did not
   perform it — go perform it.
5. **Deliver a verdict.** BLOCK with the flaw list, or PASS with the
   named checks. A BLOCK verdict names the fix direction for each flaw;
   it does not rewrite the patch itself.
6. **Re-review after fixes, narrowly.** Verify each flaw's fix and
   re-attack only the changed parts plus adjacent behavior. A full
   re-review of unchanged code wastes the budget the first review spent.

## Rules

- Trying to find a flaw is mandatory; fabricating one is forbidden. If
  all six axes pass with named checks, PASS is the correct, honest
  verdict — a forced fake flaw is worse than a pass, because it teaches
  the author to ignore the reviewer.
- Never approve work you did not read. Skimming the diff and passing is
  the exact failure this skill exists to prevent.
- Never let the author grade their own review. If you wrote the patch,
  your review still follows this protocol — the axes do not care who
  wrote the code.
