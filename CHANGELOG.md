# Mochi Changelog

## 0.9.4

- **Persistent agent daemon.** `mochi daemon start|status|send|stop` runs
  a Runtime over localhost HTTP so a phone, dashboard, or script can hand
  Mochi goals without a TTY. Binds to 127.0.0.1 only; every request needs
  a per-workspace bearer token written to `~/.mochi/daemon/info.json`
  (0600) along with the live port and pid. Endpoints: `/api/status`,
  `/api/inspect`, `/api/plan`, `/api/goal`. Verified end to end with a
  real model: `daemon send` created `answer.ts` correctly. In-process and
  detached-spawn paths are both tested.

## 0.9.3

- **Live integration tests against real freeinference.**

- **Polyglot code indexing.** The codegraph previously understood only
  JavaScript/TypeScript files, so pointing Mochi at a Python, Rust, Go,
  Java, or C++ repo produced an empty symbol index. The tree-sitter WASM
  backend (in-process, no full compiler, same engine across languages) is
  now the DEFAULT and indexes all seven languages (TS/JS, Python, Rust,
  Go, Java, C/C++); the TypeScript-compiler AST remains as an opt-in
  fallback (`MOCHI_CPG_BACKEND=tsc`). Benchmark: cold index of 200 files
  comes in at ~100ms on either backend, so this is a coverage win, not a
  measured speedup.
- **Polyglot test-runner auto-detection.** `autoTestCommand` now emits
  `go test ./...` and `cargo test` for Go/Rust file scopes (plus the
  existing vitest/jest/pytest), and `isWeakVerification` no longer treats
  real Go/Rust/Python runners as weak.
- **Plan-mode enforcement.** A plan-mode reply that is only a preamble
  ("I'll research the codebase first") is no longer accepted as the
  finished deliverable. The loop nudges the model up to 3 times to emit an
  actual plan (numbered steps, bullets, or structured plan language) and
  fails with a clear reason if it never does.
- **Language-aware model guidance.** When the repo is not JS/TS, the
  preflight system message now tells the model the right tooling directly
  ("this is a Python repo; use `python -m pytest -q`"), so it stops
  emitting `npm test` against Rust or Go projects. Real Go/Rust/Python
  repos get `go test` / `cargo test` / pytest guidance before the loop
  even runs.
- **Python typecheck fix.** Repos were assumed to need `mypy` for every
  pyproject.toml; verification would fail with `mypy: not found` in repos
  that don't configure it. Only repos with an actual mypy config
  (mypy.ini / setup.cfg / `[tool.mypy]`) get a typecheck command.
- **Fake-openai multi-call fix.** The scripted test server emitted every
  tool_call chunk without an `index`, so the stream parser merged all
  tool calls in one response into a single mangled call. Each call now
  carries a distinct `index`, matching the real provider wire format.
- **Python E2E test.** The full loop now verifies against a REAL `pytest`
  subprocess for a Python repo (repo detection → polyglot test detect →
  subprocess verify), proving the polyglot path works end to end.
- **Go and Rust E2E tests.** Same real-subprocess proof for `go test
  ./...` and `cargo test`: the loop fixes a fibonacci bug in each
  language and verification passes against the actual toolchain, not a
  scripted response.
- **Language-aware failure probes.** The diagnosis engine probed every
  changed file with `node --check` + `npx tsc` regardless of language,
  so a Rust/Go/Python fix that passed its real toolchain was endlessly
  re-diagnosed as a "syntax error". Syntax and type hypotheses now use
  the native checker per language (`cargo check`, `go vet`, py_compile,
  javac, gcc -fsyntax-only) and skip the probe entirely for unknown
  extensions. Real-model dogfood: the same Rust fix that previously
  failed now completes in ~2s.
- **Polyglot index walker skips build/cache dirs.** The codegraph
  walker only ignored JS dirs (node_modules, dist, .next), so indexing
  a Python repo walked `.venv`/`__pycache__`, Go walked `vendor/`, and
  Rust walked `target/` — slow and able to shadow real symbols with junk
  rows. Layer caches and toolchain outputs are now skipped for every
  language.
- **Polyglot mutation verification.** `runMutationCheck` only targeted
  `.ts/.tsx/.js` files and flip a JS-only operator set, so in a
  Python/Rust/Go repo the adversarial weak-coverage signal silently
  never fired. Source extensions now cover Python/Rust/Go/Java/Ruby/PHP/
  C/C++; flips include Python's `==`/`!=` and ` and `/` or `; and the
  test-file detector recognizes pytest/Go/Rust/JUnit naming so test
  files are never mutated.
- **Language registry (15+ languages).** `detectRepo` is now data-driven
  with a per-language table: markers, build/test/lint/typecheck
  commands, package managers, and entrypoints for TS/JS, Python, Go,
  Rust, Java, C/C++, C#, Zig, Ruby, PHP, Swift, Kotlin, Elixir,
  Haskell, Scala, Dart, Lua. The loop's verify() uses the registry's
  commands, and optional checks run only when the tool is actually
  installed.
