---
name: code-contracts
description: State a module's contract before editing it — its purpose, invariants, and forbidden behaviors — check the change against the contract, and revise the contract explicitly instead of silently breaking it.
tools: [read, search, glob, verify]
---

# Code Contracts: State It Before You Change It

Most edit regressions are not typos. They are contract violations: the
agent changed behavior a module's callers depended on, without knowing the
dependency existed. A repo map says what calls what. A contract says what
must stay true. This skill makes the contract explicit before the edit.

## When to use it

Before editing any module you did not write in this session — and always
before changing shared code, public APIs, or behavior other modules rely
on.

## Protocol

1. **Read the module and its dependents first.** Read the module itself,
   then search for its callers and importers. An edit to code with
   unknown dependents is a blind edit — do not make it.
2. **State the contract in three lines.**
   - Purpose: what the module is for, in one sentence.
   - Invariants: what must stay true across every change (ordering
     guarantees, idempotency, error behavior, data shapes).
   - Forbidden behaviors: what the module must never do (mutate its
     inputs, swallow errors, depend on call order, leak secrets).
   If you cannot state an invariant, say which one is unknown and what
   evidence would settle it — then go find that evidence before editing.
3. **Check the planned change against each invariant.** Walk the diff
   in your head against the contract line by line. A change that
   violates an invariant has exactly two legitimate outcomes: change
   the plan, or revise the contract.
4. **Revise contracts explicitly, never silently.** If the behavior
   change is intentional, write the new contract and name every
   dependent the revision affects. A silent invariant break is the
   specific failure this skill exists to prevent — it turns a deliberate
   change into a mystery regression for the next session.
5. **Verify callers still hold.** After the edit, run the module's tests
   and search for the affected call sites. A green module suite with a
   broken caller is a failed verification, not a passed one.
6. **Record the contract where the next session finds it.** Put the
   revised contract in the working notes and, when it is load-bearing,
   in the commit message. Contracts that live only in one session's
   context die with that session.

## Rules

- Never edit a module whose contract you have not stated.
- Never break an invariant quietly. Explicit revision with named
  dependents, or no break at all.
- Never treat "the tests pass" as proof the contract holds when the
  tests do not cover the invariant — check the invariant directly.
- A contract you cannot state after reading the module and its
  dependents is a signal to read more, not to edit anyway.
