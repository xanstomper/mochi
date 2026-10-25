---
name: case-recall
description: Solve new tasks by recalling similar past ones — search the trajectory corpus for matching task shapes and failure modes, adapt the winning approach and avoid the recorded dead ends, and file each solved task as a new case.
tools: [read, search, glob, verify]
---

# Case Recall: Solve From Precedent, Not From Scratch

Every solved task is a precedent. Agents that ignore precedent re-derive
solutions, repeat dead ends, and pay full price for lessons already
learned. This skill makes precedent the first step: recall before
reasoning from scratch.

## When to use it

At the start of any non-trivial task — before planning, before the
first tool call — and again when the first approach stalls.

## Protocol

1. **Search the corpus for similar cases.** Match on task shape and
   failure mode, not on surface words: same class of problem, same
   kind of failure, same codebase area. A case that merely shares
   vocabulary is not similar — similarity needs evidence.
2. **Retrieve the approach and the dead ends.** For each matching
   case, pull two things: the approach that worked, and the approaches
   that were tried and failed. Dead ends are as valuable as wins —
   they are the search space already pruned.
3. **Adapt, do not copy.** A recalled approach is a starting
   hypothesis, not a script. Adjust it for what differs between the
   old case and this task, and name the differences. Blind copying
   imports assumptions the new task does not share.
4. **If the recalled approach fails here, record the divergence.**
   The case was similar but not identical — write down what differed
   and why the approach failed. That divergence is what makes the
   corpus smarter instead of merely bigger.
5. **File this task as a new case when it ends.** Record the task
   shape, the approaches tried (wins and dead ends), and the outcome.
   A task that ends without being filed teaches nothing to the next
   session.

## Rules

- Never let a recalled case override fresh evidence. If the case says
  X works and the current task shows X failing, the task wins — and
  the divergence gets recorded.
- Never recall by vibes. If no case matches on task shape or failure
  mode, say so and reason from scratch — a forced match is worse
  than no match.
- Never file a case without its dead ends. A corpus of wins only
  teaches the next agent to repeat the failures.
- Never treat the corpus as authority. It is precedent: persuasive,
  revisable, and always subordinate to the evidence in front of you.
