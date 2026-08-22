# Mochi Harness V2 — Architecture & Implementation Plan

> Derived from `harness-research.md` (source-first comparison of Pi 0.84,
> Cline 3.x SDK, and Mochi's current code). Principles over feature-copying.

## Design principles

1. **Procedural knowledge beats prose identity.** A prompt that says *when*
   to use each tool and *what to do when stuck* outperforms a long identity
   statement. Mochi keeps its cached stable prefix but adds decision rules.
2. **Nothing is lost, everything is bounded.** Every tool result gets one
   uniform policy: dual-limit truncation with head/tail preservation and a
   temp-file spill holding the full output. The model can always re-read the
   full log.
3. **Compaction must be structurally valid.** Never cut between a tool call
   and its result. Trigger from real provider usage, not guesses.
4. **Capabilities are advertised, not injected.** Skills/guides are listed by
   name+description in the prompt and loaded on demand (Pi/agentskills.io
   pattern). Bundled guides ship by default so the harness is never "empty".
5. **Teach the model the harness's strengths.** Parallel batching, background
   long commands, model failover — if the prompt doesn't say it, the model
   behaves as if it doesn't exist (the "minimal" feeling).

## Target architecture

```text
                        MOCHI
                          │
                   ┌──────▼──────┐
                   │ Agent Core  │  goal → task → agent loop
                   └──────┬──────┘
          ┌───────────────┼────────────────┐
          ▼               ▼                ▼
   Context Engine   Capability Layer   Verify/Teach
   ├ stable prefix  ├ ToolRegistry     ├ baseline
   ├ rules/guides   ├ uniform policy   ├ verify
   ├ state prompt   ├ MCP / ACP        ├ self-review
   └ compaction     └ subagents        └ autopsy
          │               │
          └───────┬───────┘
                  ▼
            Model Router  (profiles, failover, capability gate)
```

Changes are incremental inside the existing files — no rewrite.

## P0 implementation (this phase)

### P0.1 Bundled guides (`.mochi/skills/*` shipped with the package)
- `debugging/SKILL.md` — reproduce → localize → fix → verify procedure.
- `testing/SKILL.md` — pick the runner, write narrow tests, repair loop.
- `research/SKILL.md` — web_search → web_crawl → cite; repo exploration.
- `implementation/SKILL.md` — read-first, surgical edits, verify.
- `git-workflow/SKILL.md` — checkpoints, branches, safe destructive ops.
- Advertised via the existing `skills()` prompt block; loaded on demand by
  the model through the `skill` tool. Zero prompt-cost when unused.

### P0.2 Uniform tool-result policy (`src/core/tool-output.ts`)
- `applyToolOutputPolicy(output, {maxLines=400, maxBytes=20KB})`:
  - keeps whole lines only; dual limit; head+tail preservation;
  - spills full output to `$TMPDIR/mochi-tool-<id>.log`;
  - appends `[full output: <path> (N lines, M KB total)]` so the model can
    `read` or `grep` the file when the fold hid what it needed.
- Applied once in `runToolCall` — every tool inherits it.

### P0.3 Prompt upgrades (`src/context.ts`)
- New "Working style" section: parallel batching instruction (Cline),
  background long commands, stuck-recovery ladder, budget awareness.
- Guides advertised by name+description (already the shape of
  `formatSkillsForPrompt`).

### P0.4 Valid-cut-point compaction (`src/context.ts`)
- Track the index of the last completed turn (assistant message that had no
  tool calls, or the user message that starts a turn).
- `compact()` cuts only at valid boundaries; usage-based trigger uses the
  last real `usage` when available (already emitted as `usage:updated`).

## P1 (next)
- LLM structured checkpoint on compaction (Pi's Goal/Progress/Decisions
  format) via the `fast` profile.
- Mode stamping on user messages when plan mode toggles.
- Conditional guidelines: only mention tools actually registered.

## P2
- File-op carryover across compaction (read/edited sets). **SHIPPED (phase 2)**
- Truncation telemetry counters per tool. **SHIPPED (phase 3)**

## Phases 2–10 (shipped in docs/harness-v2-phases.md)
- Phase 4: real-usage context accounting (provider promptTokens drive the
  compaction floor; chars/3.8 estimate is the fallback).
- Phase 5: stuck-signal counters surfaced in the volatile state prompt.
- Phase 6: skill result caching (second load is a short reminder) + load counts.
- Phase 7: durable checkpoints persisted to `.mochi/state/checkpoint.json`,
  re-injected on resume.
- Phase 8: prompt-quality regression suite (`src/prompt-quality.test.ts`)
  asserting skills advertisement, section order/uniqueness, byte bounds.
- Phase 9: prose-runaway guard (one terse-rewrite request when a no-tool-call
  answer exceeds 12k chars).
- Phase 10: this documentation refresh.

## Benchmark plan
- Token per task: `mochi --print` on a fixed 10-task suite, sum tokens.
- Lost-information rate: tasks requiring data beyond the fold (e.g. "find the
  failing test name in a 10k-line test log") must succeed via temp-file read.
- Loop safety: existing loop regression tests must stay green.
