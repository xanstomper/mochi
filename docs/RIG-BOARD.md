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

## New tool queued (Ben, 2026-10-23): CDP-native headless browser
Brief: ~/campaign/cdp-browser-brief.txt. Raw CDP over WebSocket to chrome-headless-shell —
no puppeteer/playwright, no full-browser process tree. AX-tree snapshots with ref ids,
one action-discriminated tool, binary resolution + pinned download, sandbox-aware.
Ships behind a measurement gate vs the existing browser path (cold start, RSS,
time-to-snapshot/screenshot on local fixtures) — the 10x target gets tested, not asserted.
Starts on branch feat/cdp-browser the moment P3 closes. Owner: VM coder; vermes/WooWop verify.

## P3 smoking-gun sweep — WooWop independent verification (2026-10-24)
Fresh worktree at 6b10f23, Node 26.12.1: tsc CLEAN; full suite **3,401 passed / 0 failed / 14 skipped** —
exactly matching the coder's gate. All 11 P3 commits PASS: ISSUES.md dispositioned,
9 dead exports deleted, self-poisoning class fixed (annotations cannot enter the
objection/evidence channel), plaintext-key hygiene warning, node<22 preflight,
doc-sprawl/price/oauth fixes. Wave 3 + P3 CLOSED; verified chain since b499831:
3,269/2 failed -> 3,271 -> 3,285 -> 3,328 -> 3,384 -> 3,401, zero failures throughout.
CDP-native headless browser tool now building on feat/cdp-browser (brief gated).

## Endless workflow (Ben, 2026-10-24): the loop is ON
Standing order: work everything on the Wave 4 chart + the fresh-gap list,
continuously, across SYS-1 WooWop / SYS-2 home / SYS-3 VM (vermes + coder).
Queue: ~/workspace/vps-setup/hermes/queue.md (VM copy: ~/campaign/queue.md).
Loop rules: one coder run + one vermes run at a time (freeinference concurrency
= 2, shared with home); every landing gets a fresh-suite verification before it
counts; never push to origin (home merges); never relaunch promo; never touch
Ben's keys. Coordinator cron (mochi-endless-loop, ~every 3h) checks state and
advances the queue; it reports completions/blockers only. Loop stops ONLY when
Ben says stop.
Running at loop start: P5 live scorecard (vermes), hybrid tuning (coder),
CDP verification (WooWop).

## CDP browser tool — WooWop independent verification (2026-10-24)
Fresh worktree at a9efc8f, Node 26.12.1: tsc CLEAN; full suite **3,445 passed /
0 failed / 12 skipped** (+44 vs P3's 3,401 — the 42 CDP tests + pins).
Coder's measurement gate stands: cold-start 1.13x (not 10x — chromium startup
dominates), RSS -105 MB (-17%), warm click 24x, screenshot 1.5x, snapshots tie.
CDP CLOSED and verified. Verified chain: 3,269/2 -> 3,271 -> 3,285 -> 3,328 ->
3,384 -> 3,401 -> 3,445, zero failures throughout.

## Hybrid tuning — coder COMPLETE, WooWop verification running
feat/hybrid-tuning (300eb87 file-level RRF, d06a37b lexical vote at half
weight, f9861d9 frozen set 24 -> 60). 60-query set, real production path:
lexical 0.800/0.867, embedded 0.833/0.883, tuned hybrid 0.883/0.900 — ship rule
PASSES both legs. Coder's gate: tsc clean, 3,450/0. 4 every-signal misses
diagnosed (q10/q12/q21 corpus gaps; q23 ground-truth ambiguity — needs a human
call on whether session-store.ts joins the target list).

## P5 first live cell — BLOCKED, not failed
swe cell remains UNMEASURED: zero live tasks. Two concrete stops: (1) no real
SWE-bench Pro V2 dataset exists on the VM (only the 4-instance synthetic
fixture); (2) the vermes session's permission gate withheld network consent
for every repo-fetch probe (5-min approval timeouts, unanswered). Next run
needs: a real dataset source + an egress-approval path Ben can answer, plus
runner backoff and per-task turns/token capture. This is a Ben decision, not
a coder task. Falsification head-to-head (Mochi vs Hermes, same model, fresh
tasks, no dataset needed) launched to vermes instead — it sidesteps both stops.

