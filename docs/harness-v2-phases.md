# Harness V2 — Phases 2 through 10

> Continuation of the P0/P1 work (commits 32f9a61, fd89da6). Each phase is
> grounded in a mechanism observed in the research (docs/harness-research.md)
> or an identified gap in Mochi's own loop. All changes are incremental.

## Phase 2 — File-op carryover across compaction (P2 from roadmap)
- `ContextEngine` tracks `filesRead` and `filesEdited` sets as the transcript
  is appended (from read/write/edit/patch/delete tool calls).
- `compact()` re-injects the sets into the compacted ledger so the model does
  not re-read known files or re-edit forgotten ones after context loss.
- This is the concrete fix for "compaction amnesia": the cheapest possible
  memory (a set of paths) survives every compaction.

## Phase 3 — Truncation telemetry (P2 from roadmap)
- `tool-output.ts` increments per-tool counters (calls, truncations, bytes
  saved) in a module-level registry.
- Exposed via the `mochi doctor` surface and a `telemetry` tool result footer
  so runs are debuggable: "how often is the fold hiding things?"

## Phase 4 — Real-usage context accounting (Pi mechanism)
- The loop records the last REAL provider usage (promptTokens) into the
  ContextEngine; the compaction floor compares against actuals instead of the
  chars/3.8 estimate. Estimate remains the fallback when a provider reports
  no usage.

## Phase 5 — Escalation telemetry: stuck-signal counters in state prompt
- Track consecutive identical-tool-call streaks, veto counts, and nudge
  injections; surface a one-line "frustration signal" in the volatile state
  prompt when thresholds trip so the model sees its own loop pattern.

## Phase 6 — Skill result caching + skill telemetry
- Loading the same skill twice in a session is a waste (it is static text):
  cache loaded skill bodies per agent; count loads in telemetry.

## Phase 7 — Checkpoint durability across restarts
- The compaction checkpoint is persisted to the workspace (`.mochi/state/`)
  and re-injected on resume, so a killed session resumes with the distilled
  Goal/Progress/Decisions rather than nothing.

## Phase 8 — Prompt-quality regression harness
- A vitest suite that builds the REAL system prompt (bundled skills, rules,
  conditional guidelines) and asserts structural invariants: skills present,
  no duplicate sections, section count/order stable, byte-size bounds. Guards
  against prompt regressions like the 0-skills ESM bug.

## Phase 9 — Turn-level token budget guard
- Per-turn output cap guidance injected as a system notice when a model
  generation exceeds a threshold (e.g. 12k chars with no tool calls and no
  end): prevents prose runaways (the "spam" class of bug) at the prompt level
  rather than only the stream-guard level.

## Phase 10 — Consolidation: docs + guides refresh
- Update harness-v2.md to record shipped phases; add a CHANGELOG-style entry;
  ensure the benchmark plan section reflects the telemetry now available.
