---
name: debug-hypotheses
description: Debug by competing hypotheses — when a test or verification fails, generate falsifiable explanations, run the cheapest experiment that discriminates between them, and fix only the surviving hypothesis.
tools: [read, search, glob, verify]
---

# Debug by Competing Hypotheses

A failed test is evidence, not an invitation to guess a fix. Guessing burns
turns: each wrong fix costs a full edit-verify cycle and teaches nothing.
This protocol replaces guessing with elimination.

## When to use it

Any failing test, failing verification gate, or reproduction that does not
match the expected behavior — before writing any fix.

## Protocol

1. **State the failure exactly.** Quote the failing assertion, the command
   that produced it, and the minimal input that reproduces it. If you cannot
   reproduce it, say so and stop — a fix for an unreproduced failure is a
   guess with extra steps.
2. **Generate 2–4 competing hypotheses.** Each one must be falsifiable: a
   specific mechanism ("the mock returns stale state because the cache key
   ignores the tenant id"), not a vibe ("something is off with caching").
   Include at least one hypothesis you initially dislike — the obvious
   suspect is wrong often enough that skipping it is a bias, not efficiency.
3. **Name the discriminating evidence for each hypothesis.** For every
   hypothesis, write down one observation that would confirm it and one
   that would kill it, before running anything. If two hypotheses predict
   the same observation, they are the same hypothesis — merge them.
4. **Run the cheapest experiment first.** Prefer a targeted probe over a
   full suite run: a single focused test, a printed intermediate value, a
   minimal reproduction script. One experiment per hypothesis where
   possible; a single experiment that kills two hypotheses is ideal.
5. **Eliminate by evidence, in writing.** Cross hypotheses out as experiments
   report. Do not keep a killed hypothesis alive because its fix would be
   convenient. The surviving hypothesis is the diagnosis.
6. **Fix only the survivor.** Implement the minimal change the surviving
   mechanism demands, then verify with the original failing test plus one
   regression test that pins the mechanism (not just the symptom).
7. **If every hypothesis dies, re-hypothesize exactly once.** Use what the
   experiments taught — the dead hypotheses constrained the space. If the
   second set also dies, escalate with the full elimination record instead
   of guessing a third set: the record is the useful output.
8. **Record the elimination.** Write down the failed hypotheses and the
   evidence that killed each. That record is decision memory: the next
   session that meets the same failure class starts from it instead of
   re-guessing.

## Rules

- Never implement a fix for an untested hypothesis.
- Never run the full suite to discriminate when a targeted probe exists.
- Never present a fix without naming the hypothesis it follows from and
  the experiment that confirmed it.
- A hypothesis that cannot be tested with available tools is not a
  hypothesis — it is a wish. Replace it with one that can.
