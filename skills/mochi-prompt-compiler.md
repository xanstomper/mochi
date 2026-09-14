---
name: mochi-prompt-compiler
description: How to use Mochi's compile_prompt tool effectively. Explains the 4 reasoning tiers (low/medium/high/max), what the compiled output sections mean, and how to write input prompts that produce the best blueprints.
tools:
  - compile-prompt
---

# Mochi Prompt Compiler Skill

## What This Is
`compile_prompt` converts a high-level goal into a structured, ambiguity-resistant blueprint the runtime can execute reliably. It is Mochi's antidote to under-specified prompts: it forces you to pin down the mechanism, first actions, and verification before the loop starts.

## The 4 Reasoning Tiers
- **low:** fastest; best for trivial, mechanical, well-specified changes (a rename, a one-line bugfix). Output is terse.
- **medium:** default; balanced. Use for typical implementation tasks with a clear path.
- **high:** for multi-step, cross-cutting work where the order of operations matters (refactors, integrations, features touching several files).
- **max:** for ambiguous, novel, or high-stakes tasks where getting the decomposition wrong is expensive. Produces the most thorough plan and pitfalls analysis.
- Rule of thumb: **spend reasoning on ambiguity, not verbosity.** Don't use `max` for a mechanical edit, and don't use `low` for a task with hidden failure modes.

## What the Output Sections Mean
- **Goal restatement:** the compiler echoing the objective in concrete, checkable terms. If this drifts from your intent, fix the input.
- **Mechanism:** *how* the task should be accomplished (the approach, libraries, entry points). This is the spine of the plan.
- **First actions:** the initial concrete steps; if these are wrong, the whole run derails, so review them first.
- **Risk & pitfalls:** known ways the task can fail. Skim for anything you did not anticipate.
- **Verification:** how to confirm success. Make sure this is observable (a test, a command output) rather than subjective.

## How to Write a Good Input Prompt
- **State the outcome and the constraint:** "Add pagination to `GET /items` in `services/api.ts`, keep the existing response shape, add a test."
- **Name the files/functions** you want touched; the compiler cannot discover intent you do not state.
- **Be explicit about non-goals** ("do not change auth"), which reduces scope creep.
- **Prefer concrete over vague:** "return 422 on invalid input" beats "handle errors well."
- **When uncertain, ask for the mechanism to be made explicit** rather than leaving it implicit.

## Workflow
1. Call `compile-prompt` with a clear goal and the right tier.
2. Read the **Goal restatement** and **First actions** first; correct misunderstandings early.
3. Scan **Risk & pitfalls** and fold in anything relevant.
4. Confirm **Verification** is observable, then let the runtime execute the plan.