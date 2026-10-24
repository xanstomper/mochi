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

## Coder slot changed (2026-10-23, Ben's order): OpenCode OUT, Hermes "coder" profile IN
- New Hermes profile `coder` on the VM (alias `coder`), verified live 2026-10-23 (one-shot probe answered OK).
- Brain: freeinference / glm-5.3-flash (same provider as vermes; key already on the box, wired via key_env). API door: http://100.101.205.88:8377/p/coder/v1 through the default-profile multiplexer.
- Vyce detour (closed): a vyceai provider block (https://vyceai.com/v1, model claude-sonnet-4-6) is configured in the coder profile and the wiring was verified end-to-end (Vyce answered 401 — correct pipe, no key). The VYCEAI_API_KEY value exists nowhere on this VM (checked by WooWop and vermes). If home ever pushes it into ~/.hermes/profiles/coder/.env, flipping model.provider back to vyceai takes one line.
- Wave 3 now runs on coder (brief: ~/campaign/wave3-brief.txt). Vermes still verifies independently. OpenCode/mimo remains installed as an unused fallback.

## Wave 4 phases (planned 2026-10-23 — full plan: WooWop's phases-wave4-plan-2026-10-23.md)
Three-system workflow (Ben): SYS-1 WooWop (plan/verify) | SYS-2 home Hermes (issue #74) | SYS-3 VM (vermes + coder).
- P0: land in-flight (run-1 verification, W3-3/W3-5, then W3-4 TUI).
- P1 behavior core (home lead): G1 verified compaction all evidence classes (digest share ~34% -> <15%), output-boundary hygiene generalization, discipline round 2 (think-loop stop), ask/act calibration.
- P2 speed (split): startup budget, streaming + MCP progress notifications, G12 (home), incremental embedding index (153.8s full build -> <10s diffs), failover latency table.
- P3 smoking guns (VM lead): ISSUES.md burn-down to 0-or-deferred, fabricated-metrics class grep, config.json plaintext keys -> keyring, node<22 hard preflight, dead-code sweep 2.
- P4 smarts (split): hybrid tuning (embedded 0.833 beat hybrid 0.792 @recall10 — fix pool/RRF; grow query set 24->60), G8/G10 (home), capabilities catalog, post_compaction hook (home), edit-apply corpus expansion.
- P5 first LIVE scorecard cell (VM runs, WooWop verifies): swe class k=1 on freeinference glm-5.3-flash, serial (account concurrency = 2, shared with home), full caveats published.

## Wave 3 run 1 — WooWop independent verification (2026-10-23)
Fresh worktree at 08ed9f5, Node 26.12.1, run by WooWop directly (no model in the loop):
tsc --noEmit CLEAN; full suite **3,285 passed / 0 failed / 14 skipped** (3,299 total; files 415 passed / 4 skipped).
Vs the campaign-1 verified tip (3,271 passed): **+14 net new tests, zero regressions.**
Per-item verdicts: leftover listDir PASS, leftover L-14 PASS, W3-1 embedder gate + recall harness PASS
(measurement: recall@10 lexical 0.708 / embedded 0.833 / hybrid 0.792 — ship condition met, opt-in stays),
W3-2 ACP v1 completeness PASS. Run 1 CLOSED.
Note: origin/main advanced today (home: e4f255f verifySummaryEvidenced first-line hardening — complementary
to the rig's cfcba5f, no collision — and 0d0442c wip tidy). Rig branch remains based on b499831; merge is home's call.
W3-3 + W3-5 in flight on coder/wave3-rest (~/mochi-w3b).

## Coder slot changed (2026-10-23, Ben's order): OpenCode OUT, Hermes "coder" profile IN
- New Hermes profile 























╭─────── Hermes Agent v0.22.5 (2026.9.24) · stable · local bf0203a794a0 ───────╮
│                                     Available Tools                          │
│  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⡀⠀⣀⣀⠀⢀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀     browser-use: browser_exec                │
│  ⠀⠀⠀⠀⠀⠀⢀⣠⣴⣾⣿⣿⣇⠸⣿⣿⠇⣸⣿⣿⣷⣦⣄⡀⠀⠀⠀⠀⠀⠀     clarify: clarify                         │
│  ⠀⢀⣠⣴⣶⠿⠋⣩⡿⣿⡿⠻⣿⡇⢠⡄⢸⣿⠟⢿⣿⢿⣍⠙⠿⣶⣦⣄⡀⠀     code_execution: execute_code             │
│  ⠀⠀⠉⠉⠁⠶⠟⠋⠀⠉⠀⢀⣈⣁⡈⢁⣈⣁⡀⠀⠉⠀⠙⠻⠶⠈⠉⠉⠀⠀     connections: manage_connections          │
│  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣴⣿⡿⠛⢁⡈⠛⢿⣿⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀     delegation: delegate_task                │
│  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠿⣿⣦⣤⣈⠁⢠⣴⣿⠿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀     file: patch, read_file, search_files,    │
│  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠻⢿⣿⣦⡉⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀     write_file                               │
│  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠘⢷⣦⣈⠛⠃⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀     image_gen: image_generate                │
│  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⣴⠦⠈⠙⠿⣦⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀     memory: memory                           │
│  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠸⣿⣤⡈⠁⢤⣿⠇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀     (and 6 more toolsets...)                 │
│  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠉⠛⠷⠄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀                                              │
│  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⠑⢶⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀     Available Skills                         │
│  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⠁⢰⡆⠈⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀     autonomous-ai-agents: claude-code, +4    │
│  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠳⠈⣡⠞⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀     more                                     │
│  ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀     creative: architecture-diagram, +9 more  │
│                                     devops: sdlc-review                      │
│  claude-sonnet-4-6 · Nous Research  email: email-inbox-triage, himalaya      │
│  /home/opc                          media: gif-search, songsee, +1 more      │
│  Session: 1ae18787                  note-taking: obsidian                    │
│                                     productivity: airtable, box, +12 more    │
│                                     research: arxiv, +3 more                 │
│                                     social-media: xurl                       │
│                                     software-development:                    │
│                                     codebase-inspection, +11 more            │
│                                     web: blocked-page-recovery               │
│                                                                              │
│                                     Profile: coder                           │
│                                     21 tools · 54 skills · /help for         │
│                                     commands                                 │
╰──────────────────────────────────────────────────────────────────────────────╯

Welcome to Hermes Agent! Type your message or /help for commands.
✦ Tip: /verbose cycles tool progress display: off → new → all → verbose.

[?12l[?25h[?2004h[?1l[?25l[0m[?7l[0m[J[0;38;5;102m───────────────────────────────────────────────────────────────────────────────
[79C─[0m
[0;38;5;230mcoder ❯ [0;38;5;136;3mPlan a feature, then build it step by step[0m
[0;38;5;102m───────────────────────────────────────────────────────────────────────────────
[79C─[0m
[0;38;5;250m ☤ [0;38;5;220;1mclaude-sonnet-4-6[0;38;5;101m · ctx -- · [░░░░░░░░░░] -- · 1s · ⏲ 0s[59D[2A[8C[?7h[0m[?12l[?25h[2 q[8D[A[J[0m[?7h[?2004l[0 q[2;3mShutting down… (finalizing session)[0m

Goodbye! ☤ on the VM: provider vyceai (https://vyceai.com/v1), model claude-sonnet-4-6. API via multiplexer: http://100.101.205.88:8377/p/coder/v1 (profile key in ~/.hermes/profiles/coder/.env).
- Wiring VERIFIED: one-shot probe reached Vyce and got HTTP 401 Invalid API key — the pipe is correct; the key VALUE is not on the VM yet (checked by WooWop + vermes: no VYCEAI_API_KEY anywhere on this box; only the provider registration in Mochi code names it).
- ACTION FOR HOME: push the key — append  to ~/.hermes/profiles/coder/.env on the VM (via vermes' API/terminal), then the coder answers and Wave 3 starts with coder in the opencode slot. Wave 3 brief unchanged (~/campaign/wave3-brief.txt); vermes still verifies.

## Wave 3 run 2 (W3-3 MCP + W3-5 env) — WooWop independent verification (2026-10-23)
Fresh worktree at bf4a5b0, Node 26.12.1: tsc CLEAN; full suite **3,328 passed / 0 failed / 14 skipped** —
exactly matching the coder's own gate. W3-3 PASS (tools/list cache, reconnect/backoff, lazy schemas;
measured first-turn schema bill 2,643 -> 1,453 est. tokens, -45%, real-loop fixture). W3-5 PASS
(sandbox preflight, exec ceilings, scoped worktree helper).
W3-4 (TUI) then landed on coder/wave3-rest: be3fdbc status line + routing badge, 2f44231 subagent
panel, 70dbee8 per-hunk edit review (coder's final gate was cut by a 429 after the commits;
WooWop verification of 70dbee8 running). P3 smoking-gun sweep launched on the same branch.