## Hybrid tuning — WooWop independent verification (2026-10-24)
Fresh worktree at f9861d9, Node 26.12.1: tsc CLEAN; full suite **3,450 passed /
0 failed / 12 skipped** — exactly matching the coder's gate. Tuned hybrid
(file-level RRF + lexical vote at half weight) SHIPS as the production
file-aggregation path: 60-query set lexical 0.800/0.867, embedded 0.833/0.883,
hybrid 0.883/0.900. Hybrid CLOSED. Verified chain: 3,269/2 -> 3,271 -> 3,285 ->
3,328 -> 3,384 -> 3,401 -> 3,445 -> 3,450, zero failures throughout.
Open from the run: q23 ground-truth ambiguity (session-store.ts vs
state-store.ts) — needs a human call, recorded not decided.

## Lightpanda bake-off — WooWop independent verification (2026-10-24)
Fresh worktree at 69c0fde (feat/lightpanda-engine), Node 26.12.1: tsc CLEAN;
full suite **3,475 passed / 0 failed / 12 skipped** — exactly the coder pass
count, and the coder gate single failure (src/agent/loop.test.ts:1318, pytest
case) did NOT reproduce in the full suite at tip. Adjudicated a load flake,
not a lightpanda regression (same pattern as the batch-2 load-flake
adjudication). Lightpanda CLOSED: verdict stands — opt-in engine only, NO
auto-routing. Decisive probe: Accessibility.getFullAXTree works, interactive
roles carry backendDOMNodeId, ref-id snapshots work.

## MCP server-side 2026-07-28 — coder audit CLOSED, zero code changes (2026-10-24)
Coder stopped at the brief stop condition: src/mcp-server.ts speaks exactly
one revision, 2024-11-05 (hardcoded, no negotiation); there is NO MCP SDK in
the tree (no dependencies field, zero MCP entries in package-lock, no
@modelcontextprotocol in node_modules); the latest published SDK
@modelcontextprotocol/sdk@1.32.2 tops out at 2025-11-25 with no
server/discover — 2026-07-28 support exists only on TS SDK main, unpublished.
Implementing discover + cache hints would have meant hand-rolling unverified
protocol, explicitly forbidden. Tree still exactly f9861d9. No code to land,
no verification suite to re-run: that tip was already independently verified
(hybrid verification, 3,450/0/12); the coder own gate on the untouched tree
was 3,450/1 with the same known loop.test.ts flake. Follow-ups, not rig
tasks now: revisit when a published SDK supports 2026-07-28; note the client
cacheScope vocabulary mismatch (ours: connection/process; spec:
public/private) for whenever server hints arrive.

## Recall queries — WooWop independent verification (2026-10-25)
Fresh worktree at 518a6b7 (feat/recall-queries), Node 26.12.1: tsc CLEAN;
full suite **3,454 passed / 0 failed / 12 skipped**. Coder's fix SHIPS:
`expandQueryText()` glossary in src/repo/semantic-index.ts (generic
everyday->technical vocabulary, no target filenames/symbols), applied at the
single semanticSearch entry so lexical and embedding signals see the same
expanded text. 60-query set, real production path: hybrid **0.883/0.900 ->
0.917/0.950** (+0.033/+0.050); lexical @10 +0.017, embedded @10 +0.050.
Row-level diff: exactly q10/q12/q21 changed, all upward (hybrid file ranks
0->4, 20->5, 0->6); 57 rows byte-identical; q23 untouched. Diff scope
verified: exactly semantic-index.ts + its test (+112 lines), bench/ and
evals/ untouched, frozen set byte-identical. Coder's own gate showed 1
failure (polyglot-python e2e, loop.test.ts:1318) that did NOT reproduce in
this independent full suite; coder proved it pre-existing by A/B on the
pristine f9861d9 tree (fails identically there, gated on a pytest venv
that has since appeared on PATH). Recall CLOSED. Verified chain:
3,269/2 -> 3,271 -> 3,285 -> 3,328 -> 3,384 -> 3,401 -> 3,445 -> 3,450 ->
3,454, zero failures throughout.
Open from the run: q21 ownership adjudication (workspace.ts vs
prefetch/trace/read-cache-store, which literally track file reads/writes)
joins the existing q23 question (session-store.ts vs state-store.ts) —
both need a human call, recorded not decided.

## Hermes distillation — vermes research run COMPLETE (2026-10-24)
Research + data collection ONLY — no Mochi source touched. Subject:
Hermes Agent v0.22.5, probe model glm-5.3-flash via freeinference (same
model family as the rig). Deliverables: report at
~/campaign/hermes-distillation-report.md + corpus under
~/campaign/distill-hermes/ (13 subsystem notes, 8 exported probe
trajectories, per-run token/cost measurements). One consent-gate event
(17:07Z fixture-generation heredoc timed out, not retried; probe 5
redesigned gate-safe). Landing: the report's Phase 3 prioritized list is
queued as distillation fuel D1–D10 (telemetry sidecar first, through
run-recipe manifest). Distillation CLOSED as a research run; its items
now ship only with their proof metrics measured.

