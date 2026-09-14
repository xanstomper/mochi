---
name: refactoring
description: Safe refactoring patterns. Extract/rename/move code, dependency inversion, strangler fig, test-first refactoring, using blast radius before changes and AST-based renames. Use when restructuring code without changing behavior.
tools:
  - blast-radius
  - rename-symbol
  - edit
  - shell
  - verify
  - code-similarity
---

# Safe Refactoring Skill

## When to Use
- Restructuring code to improve readability, maintainability, or extension points.
- Renaming symbols, extracting functions/classes/modules, or moving code.
- Any change meant to preserve *observable behavior* while changing its shape.

## Core Principle: Behavior-Preserving
A refactor changes *how* code is organized, not *what* it does. Every refactor should be verifiable by the behavior staying identical:
- **Run a baseline** test before you start so you can prove behavior is unchanged.
- Prefer **small, reviewable, separately-mergeable** refactors over one sweeping rewrite.
- If behavior is expected to change, that is a feature change, not a refactor — separate the two.

## Blast Radius First
Before editing, use `blast-radius` to see what depends on the code you will touch:
1. Identify all call sites, importers, and overrides of the symbol.
2. Only refactor when you can account for every dependency; unexpected dependents usually derail a "safe" change.
3. This is especially important for public APIs, exported functions, and shared utilities.

## Safe Renames
- Use `rename-symbol` (AST-based) rather than blind find-and-replace, which can mangle strings, comments, and unrelated identifiers.
- Prefer language-aware renames that update all references atomically.
- After the rename, build and run tests to catch references outside the AST's view (e.g. reflection, string-based dispatch).

## Common Refactoring Patterns
- **Extract function/class/module:** pull a cohesive block into a named unit with a clear single responsibility.
- **Extract / inline variable:** name cryptic expressions or remove redundant aliases.
- **Replace magic numbers/strings** with named constants.
- **Dependency inversion:** make high-level modules depend on abstractions, not concrete implementations, to ease testing and swaps.
- **Replace conditionals with polymorphism** when a type switch keeps growing.
- **Strangler fig pattern:** for large rewrites, wrap the new implementation behind the same interface, migrate consumers incrementally, then delete the old path.

## Test-First Refactoring
- If coverage is thin, **add characterization tests** capturing current behavior *before* refactoring, so you can prove nothing changed.
- Refactor in tiny increments with a test run between each step; the moment a test fails, you know exactly which step broke it.
- Use `code-similarity` to find duplicated logic worth consolidating into a single source of truth.

## What NOT to Do
- Do not refactor and add features in the same change.
- Do not mix refactoring with formatting/style rewrites that obscure the real diff.
- Do not change public API shape for internal convenience without a deprecation path.
- Do not assume a rename is safe because "nothing obvious references it" — use `blast-radius` and `rename-symbol`.

## Workflow
1. **Baseline** the tests; ensure they pass before touching code.
2. **Blast radius** the target to enumerate dependents.
3. **Refactor** in small, verifiable steps (prefer AST renames).
4. **Verify** tests/build after each step; stop at the first failure to localize it.
5. **Commit** each coherent step separately so the change set is easy to review and revert.