# Mochi Changelog

## 0.11.0

- **Reliability overhaul: the agent can no longer hang, freeze, or spin on token-draining loops.** A suite of guards makes the loop fail fast instead of stalling:
  - *Cumulative repeated-tool breaker* — a turn that keeps calling the same tool name without producing file edits is cut short instead of rambling across many exploration rounds (a "hello" chat prompt previously ran 12+ rounds burning ~140k tokens / 29s; now the chat-task tool cap stops it immediately).
  - *Mutating-tools-only no-progress breaker* — the repeated-tool abort only fires on mutating tools, never on legit context-gathering reads (`read`/`glob`/`tree`/`search`), so multi-file coding tasks that read several files before editing are never killed mid-flight.
  - *Hard per-response stall guard* — a fully silent provider hold (no chunks, no error) previously froze the agent forever; the gather now races a 3-minute timer and reports a clean `model_error`.
  - *SIGKILL fallback on abort* — when a tool call is aborted a `SIGKILL` is scheduled 5s after `SIGTERM`, so a stubborn child can never hang the loop or freeze the agent.
  - *Subagent timeout fence* — a child's late rejection (post-timeout / post-abort) can no longer crash the process via an unhandled rejection or race into a duplicated `subagent:completed` event.
  - *Event-layer safety* — `emit()` now defensively swallows promise rejections from handlers, so a future async handler can't leak an unhandled rejection.
- **Fast, lean defaults.** Default reasoning was lowered `max → medium` so free/low-tier flash models stop stalling: a chat reply dropped from ~30s / 139k tokens to ~2s / 7k tokens. The stale test that asserted `max` was updated to match; the suite is green at 763/763 (excluding the network-flaky live test).
- **Terminal no longer freezes.** A root-cause fix eliminated the raw-mode/`fake wrapper` freeze bottleneck, and the Enter-to-run path now has unhandled-rejection safety so a provider/command error surfaces as a line and resets busy/spinner instead of leaving the terminal stuck.
- **TUI: Cline-style tool cards.** Every tool call is now rendered as a small framed card with a status icon, the tool name, the key argument(s) (file path + edit delta, `$ command`, search query, subagent role/prompt), and the first useful line of output or error — an entire `READ`/`EDIT`/`SHELL` turn is scannable at a glance, with noise (`exit_code`, `duration_ms`, `{}`) stripped.
- **TUI: post-turn "what I did" summary card.** When a turn finishes, the TUI shows a Cline-style card: `✓ TURN COMPLETE 4523ms · 8 tools` with the first line of the final summary, the files touched (`files: a.ts, b.ts, c.ts (+2 more)`), and tokens used. No-op turns ("the model said hi") get no card; failures render `TURN STOPPED: <reason>`.
- **TUI: coordinated visual language & semantic themes.** Every transcript line now sits on a 2-space grid gutter with a single-character role marker colored to its accent; all themes were refactored and redesigned around semantic role colors with a single source of truth.
- **TUI: drag-select fixes.** Drag-select highlight now works reliably (root cause: a missing `?1002h` private-mode query), works on the splash screen too, and remembers the last column the cursor touched; added a `/copy` keyboard fallback.
- **Removed the DeepWiki MCP server's canned-response mode.** The standalone `deepwiki-server` no longer honors a `MOCHI_TEST_WIKI=mock` env-var shortcut that returned a fabricated summary from shipping code. It now always hits the real Wikipedia REST API + search fallback (verified live), so `wiki_lookup` returns genuine, current content instead of a placeholder.
- **Real shared SSE encoder.** The OpenAI-compatible SSE *encoder* previously lived only in the test harness (hand-rolled framing inside `fake-openai.ts`). New `src/sse-encode.ts` is the real outbound half of `StreamParser` (`encodeSSEChunk`, `encodeSSEDone`, `buildChatCompletion`), and the test server now delegates all wire encoding to it — deleting ~60 hand-rolled protocol lines. Both production and tests emit identical bytes. Verified with 8 round-trip tests that encode through the real `StreamParser`.
- **Consolidated the two divergent Wikipedia lookups.** The in-process `deepwiki` tool and the standalone `wiki_lookup` MCP server each carried their own copy of the summary + search-fallback fetch logic, and they had already drifted (different User-Agents, search tags, error messages). New `src/wiki.ts` is the single source of truth (`wikiSummary(query, lang, opts)`), with both call sites delegating to it and keeping only their genuine differences in `WikiLookupOptions`. Killed 48 lines of duplication; behavior is byte-identical (deepwiki tool tests still green), with a new 10-test `wiki.test.ts` suite and a live MCP smoke test proving real content flows through the shared path.
- **Gated the live network tests behind explicit opt-in.** The `loop.live` and `daemon.live` suites used to run whenever `FREEINFERENCE_API_KEY` was set, so a transient hiccup or slow response from the real provider could waste 3-10 minutes retrying and fail the whole `npm test` run. Both now require `MOCHI_LIVE=1` (in addition to the key) to execute, so the default unit run is deterministic and never touches the network, while the opt-in path remains for live verification. Full suite is now green: **855 passed, 4 skipped, 0 failures, exit 0**.

