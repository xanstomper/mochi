---
name: debugging
description: Systematic procedure for fixing bugs - reproduce first, localize with symbol tools, fix the root cause, and add a regression test. Use when a test fails, an error is reported, or behavior is wrong.
---

# Debugging Procedure

When something fails, resist guessing. Follow this ladder; escalate only when a step cannot answer the question.

## 1. Reproduce
- Find or create the SMALLEST input/command that triggers the failure.
- Capture the exact error text, stack trace, and exit code. These strings are your search keys.
- If it only fails in CI, diff the environment (Node version, env vars, file case).

## 2. Localize
- Read the stack trace BOTTOM-UP for application frames (skip node_modules/vendor).
- Use `search` (grep) for the error string or the failing symbol — the throw site is usually near a match.
- Use `get_function` to read just the suspect function, `find_callers` to see who calls it.
- For "wrong value" bugs, bisect: find the earliest point where the value is wrong (log or a quick node -e).
- For regressions, `git_log`/`git blame` the file and read the suspicious commit's diff.

## 3. Hypothesize (one at a time)
- State the hypothesis in one sentence: "X is null because Y doesn't handle Z."
- Pick the cheapest experiment that could REFUTE it.
- If two rounds of experiments refute hypotheses, stop and re-read the surrounding code — the mental model is wrong, not the code.

## 4. Fix the root cause
- Fix the cause, not the symptom: prefer changing the invariant over adding a null check at the crash site.
- Match the file's existing style and error-handling pattern.
- Keep the diff as small as correctness allows.

## 5. Prove it
- Re-run the exact repro from step 1 — it must pass now.
- Add/extend a test that FAILS on the old code (regression guard).
- Run the narrowest related suite (one file, not the whole repo).

## When stuck
- Re-read the actual failing line with `read` — verify your assumption of what the code says.
- Check the tool result you're reasoning about: if it was truncated, read the full output file noted at the end of the result.
- Explain the failure to yourself in writing in 3 sentences; the contradiction usually surfaces.
