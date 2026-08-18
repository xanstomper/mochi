# Mochi Changelog

## 0.5.4

External tool integrations:

- **Lazy Chameleon** (synthetic-parameter reasoner):
  - `mochi enhance "<task>" [--mode <mode>]` shells out to the `chameleon` CLI
    and prints the dense reasoning context it synthesizes (offline by default).
  - New `chameleon` agent tool in the tool bus: the model can generate
    enhancement context before tackling a hard task.
  - Auto-inject: `mochi goal --enhance "<task>"` (and `--mode`) runs
    `chameleon enhance` first and injects the result as a leading system
    message into every task's agent context, so a cheap model reasons like a
    bigger one on hard goals. Config `{ "enhance": { "enabled": true } }` also
    opts in without a flag. Graceful no-op when `chameleon` isn't installed.
- **Termix** (lightweight GTK3+VTE multi-terminal): `mochi termix` launches it,
  `--install` clones the repo to `~/termix` first; Mochi seeds
  `~/.config/termix/config.json` with a compatible default. No Electron.
- Adds `chameleon` tool schema test.

## 0.5.3

- `bench/task.mjs` (`npm run bench:task`): runs a real multi-turn agent task and
  reports total tokens, cost, and wall time (the per-task efficiency number, vs.
  the cold-start microbench). Verified live: writing+running a small module took
  ~43k tokens / ~$0.006 / ~37s on the configured provider.
- Budget-phase-aware model routing in the agent loop: when the budget drops to
  `cheap`/`verify`, later iterations fall back to the `fast` model profile
  (cheaper/leaner) while critical early reasoning stays on the full profile.
  Providers are cached per profile so they aren't rebuilt every iteration.
- Compact-first context floor: the agent rolls up old turns (semantic ledger)
  as soon as the live transcript exceeds 60% of the context budget, so long runs
  stay lean regardless of iteration cadence. Adds `ContextEngine.estimateTokens()`.
- Adds tests for `estimateTokens()`.

## 0.5.2

- Adds `npm run build:bin`: compiles the CLI into a standalone native executable
  (`dist/mochi-bin`) via Bun. No Node, `node_modules`, or `package.json` needed at
  runtime; the binary is fully functional end to end (agent loop, tools, config,
  workspaces).
- `src/cli.ts` no longer depends on reading `package.json` for the version when
  compiled; it falls back to a baked-in constant so the binary works from any CWD.
- `bench/efficiency.mjs` now also measures the native binary when present.
- OpenAI-compatible tool schema payloads are memoized via a `WeakMap`, so the
  per-request tool schema JSON (+ allocations) is built once per tools array
  instead of on every streaming call.

## 0.5.1

Efficiency pass:

- Cache project rules + memory reads in `ContextEngine`; long runs no longer
  re-read `MOCHI.md`/`AGENTS.md`/`project.md` (and parse memory) on every agent
  iteration. Cheap size+mtime fingerprints refresh the cache on real edits, so
  behavior is unchanged.
- New `bench/efficiency.mjs` harness (`npm run bench:efficiency`) measuring
  cold-start wall time and peak RSS for Node and Bun, with an optional
  comparator (`MOCHI_COMPARE=...jcode`). Measured on this host:
  `mochi (node) ~55ms / ~47MB`, `mochi (bun) ~50ms / ~41MB`,
  `jcode --version ~19ms / ~24MB`.

## 0.5.0

Real usage + plan/approve + known-good state:

- `UsageStore` persisted per-provider model calls, commands, cost, tool calls, and time.
- `/usage`, `/cost`, and `mochi usage` show real accumulated usage.
- `/plan` stores a pending plan; `/approve` executes it.
- `/known-good` snapshots a baseline (test/build/typecheck/lint); `/check` compares current vs. baseline.
- CLI: `mochi run/test/init/branch/commit/usage/known-good/check`.
- 20 providers with `/login`; Anthropic and Gemini routed via native adapters.
- Feature-flagged Tree-sitter (WASM) symbol backend behind `MOCHI_CPG_BACKEND=tree-sitter`
  with automatic fallback to the TS-AST backend; `get_function`/`find_callers`/
  `type_hierarchy` are backend-agnostic.

## 0.3.0

Performance pipeline and TUI:

- Incremental OpenAI-compatible SSE stream parser.
- Compact high-frequency events (`text-delta`, `tool-start`, `tool-delta`, `usage`, `finish`).
- `FastEventBus` with batching and measured dispatch overhead.
- Hot/cold state separation and dirty-region tracking.
- Microtask batch scheduler.
- Dirty-region renderer abstraction with ANSI fallback.
- End-to-end `PerformancePipeline`.
- `mochi perf` benchmark with parser/bus/state/renderer timing.
- Real terminal UI: header, transcript, rounded input, command palette, status bar.

## 0.2.0

Tier-2 harness layer:

- Agent profiles loaded from `.mochi/agents/*.md`.
- Independent verifier and evidence-based outcome judge.
- Budget engine tracking tokens, cost, time, tool calls, model calls, and agents.
- Budget-aware model fallback and throttling.
- Lifecycle hooks with veto-capable `before_*` commands.
- Intelligent retrieval across files, symbols, references, imports, and git history.
- New `inspect` tool and CLI command.
- Speculative execution engine for difficult problems.
- Curated project memory and cross-session engineering facts.
- New `memory` tool and CLI command.
- Local harness learning for successful recovery strategies.
- Model-request retry with context compaction.
- Goal summaries now include token and cost usage.
- Example agent profiles and project memory.

## 0.1.0

- Initial rewrite from Pi baseline.
- Core runtime, event bus, workspace, and config.
- Model-agnostic OpenAI-compatible provider with OpenCode aliases.
- Model profiles: fast, coding, reasoning, review.
- Tool bus: read, write, edit, delete, shell, search, glob, git.
- Permission system: safe / ask / auto.
- Context engine with token budget, compaction, and structured state.
- Agent loop with preflight, verification, recovery, and pulse.
- Persistent goals and task DAG scheduler.
- Team orchestration with role-based agents.
- Git checkpoint and rollback.
- Interactive CLI and slash commands.
- Multiple workspaces.
- Tests and benchmarks.