## 0.10.7

- **Interactive `/reasoning` Command & Live TUI Display.** Added `/reasoning` (and `/depth`)
  command to the interactive TUI with an interactive menu selector allowing
  instant adjustment between `low`, `medium`, `high`, and `max` reasoning compute.
  The active reasoning level is now displayed live in the TUI status bar right next
  to the model name (`[REASON: HIGH]`). Also added `mochi reasoning [level]` and
  `--reasoning <level>` CLI flags.
- **Full Reasoning Compute & Thinking Support.** Reasoning levels map to real
  model compute parameters:
  - `low`: Fast, agile execution with minimal overhead.
  - `medium`: Balanced reasoning with careful validation.
  - `high`: Deep cognitive analysis, edge-case checks, AST blast radius checking.
  - `max`: Maximum reasoning compute, exhaustive multi-angle decomposition,
    Chameleon MoE synthetic reasoning, and comprehensive verification.
  - Wired provider-level parameters: `reasoning_effort` for OpenAI/OpenCode/DeepSeek,
    adaptive `thinking` token budgets for Anthropic Claude, and Gemini thinkingConfig.
- **Multi-turn Context Memory & Cross-Session Recall.** Solved conversation amnesia across
  turns by preserving ongoing active sessions and loading previous conversational
  turns (user questions & assistant answers) directly into the agent's context.
  Added the new `session_recall` core tool allowing Mochi to search, list, and
  inspect transcripts and architectural decisions from past sessions via SQLite FTS5.
- **Futuristic Startup Animation & Professional UI Design.** Replaced emojis with
  crisp, high-end developer status pills and glyphs (`[STOP]`, `[REASON]`, `[SAFE]`, `[YOLO]`).
  Upgraded startup sequence with a futuristic segmented gradient power bar `⟦ ━━━◈─── ⟧`,
  animated braille scanner beam, and telemetry diagnostic boot phases.
- **Conscious & Empowered Agent Intelligence.** Upgraded the agent system prompt
  and output directives: the model understands its full arsenal of autonomous
  capabilities (AST analysis, blast radius, code modification, execution, skills,
  session recall, deep memory, subagents) and communicates with high technical fidelity.

## 0.10.6

- **Rust runtime core.** Pure compute now lives in a zero-dependency Rust crate
  (`native/mochi_core`): tokenizer, budget math, context compaction planning,
  and agent-loop decision logic, exposed both as a N-API module and a stdio
  JSON-line protocol (`mochi-agent plan`). The TypeScript frontend keeps model
  I/O, the TUI, and tool execution. Every native path has a parity-tested TS
  fallback (null-return contract), so the harness runs identically on machines
  without a Rust toolchain (CI, cold installs).
- **Native tokenizer + compaction planner wired in.** `approxTokens()` prefers
  `countTokens` from the native module; `ContextEngine.compact()`/
  `previewCompact()` compute their valid cut points via the native planner
  (never orphaning a tool result), falling back to the inlined TS walk.
