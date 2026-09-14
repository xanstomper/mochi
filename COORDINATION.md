# Mochi Fix-All — 4-Way Coordination Plan

Updated: 2026-09-14T05:48Z (octopus session)

## Goal
Coordinate 4 jcode sessions (via Terminus) to fix ALL Mochi issues in `~/mochi`:
weak harness, weak skills, rate limiting, and freezing. Sessions target SEPARATE
issues, review + communicate, and integrate cleanly.

## Root cause analysis (from ~/.mochi/memory/failures.md + code review)

The #1 recurring failure across every session is:
```
Model request failed: The operation was aborted.
```
It appears ~30+ times. This is the 30s **stall guard** in `src/model/openai.ts`
(killing slow free-tier streams) surfaced as a raw provider error, then:
- Escalated as a health failure into `CapabilityRegistry.record(ok=false)`,
  growing cooldown, sometimes marking providers effectively unusable.
- The `withFailover` chain then fails over, but the primary (free tier) keeps
  getting poisoned. Same slow provider + same abort = repeated aborts.

Secondary failures:
- **Rate limit**: `429 Too Many Requests ... Too many concurrent requests (limit: 4)`
- **Cooldown**: `Provider freeinference is cooling down after failures`
- **Loop guard**: `Too many tool calls; stopping to avoid an infinite loop` and
  `repeated mutating tools and no progress` — trips on slow/chatty providers.

## Current in-progress changes (do NOT clobber; both belong to wsA)
- `src/model/provider-failure.ts` (untracked) + test — classify transient/fatal provider errors.
- `src/tools/tool-usage.ts` (untracked) — authored-tool telemetry.
- Modified: `src/model/router.ts` (cooldown wait message), `src/skill-curator.ts`
  (consolidate default true), `src/tools/tool-factory.ts` (usage line),
  `src/tui/app.ts` (safeWrite EIO guard + transient auto-retry in prompt runner).
These pass tests already. Keep them as the foundation for wsA.

## Workstream assignment (each session owns ONE, review others)
- **WORKSTREAM A — rate-limit/freeze (owns provider-failure + TUI retry):**
  Fix abort/cooldown poisoning. Slow free-tier abort must NOT poison the
  capability registry. Pre-stream abort should retry (with backoff) on the SAME
  provider before failing over. 429 should respect Retry-After. Freeze = TUI
  waiting on a stream the stall guard cannot reach; ensure chains fail over.
- **WORKSTREAM B — skills:** 72 bundled skills in `~/mochi/skills/` exist but only
  `safe-shell` is installed in `~/.mochi/skills`. Fix auto-install/sync and make
  skill usage actually drive retrieval (skill-usage.json already tracked).
- **WORKSTREAM C — loop-guard/harness:** Reduce false `tool_loop` trips on slow
  providers. Loop guard in `src/agent/loop.ts` (lines ~961-1042). Distinguish
  genuine infinite loops from slow-but-progressing work. Chat tasks should not
  require repeated tool calls, but delayed output should not count as no-progress.
- **WORKSTREAM D — context/freeze hardening:** Verify freeze root cause, harden
  context compaction + multi-agent memory. Check `src/agent/loop.ts` stall surfacing
  (~line 794) and context budget. Make freezes recoverable rather than sessions.

## Integration
- After each workstream: run `npx vitest run` (targeted), then full suite.
- Rebuild binary: `npm run build` then `npm run build:bin` (or the TSX dev path).
- Coordination doc lives here: `~/mochi/COORDINATION.md`. Sessions append notes
  with a `## session:<name>` header. Final owner (octopus) does integration.

## Session roster
Fill in as sessions report their names and picked workstream.
## session:dolphin — claim
- **Slice:** Harden `src/skills.ts` discovery/dedup + test isolation (the coordinator's
  offered "additional B-slice"). No overlap with A/C/D or the committed skills content fix.
- Files: `src/skills.ts`, `src/tools/skills.test.ts`, `src/skills.catalog.test.ts` (tests only),
  plus an additive `skills/rigorous-code-review/` skill (new name, no collision).
- Status: test-isolation fix landed. In progress.

## session:dolphin — DONE
- Committed `a09ff3f` "fix(skills): harden discovery budget + test isolation, add
  rigorous-code-review skill". Skills tests now 9 green + catalog(3) + manager(13)
  = 25 green; typecheck clean.
- Budget hardening: `discoverSkills` maxEntries now genuinely bounds the whole walk
  (was a per-branch const no-op), so pathological trees can't block the event loop.
- Test isolation: `loadProjectSkills` no longer leaks the real `~/.mochi/skills`
  user dir into assertions on dev machines.
- Added additive `skills/rigorous-code-review/` (proven multi-pass audit skill).

## session:A (raccoon) — 2026-09-14 — ABORT-POISONING FIX LANDED (a5afdda)
Root cause of the recurring freeze closed: the openai 30s stall-guard aborts a
slow free-tier stream via signal.abort(); withCapabilityGate was recording that
abort as a provider FAILURE (reg.record ok=false), growing cooldown and
poisoning providers that are merely slow. Now isAbort() skips the registry
penalty for aborts (AbortError / ABORT_ERR / UND_ERR_ABORTED / transport abort)
yet still rethrows so withRetries treats it as transient. Real failures
(ECONNREFUSED, 5xx, auth) still escalate cooldowns. Combined with the earlier
shared throttle (5884f3f), Workstream A (rate-limit/freeze) is CLOSED.

## session:dolphin — integration pass (cont.)
- Committed `7a39ffe` "fix(skills): correct uppercase names in bundled cognitive
  skills". The 4 bundled cognitive skills declared uppercase frontmatter names
  (ANCHOR/DOX/OWL/SISPIS) which violated the lowercase validator, so they were
  silently discovered only under uppercase identifiers + produced validation
  diagnostics. Renamed to the lowercase catalog identifiers
  (cognitive-anchor/dox/owl/sispis). Discovery now clean, 0 uppercase diags.
- Integration check: combined discovery of bundled (~68) + Session D's 143
  imported user skills = 209 skills within default budget; only benign diag remains
  (a description-less README.md in the user tree). Cognitive + skill tests 41 green.
- Full-suite integration run in progress as the coordinator's verification step.

## session:A (raccoon) — WS-A FINAL — abort handling unified (c57ea9f)
Workstream A (rate-limit/freeze) fully closed. Abort handling now one coherent
story across three commits:
  5884f3f shared throttle (token bucket + concurrency) curbs 429 bursts ahead of wire
  a5afdda isAbort() skips registry poisoning on stall-guard aborts
  0c28d45  classifyError treats local aborts as non-retryable (no re-request freeze)
  c57ea9f single canonical isAbort in rate-limit.ts (router imports it; no dup)
20/20 router+rate-limit+failover tests green, 11 rate-limit tests incl. the
abort-retry pin, tsc clean. A slow free-tier stall no longer poisons providers,
no longer re-enters a multi-minute retry freeze, and bursty concurrency is
throttled up front. See commit messages for detail.
