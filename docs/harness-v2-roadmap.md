# Mochi Harness V2 — Phase 1–10 Engineering Specification

> Supersedes the ad-hoc P0/P1/P2 numbering in `harness-v2.md` (all of which
> shipped in commits 32f9a61, fd89da6, 7f03ce3 and is now "Phase 0 —
> baseline upgrades" for the purposes of this document).
>
> Every phase below specifies: files/components affected, new interfaces,
> migrations, dependencies, risks, tests, benchmarks, and backwards
> compatibility. Phases are ordered so each builds on the last; phases 1–3
> are foundation work, 4–6 are capability work, 7–10 are quality work.

---

## Phase 1 — Core runtime

**Goal**: Make the agent loop itself robust and observable: deterministic
iteration lifecycle, first-class stream guards, structured stop reasons.

**Files/components affected**
- `src/agent/loop.ts` (1626 loc — the primary target; split candidates below)
- `src/core/tool-dispatcher.ts` (execution ordering)
- `src/agent/loop.test.ts`, `src/agent/failover.test.ts`

**New interfaces**
- `interface IterationTrace { iteration: number; stopReason?: AgentStopReason; toolCalls: number; streamBytes: number; durationMs: number }`
  — replaces the scattered `this.events.emit({type:'agent:log', ...})` calls
  with a typed per-iteration trace emitted once per loop turn.
- `class LoopStateMachine` (extracted from `run()`): states
  `preflight → model-call → stream-guard → tool-exec → verify → finish`,
  each transition logged through `IterationTrace`.

**Migrations**
- None user-visible. Internal refactor of `run()` into the state machine;
  the public `Agent.run(task)` signature is unchanged.

**Dependencies**
- None external. Must land before phases 4/9 (they instrument these hooks).

**Risks**
- Refactoring a 1626-loc hot loop can regress the loop-guard behaviors
  (repetition detection, plan vetoes, empty-response backoff) that were
  hard-won. Mitigation: characterization tests first — port every existing
  guard scenario into `loop.test.ts` BEFORE moving code, and keep the guards'
  logic byte-identical (move, don't rewrite).

**Tests**
- Characterization suite: repeated-tool-call nudge, plan-mode veto, empty
  response backoff sequence, stream-loop failover, prose-runaway guard.
- State machine: assert every legal transition and that abort/timeout exits
  from ANY state (no hang paths).

**Benchmarks**
- Iterations-to-complete on the fixed 10-task suite must not regress > 10%.
- Wall-clock on "Code a calculator" smoke task stays ≤ 8s.

**Backwards compatibility**
- `AgentResult`, `AgentStopReason`, event names unchanged. Hooks
  (`before_tool`/`after_tool`) unchanged. TUI/daemon render from the same
  events, so no UI migration.

---

## Phase 2 — Tool architecture

**Goal**: One registry, one dispatch path, one output policy, per-tool
metadata (cost, side-effect class, cacheability).

**Files/components affected**
- `src/tools/index.ts` (registry assembly)
- `src/core/tool-dispatcher.ts`, `src/core/tool-output.ts` (both exist, extend)
- `src/core/capability-registry.ts`, `src/core/capability.ts` (already gate
  capabilities; fold into the registry)
- All 42 tools in `src/tools/*` (metadata annotation only, no logic changes)

**New interfaces**
- `interface ToolMetadata { cost: 'free'|'cheap'|'expensive'; effect: 'read'|'write'|'shell'|'network'; cacheable: boolean; parallelSafe: boolean }`
  — declared per tool; the dispatcher uses `parallelSafe` to decide batching
  (replacing the hardcoded `isReadOnly` + name-list logic in `executeToolCalls`).
- `ToolRegistry.register(tool, metadata)` — single construction path; role
  allowlists resolved against the registry, not ad-hoc name arrays.
- Output policy becomes per-tool configurable:
  `applyToolOutputPolicy(output, { toolName, profile: registry.profileFor(toolName) })`
  so e.g. `read` can keep a larger head than `grep`.

**Migrations**
- `src/tools/index.ts` gains a table mapping tool name → metadata; tools
  missing metadata default to `{cost:'cheap', effect:'read', cacheable:false, parallelSafe:false}`
  and are flagged by a lint test so omissions are visible.
- `executeToolCalls` batching switches from name-lists to `parallelSafe`.

**Dependencies**
- Phase 1 (dispatcher instrumentation hooks). No external deps.

**Risks**
- A tool wrongly marked `parallelSafe: true` could interleave writes.
  Mitigation: default false; whitelist opt-in per tool with a test asserting
  the whitelist contains only tools whose execute() has no shared mutable
  state (verified by code review + a concurrency stress test per whitelisted
  tool).

**Tests**
- Registry completeness: every exported tool has metadata (lint test).
- Dispatcher: mixed batch (read+write+shell) executes reads in parallel,
  writes to distinct files in parallel, shell serial — assert via a fake
  clock and call-order recording.
- Output policy profiles: `read` gets the large-head profile, `grep` default.

**Benchmarks**
- Parallel batch speedup: 5 concurrent `read`s complete in < 2x single-read
  wall-clock (was serialized in the worst case before).

**Backwards compatibility**
- Tool names and JSON schemas unchanged (model-visible surface frozen).
- MCP tools (`src/mcp/tools.ts`) auto-register with conservative defaults.

---

## Phase 3 — Context engine

**Goal**: Tiered context as a first-class object with explicit accounting,
caching tiers, and compaction contracts; kill ad-hoc message surgery.

**Files/components affected**
- `src/context.ts` (522 loc — extend, don't rewrite)
- `src/agent/loop.ts` (compact call sites — already migrated to
  `checkpointAndCompact`)
- `src/context.test.ts`, `src/agent/compact-cutpoints.test.ts`

**New interfaces**
- `type ContextTier = 'stable' | 'volatile' | 'transcript' | 'ledger'`
- `interface ContextAccounting { stableBytes: number; volatileBytes: number; transcriptBytes: number; ledgerBytes: number; reportedPromptTokens?: number }`
  — exposed as `context.accounting()`; the TUI status bar can render it.
- Compaction contract (already shipped, formalize):
  `compact(checkpoint?)` guarantees (a) no orphaned tool results, (b) mode
  stamps carried forward, (c) file-op sets carried forward, (d) checkpoint
  leads the ledger. Each guarantee gets a named test.

**Migrations**
- None breaking. `estimateTokens()` stays (fallback); `effectiveContextTokens()`
  is the preferred signal (already shipped in phase 4 of the old numbering).

**Dependencies**
- Phase 1 for the iteration trace that reports accounting per turn.

**Risks**
- Byte-stability of the stable tier is what makes provider prefix caching
  work. Any change to `buildSystemPrompt` ordering breaks cache hits
  silently (costs money, no errors). Mitigation: the existing
  prefix-cache test (`keeps the leading system message byte-identical`) plus
  the prompt-quality suite are release gates.

**Tests**
- The four compaction guarantees, each named.
- Accounting sums match rendered packet sizes (±5%).
- Ledger survives 5 consecutive compactions without unbounded growth
  (cap the facts list; assert bytes stabilize).

**Benchmarks**
- Cache-hit rate: with a fixed session, replay 10 turns against a usage-
  reporting provider; cache_tokens/total_tokens must not regress.

**Backwards compatibility**
- `buildPacket()` return shape unchanged. New methods are additive.

---

## Phase 4 — Token optimization

**Goal**: Measure and cut tokens: prompt sizing, tool-schema compression,
transcript pruning with keep-policies, per-role budget knobs.

**Files/components affected**
- `src/context-budget.ts` (fold into context engine or keep as helper)
- `src/tools/index.ts` (schema emission — the biggest fixed cost)
- `src/budget.ts` (runtime budget engine)
- `src/model/openai.ts` (emit `tool_cache`/compressed schemas when provider
  supports them)

**New interfaces**
- `interface ToolSchemaBudget { maxToolsPerCall: number; maxDescriptionChars: number; includeOnlyUsedRecently?: boolean }`
- `context.buildPacket(tools, task, repo, { toolSelection: 'all' | 'task-relevant' })`
  — task-relevant mode ranks tools by historical co-occurrence with the task
  kind (data already collected by the LearningStore) and trims the schema
  block for weak/budget models.
- Budget profiles per role: `role.budget.toolSchema = 'minimal' | 'full'`.

**Migrations**
- Default behavior unchanged ('all'); opt-in flag first, flip default only
  after the benchmark shows no quality regression on the 10-task suite.

**Dependencies**
- Phase 2 (registry metadata drives ranking), Phase 3 (accounting to measure).

**Risks**
- Trimming schemas can hide a tool the model needed (the "minimal harness"
  feeling the user complained about). Mitigation: never trim below 12 tools
  for the coder role; keep an escape hatch — if the model attempts a call to
  a hidden tool name, re-inject full schemas for the rest of the session and
  log it as a telemetry event.

**Tests**
- Packet builder: task-relevant mode emits fewer schema bytes and still
  includes the tools the task kind historically used.
- Hidden-tool fallback: attempting an unregistered-but-known tool name
  triggers re-injection (fake provider test).
- Budget engine: token accounting matches emitted usage within tolerance.

**Benchmarks**
- THE core metric: tokens/task on the fixed 10-task suite, per model class.
  Target: −20% input tokens on weak-model profiles with equal task success.

**Backwards compatibility**
- Opt-in only. No schema change for default configs.

---

## Phase 5 — MCP/ACP

**Goal**: First-class external tool federation: MCP servers configurable per
project, ACP session resume parity with the TUI.

**Files/components affected**
- `src/mcp/index.ts`, `src/mcp/tools.ts` (client + tool bridging)
- `src/acp.ts` (editor protocol server)
- `src/config.ts` (per-project `.mochi/mcp.json`)
- `src/mcp/deepwiki-server.ts` (existing in-repo server, keep as reference)

**New interfaces**
- `interface McpServerConfig { command: string; args?: string[]; env?: Record<string,string>; tools?: string[] /* allowlist */; trust?: 'full' | 'sandboxed' }`
- `loadMcpServers(projectRoot): Promise<McpConnection[]>` — validated at
  startup; failures degrade to a warning, never block the loop.
- ACP: implement `session/load`, `session/paste` history hydration so an
  editor reconnect sees the full transcript (currently fresh-context only).

**Migrations**
- `.mochi/mcp.json` is new and optional; the existing global config path
  continues to work. Add `mochi mcp list` CLI for visibility.

**Dependencies**
- Phase 2 (registry: MCP tools get metadata defaults). Uses `@modelcontextprotocol/sdk`
  if already present — check package.json; vendored minimal client otherwise.

**Risks**
- External servers are untrusted code. The `trust` field gates dangerous
  permissions; sandboxed servers get read-only tool permissions regardless
  of their own claims. Spawned processes MUST be killed on abort (leak risk
  on long sessions — the same class of bug as the dangling-subprocess fix
  in runProbe).

**Tests**
- Mock MCP server over stdio (in-repo fixture): tool listing, call bridging,
  allowlist enforcement, kill-on-abort within 2s.
- ACP: reconnect receives prior transcript (integration test with a socket
  pair).

**Benchmarks**
- MCP tool call latency overhead vs native tool: target < 50ms overhead.

**Backwards compatibility**
- No existing config changes. ACP protocol versioning already in place.

---

## Phase 6 — Subagents

**Goal**: Make delegation reliable and cheap: bounded fan-out, result
contracts, shared read-cache, and depth-aware toolsets.

**Files/components affected**
- `src/agent/loop.ts` (`spawnSubagent`)
- `src/tools/subagent.ts` (the tool surface)
- `src/goals/goal.ts` (top-level orchestration reuses the same primitives)

**New interfaces**
- `interface SubagentContract { prompt: string; role?: AgentRole; maxIterations?: number; maxTokens?: number; expectedArtifact?: 'summary' | 'diff' | 'files' }`
- Result envelope: `{ summary: string; filesTouched: string[]; tokensUsed: number; stopReason: string }`
  — the parent gets structured results instead of free text.
- `subagentDepth` (exists) + a new sibling cap: `maxConcurrentSubagents`
  from safety config is enforced by a semaphore in the dispatcher.

**Migrations**
- `spawnSubagent(prompt, role)` internal signature extends to accept the
  contract; the `subagent` tool's JSON schema gains optional fields only.

**Dependencies**
- Phase 1 (state machine), Phase 2 (registry gives children narrowed
  toolsets by role), Phase 3 (children get compact ledgers seeded from the
  parent's file-op sets so they don't re-read).

**Risks**
- Fan-out cost blowups on cheap models (N children × iterations). The
  semaphore + per-child token caps bound it; budget engine must count child
  tokens against the parent run (already true via shared BudgetEngine —
  verify with a test).

**Tests**
- Semaphore: N=4 spawns with cap 2 → max 2 concurrent (fake-clock test).
- Child sees parent's read-set in its seed ledger (context assertion).
- Depth guard: depth-1 child has no subagent tool (already tested; keep).

**Benchmarks**
- Parallel research task (3 independent lookups) completes ≤ 1.5x the
  slowest single lookup's wall-clock.

**Backwards compatibility**
- Tool schema additive. Default cap = existing `maxConcurrentAgents`.

---

## Phase 7 — Memory

**Goal**: Layered memory that survives sessions: project facts, episodic
transcripts, procedural lessons — with relevance selection and decay.

**Files/components affected**
- `src/memory.ts` (MemoryStore)
- `src/learning.ts` (LearningStore — procedural lessons)
- `src/sqlite.ts` (storage layer; already optional)
- `src/goals/goal.ts` (prior-transcript hydration on resume — exists, extend)

**New interfaces**
- `type MemoryKind = 'fact' | 'episode' | 'lesson' | 'correction'`
- `interface MemoryRecord { id: string; kind: MemoryKind; content: string; tags?: string[]; createdAt: number; lastUsedAt: number; useCount: number }`
- `MemoryStore.recall(query, { kinds?, limit?, minRelevance? })` — FTS when
  sqlite available, `src/relevance.ts` scoring fallback otherwise.
- Decay: `prune(maxAgeDays)` runs on session start; lessons referenced by
  successful runs get `useCount++` and never decay below N uses.

**Migrations**
- Existing `MemoryEntry` rows map to `kind:'fact'`. Bump the sqlite schema
  with an additive column + `ALTER TABLE` guarded by a version check; absent
  sqlite falls back to the JSON store unchanged.

**Dependencies**
- Phase 3 (the compact ledger and resume checkpoint feed episodic memory).

**Risks**
- Stale/wrong memories poison future runs (the classic memory hazard).
  Mitigations: corrections (`kind:'correction'`) override facts with the
  same tag; relevance threshold default is conservative; the state prompt
  caps memory injection at ~1KB.

**Tests**
- FTS recall ranking: a query matching a lesson's terms returns it first.
- Decay: records older than maxAge are pruned unless useCount ≥ N.
- Correction precedence: same-tag correction shadows the fact.
- Schema migration: old fixture DB upgrades in place and reads back.

**Benchmarks**
- Warm-start effect: re-running a previously-failed task reaches a correct
  attempt in fewer iterations than cold (measure via autopsy attempts
  count; target ≥ 1 fewer attempt on the suite's retry tasks).

**Backwards compatibility**
- Old JSON memories load as facts. No config changes required.

---

## Phase 8 — Model routing

**Goal**: Profile-aware routing with health-aware failover: capability gates,
latency/cost scoring, and per-model prompt quirks (e.g. the qwen system-
message-after-user bug class).

**Files/components affected**
- `src/model-router.ts` (113 loc), `src/model/router.ts` (chain + failover)
- `src/model/openai.ts` (quirk adapters), `src/model/anthropic.ts`,
  `src/model/gemini.ts`
- `src/model/failover.test.ts`, `src/model/rate-limit.ts`

**New interfaces**
- `interface ModelHealth { model: string; consecutiveFailures: number; lastLatencyMs: number; avgLatencyMs: number; loopIncidents: number; cooledDownUntil?: number }`
- `ModelRouter.select(task, { health, budget, capability })` — scored choice
  replacing the static profile map at call time (profiles remain the prior).
- Quirk registry: `providerQuirks(baseUrl): { mapSystemAfterUser: 'user-role' | 'reject' | 'native'; supportsParallelTools: boolean }`
  — codifies the dac1e72 fix class as data, per provider/model.

**Migrations**
- `pickProvider()` in the loop delegates to `ModelRouter.select` while
  keeping the same return type. `FALLBACK_MODELS` static list becomes the
  router's tail of the preference chain (same models, same order — no
  behavior change on day one).

**Dependencies**
- Phase 1 (iteration trace feeds health stats), budget engine (exists).

**Risks**
- Oscillation between models on transient errors. Mitigation: hysteresis —
  switch only after the existing repetition thresholds trip; cool-down
  period before switching back (60s default).

**Tests**
- Health scoring: high loop-incidents demotes a model below a fresh one.
- Failover preserves the existing semantics (error before first chunk →
  try next; after output started → rethrow).
- Quirk: system-after-user messages are rewritten for qwen-class providers,
  passed through natively otherwise (existing midconv test keeps passing).

**Benchmarks**
- Suite success rate with routing enabled ≥ static-profile baseline; mean
  first-token latency on repeated runs improves via cooldown avoidance.

**Backwards compatibility**
- Config schema unchanged; profiles still work exactly as today.

---

## Phase 9 — Observability

**Goal**: One structured event stream, persisted traces, and a run inspector:
every stop reason explainable post-hoc.

**Files/components affected**
- `src/events.ts` / wherever `AgentEvents` lives (unify typed events)
- `src/trace.ts` (new: run trace persistence, replay)
- `src/autopsy.ts` (failure records — join with traces)
- `src/doctor.ts`, `src/cli.ts` (`mochi trace` subcommand exists — deepen)
- Telemetry registries shipped in phase 3/6 of old numbering
  (`tool-output.ts`, `skill.ts` counters) get one aggregation point.

**New interfaces**
- `interface RunTrace { runId: string; goalId: string; iterations: IterationTrace[]; toolCalls: { name: string; argsDigest: string; durationMs: number; truncated: boolean }[]; usage: ContextAccounting[]; stopReason: AgentStopReason; modelSwitches: { from: string; to: string; cause: string }[] }`
- `mochi trace <runId> --json` prints it; `--replay` re-renders in the TUI.
- Trace files under `.mochi/traces/<runId>.json`, pruned to the newest 50.

**Migrations**
- `agent:log` string events remain for the TUI but are ALSO parsed into the
  structured trace (dual-write during migration; TUI switches at leisure).

**Dependencies**
- Phases 1–4 (iteration trace, accounting, telemetry registries).

**Risks**
- Trace writes on every event could dominate I/O on hot loops. Mitigation:
  batched fsync (write on iteration boundary, not per tool call), size caps
  per trace (drop argDigests beyond N tools).

**Tests**
- A full fake run produces a trace whose iterations count, tool totals, and
  stop reason match the run's actuals.
- Pruning keeps ≤ 50 traces.
- `--json` output validates against the RunTrace schema.

**Benchmarks**
- Overhead budget: tracing adds < 3% wall-clock on the smoke task.

**Backwards compatibility**
- Additive. Old runs simply have no trace files.

---

## Phase 10 — Performance optimization

**Goal**: Close the loop on speed and cost with the telemetry from 1–9:
prefix-cache discipline, warm paths, and the benchmark harness as CI.

**Files/components affected**
- `src/context.ts` (stable-tier discipline — final pass)
- `src/tools/read.ts` + `src/codegraph.ts` (read caching, symbol index reuse)
- `benchmark/` (new directory: the fixed 10-task suite runner)
- `.github/workflows/ci.yml` (nightly perf job, not per-push)

**New interfaces**
- `benchmark/run.ts`: `mochi bench --suite core --models qwen3.6-35b,...`
  emitting `benchmark/results/<date>.json` with tokens, latency, iterations,
  success per task; a compare mode `mochi bench --compare <old> <new>` that
  fails on > 10% regression in tokens or success rate.
- Read-cache hit-rate and symbol-index warm/cold timings surfaced in perf
  stats.

**Migrations**
- Benchmark tasks are fixtures (small repos in `benchmark/fixtures/*`);
  no product code depends on them.

**Dependencies**
- Everything: this phase is the measurement layer for all prior claims.

**Risks**
- Benchmarks on free providers are noisy (queue latency variance).
  Mitigation: median of 3 runs, per-model baselines stored, CI job marked
  non-blocking first, promotion to blocking only when variance is proven
  acceptable.

**Tests**
- The bench runner itself is unit-tested with a fake provider (fixture
  tasks "succeed" deterministically; compare-mode flags an injected
  regression).

**Benchmarks**
- Meta: the suite becomes the gate. Explicit targets: tokens/task −20% vs
  the 7f03ce3 baseline on weak-model profiles; smoke-task wall-clock ≤ 8s;
  cache-hit ratio ≥ 60% on multi-turn sessions with usage-reporting
  providers.

**Backwards compatibility**
- None affected; `mochi bench` is a new subcommand.

---

## Sequencing summary

| Phase | Depends on | Ships behind | Release gate |
|---|---|---|---|
| 1 Core runtime | — | internal refactor | characterization suite green |
| 2 Tool architecture | 1 | metadata defaults | registry lint + dispatcher tests |
| 3 Context engine | 1 | additive methods | compaction contract tests |
| 4 Token optimization | 2,3 | opt-in flag | bench: no success regression |
| 5 MCP/ACP | 2 | optional config | mock-server suite |
| 6 Subagents | 1,2,3 | schema additive | semaphore + seed tests |
| 7 Memory | 3 | additive schema | migration test |
| 8 Model routing | 1 | router delegates | failover parity tests |
| 9 Observability | 1–4 | dual-write | trace fidelity test |
| 10 Performance | all | new subcommand | bench compare gate |