- **Native accelerators (Rust + C++).** Mochi now ships real native
  code: a dependency-free fuzzy line matcher in both `native/rust/fuzzy.rs`
  and `native/cpp/fuzzy.cpp`, built by `npm run build:native`, used by
  the edit tool's hot path with a transparent fallback to the
  TypeScript matcher. Both binaries are parity-tested against TS.
- **Verification fixes from the Zig dogfood.** Models persisting
  `cd <project_root> && cargo test` had it run verbatim through sh -c,
  where `<project_root>` is redirect syntax that fails every check.
  Sanitize now strips the placeholder, and `cwdForScope` only scopes
  into a subdirectory that carries its own project marker (a Rust/Zig
  file in src/ resolves to the repo root). Real-model dogfood: a broken
  fib in a Zig repo now fixes end to end ("Goal completed. 1 done, 0
  failed").
- **Code index now 10 languages.** The tree-sitter symbol index adds
  Ruby, PHP, and C# (grammars ship WASM); the Dart and Elixir npm
  grammars don't load under the pinned tree-sitter WASM ABI, so their
  symbol index falls back to "no definition" but registry/verify
  support remains. `get_function`/`find_callers`/`type_hierarchy` now
  answer for Ruby classes/methods, PHP functions/classes, and C#
  classes/methods in the same repo.
- **Diagnosis probes cover the new languages.** Syntax/type probes now
  use `ruby -c`, `php -l`, `dotnet build`, `dart analyze`, `zig build`,
  and `mix compile` so a retry loop on those repos probes with the
  real toolchain instead of silently falling through to a read-only
  hypothesis.
- **Mutation skips test files in every language.** `isTestFile` now
  recognizes RSpec (`foo_spec.rb`), JUnit/PHPUnit (`FooTest.java`,
  `BarTest.php`), and C# (`FooTests.cs`) naming in addition to the
  existing JS/TS/Python/Go/Rust conventions, so a mutation never
  corrupts a test file in a polyglot repo.
- **Planning layer speaks polyglot too.** The decomposer's verification
  guidance and the test-kind focus hint now list the real runner per
  language (go test, cargo test, dotnet test, rspec, zig build test,
  phpunit, mvn/gradlew) instead of only `npx vitest/npm test`, so a
  model planning a Go or C# task picks the right command up front.

## 0.9.2

- **Live integration tests against real freeinference.** New
  `src/agent/loop.live.test.ts` exercises the real model on a real file
  system end-to-end (decompose -> plan -> run -> verify). Three tests:
  writes a requested file, writes a working vitest test, decomposes a
  multi-step goal. Auto-skipped when `FREEINFERENCE_API_KEY` is missing so
  CI stays offline. Run explicitly with
  `FREEINFERENCE_API_KEY=... npx vitest run src/agent/loop.live.test.ts`.
  These complement (not replace) the scripted fake-openai unit tests: the
  fake tests cover harness behavior deterministically, the live tests
  cover what the model actually does with a real prompt.

## 0.9.1

Three more dogfood-found regressions where the verifier was being too
aggressive about a subdirectory-scoped task:

- **Scope-aware verification cwd.** `testdetect.cwdForScope` resolves the
  directory the verification command should run from (the fileScope's parent
  when it's consistent). `withCwd` prefixes `cd <dir> && ...` to commands
  that don't already start with a `cd`. Fixes a class of "Unknown option
  `--prefix`" failures (vitest doesn't take `--prefix`; that's an npm
  flag) and "command not found" errors when the runner lives under the
  task's package.json but not the project root.
- **Skip repo-level commands under a scope.** When a task has a
  fileScope, repo-level checks (testCommand/typecheckCommand/lintCommand/
  buildCommand) no longer run. They describe the PROJECT ROOT and would
  fail on `Missing script: "build"` for the wrong reason. The
  auto-detected runner + the explicit verificationCommand cover the
  task's own verification.
- **Diff evidence is filtered to the fileScope.** `verification.safeGitDiff`
  walks the diff block-by-block and drops out-of-scope files entirely.
  Previously, the model judge received a diff that included harness work
  the user did concurrently and complained "the diff shows changes to
  src/agent/loop.ts, not the requested file" even when the agent's work
  was correct. New test locks this in.
- **Task-kind-aware system prompts.** `src/taskkind.ts` classifies a
  task into implement/fix/refactor/test/research/plan/document via
  title/description/role heuristics, and the system prompt appends a
  focused hint per kind. Debug tasks get "reproduce first, then
  localize"; research tasks get "read-only, do not modify"; etc.
- **Decomposer prompt now requires a real test runner.** When the task
  is implement (not plan mode), the JSON-shape hint forbids string/file
  checks (`test -f`, `grep`) and demands `npx vitest run`, `npx jest`,
  `pytest -q`, or `npm test`.

Tests: 226 passing (was 207).

## 0.9.0

Observation-driven replanning foundations and a verifier regression found by
dogfooding:

- **Failure diagnosis + autopsy + procedural memory.** New `src/diagnosis.ts`
  classifies verification failures into eight kinds (`syntax`, `type`, `logic`,
  `test_gap`, `env_missing`, `env_runtime`, `concurrency`, `unknown`),
  generates ordered hypotheses, and evaluates probe results so the next
  attempt is a *targeted* fix instead of a vague "Continue and fix". `Autopsy`
  records persist at `<workspace>/autopsies/<taskId>.json` with hypothesis
  history, evidence, and outcome. `Lessons` records persist at
  `<workspace>/memory/lessons.json` and are surfaced as prior context on
  matching failure signatures — Mochi remembers what worked across runs in
  the same workspace. A `recordFailure` path also writes an `AVOID`-style
  lesson on retry exhaustion so the next run starts with prior context.
- **Verifier scoped mutation.** The mutation check now operates only inside
  the task's `fileScope`, so an in-progress edit to the harness itself can
  no longer produce a meaningless "mutation survived" verdict against logic
  the verification command does not exercise. Two new tests lock this in.
- **Auto-detected test runner.** New `src/testdetect.ts` examines the
  task's `fileScope` and appends a real runner command (`npx vitest run`,
  `npx jest`, `pytest -q`) to the verification checks when the explicit
  `verificationCommand` is weak (file-existence or `grep`/`cat`/`ls`).
  Fixes a class of silent downgrades where a model's overly-clever
  verification command "passed" but the mutation check still survived
  because no test was ever executed.

