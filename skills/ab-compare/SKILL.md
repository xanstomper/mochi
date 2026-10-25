---
name: ab-compare
description: Ship harness changes only on measured deltas — define the metric and task set before the change, run old versus new on identical tasks and models, require a real sample, and record the experiment so it reproduces.
tools: [read, search, glob, verify]
---

# A/B Compare: No Ship Without a Measured Delta

A harness change that "feels faster" or "seems smarter" is a story, not
an improvement. This skill makes every change earn its ship with a
controlled comparison — the same discipline the scorecard demands, run
at the size of a single change.

## When to use it

Before shipping any harness change: a new skill, a routing tweak, a
prompt change, a tool change, or a default flip — anything whose value
is claimed rather than measured.

## Protocol

1. **Define the metric and the task set before the change.** Pick the
   metric the change claims to move (pass rate, turns, cost-per-solve,
   time) and the guard metric it must not regress (usually pass rate
   or cost). Pick the task set: fixed, held-out where possible, and
   the same for both variants. A metric chosen after seeing results
   is cherry-picking.
2. **Run both variants on identical conditions.** Same model, same
   prompts, same tasks, same environment. Any difference between the
   runs other than the change itself invalidates the comparison — say
   what differed, or do not report the delta.
3. **Require a real sample.** One task is an anecdote, not an
   experiment. The sample must be large enough that a single task
   flipping does not flip the verdict — state the sample size with
   the result, always.
4. **Ship only on improvement without guard regression.** The change
   ships when the claimed metric improves and the guard metric does
   not regress. A tie ships only if it simplifies something real
   (fewer moving parts, lower maintenance) — and the report says that
   plainly instead of dressing the tie as a win.
5. **Record the experiment.** Variants, task set, model, sample size,
   metric, guard metric, and results — written where the next session
   can rerun it. An unrecorded experiment cannot be reproduced, and a
   result nobody can reproduce is a rumor.

## Rules

- Never ship on vibes, on one task, or on a metric chosen after the
  fact.
- Never change the task set mid-experiment. If the set was wrong,
  restart the experiment and say so.
- Never report a win without the guard metric beside it. A speed win
  that tanks pass rate is a regression wearing a trophy.
- Never hide a null result. "No measured difference" is a valid,
  useful outcome — it kills a change before it ships on faith.