- **Team roster expanded.** Specialist roles (devops, db_admin, frontend,
  backend, performance, tech_writer, qa_engineer, data_scientist) join the
  roster; tester/debugger now carry edit tools to write tests and
  instrumentation. Review-only roles (lead, reviewer, researcher, security,
  architect) remain shell-free.
- **Light mode.** `MOCHI_LIGHT=1` (or `MOCHI_NO_EMBED=1` / `MOCHI_NO_INDEX=1`)
  disables the embedded SQLite symbol index for ultra-lightweight execution;
  the codegraph degrades to "no symbol index" instead of throwing.
- **Iteration lifecycle traces (harness-v2 Phase 1).** New
  `src/agent/loop-state.ts`: a `LoopStateMachine` walks every loop turn
  through `preflight → model-call → stream-guard → tool-exec → verify →
  finish` and emits exactly one typed `agent:iteration` event per turn
  (`IterationTrace`: iteration, stopReason, toolCalls, streamBytes,
  durationMs, end phase). Abort/timeout/budget exits from any phase are
  captured with their stop reason; illegal transitions are recorded for
  diagnostics, never thrown. Eight new tests cover the transition contract
  and a live end-to-end trace run.
- **Lazy codegraph (harness-v2 perf).** Importing the codegraph no longer
  loads web-tree-sitter + all ten language grammars (~110MB RSS) or the
  TypeScript compiler (~75MB RSS) at module scope. The parser core and each
  grammar now load on first use, and only for languages actually present in
  the repo; the tsc fallback compiler loads only if that backend runs.
  Measured: full runtime import chain ~62MB RSS (was ~130MB+), startup 52ms
  → 47ms. `MOCHI_LIGHT` / `MOCHI_NO_EMBED` / `MOCHI_NO_INDEX` now skip the
  WASM parser entirely (true zero-parser light mode). Read paths
  (`get_function`, `find_callers`, `type_hierarchy`, `blast_radius`,
  `sql_codebase_query`) are async and self-warming; a sync
  `querySymbolGraphSync` serves hot prompt-build paths, primed once per task
  by the agent preflight via `primeScaffold` (cached Chameleon scaffold).
- **Memory regression gate.** New `npm run bench:memory`
  (`bench/memory.mjs`) measures fresh-process RSS for the codegraph import
  and the full runtime chain against ceilings (80MB / 95MB) and fails above
  them; wired into CI after build so eager heavy imports can never silently
  return. Measured today: 46MB / 61MB (eager era was ~158MB on import).
- **Lean installs.** All tree-sitter grammar packages are now
  `optionalDependencies`: `npm i @mochi/agent --omit=optional` skips ~250MB
  of grammars on disk; missing grammars degrade gracefully to the tsc
  backend. Default installs are unchanged.
- **Parallel verification.** `verify()` now runs the independent repo checks
  (test / typecheck / lint / build) concurrently instead of serially, so
  per-iteration verification wall-clock is the slowest check rather than
  their sum. Failure reporting keeps deterministic declared-order semantics.
- **Diff-hygiene gate (better shipped code).** After verification passes on a
  file-changing task, a bounded pass scans the diff (tracked + untracked
  files) for debug debris the model added — `console.log`/`debugger`,
  TODO/FIXME/HACK markers, `@ts-ignore`/`eslint-disable`/`noqa`
  suppressions, and focused `.only()` tests. Findings trigger ONE cleanup
  nudge before completion, so Mochi ships clean code instead of leaving a
  human cleanup pass. Test files and non-code files are exempt; the scan
  never blocks finishing on git/shell failures. New
    `src/core/diff-hygiene.ts` (pure scanner) + `src/agent/hygiene.test.ts`
  (end-to-end: junky write → nudge → clean write → complete).
