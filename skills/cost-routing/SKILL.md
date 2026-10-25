---
name: cost-routing
description: Route each step to the cheapest model that can plausibly do it — set a cost budget before the task, escalate only on a failed cheaper attempt or a stakes argument, and report cost-per-solve at a fixed pass rate.
tools: [read, search, glob, verify]
---

# Cost Routing: Cheapest Sufficient Model Per Step

Flagship effort on every step is how a solved task costs ten times what
it should. The fix is routing per step: cheap models for cheap steps,
strong models for hard ones, and escalation only on evidence — never on
anxiety.

## When to use it

At the start of any task with a meaningful model bill, and again at
every step where the model choice is not obvious.

## Protocol

1. **Set the budget before the task.** State the cost budget and the
   pass-rate floor the task must hold. Routing without a budget is
   just guessing cheap; routing without a floor is just guessing
   wrong.
2. **Grade each step before choosing a model.** Three grades:
   - Routine (lookup, formatting, simple edits): cheapest model that
     can do it.
   - Standard (multi-file reasoning, debugging): mid-tier model.
   - Hard or high-stakes (architecture, irreversible steps, subtle
     bugs): strongest model available.
   Grade the step, then pick the model — never pick the model first
   and justify it after.
3. **Escalate only on evidence.** A step moves to a stronger model
   when the cheaper model fails at it, or when the step's stakes
   argument requires it from the start. "Might be tricky" is not
   evidence — try the cheaper model and let it prove the need.
4. **Never downgrade blindly after failures.** A step that already
   failed cheap twice does not get a third cheap attempt without a
   changed approach. Downgrading past the point of evidence is how
   cost-per-solve balloons through retries.
5. **Report cost-per-solve at a fixed pass rate.** At the end, report
   the task's cost and its outcome together. Cost without pass rate
   is meaningless (cheap and wrong is not cheap), and pass rate
   without cost hides the bill.

## Rules

- Never spend flagship effort on a routine step. If the step is
  routine, the cheap model is the correct model.
- Never route a high-stakes step to a cheap model to save cost. The
  failure of a high-stakes step costs more than the model ever will.
- Never escalate on anxiety. Escalation needs a failed attempt or a
  stakes argument, stated before the stronger model is called.
- Never report cost without the pass rate beside it. The pair is the
  metric; either alone is a half-truth.
