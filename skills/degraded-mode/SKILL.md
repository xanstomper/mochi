---
name: degraded-mode
description: Negotiate with a failing environment instead of dying on it — classify the failure, try one documented fallback, complete with reduced scope and a degradation label if it works, or record what was tried and stop that path.
tools: [read, search, glob, verify]
---

# Degraded Mode: Negotiate With a Failing Environment

Tools fail, services rate-limit, permissions get denied, networks drop.
The naive agent either retries forever or gives up entirely. The good
agent negotiates: it finds the best outcome the environment still
allows, labels it honestly, and never pretends a degraded result is a
full one.

## When to use it

The moment any tool, service, or permission the task depends on fails —
before the second attempt, not after the fifth.

## Protocol

1. **Classify the failure before retrying.** Four classes, and the
   class decides everything:
   - Transient (timeout, 429, flake): may succeed on retry.
   - Persistent (404, bad input, broken endpoint): retrying is
     pointless until something changes.
   - Permission (denied, locked, consent withheld): retrying — or
     rephrasing to get around it — is forbidden. The denial is data.
   - Missing (no such tool, file, or capability): the path does not
     exist; find another one.
2. **One retry for transient failures, then a fallback.** A transient
   failure gets exactly one retry with backoff. If it still fails,
   move to the fallback — do not loop.
3. **Try one documented fallback.** The fallback must be a real
   alternative, named before it is tried: a cached copy, a different
   tool for the same job, a reduced scope (fewer items, smaller
   window), or a manual step the user can take. An invented fallback
   is not a fallback.
4. **Complete degraded, and label it degraded.** If the fallback
   works, finish the task at reduced scope and say so plainly: what
   is missing, what was substituted, and what would restore the full
   result. A degraded result presented as complete is a lie with
   extra steps.
5. **If no fallback works, record and stop that path.** Write down
   the failure class, what was tried, and what would unblock it —
   then stop hammering that path and work on what remains. A recorded
   dead end is progress; a fifth identical retry is not.

## Rules

- Never retry a permission denial, and never rephrase a denied request
  to get around it. A denial binds the agent, not just the wording.
- Never retry a persistent failure without a changed condition. Same
  input, same endpoint, same result — learn faster.
- Never present degraded output as full output. The label is part of
  the result, not an apology attached to it.
- Never let one failed path block all paths. Degrade the failed leg,
  keep the rest of the task moving.
