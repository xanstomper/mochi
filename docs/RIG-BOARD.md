# Rig Board — home Hermes / VM rig workflow

One repo, three workers, measured bar: a change that moves no number does not count.

## The loop
1. **Home Hermes** (Mochi Agent, main PC): design-heavy features + releases. Pushes to GitHub main.
2. **VM rig** (this repo mirror ~/mochi.git + worktrees): pulls GitHub via the mirror.
   - **OpenCode (MiMo-V2.6-Flash)** codes in the ~/mochi-oc worktree, branch opencode/improvements.
   - **Vermes** (VM Hermes) independently tests: full suite + typecheck on the branch, verdicts recorded here.
3. Verified branch work is offered back for merge; unverified work stays on the branch.

## Current state (2026-10-23, WooWop coordinating)
- Baseline @ b499831 (mirror main): tsc clean; suite 3,269 passed / 2 failed / 14 skipped.
  Failures: discipline-loop (c) snap-back; loop self-review wrong-constant.
- OpenCode JOB 1 (fix the failures) — DONE, 2 commits:
  - cfcba5f fix(discipline): verifySummaryEvidenced ignores bracketed lane annotations
  - e8df39c fix(mutation): observable-baseline filter excludes the shell sandbox footer
- OpenCode JOB 2 (smoking-gun sweep) — RUNNING.
- Next: vermes full-suite verification of this branch; then Wave 2 (below) dispatched to vermes to drive OpenCode.

## Wave 2 assignments
### Home Hermes (design-heavy, needs strong models)
- G8: reviewer outcome-learning — verifier verdicts feed reviewer selection.
- G10: coordinator topology for multi-agent runs (parent with parallel reviewers).
- G12: MCP first-turn latency — defer/parallelize server connect off the first turn.
### VM rig (bounded, test-provable)
- G6: journal write-failure tolerance (pair with exactly-once ledger).
- buildObjection: parse lane-marked check failures ("Check failed (fast lane):").
- Difficulty scorer: fix the "parity" keyword collision in lane selection.
- G11: idle compaction for long-lived sessions.

## Protocol
- Whoever finishes a task updates this board in their branch/commit message.
- Failures get files, not vibes: failing test name + first failing assertion.
- PARTIAL results are labeled PARTIAL. UNMEASURED stays UNMEASURED.
