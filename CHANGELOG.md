# Mochi Changelog

## 0.5.5

Internal Chameleon + Termix rework (no external services, no auto-launch):

- **Chameleon is fully internal now.** Drops the external `chameleon` CLI /
  shell-out path entirely. `ChameleonEngine` generates synthetic-parameter
  reasoning context via the agent's OWN configured provider
  (`createProvider(config.model, 'reasoning')`) — so enhance behaves as
  "basically part of the agent." `mochi enhance` and the `--enhance` /
  auto-inject path now report tokens, cost, and strategies used, and gracefully
  no-op if the provider call fails. `chameleon` tool no longer needs network
  permission (it uses the same provider the loop uses).
- **Termix is now a baked-in UI command, not an auto-launcher and not a
  third-party app.** `mochi termix "<task>" [--coms|--sep]` opens N parallel
  agent sessions against the configured provider. `--coms` (default) lets the
  sessions COMMUNICATE over a shared broadcast channel; `--sep` keeps them
  fully isolated. Result line reports steps/tokens/cost per session.
- **Mock provider removed entirely.** `src/model/mock.ts` is gone and
  `createProvider` no longer has a mock branch. Tests that previously drove a
  fake model now spin up an in-process OpenAI-compatible SSE HTTP server
  (`src/testutil/fake-openai.ts`) so the REAL provider/router/fetch/stream-parser
  path is exercised end-to-end. There is no fake model anywhere in the codebase.
- **Chameleon multi-pass**: higher modes now spend real test-time compute, running
  1–3 genuine model passes (flash/easy=1, medium/hard=2, deep/extreme/genius=3)
  that critique and refine a draft before the final synthesis. Enhancement
  respects the run's model-call budget and surfaces strategies, tokens, and cost.
  Adds `src/chameleon.test.ts` covering multi-pass + mode→tier mapping over the
  real provider path.
- **Stronger agent system prompt**: a clear identity plus eight operating
  principles (small reviewable changes, verify everything, move with intent,
  safety, budget-aware, correctness under hard problems, and learning from the
  codebase). Live-verified: Mochi made a minimal surgical fix and ran the test
  to confirm it passed.
- **Leaner defaults for far lower token usage**: the default safety budget shrank
  from a 120k-token/50-iteration context to 32k tokens / 8 iterations, so simple
  tasks finish in a few decisive passes instead of grinding a huge transcript.
- **Deterministic transcript ceiling**: the agent loop's compaction floor is now
  capped at 32k live tokens regardless of the configured context budget, so a
  user's very large budget (e.g. 120k+) can no longer let old turns balloon the
  per-call payload. Long runs roll up into the semantic ledger past the ceiling,
  keeping per-turn token cost bounded and predictable instead of model-luck
  dependent.

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