- **TUI freeze fix (regression).** The harness-v2 preflight `await
  primeScaffold(...)` scanned the working tree synchronously *before* the first
  model call, so running Mochi inside a large directory (e.g. from `$HOME`)
  pegged the event loop and froze the UI mid-"sending". Warming is now
  fire-and-forget (never gates the first call) with a cheap detected-language
  hint instead of a full tree scan, and `primeScaffold` refuses to warm over
  `$HOME`. Reproduced the exact freeze scenario (cwd = `$HOME`, prompt "how
  much ram does mochi use") and confirmed it now completes in ~2.3s instead
  of locking up.
- **Dogfood fixes (mochi-dogfood3 battery vs jcode, same model).**
  `node --test` scripts recognized as real runners; verification debt-masking
  is disabled when the task demands green checks ("make npm test pass").
- **Dogfood battery results.** Same `deepseek-v4-flash` via freeinference,
  apples-to-apples vs jcode: mochi 10.6s / 5.6s / 7.1s vs jcode 8.6s / 5.4s /
  17.0s across T1 (CSV greenfield) / T2 (Python bugfix) / T3 (Go feature) —
  mochi 2.4× faster on the Go task; all outputs green and hygiene-clean.
  Next lever: system prompt is ~5.1k tokens re-sent every turn — trimming
  it (with this battery as the A/B gate) targets jcode-class token
  efficiency.

## 0.10.5

- **Terminal copy / paste / highlight.** Mouse click-drag now selects
  transcript text (SGR mouse events); releasing copies the selection to the OS
  clipboard via OSC-52 with xclip/wl-copy/xsel/pbcopy fallbacks, and native
  Shift+drag still works for host selection. The selected range is highlighted
  in reverse-video and cleared on the next keypress.
- **No more accidental GUI launches.** The `shell` tool now refuses to spawn
  desktop GUI apps (`gnome-calculator`, `kcalc`, browsers, terminals, editors),
  and the system prompt tells the agent that BUILD/IMPLEMENT/CODE requests are
  delivered as source files verified headlessly. Fixes "make a calculator"
  repeatedly opening a calculator window.
- **Non-interactive runs exit cleanly.** `mochi --print "..."` (and piped
  invocations) now call `process.exit(0)` once output has flushed, instead of
  hanging after the work is done because the event bus / recorder / model
  keep-alive leaves a live handle.
- **Bounded stream spam.** When a model (often a low/free-tier one) repeats
  the same boilerplate block dozens of times in a single streamed response,
  mochi now aborts the stream, tells the model to stop repeating, and fails
  cleanly after a couple of attempts instead of flooding the transcript with
  hundreds of identical lines and looping forever.
- **Full scroll to top.** PgUp/PgDn scroll a full visible page and Home/End
  (`\x1b[1~`/`\x1b[4~`) jump straight to the absolute top or bottom of the
  transcript.
- **Bracketed paste.** Enabled on startup so pasted text is folded into the
  composer even when the terminal splits it across several data chunks.
- **History path + TUI fixes.** `/history`, `mochi doctor`, and the CLI session
  store now resolve paths via `findProjectRoot(cwd)` so GoalEngine sessions are
  recorded where they are written; self-review no longer re-loops/re-streams on
  terse non-issue verdicts; identical no-tool answers no longer re-stream and
  spam the transcript; `find_references`/`find_definitions` work without
  ripgrep; and the GoalEngine brief is recorded as a system message instead of
  a user turn.
- **New TUI `/help` tips** document the terminal shortcuts above.

## 0.10.4

- **ACP editor adapter.** `mochi acp` speaks the Agent Client Protocol v1 over
  JSON-RPC stdio, so editors (VS Code, Zed, JetBrains) can drive the full
  harness: `initialize`, `session/new`, `session/resume`, `session/prompt`,
  `session/close`, `shutdown`. Supports all ACP v1 methods:
  - Full `agentCapabilities`: `loadSession`, `sessionCapabilities` (list,
    delete, additionalDirectories, resume, close), `promptCapabilities`,
    `mcpCapabilities`, `authMethods`
  - Streaming `session/update` notifications: `tool_call`, `tool_call_update`,
    `agent_message_chunk`, `usage_update`, `plan`
  - Per-session abort support for clean cancellation via `session/cancel`
  - `session/load` with `goalId` to resume persisted goals
  - `session/list` pagination with cursor and `additionalDirectories`
  - `session/set_mode` / `session/set_config_option`
  - `session/request_permission` for MCP
  - `authenticate` / `logout` for built-in agent auth
- **New Tools:** `search_replace_multi` (multi-file regex replace with preview),
  `analyze_code` (code complexity metrics), `verify` (run tests/builds with auto-detect),
  `perf` (performance diagnostics and monitoring)
- **Config Validation.** `validateConfig()` validates config values at startup,
  catching misconfigurations (invalid safety mode, bad numbers, MCP server shape)
  before they cause mid-run failures. A missing API key is intentionally NOT a
  structural error — it surfaces at the model call layer, so a Runtime can be
  built for inspection/tests without keys and no provider key is required in CI.
- **TUI mode overlay.** The status bar now shows the active execution mode
  (`[SPEC]`, `[SECURITY]`, `[CODEMOD]`, `[CHAOS]`) so users can see at a glance
  which harness behavior is active.
- **TUI transcript scrolling.** The scroll wheel now scrolls the chat (mouse
  reporting enabled); PageUp/PageDown scroll too. Scrolling up holds the view
  instead of live events yanking it back to the bottom. `git diff` stats in the
  status bar are throttled so heavy tool work no longer stutters or freezes the
  UI loop.
- **TUI freeze fix.** The transcript render is now incremental: each frame only
  re-wraps the lines that actually changed (the appended tail and the streaming
  last line) instead of rebuilding the whole transcript O(n) per streamed token.
  Combined with coalescing renders via a macrotask (instead of draining
  microtasks synchronously), the spinner and UI stay responsive while the agent
  explores code and runs tools. Render frames are guarded with a try/catch so a
  single bad frame logs and recovers instead of permanently freezing the UI.
- **TUI line-wrap speed.** `wrap` no longer re-strips ANSI codes over the whole
  growing line for every word (that was O(line²) and froze while a long response
  streamed in); it now tracks visible width incrementally in O(n). Render frames
  that do throw print their stack and PAUSE rendering (instead of auto-retrying
  a throwing frame in a loop), and any real key re-arms rendering so a transient
  error can never leave the screen frozen.
- **`mochi daemon restart`.** Stop + start a fresh daemon on the same
  port/token. Cron jobs, sessions, and goal state persist across restarts
  (`.mochi/cron.json` plus the SQLite session store).
- **Cron result delivery.** Jobs accept `--notify <url|cmd>`: webhooks get a
  POST of `{job,prompt,summary,ts}` and shell commands receive the summary as
  `MOCHI_JOB_SUMMARY` + stdin after each scheduled run.
- **`mochi doctor`.** Health self-inspection across subsystems: model/key,
  node:sqlite, codegraph index, FTS5 sessions, daemon status, and toolchain
  detection, with an actionable problems list.

## 0.10.3

- **Credential pool + rotation.** A single `$PROVIDER_API_KEY` was a single point
  of failure for long agent runs. New `src/model/credential-pool.ts` pools
  multiple keys per provider (env comma/newline lists, `~/.config/mochi/credentials/<provider>.json`,
  or config) and rotates transparently on 401/403/429 via `nextKey` /
  `retireKey` with per-key cooldowns. `createOpenAIProvider` now calls
  `onRetryable` before each retry to swap to a fresh pool key, and
  `withRetries` gained the `onRetryable` hook. Keys are redacted in
  `inspectPool`/`describeConfig`; nothing secret is ever logged.
- **Scheduled agent jobs.** `mochi daemon cron add|list|remove` (and the
  `/api/cron` endpoint) run a prompt on an interval (`"every 30m"`) or 5-field
  cron (`"0 9 * * 1-5"`), persisted to `.mochi/cron.json`. The daemon ticker
  (in-process and detached) runs due jobs serially through the goal engine.
- **Session history (Hermes-style).** SQLite + FTS5 transcript store
  (`src/session-store.ts`) records every task conversation; `mochi session
  search "<text>"` and `mochi session list` inspect past work. Resuming a goal
  injects the real prior transcript so work isn't redone.
- **Background tasks.** `shell` accepts `background:true`; long tests/builds
  return a task id immediately and the loop injects the result when it
  finishes (`bg list` / `bg status <id>`).
- **Instant per-file diagnostics.** After write/edit/patch the edited file is
  type-checked same-turn (TS LanguageService cached ~32ms warm, Python via
  py_compile, `npx tsc` fallback) with FIX-BEFORE-CONTINUING guidance.
- **`replace_symbol` tool.** Name-addressed whole-symbol replacement through
  the code symbol index (no whitespace matching).
- **Prompt-stability tiers.** Task-dependent memory/kind hint moved out of the
  system prompt into the per-turn state tier for provider prefix caching.
- **Cron persistence fix.** The daemon ticker now saves `bumpJob`'s advance
  (`updateJob`) so a due job fires once per interval instead of re-firing on
  every 10s poll. Covered by a new daemon integration test (`/api/cron` add ->
  tick fires -> `nextRun` advances).
- **State cleanup.** Stale failed goal `3f5cb725` (a dogfood fixture whose
  `broken.ts` never existed) and its trace were removed; the spurious
  `completedTasks` entry and the matching `failures.md` block were cleared.

## 0.10.2

- **Proportionate verification.** Content-only tasks (e.g. "write OK to a file")
  no longer trigger the repo's full `npm test` / `tsc` / lint / build suite and
  get charged for pre-existing failures in untouched code. Verification is now
  scoped by task: relevant test subset for behavior changes, the task's direct
  check for content deliverables, and none for research. `autoTestCommand`,
  `Agent.verify`, and the `VerifierEngine` all gate repo-wide suites behind the
  content-only classifier; in-loop repo-wide runners on content-only tasks are
  vetoed with guidance.
- **Baseline-aware verification.** `Agent.verify` captures the repo's green
  baseline once (`baseline.json`) and no longer fails correct work for
  pre-existing red — a task is only blocked when it *transitions* the suite.
- **Diagnostics fallback.** When the edited project has no importable TypeScript
  API, `src/diagnostics.ts` falls back to `npx tsc` (bounded by timeout) so
  in-file diagnostics still work in repos that only have `tsc` via npx.
- **Tool: `replace_symbol`.** Add a name-addressed whole-symbol replacement tool
  with signature/type matching, used by the codegen loop.
- **Daemon `resume` test hardening.** The hermetic `/api/resume` test
  (`src/daemon.test.ts`) is now fully self-contained per test (dedicated
  workspace + daemon, no module-level shared `handle`/`dir`), so it passes in
  isolation and in group runs.
- **Instant per-file diagnostics.** After every write/edit/patch, the edited
  file is type/syntax-checked in the same turn (TS LanguageService with a
  cached host: 32ms warm; Python via py_compile) and errors are appended to the
  tool result with a FIX-BEFORE-CONTINUING instruction.
- **Background tasks.** `shell` takes `background: true`; long suites/builds
  return a task id immediately and the loop injects results when they finish
  (`bg list` / `bg status <id>`).
- **Prompt-stability tiers.** Task-dependent memory/kind-hint moved out of the
  system prompt into the per-turn state tier for provider prefix-cache hits.
- **Session history.** SQLite + FTS5 transcript store (`src/session-store.ts`)
  persists every task conversation; `mochi session search "<text>"` and
  `mochi session list` inspect past work. Hermes-style searchable memory.
- **Warm-start resume.** Resumed goals surface prior failed attempts as
  `PRIOR SESSION CONTEXT` ("do not repeat").
- Verified green end to end: content-only write completes in ~6s (was ~5min /
  47k tokens / failed). 384 tests / 71 files pass, typecheck clean.

## 0.10.1

- **Code-scan cleanup.** 10 real findings addressed (ReDoS in
  `sanitizeVerifyCommand` and `providerKey`, clear-text key logging in
  `describeConfig`, a template-literal regex bug where `[\s\S]` collapsed to
  `[sS]`, prototype pollution in config merge, lenient script/style end-tag
  matching, glob metachar escaping, and a missing `permissions` block in CI).
  CodeQL default setup is enabled for JS/TS; 79 stale alerts from the
  pre-rewrite Go codebase were dismissed.
- **Hermetic daemon test.** The resume test no longer calls a real provider in
  CI (it built tasks directly), eliminating a 429 rate-limit flake.
- **Docs.** README hero refreshed to match the current product (goals/DAG/teams,
  daemon, traces, zero deps, polyglot harness).

## 0.10.0

- **Daemon `resume` over CLI.** `mochi daemon resume <goalId>` is now wired
  (`/api/resume` was API-only), so interrupted or failed goals can be
  restarted from a headless box without the interactive flow.
- **Daemon remote access.** `mochi daemon start --host 0.0.0.0` binds the
  HTTP surface off loopback for LAN/phone/dashboard access (default stays
  `127.0.0.1`); the README documents local, LAN, and tunnel paths and the
  bearer-token surface any gateway (phone app, Discord bot, dashboard) can
  drive.
- **Daemon live round-trip test.** `src/daemon.live.test.ts` (skipped
  without `FREEINFERENCE_API_KEY`) sends a real goal through a daemon
  instance with the real provider, verifies the artifact on disk, simulates
  shutdown, and resumes the persisted goal through a fresh instance's
  `/api/resume` end to end.
- **Docs.** README now covers the daemon surface, `/api/resume`
  restart-survival semantics, run traces (`mochi trace [<goalId>]`), and
  refreshed cold-start/memory numbers (node ~84ms/~47MB, bun ~78ms/~42MB).

# Mochi Changelog

## 0.9.6

- **Mid-stream cancellation.** Ctrl-C now actually cancels the model request
  on the wire: `fetch` accepts an AbortSignal threaded from the loop, so an
  interrupted run stops the HTTP response instead of waiting for it to
  finish. Tested with a hanging SSE connection: aborting ends the stream
  immediately.
- **Daemon /api/resume.** Failed, active, or pending goals can be resumed
  over HTTP (`runtime.resumeGoal(goalId)` + `/api/resume {goalId}`), with
  the run trace continuing per goal. The daemon can now fully
  restart/retry dead work without a terminal.
- **Real team mode.** `mochi team` now decomposes the goal, assigns
  specialist roles per task (tester/reviewer/researcher/security/
  architect/debugger via title+description hints, with the final task
  forced to reviewer for convergence), and runs them through the
  scheduler concurrently. Verified with a real model: "2 done, 0 failed".
- **Tested TUI event pipeline.** The transcript/task-tree reducer is
  extracted into the pure `src/tui/state.ts` and unit-tested (transcript
  assembly, task lifecycle, stop reasons, truncation, cap). The TUI's
  `onRuntimeEvent` now delegates to it, so it surfaces `stopReason` and
  the same behavior the tests assert.
- **Structured stop reasons.** `AgentResult` now carries a `stopReason`
  (`completed`, `aborted`, `runtime_limit`, `budget`, `pulse_abort`,
  `max_iterations`, `model_error`, `tool_loop`, `verification_failed`),
  mirroring modern agent SDKs (LangChain/LangGraph). Every finish path in
  the loop declares why the run ended, and the reason rides the
  `task:completed`/`task:failed` events.
- **Run traces.** New `src/trace.ts` records a durable, deep-redacted
  JSONL trace of every agent run to `<workspace>/.mochi/traces/
  <goalId>.jsonl` — tool calls with args, results, errors, agent logs,
  and a goal summary — the observability layer harnesses ship by default.
  `mochi trace [<goalId>]` replays the newest (or a named) run as a
  readable transcript; `mochi trace` with no id lists the latest trace.
  Secrets inside nested tool args are redacted before they ever touch
  disk.
- **Clean interrupt handling.** Ctrl-C / SIGTERM now aborts the active goal
  cleanly instead of SIGKILLing the process and orphaning subagents: Runtime
  owns an AbortController, GoalEngine.runGoal accepts an external signal, and
  the CLI registers a one-shot interrupt handler (second interrupt force-
  exits). The agent loop stops at its next checkpoint and finishes the task
  as aborted.
- **Self-review pass.** After verification passes, the agent spends one cheap
  model call reviewing the working git diff for test-blind correctness
  problems (accidental deletions, dead code, wrong constants, TODO/debug
  leftovers, out-of-scope edits). A real issue feeds back into the loop so it
  is fixed and re-verified (bounded to two review rounds); a clean review
  confirms done. Skipped for pure answer/research tasks and plan mode.

## 0.9.5

- **From Horus (xanstomper/Horus).** New `src/security.ts` ports and
  extends the Horus security package:
  - `redact`/`redactObject` scrub API keys, JWTs, bearer tokens, private
    keys, GitHub/AWS/Slack/GitLab tokens, plus Google/Gemini/OpenAI/
    Anthropic keys. Wired into every persistent write: autopsies,
    procedural lessons, and usage records, so raw model output can never
    leak a key to disk.
  - `classifyCommand` ranks shell commands `low`/`network`/`destructive`;
    the shell tool now blocks destructive commands in `safe` mode and
    logs their risk class in auto mode.
  - `ApprovalQueue` for tool-approval flows.
- **From OpenFable (xanstomper/OpenFable).** The codegraph fingerprint
  is now content-addressed (SHA-1 of file bytes) instead of mtime+size,
  so edits that preserve mtime/size (or land on a coarse-timestamp
  filesystem) can never leave a stale symbol index. Huge files keep the
  cheap mtime fast path.
- **More from OpenFable (shared util).** New `src/util.ts` ports:
  - `randomSlug` (Slug): `mochi workspace create` without a name now
    gets a readable random name like `clever-comet` instead of colliding
    on "default".
  - `sortableId` (Identifier): attempts in the autopsy now use
    lexicographically ascending IDs, so they sort by when they happened.
  - `binarySearch`/`binaryInsert` for keep-sorted lists.
  - `lazy` memoizing singleton.
  - `getFilename`/`getDirectory`/`getFilenameTruncated`/`truncateMiddle`
    (path utils): verification failures and the daemon job list now show
    head and tail of long output instead of a blind head-only slice.
- **Call graph.** The symbol index now records `calls` edges (callee,
  caller, file, line) across all 10 indexed languages, extracted at index
  time from every grammar's call nodes. `find_callers` answers from the
  graph first — attributing each call site to its enclosing function
  symbol — then falls back to the line scan only for symbols the grammar
  didn't index. Cross-file callers are now exact in TS and Python (and
  every other indexed language).