## G6 journal write-failure tolerance + G11 idle compaction — WooWop independent verification (2026-10-25)
WooWop-direct implementation (queue item 4; the loop did not launch it on
coder), worktree ~/mochi-g6g11, branch feat/g6g11, base f9861d9. Commits:
79ec40c (G6 bounded-retry appends, dedupe on fsync failure, atomic tail
salvage), d00da9e (G11 idle-compaction decision, activity clocks, named
break reason), 32b65de (G11 idle-compaction trigger at run start +
per-child windows), 65f4efd (steer-acceptance window fix, see below).
First full gate at 32b65de came back 3,474 passed / 1 failed / 12 skipped —
and the 1 failure was a REAL regression, not a flake: subagent-steer test
(e), queued-child steer delivery (base f9861d9 passes 6/6, item tree failed
twice). Mechanism was a microtask race: G11's awaited idle check deferred
runActive past the child-launch handover, so the queued steer was refused
as "not started". Fix 65f4efd opens the steer-acceptance window before
run()'s first await, plus new regression test (g): a queued child opted
into idle compaction still receives its queued steer from its first turn.
Fresh worktree at 65f4efd, Node 26.12.1: tsc CLEAN; full suite **3,476
passed / 0 failed / 12 skipped** (432 files passed, 4 skipped); the
subagent-steer file is 7/7. Proof metrics unchanged by the fix: G6 7/7
injected-fault scenarios, 0 lost runs; G11 8/8 decision-matrix verdicts,
0 false triggers, first-turn tokens 11,260 -> 2,135 on fixture (est.
~2,963 -> ~562, -81%). G6+G11 CLOSED. Verified chain:
3,269/2 -> 3,271 -> 3,285 -> 3,328 -> 3,384 -> 3,401 -> 3,445 -> 3,450 ->
3,454 -> 3,476, zero failures at the tip.

## AAIF Agent Skills alignment — WooWop independent verification (2026-10-25)
Coder COMPLETE on ~/mochi-aaif, branch feat/aaif-skills, base f9861d9. Commits: 17afb86 (spec conformance gate — validateAaifSkill, spec-exact name rules, line-pinned diagnostics), 870095f (published-skill ingestion — security screen reusing scanPromptInjection plus invisible-unicode / hidden-html / concealed-directive / credential-exfiltration / obfuscated-blob rules, fetch-execute warn-tier; quarantine under <root>/.quarantine/<name>/ with QUARANTINE.json naming every rule + line, never installed, never silently dropped; .origin.json provenance with source + git commit/tag), 742baf5 (authoring guide docs/AAIF_SKILL_AUTHORING.md).
Independent verification in a fresh worktree at 742baf5, Node 26.12.1: tsc CLEAN; full suite **3,494 passed / 0 failed / 12 skipped** (431 files passed, 4 skipped). The coder's own gate showed 1 failure (pre-existing agent-loop e2e) that did NOT reproduce in this independent full suite — consistent with the coder's A/B on the pristine f9861d9 tree, so it is not an AAIF regression. Proof metrics: spec pinned live (agentskills.io/specification + canonical repo 69ef37e, 2026-08-09; skills-ref v0.1.0 normative validator); bundled conformance **150/150** (skills lint clean, exit 0); ingestion fixtures **7/7** (1 good installed with provenance, 3 malformed + 3 malicious quarantined with named rules; isolated-HOME CLI smoke confirmed both paths on disk). Bonus fix in the tree: the frontmatter parser's silent hoisting of nested metadata: keys is fixed and regression-tested. AAIF CLOSED. Note from the coder, recorded not fixed here: this VM's 60 user-dir external skills (Hermes dialect) are flagged 60/60 by the new strict gate — correct gate behavior, rig-side work outside this repo. Verified chain: 3,269/2 -> 3,271 -> 3,285 -> 3,328 -> 3,384 -> 3,401 -> 3,445 -> 3,450 -> 3,454 -> 3,476 -> 3,494, zero failures at the tip. Nothing pushed to origin — home merges, as usual.


