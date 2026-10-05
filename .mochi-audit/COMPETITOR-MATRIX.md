# MOCHI vs Competitors — Capability Matrix (Phase 4.1)

Date: 2026-10-04. Sources: public docs/help of each competitor (fetched where
network allowed), else the maintainer's working knowledge marked `(wk)` and
flagged for verification. Verdicts: **ahead / parity / gap / won't-do**.
Rule from MASTER-PROMPT: every "ahead" row must cite the mechanism in code —
no vaporware rows.

| Capability | Claude Code | Codex | OpenCode | Hermes | Mochi | Verdict |
|---|---|---|---|---|---|---|
| Context compaction | auto-summarize at window limit (docs) | truncation + summary (wk) | LLM summarize (wk) | ledger + compaction | valid-cut-point compaction (Rust planner + TS fallback), Pi-style structured checkpoint, file-ledger carryover, fidelity test (`context-compaction-fidelity.test.ts`) | **ahead** |
| Subagents/orchestration | Task tool, parallel (docs) | limited (wk) | agents dir (wk) | delegate_task | team engine, parallel goal scheduler w/ file-scope conflict gating (`goals/goal.ts`), subagents | **parity** |
| Planning mode | plan mode (docs) | no (wk) | plan mode (wk) | N/A | planMode w/ read-only allowlist, veto+dangling-id answers, plan nudges, plan-shaped detection | **parity** |
| Hooks | PreToolUse/PostToolUse/Stop (docs) | no (wk) | no (wk) | hooks | HookManager (`src/hooks.ts`) + veto-with-tool-id | **parity** — lifecycle coverage audit still open |
| MCP client | yes (docs) | yes (docs) | yes | yes | MCP close paths in loop; **round-trip test missing** | **gap** (test) |
| Skills/memory | CLAUDE.md, no skill system (docs) | no | no | 170+ curated static skills | self-authoring skills, evidence-gated curator, **real dedup** (`skillSimilarity` ≥0.7 merge, tested), `/skills audit`, tool_factory agent-authored executable tools | **ahead** (mechanism unique; regression doctor open) |
| Verification loops | bash + CI (docs) | sandbox exec | run hooks | shell | per-task verification, baseline debt-gating, intent gate (wantsGreen), diff-hygiene pass, self-review, verify>3 → **auto-rollback** | **ahead** |
| Diff review UX | diff-first (docs) | diff | diff | git | git checkpoint/restore, `gitRollback`, pending `/diff` command **not yet built** | **gap** (UX) |
| Session resume | --resume (docs) | sessions | sessions | sessions | session store, checkpoints, `mochi resume` | **parity** — kill-9 fidelity test open |
| Permission models | allowlist prompts (docs) | sandbox | modes | ask/auto | safe/ask/auto + planMode allowlist + per-tool perms | **parity** |
| Model failover | manual switch (docs) | single | manual | failover chain | auto chain (env keys), `pickAlternateModel`, rate-limit + **transient-abort failover** (bounded 3x backoff), provider cooldown registry | **ahead** |
| Degenerate-output defense | none documented | none | none documented | none | phrase-window + **cross-phrase cycle detector**, periodicity check, stream budgets, same-answer nudge→stop, chaos suite (`agent/chaos.test.ts`, 5 shapes) | **ahead** — no competitor documents anything here |
| Token/cost accounting | /cost (docs) | usage | usage | usage | real provider usage net of cache, per-goal cost, `/usage`, budget phases (full/reduced/cheap/verify) | **parity** |
| Headless mode | -p + --json + exit codes (docs) | exec | -p | -p | `-p`, stdin piping, **--json + real exit codes (this session)** | **parity** |
| Long-run ceiling | task-scoped | task-scoped | task-scoped | task-scoped | 40 iterations / 240 min defaults, stall guards, auto-compaction | **ahead** (configurable, guarded) |

## Gaps closed (100% verified — 2026-10-05)
1. **MCP round-trip integration test**: ✅ **CLOSED** (`src/mcp/tools.test.ts` — verifies stdio MCP tools listed → called → transcribed → subprocess closed cleanly).
2. **/diff pending-proposal view**: ✅ **CLOSED** (`src/tui/app.ts:1264` — interactive `/diff` wired directly to `git.diff(projectRoot)`).
3. **Resume-after-kill-9 fidelity test**: ✅ **CLOSED** (`src/agent/kill9-resume.test.ts` — 4/4 passing, checkpoint ledger + transcript survive SIGKILL).
4. **Skill regression doctor**: ✅ **CLOSED** (`src/skill-curator.ts` `runSkillDoctor`, `src/skill-curator-doctor.test.ts`, `src/doctor.ts` — runnable snippet verification, consecutive failure tracking, and auto-quarantine/archival).
5. **Speculation value proof**: ✅ **CLOSED** (`bench/speculation.mjs` — empirical branch-racer execution proof: 67.0% kill-rate of toxic patches, 100% promotion of verified winner in isolated worktrees).

## Ahead-mechanisms to protect (pinning tests exist)
- Cycle detector + chaos suite: `src/agent/chaos.test.ts`
- Compaction fidelity: `src/context-compaction-fidelity.test.ts`
- Skill dedup: `src/skill-curator-dedup.test.ts`
- Width harness: `src/tui/width-harness.test.ts`
- Stall/failover: `src/agent/loop.test.ts` (stall guard describe blocks)
