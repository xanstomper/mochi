---
name: tool-discipline
description: Use the smallest toolset that can do the task — classify the task, start minimal, prune tools that return nothing useful, and escalate only on a named blocker, so tool calls per solve stay low.
tools: [read, search, glob, verify]
---

# Tool Discipline: Smallest Sufficient Toolset

Every tool call costs context, time, and attention. Agents that call tools
"just to see" drown their own reasoning in output they never use. This
skill keeps the toolset minimal and earned: a tool stays in rotation only
while it produces useful evidence.

## When to use it

At the start of any task, before the first tool call — and again whenever
the task changes shape.

## Protocol

1. **Classify the task first.** Pick one class before calling anything:
   - Recon: understand code or docs. Minimal set: read, search, glob.
   - Edit: change code. Minimal set: read, search, glob, plus the edit
     and verify tools the change requires.
   - Verify: confirm behavior. Minimal set: verify, plus read for
     failure output.
   - Browse: gather from the web or a live app. Minimal set: the
     browsing tool and read.
   - Mixed: genuinely needs two classes — name both, and the order
     (recon before edit, edit before verify).
2. **Start with the minimal set only.** Do not preload the full toolbox
   "in case." A tool outside the class needs a reason to enter, stated
   before it is called.
3. **Prune tools that return nothing useful.** If a tool returns no
   usable evidence twice in one task, stop calling it for this task.
   Two empty results are a pattern, not bad luck. The same applies to a
   tool that keeps returning the same already-known output.
4. **Escalate only on a named blocker.** Add a tool to the set only when
   the current set provably cannot proceed — and name the blocker
   ("recon set cannot run the failing test, so verify enters"). An
   escalation without a named blocker is just toolbox sprawl.
5. **After the task, record the effective set.** Write down which tools
   actually produced the evidence the task turned on, per task class.
   That record is what lets future tasks of the same class start with a
   sharper default instead of re-learning the same pruning.

## Rules

- Never call a tool "just to see" — every call needs a question it
  answers.
- Never keep a failing or empty tool in rotation out of habit.
- Never let the toolset grow without a named blocker. Growth without a
  reason is how a 5-call task becomes a 50-call task.
- Writes and destructive actions never enter a recon-class set. If the
  task turns out to need edits, re-classify first — do not quietly
  widen the set.
