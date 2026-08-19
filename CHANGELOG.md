# Mochi Changelog

## 0.6.0

Six capability milestones, plus the surrounding hardening:

- **Todo planning tool.** Persistent, editable work list in
  `state/todo.json` (deduped by title, ordered, concurrency-safe across
  parallel agents). The model plans and tracks its own checklist mid-run.
- **Provider capability registry.** Live per-provider health tracking:
  `ok` / `cooldown` / `dead` states with probe-driven recovery, mirroring
  jcode's on-demand retry gates. The router skips dead providers fast and
  retries transients with backoff instead of failing the run.
- **Agent Skills.** Full agentskills.io spec: frontmatter parsing, discovery
  from `.mochi/skills/`, prompt injection when a goal matches a skill, and a
  `skill` tool so the model can load one mid-run.
- **MCP support.** Minimal stdio MCP client (JSON-RPC 2.0, initialize
  handshake, tools/list + tools/call) plus `buildMcpTools()`, which wraps each
  remote tool as a native namespaced tool (`serverName__toolName`) with
  `network` permission. Servers are spawned once per run, closed on finish, and
  a server that dies rejects its pending calls instead of hanging the agent.
- **Plan-then-act mode.** `planMode` (config or `--plan`) disables
  `write`/`edit`/`delete`/`shell`, vetoes violation attempts with a proper tool
  response, and steers the model to return a plan (steps, files, risks,
  verification). No files are changed.
- **Subagent delegation.** The `subagent` tool runs a fresh child agent on a
  well-scoped subtask, sharing the run's budget, read cache, and workspace, and
  returns the child's summary. Delegation is depth-guarded to one level so a
  child cannot spawn runaway grandchildren.
- **`agent:log` event + 3 new test files.** 147 tests total; typecheck clean.

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
- **Per-run file-read cache**: the `read` tool caches file contents keyed by
  (path, mtime, size) for the life of a task, so unchanged files are read from
  disk once instead of once per call. Edits change the signature and trigger a
  re-read.
- **Role-specific tool sets**: each agent role now advertises only the tools it
  needs (coder ~10 tools vs 14; reviewers/researchers read-only), cutting the
  scheduled per-call tool-schema payload (~1,400 → ~1,000+ tokens for coding).
- **Parallel independent writes**: the loop runs `write`/`edit`/`delete` tool
  calls to distinct files concurrently (previously fully serial), so a multi-file
  task pays one round-trip for several files. Same-file writes stay serial for
  safety.
- Verified on a two-file create+test task: **15.9k tokens / $0.0023 / 5s** with
  all tests passing. 61 tests green, typecheck clean.
- **Relevance-scoped memory injection**: project memory is no longer dumped
  verbatim. Only the entries most relevant to the current task are selected
  (lexical token overlap over title/body, `src/relevance.ts`) and injected, so
  a large memory file no longer burns tokens on irrelevant policy in every
  packet. The project overview is always carried. Deterministic, no new
  dependencies, no embedding model required.
- **Structure-aware, deduped, cached search** (agent-grep style): `search` now
  groups matches by file and emits a compact per-file declaration outline (so
  the model can infer a file's layout without a full read), collapses repeated
  identical match lines to one while still reporting the true raw match count,
  caps displayed lines via `limit`, and serves a repeat identical query from a
  mutation-invalidated per-cwd cache (marked `[query cache hit]`) instead of
  re-scanning.
- **One-shot fast path**: a deterministic classifier
  (`src/one-shot.ts`) recognizes high-confidence answer/summarize tasks and
  injects a "resolve in one turn" nudge so the loop doesn't burn tokens on
  needless tool round-trips. Verification still gates every "done" when files
  changed; the classifier never short-circuits tasks that touch code. It now
  also short-circuits at the *decomposition* stage: one-shot goals emit a
  single no-verify answer task instead of asking the model to over-engineer a
  simple question into a file-creation + verify loop. Measured end to end on
  "Say hello in exactly 3 words": the old path failed after a self-imposed
  coding task (10,019 tokens / $0.0014 / 2s); the new path succeeds in one
  direct turn (2,209 tokens / $0.0003 / ~0s) — an ~4.5× token cut, and genuine
  coding tasks still flow through the normal builder/verifier path unchanged.
- **Mutation-invalidated search cache**: the `search` result cache is now keyed
  by a shared process-wide mutation generation that the `write`/`edit`/`delete`
  tools bump on every real file change (`src/tools/fs-signal.ts`). A repeated
  identical query is deduped, but a write/edit/delete invalidates the stale
  entry instantly (O(1), no tree re-walk), so the cache can never serve a result
  that a subsequent edit has already made wrong.
- **Adversarial mutation verification** (`src/mutation.ts`): a clean PASS no
  longer just means "commands exited 0". After the agent's test command passes,
  the verifier injects one real logic bug (a *mutation*) into a changed source
  file and re-runs the test suite. If the mutation is caught the tests are
  sound; if it **survives**, the verifier downgrades a naive PASS to PARTIAL
  with an explicit "Mutation check: injected logic bug was NOT caught" signal so
  the agent hears that its coverage is weak on that path instead of getting a
  false green. Deterministic operator flips, no model in the mutation loop, and
  the file is always restored after the check - the repo is never left mutated.
- 88 tests green (mutation engine + verifier downgrade coverage added),
  typecheck clean, native binary rebuilt.

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
