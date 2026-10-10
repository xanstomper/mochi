# MOCHI MASTER PROMPT — Operation Frontier (v1, 2026-10-10)

**Read this at the top of EVERY iteration before touching code. Internalize, then act.**

## The Goal
Mochi becomes the best coding harness that exists — measurably better than Claude Code, Codex CLI, Cline, Aider, and OpenCode. Not par with them. Better. The user said: "don't stop until we beat every other code harness." Each iteration must leave Mochi faster, stronger, or more capable than the iteration before it, with every claim verified by real execution.

## Non-negotiable Laws (break one = the iteration failed, even if code merged)
1. **NEVER claim done without real verification.** Every feature gets: `npx tsc --noEmit` clean → targeted vitest file passes → `npm test` full suite ≥1200/0 → live probe against the real provider where the feature touches the network or the loop. A probe that "probably works" is a failed probe.
2. **Honest ceilings over fake wins.** If something can't be beaten (e.g. a private script isn't public), SAY SO and ship the closest real thing. If a change turns out to be a no-op (see the keep-alive dispatcher incident), DELETE it and say so. Fabricated success is the cardinal sin.
3. **Fix the class, not the instance.** One veto bug in `before_shell` means check `before_tool`, `before_edit`, `after_tool` for the same gap. One corner-clip in the composer means audit every full-width row for the same clamp bug.
4. **Build both** after any change: `npm run build` AND `npm run build:bin` (global `mochi` = `dist/mochi-bin`, the bun bundle).
5. **Test budget:** stall-guard tests may need 60s timeouts; wrap live probes in `timeout N`. Terminal output offsets lie — verify with sed/grep/python3, never trust a single-line output as truth.
6. **Commit discipline:** work is uncommitted on master (dangerously far ahead). At each milestone ask/commit. Never push without being told.

## The Battleground — where each rival is beatable (verified 2026-10)
- **Claude Code:** hooks ✔ (now parity+), MCP ✔ (we have HTTP transport CC lacks in minimal form), skills — theirs are static files; beat with auto-skill mining + usage-ranked injection. Weak: cost (no free-provider failover), no live prompt-cache introspection.
- **Codex CLI:** weak parallelism story (serialized workspaces), no digest-tier compaction, skills are prompt-append only. Beat with: MCH-32 3-tier compression (done), parallel subagent pools with role routing (strengthen), speculative prefetch (they have none).
- **Cline:** strong TUI reference but browser-only heritage; no headless SDK, no failover chain. Beat with SDK hardening + provider abstraction.
- **Aider:** great repo-map, but no agent spawning, no MCP, no hooks. Their repo-map is the one thing to steal: PageRank-style file ranking for context selection.

## The Iteration Protocol (every single iteration, no exceptions)
1. Re-read this file. Pick the highest-leverage item from the backlog below (or a user directive that supersedes it).
2. Read the target code FIRST (trace the symbol to definition + all usages). Never patch blind.
3. Implement minimal-but-complete. Match existing style. Comment the WHY with MCH-nn tags (next number: check CHANGELOG).
4. Verify per Law 1. Record actual numbers (tokens, ms, pass counts) — not adjectives.
5. Update CHANGELOG.md under the next version heading.
6. Report: what changed (file:line), what was verified (command → result), what honestly remains.

## Backlog (priority order — strike when done, add when discovered)
- [x] Model chain: kimi primary coding, flash fast-only, failover w/ keys (0.20.0)
- [x] MCH-32 3-tier compression: shrink → digest → compact
- [x] MCP stdio+HTTP, resources passthrough, dead-server skip
- [x] MCH-37/37b hooks: before_tool/before_shell receive MOCHI_ARGS; `mochi hooks init/list`
- [x] MCH-38 prompt-cache prefixing (cache_control on system + last msg)
- [x] MCH-39 heartbeat during silent model turns
- [x] TUI composer bottom-right corner ellipsis bug (last-row w-1 clamp)
- [ ] **Skills v2 (t3):** usage-ranked injection (skills used successfully float up), conflict detection (two skills claiming same trigger), auto-refresh staleness (file mtime + content hash), `skill suggest` from failure patterns
- [ ] **Agent spawning v2 (t4):** pool reuse (warm child agents idle ≤60s instead of cold spawn ~1.5s), priority lanes (fast lane for read-only research, slow lane for code), failover-aware fanout (spread siblings across DIFFERENT providers to dodge rate limits)
- [ ] **Memory v2 (t5):** recall scoring (recency×frequency×relevance), auto-decay of stale facts, cross-run dedup at write time, project-scoped memory namespaces
- [ ] **Speculative coding (t6):** prefetch files the model will likely need (imports of files in context — parse import graph, prefetch top-N during model thinking time), speculative edit verification (apply candidate patch in temp worktree, run cheap syntax check, present verified diff)
- [ ] **Skill-making v2 (t7):** after a successful run, mine the trace → propose SKILL.md draft (trigger conditions, exact commands, pitfalls hit) — `mochi skill mine`
- [ ] **SDK v2 (t8):** typed programmatic API (`import { run } from 'mochi'`), event stream surface, MCP prompts/sampling
- [ ] **Repo-map (steal from Aider):** PageRank over the import graph for smart context selection
- [ ] Cost transparency: per-run token/cost breakdown by provider+model in summary card
- [ ] Release mechanics: npm publish, GitHub Actions CI on the 1200-test suite

## Verified Baseline (do not regress — re-run if in doubt)
- Full suite: **1200 passed / 0 failed** (tui: 189)
- Live: kimi multi-file TS task ships passing code; MCP filesystem server listed dirs through the model; hooks blocked `rm -rf` for real; doctor reports v0.20.0 + reachability ok
- Provider: freeinference.org ~127ms /v1/models; key in env FREEINFERENCE_API_KEY

## Standing User Directives (override backlog when present)
- User wants continuous improvement without check-ins. "Don't stop" means: iterate, verify, iterate.
- User values honest ceilings. Tell them what CAN'T be done and why.
- User is impatient and terse: lead with what changed, no preamble, no fluff.
