# Mochi

> Minimal, fast, autonomous coding agent for the terminal. Goals, task DAGs, teams,
> a persistent daemon, and deep run traces on a Rust runtime core with a TypeScript
> frontend.

Mochi is a from-scratch re-imagining of the terminal coding-agent harness. It keeps the
best ideas from Pi (tools, sessions, context files, minimal TUI) and adds first-class
support for goals, task DAGs, teams, persistent state, checkpoints, verification,
recovery, budgets, hooks, retrieval, memory, and local harness learning.

```bash
npm install && npm run build
mochi "add a rate limiter to the auth service"   # one-shot agent run
mochi daemon start --host 0.0.0.0                 # persistent agent over HTTP
mochi daemon send "finish the auth flow"          # drive it from anywhere
mochi team "ship the payments refactor"           # role-diverse agent team
mochi trace <goalId>                               # replay any run end to end
```

Zero runtime JS dependencies; runs under Node 22 or Bun, and ships a standalone native
binary (`npm run build:bin`) that needs no runtime at all. The performance core is a
zero-dependency Rust crate (`native/mochi_core`): tokenization, budget math, context
compaction planning, and agent-loop decisions run natively, with the TypeScript frontend
handling model I/O, TUI, and tool execution. Every native path has a parity-tested TS
fallback, so nothing breaks when the Rust binary is absent (CI, cold installs). The
harness is polyglot: 15-language registry, tree-sitter codegraph, and native Rust/C++
accelerators in the `edit`/`patch` hot paths.

## Comprehensive Documentation

- **[Technical Architecture Blueprint](docs/ARCHITECTURE.md)**: Deep dive into the dual-engine Rust Core + TypeScript TUI architecture, compaction protocols, and event loops.
- **[Complete Capabilities Reference](docs/CAPABILITIES.md)**: Detailed breakdown of the **16 specialized agent roles**, 30+ native tools, 30+ skills, and MCP/ACP protocols.
- **[Empirical Benchmarks vs Other Agents](docs/BENCHMARKS.md)**: Standardized PSS memory, TTFF, TTFI, and compaction latency benchmarks vs jcode, Claude Code, Cursor, Copilot, and OpenCode.
- **[CLI & Interface Reference](docs/CLI_REFERENCE.md)**: Complete guide to CLI flags, daemon endpoints, interactive slash commands, and keybindings.

## Performance Highlights (vs Other Agents)

| Benchmark Metric | Mochi (Rust Core) | jcode | Cursor Agent | Claude Code | OpenCode |
| :--- | :--- | :--- | :--- | :--- |
| **1 Active Session (PSS)** | **18.2 MB** [1st] | 27.8 MB | 214.9 MB | 386.6 MB | 371.5 MB |
| **10 Active Sessions (PSS)**| **84.5 MB** [1st] | 117.0 MB | 1632.4 MB | 2300.6 MB | 3237.2 MB |
| **Time to First Frame (TTFF)**| **11.2 ms** [1st] | 14.0 ms | 1949.7 ms | 3436.9 ms | 1035.9 ms |
| **Time to First Input (TTFI)**| **38.2 ms** [1st] | 48.7 ms | 1978.7 ms | 3512.8 ms | 1047.9 ms |
| **Compaction Cut Calculation** | **0.12 ms** (Rust) [1st]| 0.45 ms | 14.5 ms | 35.0 ms | 19.8 ms |

*See full test methodology, PTY probe scripts, and 9-agent comparison tables in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).*

## Status

Implemented:

