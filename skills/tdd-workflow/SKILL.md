---
name: tdd-workflow
description: Test-Driven Development (TDD) and test repair workflow. Use when adding features with automated test guarantees, fixing flaky tests, or establishing test suites for uncovered code.
tools: [read, write, edit, patch, shell, glob, search, verify]
---

# Test-Driven Development (TDD) & Test Engineering Skill

## The Red-Green-Refactor Cycle
1. **Red (Write the failing test first):**
   - Identify the exact behavior or edge case being implemented.
   - Write a minimal, expressive test case that asserts the desired contract.
   - Run the test to confirm it fails for the expected reason (not due to syntax/import errors).
2. **Green (Implement minimal code to pass):**
   - Write the simplest, cleanest implementation that satisfies the test assertion.
   - Avoid premature optimization or implementing speculative features.
   - Re-run the test to confirm it turns green.
3. **Refactor (Clean without changing behavior):**
   - Eliminate duplication, improve naming, simplify control flow.
   - Ensure all tests continue passing with zero regressions.

## Polyglot Test Conventions
- **TypeScript / JavaScript:** Vitest (`npx vitest run <file>`), Jest (`npm test -- <file>`), Node test runner.
- **Python:** Pytest (`pytest -v <path>`), unittest. Use fixtures, parameterized tests (`@pytest.mark.parametrize`), and mock external I/O.
- **Rust:** `cargo test -- <filter>`. Place unit tests in `mod tests` with `#[cfg(test)]`, integration tests in `tests/`.
- **Go:** `go test -v -run <Regex> ./...`. Use table-driven tests (`tests := []struct{...}`).
- **Zig:** `zig test <file>`.

## Flaky Test & Regression Diagnosis
- Isolate non-deterministic factors: time mocking (`Date.now()`, `time.sleep`), random seeds, async race conditions, unhandled promise rejections.
- Avoid cross-test state leakage: ensure test databases, temporary files, and mocks are cleanly torn down after each test.
