# Mochi Project Instructions

## Conventions

- Architecture: Rust runtime core (`native/mochi_core`, zero-dependency crate)
  for pure compute (tokenization, budgets, compaction planning, loop
  decisions), TypeScript frontend for model I/O, TUI, and tool execution.
  Every native path must keep a parity-tested TS fallback.
- Use TypeScript with strict mode enabled.
- Prefer the Node standard library over dependencies.
- Prefer small, targeted patches over whole-file rewrites.
- Keep the runtime independent from the CLI/TUI layer.
- Emit events for every significant state change.
- Persist goals, tasks, agent state, memory, and learning to `.mochi/`.
- Verify changes through commands and an independent verifier before completion.
- Respect budget limits; never silently exceed them.
- Never run destructive git operations without explicit approval.

## Commands

```bash
npm run build
npm test
npm run typecheck
```

## Architecture Notes

- `src/runtime.ts` is the public entry point.
- `src/goals/` implements persistent goal and task DAG management.
- `src/agent/` is the single-agent execution loop.
- `src/agents/` loads agent profiles.
- `src/teams/` defines built-in roles.
- `src/context.ts` manages the token-budgeted context packet.
- `src/retrieval.ts` implements intelligent retrieval.
- `src/memory.ts` curates durable project memory.
- `src/learning.ts` records successful recovery strategies.
- `src/budget.ts` enforces runtime budgets.
- `src/hooks.ts` implements the lifecycle hook pipeline.
- `src/verification.ts` implements the independent verifier and outcome judge.
- `src/speculative.ts` implements budget-aware speculative reasoning.
- `src/tools/` contains the tool bus and tool implementations.
- `src/model/` is the provider/router layer.
- `src/events.ts` is the typed event bus.
