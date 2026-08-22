---
name: testing
description: How to pick the right test runner, write narrow meaningful tests, and repair failing suites. Use when asked to add tests, when coverage is needed, or when tests fail.
---

# Testing Procedure

## 1. Detect the runner (never invent one)
- Read package.json scripts, pyproject.toml, Makefile, Cargo.toml, go.mod.
- JS/TS: npm test / vitest / jest. Python: pytest. Go: go test ./... . Rust: cargo test. Java: mvn test / ./gradlew test. C#: dotnet test. Ruby: rspec.
- Run the suite once BEFORE changing code when behavior is disputed — you need the baseline.

## 2. Write narrow tests
- One assertion per behavior; test the boundary and the failure path, not the happy path twice.
- Name tests after behavior: "rejects empty input", not "test3".
- Use the project's existing fixtures/helpers — fit in.
- If the code is untestable, add the test AND the smallest seam that makes it testable (dependency injection, exported pure function).

## 3. When tests fail
- Read the failure output carefully — the diff usually names the file:line.
- Truncated output? The full log path is at the end of the tool result; grep it instead of re-running with different flags.
- One failing test: fix the code (or the test if it encoded a wrong expectation — say so).
- Many failures: find the common cause (import error, env, fixture). Fix that ONE thing first; re-run.

## 4. Verify honestly
- Green must come from actually running the command. Never claim a pass you didn't see.
- If a check can't run (missing dep, no network), state what you ran instead.

## Speed
- Target one file while iterating: `vitest run path/to/file.test.ts`, `pytest path/test_x.py::test_name`.
- Full suite only at the end, or in background (`background: true`) while you continue.