- Event bus architecture
- Model-agnostic OpenAI-compatible provider with OpenCode aliases
- Model routing by capability profile (`fast` / `coding` / `reasoning` / `review`)
- Budget-aware model fallback
- Tool bus: `read`, `write`, `edit`, `delete`, `shell`, `search`, `glob`, `git`, `inspect`, `memory`, `patch`, `todo`, `skill`, `subagent`
- Codex-style multi-file `patch` tool (`*** Begin Patch` / `Add` / `Update` / `Delete File` sections) with context matching that tolerates whitespace drift
- `edit` tool falls back to whitespace-insensitive matching (unique anchor required; ambiguity is refused rather than guessing)
- Permission system (`safe` / `ask` / `auto`)
- Adaptive context engine with token budget, compaction, project memory, and retrieval
- Agent runtime loop: preflight → model → tools → verify → recover → pulse
- Persistent goals and task DAG scheduler
- Team orchestration with role-based agents
- Agent profiles from `.mochi/agents/*.md`
- Independent verifier and outcome judge
- Budget engine with token, cost, time, tool, model, and agent limits
- Hook pipeline (`before_*`, `after_*`, `on_*`)
- Intelligent retrieval across files, symbols, references, imports, and git history
- Speculative execution for difficult problems
- Project memory and cross-session engineering facts
- Local harness learning for successful recovery strategies
- Git checkpoint / rollback
- Interactive terminal UI with rounded input, transcript, command palette, and status bar
- Multiple workspaces
- Persistent daemon over HTTP: `start/status/jobs/send/approve/resume/cron/stop`
- Durable run traces with deep redaction (`mochi trace [<goalId>]`)
- Full-text session history in SQLite+FTS5 (`mochi session list` / `mochi session search`)
- Recurring agent jobs on a schedule (`mochi daemon cron add|list|remove`)
- Credential pools: multi-key rotation on 401/429/403
- Instant per-file diagnostics (TS LanguageService + Python) after every edit
- Background tasks: async shell (`shell` with `background:true`) + result delivery
- Name-addressed whole-symbol edit (`replace_symbol` via the code symbol index)
- Baseline + proportionate verification (pre-existing repo debt doesn't fail correct work)
- Mid-stream cancellation: Ctrl-C aborts the model request on the wire
- Structured stop reasons (`completed`/`aborted`/`runtime_limit`/`budget`/`model_error`/...) on every `AgentResult`
- Warm-start resume: prior session transcript + failed attempts injected on restart
- Unit and integration tests

## Quick start

```bash
# Build
npm install
npm run build

# Link globally (optional)
ln -s $(pwd)/dist/cli.js ~/.local/bin/mochi

# Set an API key
export OPENCODE_ZEN_API_KEY=sk-...

# Interactive mode
mochi

# One-shot task
mochi -p "list all TypeScript files"

# Plan only
mochi plan "refactor authentication"

# Autonomous goal
mochi goal "fix all failing tests"

# Team goal
mochi team "build a REST API for users"

# Inspect a symbol or subsystem
mochi inspect "SessionManager"

# Speculative reasoning
mochi speculate "difficult TS2345 failure"
```

> **Speculative preflight** (`model.speculative.preflight: true` in config): for hard
> non-chat tasks, mochi runs a cheap speculative pass before the main loop call and
> injects the chosen approach + alternatives as a system hint, so the model commits
> to a better plan before firing tools (DeepSeek/Cline-style "think a cheap model
> ahead"). `model.speculative.selfCritique: true` reinforces the loop's existing
> failure-repair flow on the first verification miss. Both are opt-in and never block
> the task — a failed/skipped preflight degrades to a normal run.

## Configuration

Global: `~/.config/mochi/config.json`
Project: `.mochi/config.json`

```json
{
  "model": {
    "provider": "opencode-zen",
    "apiKey": "sk-...",
    "model": "opencode/deepseek-v4-flash-free",
    "profiles": {
      "fast": "opencode/deepseek-v4-flash-free",
      "coding": "opencode/deepseek-v4-flash-free",
      "reasoning": "opencode/deepseek-v4-flash-free",
      "review": "opencode/deepseek-v4-flash-free"
    },
    "speculative": {
      "preflight": true,
      "selfCritique": true
    }
  },
  "safety": {
    "mode": "ask",
    "maxIterations": 8,
    "maxConcurrentAgents": 3,
    "contextBudgetTokens": 32000,
    "maxTokens": 150000,
    "maxCostUsd": 2,
    "maxModelCalls": 100,
    "maxToolCalls": 200
  },
  "permissions": {
    "read": true,
    "write": true,
    "shell": true,
    "network": true,
    "gitDestructive": false
  },
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory"],
      "env": {}
    }
  },
  "planMode": false
}
```

### MCP servers

`mcpServers` entries are stdio MCP servers. Each is spawned once per agent run,
handshakes over JSON-RPC, and its tools are registered natively as
`serverName__toolName` (e.g. `memory__create_entities`) with `network`
permission, so the model calls them like any built-in tool. Failed servers are
logged and skipped; a crashed server rejects its pending calls instead of
hanging the run. Servers that expose MCP **resources** additionally get
`serverName__resources_list` and `serverName__resources_read` tools (read
permission) so the model can pull server-provided context on demand.

### Plan-then-act mode

Set `"planMode": true` in config or pass `--plan` on any run: every agent
researches with read-only tools and returns a plan (steps, files, risks,
verification). Mutating tools (`write`/`edit`/`delete`/`shell`) are vetoed, the
model is redirected to produce the plan, and no files are changed.

### Subagent delegation

The `subagent` tool lets the model delegate a self-contained subtask to a fresh
child agent that shares the run's budget, read cache, and workspace, returning a
summary. Delegation is one level deep (children cannot spawn grandchildren) to
bound runaway fan-out.

## Agent profiles

Create lightweight profiles in `.mochi/agents/`:

```markdown
---
name: debugger
description: Diagnose and repair software failures
tools:
  - read
  - search
  - inspect
  - edit
  - shell
  - git
model: reasoning
verification: required
---
Reproduce the failure, classify the error, identify the root cause, and apply the smallest fix.
```

Profiles control tools, model routing, verification requirements, and behavior. Teams instantiate these profiles dynamically.

## Hooks

Create `.mochi/hooks.json`:

```json
{
  "before_shell": "echo running command",
  "after_edit": "npm test",
  "before_goal": "true"
}
```

A failing `before_*` hook vetoes the action. `after_*` hooks observe completed actions.

## Project memory

Mochi maintains curated engineering memory in:

```text
.mochi/
├── project.md
└── memory/
    ├── architecture.md
    ├── decisions.md
    ├── conventions.md
    └── failures.md
```

Agents can add durable facts through the `memory` tool. Conversation history is never dumped into memory.

## Interactive commands

```text
/help
/goal <objective>
/team <objective>
/plan <objective>
/tasks
/status
/diff
/changes
/checkpoint
/rollback
/model
/profiles
/memory
/inspect <query>
/clear
/exit
```

## Architecture

```text
Mochi
├── Runtime
│   ├── Config
│   ├── Workspace
│   ├── EventBus
│   ├── HookManager
│   └── GoalEngine
├── Goals
│   ├── Persistent goal state
│   ├── Task DAG + Scheduler
│   └── Decomposition via model
├── Teams
│   ├── Dynamic agent spawning
│   ├── Agent profiles
│   └── Role-based model selection
├── Agent Loop
│   ├── ContextEngine
│   ├── RetrievalEngine
│   ├── Model provider/router
│   ├── Tool bus
│   ├── BudgetEngine
│   └── Verification/Recovery/Pulse
├── Memory
│   ├── Project facts
│   └── Local recovery learning
├── Performance Pipeline
│   ├── Incremental stream parser
│   ├── FastEventBus
│   ├── Batched state store
│   ├── Dirty-region renderer
│   └── Measured frame budget
└── CLI / TUI
```

## Performance

The stream pipeline is event-driven and measured end to end:

```text
Model stream
  ↓
Incremental parser
  ↓
Compact events
  ↓
FastEventBus
  ↓
Batched state
  ↓
Dirty regions
  ↓
Renderer
```

Benchmark it:

```bash
mochi perf --chunks 10000
```

No high-frequency event causes full-state propagation or full-tree rendering.

### Standalone native binary (no runtime required)

For deployments where even Node/Bun aren't guaranteed, compile Mochi into a single
self-contained executable with Bun. The binary embeds the runtime and all modules;
no `node_modules`, `package.json`, or runtime install is needed:

```bash
npm run build:bin   # produces ./dist/mochi-bin (bun required)
./dist/mochi-bin --version
```

The binary is fully functional end to end (agent loop, tools, config, workspaces), so
it can be dropped onto a low-spec or headless box without a JS runtime.

### Cold-start / memory footprint

Mochi is a Rust runtime core with a TypeScript frontend and **zero runtime JS
dependencies**. Cold start and peak
RSS are measured by `bench/efficiency.mjs` (`npm run bench:efficiency`), and the CLI runs
unmodified under Bun for a lower footprint (useful on low-RAM, hardware-friendly boxes):

```text
mochi (node)  ~84ms / ~47MB
mochi (bun)   ~78ms / ~42MB
```

Long agent runs also avoid repeated disk work: project rules and project memory are
fingerprint-cached per iteration (see `src/context.ts`), so a multi-hundred-iteration task
isn't re-reading `MOCHI.md`/`AGENTS.md`/memory from disk on every model call.

## Daemon (persistent agent over HTTP)

Run Mochi as a background service and drive it from any tool (scripts, phone, Discord gateway):

```bash
mochi daemon start --port 8642 --token sekret   # serve on localhost:8642
mochi daemon status                            # is it up? jobs running?
mochi daemon jobs                             # list persisted goals + status
mochi daemon send "finish the auth flow"      # enqueue a goal
mochi daemon approve                         # approve queued shell commands (safe mode)
mochi daemon stop
```

HTTP surface (auth via `Authorization: Bearer <token>` header):
`POST /api/goal {objective}`, `POST /api/status`, `POST /api/jobs`, `POST /api/plan`,
`POST /api/approve`, `POST /api/resume {goalId}`, `POST /api/inspect {query}`. Goals persist across daemon restarts; a goal
created by one instance can be resumed by a fresh one via `/api/resume`,
so interrupted or failed work survives daemon shutdown.

By default the daemon binds to `127.0.0.1` only. For remote access from a
phone or another machine on the LAN, bind it explicitly (keep the token
secret, and prefer a tunnel over a raw public bind):

```bash
mochi daemon start --host 0.0.0.0 --port 8642 --token sekret   # LAN access
ssh -R 8649:localhost:8649 your-server                          # internet via reverse tunnel
```

The daemon is a plain HTTP server, so any gateway (a phone app, a Discord
bot, a dashboard service) can drive Mochi with the bearer token:
send goals, list jobs, approve queued commands, and resume interrupted
work from a fresh instance.

## Editor integration (ACP)

`mochi acp` starts an Agent Client Protocol v1 server over JSON-RPC stdio, so
ACP-capable editors (VS Code, Zed, JetBrains) can drive Mochi natively:

```bash
mochi acp   # spawn as an editor subprocess; speaks ACP v1 on stdin/stdout
```

Supported methods (ACP v1):

| Method | Description |
|--------|-------------|
| `initialize` | Protocol handshake; returns agent capabilities |
| `session/new` | Create a workspace session; returns `sessionId`, `modes`, `configOptions` |
| `session/prompt` | Run a goal with streaming `session/update` notifications; returns `stopReason` |
| `session/cancel` | Abort a running prompt |
| `session/load` | Load a session's modes and config options |
| `session/list` | List sessions with pagination (`limit`, `cursor`) |
| `session/delete` | Delete a session |
| `session/resume` | Reconnect to a session |
| `session/close` | Close a session |
| `session/set_mode` | Switch between `act` / `plan` modes |
| `session/set_config_option` | Set config (e.g., `plan_mode`) |
| `session/request_permission` | MCP permission requests (returns `allowed`) |
| `shutdown` | Clean server shutdown |

Streaming updates (`session/update`): `tool_call`, `tool_call_update`, `agent_message_chunk`, `usage_update`, `plan`.

Prompts accept ACP `ContentBlock[]` payloads; each run returns a `stopReason`.

## Health (`mochi doctor`)

`mochi doctor` self-inspects the full harness: model/key state, `node:sqlite`,
codegraph symbol index, FTS5 session store, daemon status, and toolchain
detection (TypeScript/Python), ending with an actionable problems list.

## Run traces

Every project run writes a durable, deep-redacted JSONL trace (secrets scrubbed):

```bash
mochi trace               # list traces
mochi trace <goalId>      # replay a goal run: prompts, tool calls, results, stop reason
```

## Integrations


### Chameleon (internal synthetic-parameter reasoning)

Turns a flash-class model into a frontier-grade reasoner for hard goals by
generating dense "synthetic parameter" reasoning context, injected into the
agent prompt. This is built into Mochi — it uses the agent's OWN configured
provider, so there's no external CLI, no shell-out, and no extra API key.

```bash
# Print enhancement context for a task
mochi enhance "Build a Redis rate limiter" --mode hard

# Auto-inject enhancement before solving a hard goal
mochi goal --enhance "finish the auth flow" --mode auto

# The agent can also call the `chameleon` tool directly while working.
```

Opt in without a flag via config:

```json
{ "enhance": { "enabled": true, "mode": "auto" } }
```

Enhance uses the same provider the agent loop uses, so a failed provider call
is a graceful no-op. Modes map to how many reasoning strategies run:
`flash<turbo<easy<medium<hard<deep<extreme/genius`.

### Termix (multi-session split)

Termix **splits your current session into N split windows** — all in-process
agent sessions on the same configured provider. It opens nothing extra: no
external app, no auto-launched process, no extra terminal. Run it and choose how
many panes, then whether the panes **communicate** or **separate**:

```bash
mochi termix                 # interactive: pick task, pane count, and mode
mochi termix "dedupe JSON"   # pick pane count + mode, task given
mochi termix "fix auth" --sessions 3 --coms   # 3 panes, shared broadcast channel
mochi termix "fix auth" --sep                # panes fully isolated
```

- `--coms` — panes share a rolling `<broadcast>` channel and see each other's
  conclusions between passes.
- `--sep` — each pane works from first principles, fully isolated.

Each pane takes a distinct angle (architect, adversarial reviewer, SRE, ...).
The run prints each pane's steps/tokens/cost plus the whole split's total.

## Symbol graph backends

`get_function` / `find_callers` / `type_hierarchy` index the repo into an
in-memory SQLite code graph. Two parsers back the index, selectable by env:

- `tsc` (default): the TypeScript compiler AST, always available.
- `tree-sitter`: a WASM CST walk for lower startup cost. Opt in with
  `npm i web-tree-sitter tree-sitter-typescript` and set
  `MOCHI_CPG_BACKEND=tree-sitter`. If the packages are missing it falls back
  to the TS-AST backend automatically.

```bash
MOCHI_CPG_BACKEND=tree-sitter mochi inspect "SessionManager"
```

The read paths (`getFunctionSynapse`, `findCallers`, `typeHierarchy`) are
backend-agnostic, so either parser produces the same tool output.

### Light mode (zero-embed, zero-parser)

On very small boxes you can disable the embedded SQLite symbol index AND the
tree-sitter WASM parser entirely (both degrade gracefully instead of throwing):

```bash
MOCHI_LIGHT=1 mochi            # no embedded index, no WASM parser
MOCHI_NO_EMBED=1 mochi         # same effect
MOCHI_NO_INDEX=1 mochi         # same effect
```

Even without the flag, the parser is lazy: grammars load on first symbol-index
use and only for languages actually present in the repo, so runs that never
touch codegraph tools pay nothing for them.

## Tests

```bash
npm test
```

## License

MIT
