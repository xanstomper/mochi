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

## Verification update (2026-10-23, vermes)
Branch opencode/improvements @ 3ab1b49 verified in a fresh worktree (~/mochi-verify):
- tsc: CLEAN
- Target files: discipline-loop PASS, loop PASS (90 passed / 3 skipped)
- Full suite: 3,271 passed / 0 failed / 14 skipped — baseline was 3,269 / 2 failed.
  Exactly the 2 baseline failures flipped; zero regressions.
- Verdicts: cfcba5f PASS, e8df39c PASS, sweep 3ab1b49 PASS (dead-code removals safe).
- PARTIAL remainder from the sweep (free-tier cap cut the run): listDir removal
  (src/curriculum/curriculum.ts) and ISSUES.md L-14 (SDK re-exports of sleeptime
  stubs) still open — first items for the next opencode run.

## Wave 3 (staged 2026-10-23 — brief: ~/campaign/wave3-brief.txt)
Coding run gated on OpenCode free-tier quota (still capped at staging time).
- Leftovers: listDir removal; ISSUES L-14 stub re-exports.
- W3-1 embedder: wire freeinference bge-m3 into retrieval (config-gated), recall harness, ship only if hybrid >= lexical.
- W3-2 ACP v1 completeness: session/resume|list|close|delete, additionalDirectories + conformance tests. ACP v2 is draft — hands off.
- W3-3 MCP: tools/list caching (ttlMs/cacheScope, list_changed), lazy tool-schema loading with token measurement, server/discover audit for the 2026-07-28 revision. G12 first-turn latency stays home's.
- W3-4 TUI: evidence status line, subagent panel, per-hunk edit review.
- W3-5 environment: sandbox preflight, exec ceilings, subagent worktree isolation.
Meanwhile: vermes is running the W3-2 ACP audit (read-only) -> ~/campaign/wave3-acp-audit.md.