- **Daemon streaming, jobs, resume, usage, auth.** `/api/goal` accepts
  SSE (`Accept: text/event-stream`) and streams `task:*`/`log` progress
  before the final result; `/api/jobs` lists workspace goals; `/api/plan`
  + `/api/approve` give the phone/dashboard plan-then-act flow; `/api/
  status` reports usage totals (calls, tokens, cost, duration). Auth is
  now a constant-time bearer-token compare. CLI: `daemon start --token`,
  `daemon jobs`, `daemon approve`.

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

- **Provider-level prefix caching.** `openai.ts` injects `cache_control: {type: "ephemeral"}` on index-0 system messages for DeepSeek/openai-compatible providers (freeinference/deepseek). First turn is 200; multi-turn harness runs clean. Combined with the byte-stable STABLE tier design (system prompt is identical across turns), this targets jcode-class token efficiency through cached-prefix billing.
-- Final concrete results (all verified, not projected) --
Freeze: reproduced from $HOME (>30s hang) -> 2.3s after fix.
Dogfood battery (same deepseek-v4-flash): mochi 10.6s/5.6s/7.1s vs jcode 8.6s/5.4s/17.0s; all outputs clean via hygiene scanner; T2 fix + T3 feature verified with untouched tests.
Prompt diet: 5249 -> 4268 tokens (~-1000/turn, -19%).
Cache control: openai provider adds ephemeral cache_control to index-0 system; freeinference returned 200 with usage tracked.
