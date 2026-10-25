---
name: goal-checkpoints
description: Decompose a goal into independently verifiable milestones with approval checkpoints before irreversible steps, on scope changes, and at completion — never claim a goal done with milestones still open.
tools: [read, search, glob, verify]
---

# Goal Checkpoints: Milestones You Can Verify, Approvals You Cannot Skip

Long tasks fail in two ways: the agent drifts off-goal for an hour, or
it declares victory with half the goal undone. Both come from the same
missing structure — milestones with done-criteria, and checkpoints where
a human approves before the work continues past a point of no return.

## When to use it

At the start of any multi-step goal: a feature, a migration, a
multi-part fix, or any task with more than three steps or any
irreversible step.

## Protocol

1. **State the goal and its done-criterion in one line each.** "Ship
   X" is not a done-criterion. "X is done when tests A, B pass and the
   docs page lists the new behavior" is. If the done-criterion cannot
   be stated, the goal is not ready to execute — clarify it first.
2. **Decompose into milestones, each independently verifiable.** A
   milestone is a unit of progress with its own check: a passing test,
   a reviewed diff, a measured number. A milestone whose only check is
   "the next milestone works" is not a milestone — split it.
3. **Mark the checkpoints before starting.** Checkpoints are mandatory
   pauses, placed at: every irreversible step (deletes, publishes,
   migrations, pushes), every scope change (the goal grew or shrank),
   and completion (all milestones verified). Write the checkpoint list
   down with the milestones.
4. **At each checkpoint, report and wait.** Report milestone status
   (done, open, blocked), what the next step changes, and what is
   irreversible about it — then wait for approval. A checkpoint the
   agent sails through without approval is not a checkpoint.
5. **A rejection re-plans from that milestone.** If approval is
   withheld or a checkpoint reveals a problem, re-plan from the current
   milestone forward. Do not discard verified milestones, and do not
   restart the whole goal — the verified work stays verified.
6. **Completion requires every milestone verified.** The goal is done
   only when each milestone's check passes and the final checkpoint is
   approved. Partial milestones plus a confident summary is the exact
   failure this skill exists to prevent.

## Rules

- Approval is per-checkpoint, not blanket. "Go ahead" for milestone one
  is not approval for milestone four's irreversible step.
- Never skip a checkpoint because the work "looks fine." Looking fine
  is the reason checkpoints exist.
- Never report a goal complete with open milestones. If a milestone is
  blocked, the goal is blocked — say which milestone and what unblocks
  it.
