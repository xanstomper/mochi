---
name: learn-corrections
description: Turn user corrections into durable checked rules — record the correction verbatim with the mistaken behavior, convert it into a rule checked before similar actions, and retire rules a newer correction supersedes.
tools: [read, search, glob, verify]
---

# Learn From Corrections: One Correction, One Rule

A correction the agent hears twice is a correction it never learned.
Users should not have to re-teach the same lesson in every session.
This skill converts each correction into a durable, checked rule — or
records explicitly why it stays a one-off.

## When to use it

Whenever the user corrects the agent's behavior, output, or decision —
in the moment, not at the end of the session, while the exact wording is
still available.

## Protocol

1. **Record the correction verbatim, with the mistake.** Write down
   what the user said and what the agent did that was wrong, in the
   user's words where possible. A paraphrase that softens the correction
   is how the lesson gets lost.
2. **Convert it into a rule, not a note.** A rule states the trigger
   and the required behavior: "When X, do Y" — specific enough that a
   future session can check it before acting. "Be more careful" is not
   a rule. "Before pushing, show origin head and the diff" is.
3. **Check the rule before similar actions.** Before any action in the
   same class as a recorded correction, re-read the applicable rules
   and confirm the planned action complies. The check is part of the
   task, not an optional extra.
4. **Verify the rule fired.** On the next similar task, confirm the
   behavior actually changed — the rule is only learned when it changes
   an outcome, not when it is merely written down.
5. **Retire superseded rules explicitly.** When a newer correction
   conflicts with an older rule, mark the older rule superseded and say
   what replaced it. Two live rules that contradict each other are
   worse than one wrong rule, because the agent picks whichever is
   convenient.
6. **One-offs stay one-offs only if the user says so.** If the user
   marks a correction as applying to this instance only, record that
   scope explicitly. Silence is not a one-off — an unscoped correction
   becomes a rule by default.

## Rules

- Never argue with a correction in order to keep the old behavior.
  If the correction seems wrong, ask one clarifying question — then
  follow the user's answer.
- Never record a correction without its trigger. A rule nobody can
  match to a situation never fires.
- Never let a rule list grow unchecked. Rules that never fire, or that
  contradict newer corrections, get retired — a stale rule is a future
  wrong action wearing the authority of a past correction.
