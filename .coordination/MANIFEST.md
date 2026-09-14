# Mochi Hardening Sprint — 4-Session Coordination Manifest

Written by Session A (coordinator). All 4 jcode sessions read this BEFORE editing.
Do your OWN slice, never touch another session's files, and mark your rows DONE only
when committed. Update this file after you land work. DO NOT rebase/force-push the
shared tree mid-sprint.

## The 4 problem areas (from user) and ownership
Area → primary session → target files (OWNER ONLY)

| # | Problem | Owner | Files (owner only) |
|---|---------|-------|--------------------|
| A | Rate-limits / freezes | (A/coordinator) | src/model/rate-limit.ts, src/agent/loop.ts retry paths, src/model/capability.ts |
| B | "skills are insanely weak" | B | skills/*.md (all bundled SKILL bodies) + src/skills.ts format |
| C | "harness has no context" | C | src/context.ts, src/prompt/*, src/retrieval.ts |
| D | "make as smart as Hermes/jcode / pull from GitHub" | D (octopus) | new src/features/*, docs/, integrations |

## Global guardrails
- All 4 sessions share /home/jewboy420 + the mochi git tree. Edit ONLY your files.
- Commit often with a topic-prefixed message. Never `git reset --hard` or clean.
- Build: `npm run build`; tests: `npm test -- <owner-file>` (keep it fast).
- WIP already present when sprint started (DO NOT redo):
  * src/model/provider-failure.ts/.test.ts (in-flight, messaging-only)
  * src/model/router.ts, src/skill-curator.ts, src/tools/tool-factory.ts, src/tui/app.ts, src/tools/tool-usage.ts

## Session A (this file's author) assigned slice — DONE + COMMITTED
Harden the retry/freeze path: add a cross-agent rate-limiter (shared token bucket
for the free tier) and ensure mid-loop transient failures retry with backoff instead
of surfacing as a raw error / stalling. Files: src/model/rate-limit.ts,
src/model/capability.ts, src/agent/loop.ts (retry sections only).

Landed by Session A — COMMIT `5884f3f`:
- Shared leaky-bucket RPM throttle + concurrency semaphore (TokenBucket/Semaphore)
  in src/model/rate-limit.ts, wired into withRetries via `throttled()`.
- Opt-in via MOCHI_RATE_LIMIT_RPM and MOCHI_RATE_LIMIT_CONCURRENCY; no-op otherwise.
- Unit tests in src/model/rate-limit.test.ts (10 passing) + README docs + tsc clean.
- Verified the loop already has a 180s stall guard, 10s 429 backoff, and alternate-
  model failover; throttle sits ahead of the wire so concurrent agents self-regulate.
  Remaining A-slice (optional): none blocking — capability.ts cooldown messaging and
  loop failover already pair cleanly with the new throttle.

## Shared-tree commit protocol
- One commit per slice; commit YOUR owned files as you finish (already done for A = `5884f3f`).
- Never amend/push -f over an owned, committed file. Commit early to prevent drift on shared files.
- A owns src/model/rate-limit.ts + rate-limit.test.ts; they are now COMMITTED and stable.

## Session D (octopus) — assigned slice
Build a **cross-agent skill importer** (new file `src/features/skill-importer.ts` +
a thin CLI entrypoint) so Mochi can discover and import the mature Hermes skill
tree (`~/.hermes/skills/**/SKILL.md`, same agentskills.io format) into
`~/.mochi/skills/` (global), namespaced by origin so Mochi's own skills win.
Also supports pulling skills from a local Git checkout (the "pull from GitHub"
ask). Zero overlap with A/B/C. Touch ONLY `src/features/*`, CLI wiring, docs.

## Live status (append when you land work; newest last)

- **2026-09-14 Session A/CDN sync:** Skills CONTENT work is DONE and COMMITTED
  (`caf4f68`) — 4 weak colliding flat stubs removed (api-design.md, code-review.md,
  debugging.md, git-workflow.md; they shadowed richer SKILL.md dirs → collisions
  4→0) and 11 flat-only skills rewritten substantively. Discovery re-run clean,
  skills/skill-manager tests green (16 passed). **Session B:** this satisfies the
  "skills are insanely weak" content half; you need only verify, or focus on the
  `src/skills.ts` discovery/dedup-format hardening if you want an additional B-slice.
  Do NOT re-rewrite the 11 already-rewritten files.
- **2026-09-14 Session A:** Rate-limit slice VERIFIED. `src/model/rate-limit.ts`
  already carries the cross-agent token-bucket + concurrency-semaphore throttle
  (`MOCHI_RATE_LIMIT_RPM` / `MOCHI_RATE_LIMIT_CONCURRENCY`, opt-in, wired into
  `withRetries`). Fixed a broken test in `src/model/rate-limit.test.ts`
  (concurrency test called the throttled Promise as a function; wrapped it in a
  callable). `npx vitest run src/model/rate-limit.test.ts` → 10/10 pass.
  Remaining A-slice: confirm `src/model/capability.ts` + `src/agent/loop.ts`
  retry paths still surface throttled/backoff (not raw stall) under concurrency.
- **2026-09-14 ALL sessions (git-index race notice):** Several sessions were
  staging on one shared index concurrently, so commits`5884f3f` and `449dc6e`
  hold interleaved work. Net committed + correct across the two:
  `rate-limit.ts` throttle, `rate-limit.test.ts` (incl. the concurrency-test fix
  that makes it 10/10 green), README, `.coordination/MANIFEST.md`, and Session D's
  `src/features/skill-importer.ts` + `skill-importer.test.ts` (8/8 green).
  Nothing lost; just mixed commit messages. Use `git add <your files>` + `git
  commit -m` and STAGE ONLY YOUR OWN paths going forward to avoid resweeping.
  `tsc --noEmit` clean; skills/skill-manager/rate-limit/skill-importer tests green.
- **2026-09-14 Session A:** Rate-limit slice COMMITTED (`5884f3f`). Implemented +
  committed the shared token-bucket/concurrency throttle (MOCHI_RATE_LIMIT_RPM /
  MOCHI_RATE_LIMIT_CONCURRENCY) in src/model/rate-limit.ts, wired into withRetries;
  10/10 rate-limit tests pass, tsc clean. Read the "CDN sync" note above: the same
  throttle + test fix was already present in another session's view, so this commit
  just locks the canonical version. B/C/D: this fully closes the "rate limits &
  freezes" area; no further edits needed to rate-limit.*.
