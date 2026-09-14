---
name: testing-strategy
description: Comprehensive testing workflow covering unit, integration, E2E, coverage, mocking patterns, snapshot tests, TDD, and mutation testing. Use when writing tests or deciding what to test for a change.
tools:
  - shell
  - write
  - edit
  - verify
  - analyze-code
---

# Testing Strategy Skill

## When to Use
- Adding tests for a new feature or bug fix.
- Deciding the right level (unit vs integration vs E2E) to put a test.
- Improving an under-tested codebase or running under mutation testing.

## The Testing Pyramid
Aim for many fast unit tests, fewer integration tests, and the least E2E tests:
- **Unit tests (Vitest/Jest/Pytest):** fast, isolated; cover pure logic, edge cases, and error paths.
- **Integration tests:** verify modules/services work together with real dependencies (DB, files, HTTP).
- **E2E (Playwright/Cypress):** cover critical user journeys end-to-end; slow and brittle, so keep these canonical, not exhaustive.

## What to Test
- **Behavior, not implementation detail:** assert on outputs/effects, not internal calls, so refactors don't break tests.
- **Happy path** plus the **most important edge/failure cases** (boundaries, empty input, malformed input, errors).
- **Regression tests for every bug you fix:** write a test asserting the observed failure *before* fixing, ensure it fails, then fix and confirm it passes.
- **Critical invariants** that must never break (auth, data integrity, payment/state transitions).
- **Public API contracts:** any exported function or endpoint consumers rely on.

## Good Test Properties
- **Fast and deterministic:** no sleeps, no flaky timing, no dependence on wall clock or network.
- **Isolated:** each test sets up and tears down its own state; avoid shared mutable fixtures leaking between tests.
- **Readable:** name tests as behavior ("returns 422 when email is invalid"), and structure with arrange/act/assert.
- **One logical assertion per test** where practical, so failures are easy to localize.

## Mocking Patterns
- Mock at **boundaries** (external HTTP, DB, time, filesystem) — not within the logic you are testing.
- Prefer **dependency injection** so mocks are trivial and types are preserved.
- Use fakes/in-memory implementations for seams where possible; reserve mocks for genuinely external systems.
- Avoid over-mocking: a test that asserts only on mocked calls tests your mock, not the code.

## Coverage & Mutation Testing
- Use coverage to find **untouched code**, not as a target to chase to 100% by testing trivial getters.
- **Mutation testing** (Stryker/pytest-mutate) checks the *quality* of tests: mutate a line; a good test should fail. Aim for high kill-rate on critical modules.
- Cover the branches you claim to support; untested branches are where regressions hide.

## TDD Workflow
1. Write a **failing test** that captures the desired behavior/regression.
2. Confirm it fails for the expected reason (not a setup error).
3. Write the **minimal code** to make it pass.
4. **Refactor** while green, then repeat.

## Workflow for a Change
1. **Decide the level:** is this pure logic (unit), cross-module (integration), or a user journey (E2E)?
2. **Write the regression/behavior tests** first (red).
3. **Implement/fix** to make them green.
4. **Run** the full suite plus `verify`; add edge-case tests for any gap.
5. **Optionally** run mutation testing on critical modules to confirm test strength.