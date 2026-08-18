# Mochi

> Minimal, fast, autonomous coding agent for the terminal.

Mochi is a from-scratch re-imagining of the terminal coding-agent harness. It keeps the best ideas from Pi (tools, sessions, context files, minimal TUI) and adds first-class support for goals, task DAGs, teams, persistent state, checkpoints, verification, recovery, budgets, hooks, retrieval, memory, and local harness learning.

## Status

Implemented:

- Event bus architecture
- Model-agnostic OpenAI-compatible provider with OpenCode aliases
- Model routing by capability profile (`fast` / `coding` / `reasoning` / `review`)
- Budget-aware model fallback
- Tool bus: `read`, `write`, `edit`, `delete`, `shell`, `search`, `glob`, `git`, `inspect`, `memory`
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
    }
  },
  "safety": {
    "mode": "ask",
    "maxIterations": 50,
    "maxConcurrentAgents": 3,
    "contextBudgetTokens": 120000,
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
  }
}
```

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

Mochi is a Node 22 TypeScript harness with **zero runtime dependencies**. Cold start and peak
RSS are measured by `bench/efficiency.mjs` (`npm run bench:efficiency`), and the CLI runs
unmodified under Bun for a lower footprint (useful on low-RAM, hardware-friendly boxes):

```text
mochi (node)  ~55ms / ~47MB
mochi (bun)   ~50ms / ~41MB
```

Long agent runs also avoid repeated disk work: project rules and project memory are
fingerprint-cached per iteration (see `src/context.ts`), so a multi-hundred-iteration task
isn't re-reading `MOCHI.md`/`AGENTS.md`/memory from disk on every model call.

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

## Tests

```bash
npm test
```

## License

MIT