## 0.8.0

Provider resilience and verifier accuracy from dogfooding:

- **Multi-provider failover.** `model.failover` accepts a list of backup
  `ModelConfig`s tried in order when the primary errors before producing any
  output (dead endpoint, auth failure, refused connection). Mid-stream failures
  are never replayed onto a fallback. Every provider in the chain keeps its own
  capability-gate health, and all call sites (agent loop, decompose, verifier
  judge, chameleon, speculative) inherit failover automatically.
- **Missing verification tools no longer fail correct work.** A check whose
  command is not installed (exit 127, e.g. the decomposer guessing
  `tsc --noEmit x.ts` in a repo without tsc) is recorded as skipped evidence
  instead of a failure. Mutation verification only runs against a genuinely
  runnable test command.
- **Diff evidence shows the work.** `safeGitDiff` excludes `.mochi` state,
  `node_modules`, `dist` noise and lists real source files first, so the
  evidence budget is spent on the new `.ts` file the agent wrote. Mutation
  targets likewise exclude dependency and build directories.

## 0.7.0

Pipelines, prompts, and hardening found by dogfooding:

- **CI pipeline.** `.github/workflows/ci.yml`: typecheck + vitest + build +
  CLI smoke on Node 20 and 22. `package-lock.json` was out of sync with
  `package.json` (`npm ci` failed); regenerated. Node 20 compatibility:
  `node:sqlite` (22.5+) users degrade gracefully (`hasSqlite()`), and the
  codegraph tests skip on runtimes without it.
- **Plan mode is actually safe and useful.** Mutating-tool veto switched to a
  read-only allowlist (`patch`, `git`, `subagent`, and arbitrary MCP tools are
  now vetoed, not just write/edit/delete/shell). Plan-mode runs skip end-state
  acceptance verification (a plan intentionally changes nothing), the
  decomposer is told to emit plan-only tasks, and the plan text is surfaced to
  the user instead of a bare "Goal completed".
- **No dangling tool_call_ids.** `before_tool`/`before_edit` hook vetoes and
  tool-budget exhaustion now answer the call with a `Blocked:` tool message;
  previously they silently dropped it, which providers reject with 400s.
- **Mutation check targets real code.** Test files and dot-directories
  (`.mochi/` state) are excluded from mutation targets, and flips inside
  larger tokens (`=>`, `>=`, `<<`) are skipped. Before: a run writing correct
  `greet.ts` + `greet.test.ts` got downgraded to PARTIAL because the checker
  mutated the *test file's* arrow into a syntax error the verification command
  never even imported.
- **MCP prompts.** `listPrompts()` / `getPrompt()` on the client, exposed as
  `<server>__prompts_list` / `<server>__prompts_get` tools (rendered messages
  as text). MCP JSON-RPC requests now time out after 10s so a server that
  silently ignores optional capabilities can't hang the harness.
- **System prompt guidance.** New "use the right tool" section (edit vs patch
  vs write, subagent delegation, todo tracking, plan-mode behavior); builtin
  role prompts enriched (coder gains `patch`/`todo`/`subagent`).
- **patch tool integration.** Fires `before_edit`/`after_edit` hooks like the
  other edit tools, and its per-file results are tracked into state.

## 0.6.1

Mutation verification understands print-style checks:

- **Output-diff mutation detection.** A mutation is now killed when the test
  command's output changes (not just when it exits non-zero). Print-style
  verification commands (`node -e "console.log(add(2,3))"`) exercise the
  mutated logic but always exit 0, so exit-code-only detection wrongly declared
  every such task weakly-covered and downgraded correct work to PARTIAL. The
  verifier captures stdout/stderr before and after the mutation and counts a
  diff as a kill, with the reason surfaced in the evidence note.

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