## Decision memory across sessions — WooWop independent verification (2026-10-25)
Coder COMPLETE on ~/mochi-decision-memory, branch feat/decision-memory,
base dba091e (post-merge main). Single commit 01cf7589: rejected-approach
records + task-start retrieval hook (770 insertions, 5 files). The first
coder run was cut by a freeinference 429 after the commit; the resumed run
filled the standing gate and the report (~/campaign/decision-memory-report.md).
Proof metrics (coder, re-verified in the independent run): fixture bench
repeat rate 1.00 -> 0.00, precision 1.00, recall 1.00; decision-memory tests
13/13 green (10 unit + 3 multi-session fixture).
Independent verification in a fresh worktree at 01cf7589, Node 26.12.1:
tsc CLEAN; full suite **65 failed / 3,462 passed / 15 skipped** (465 files:
20 failed, 440 passed, 5 skipped).
Adjudication — the 65 failures are PRE-EXISTING at base dba091e, not a
regression: an independent base comparison ran the same 20 failing files
at dba091e and got the same 65 failed tests with an EMPTY failing-name
diff (one tip-only line was a stderr artifact of the known flaky test, not
a failure). Zero-decline: no test passing at base fails at tip, and the
extra passing tests at the tip are exactly the 13 new decision-memory
tests. The coder's own resumed session ran the same base comparison with
the same result. One genuine discovery, environment-only: the sandbox
canary test ("credential canary in $HOME/.ssh is NOT readable") fails
from any /home/opc checkout at base AND tip — runShellString still uses
the legacy unmasked bubblewrap builder in exec.ts. Not a regression,
noted for a future fix, not blocking this landing. Decision memory
CLOSED. Nothing pushed; home merges.

## Routed juries for high-stakes steps only — coder, independently verified (2026-10-26)
Coder (branch feat/routed-juries, base dba091e): commits d384c901
(routed jury — 12 gated action classes, two deterministic passes that must
both agree, opt-in, default OFF) + 7d5520a5 (hardline floor restored at
the exec.ts runShellString chokepoint — dd of=/dev/sdz9 executed on base,
refused with exit 126 after the fix). Proof metrics (coder, real loop +
real provider wire path + real temp workspaces, 12 fixtures): bad-action
blocked rate 6/6 with jury vs 0/6 ungated baseline; false-block rate on
benign high-stakes actions 0/5; 0 model tokens added (deterministic
passes), per-gated-action latency median 0ms / max 2ms.
Independent verification in a fresh worktree at 7d5520a5, Node 26.12.1:
tsc CLEAN; full suite **64 failed / 3,483 passed / 15 skipped** (465
files: 19 failed, 441 passed, 5 skipped).
Adjudication — zero-decline vs base dba091e: the failing-name diff
against the independent base comparison (65 failures, 20 files) is
TIP_ONLY empty (no new failure introduced) and BASE_ONLY exactly one
test — src/security/hardline.test.ts runShellString refuses a hardline
command without executing it — the pre-existing failure this item
repairs. The remaining 64 failures are pre-existing at base
(environmental: no bubblewrap, no RLIMIT enforcement, antigravity 503,
no browser daemon; architectural: P2 sync lazy-load vs vitest src-graph),
none touching the jury. Routed juries CLOSED. Nothing pushed; home merges.

## Verification-first default mode — coder, independently verified (2026-10-26)
Coder (branch feat/verification-first, base dba091e): commits fb089612
(recorded reproductions + evidence critic as the fix-task default) +
9a2828fd (opt-out seam for the scripted degenerate-provider harnesses).
Proof metrics (coder, real loop + injected bugs, scripted archetypes):
false-fix rate ON 0/18 vs OFF 6/18 (33%) — every false-fix archetype
run completed as "success" with the reproduction still failing when the
mode was off; all 12 adversarial runs are caught with it on; every ON
completion carries a recorded reproduction (6/6 vs 0/18 off); tokens
identical on scripted accounting, harness wall time +17% (critic re-runs
+ A/B); live-LLM deltas UNMEASURED (no provider configured; keys untouched).
Independent verification in a fresh worktree at 9a2828fd, Node 26.12.1:
tsc CLEAN; full suite **65 failed / 3,480 passed / 15 skipped** (466
files: 20 failed, 441 passed, 5 skipped).
Adjudication — zero-decline vs base dba091e: the failing-name diff
against the independent base comparison (65 failures, 20 files) is
TIP_ONLY empty and BASE_ONLY empty — the identical pre-existing failure
set (environmental + architectural, same classes as prior landings),
none introduced by this item. Note: the coder gate reported 3,484
passed vs 3,480 independently — a 4-test counting difference with an
identical failure set, not a regression. Verification-first CLOSED.
Nothing pushed; home merges.
