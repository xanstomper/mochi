# Mochi Technical Architecture Blueprint

Mochi is designed as a dual-engine autonomous software engineering harness:
1. **Compiled Native Rust Core Runtime (`native/mochi_core`)**: Zero-dependency, high-throughput Rust engine for BPE tokenization, token budgeting, context compaction cut math, repo indexing, and atomic diff calculations.
2. **TypeScript TUI & Agent Frontend (`src/`)**: Event-driven orchestration layer managing model streaming, tool execution, terminal rendering, multi-agent swarms, MCP/ACP protocols, and SQLite state persistence.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          User Interface & Entrypoints                       │
│     Interactive TUI      │   Headless CLI   │   HTTP Daemon   │   ACP Server│
│     (src/tui/app.ts)     │   (src/cli.ts)   │ (src/daemon.ts) │ (src/acp.ts)│
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ user prompt / task DAG
┌──────────────────────────────────────▼──────────────────────────────────────┐
│                               Runtime Facade                                │
│                              (src/runtime.ts)                               │
│       Lifecycle Hooks  │  Git Checkpoints  │  Mode Management (spec/act)    │
└───────────────────┬──────────────────────────────────┬──────────────────────┘
                    │                                  │
┌───────────────────▼───────────────┐  ┌───────────────▼──────────────────────┐
│     Goal & Swarm Engine           │  │          Context Engine              │
│      (src/goals/goal.ts)          │  │         (src/context.ts)             │
│  - Task DAG Scheduler (FIFO/Dep)  │  │  - Active Goal & Token Budget Guard  │
│  - 16 Specialist Role Assigners   │  │  - Rules & Leaked Skills Injector    │
│  - Verifier & Autopsy Engine      │  │  - Session History & Distilled State │
└───────────────────┬───────────────┘  └───────────────┬──────────────────────┘
                    │                                  │
┌───────────────────▼──────────────────────────────────▼──────────────────────┐
│                               Agent Loop                                    │
│                           (src/agent/loop.ts)                               │
│        Preflight → Model Stream → Tool Dispatch → Verify → Recovery         │
└─────────┬─────────────────────────────────┬──────────────────────┬──────────┘
          │                                 │                      │
┌─────────▼───────────────┐     ┌───────────▼───────────┐   ┌──────▼──────────┐
│   Native Rust Core      │     │    Tool Bus & MCP     │   │   Model Router  │
│  (native/mochi_core)    │     │   (src/tools/index.ts)│   │(src/model/router│
│ - BPE Tokenizer (N-API) │     │ - 30+ Built-in Tools  │   │ - OpenCode / Zen│
│ - Compaction Cut Math   │     │ - External MCP Servers│   │ - OpenAI/Anthropic│
│ - N-API File Search     │     │ - Subagent Spawner    │   │ - 429 Failover  │
└─────────────────────────┘     └───────────────────────┘   └─────────────────┘
```

---

## 1. Core Architectural Subsystems

### A. Native Rust Core (`native/mochi_core`)
- **Language & Dependencies**: Pure Rust 2021 Edition, **0 external crates** (compiles in ~0.08s with zero network dependencies).
- **Inter-Process Interfaces**:
  1. **N-API Shared Library (`libmochi_core.so` / `mochi_core.node`)**: Direct in-memory C ABI bindings for microsecond token counting (`nativeCountTokens`), string truncation (`nativeTruncateToTokens`), and recursive workspace search (`nativeSearchDir`).
  2. **Stdio Line Protocol (`mochi-agent plan`)**: Lightweight JSON-line daemon interface for context compaction cut-point calculation (`plan_compaction_cut`) with zero GC overhead.

### B. Goal & Task Scheduler (`src/goals/`)
- **Decomposition**: Analyzes goals and maps them to directed acyclic graphs (DAGs) of tasks with explicit dependencies and acceptance criteria.
- **Role Assignment**: Maps tasks to the optimal specialist among 16 agent roles using regex-hinted keyword routing.
- **Verification Engine**: Independent verification pass before marking any task `done`.

### C. Agent Execution Loop (`src/agent/loop.ts`)
- **Preflight Phase**: Inspects repo language, framework, and git status.
- **Model Streaming Phase**: Streams LLM token deltas with live thinking-tag stripping (`<think>...</think>`), braille spinner animation, and token rate trackers.
- **Tool Dispatch Phase**: Validates schemas, enforces permission policies (`safe`/`ask`/`auto`), and runs tools with execution timers and read-cache deduplication.
- **Smart Failover & Backoff**: Automatically intercepts `429 Too Many Requests` or model outages, delays with exponential backoff, and fails over to backup model profiles.

### D. Session & State Persistence (`src/session-store.ts`, `src/workspace.ts`)
- **SQLite+FTS5 Store**: Persists session transcripts with full-text search indexing under `.mochi/sessions.sqlite`.
- **Durable Scoped Checkpoints**: Compaction summaries are isolated to active goals (`state/checkpoint.json`), preventing cross-session contamination.

---

## 2. Directory Layout

```
mochi/
├── native/
│   └── mochi_core/          # Pure Rust core crate (30+ modules, zero deps)
│       ├── Cargo.toml
│       └── src/
│           ├── lib.rs       # N-API entrypoint
│           ├── main.rs      # Standalone native agent CLI & stdio protocol
│           ├── napi.rs      # Hand-rolled zero-dep N-API bindings
│           ├── tokenizer.rs # BPE tokenizer
│           └── context.rs   # Compaction cut calculation
├── src/
│   ├── agent/               # Agent execution loop & failover
│   ├── agents/              # Profile parsing & dynamic role loader
│   ├── goals/               # Goal engine & task DAG scheduler
│   ├── mcp/                 # Model Context Protocol client & deepwiki server
│   ├── model/               # Provider routing, streaming, and failover
│   ├── native/              # TypeScript bridges for Rust N-API & binary
│   ├── teams/               # 16 agent roles & multi-agent swarms
│   ├── tools/               # 30+ native tools (edit, patch, shell, etc.)
│   ├── tui/                 # Terminal UI, view layer, and 15 themes
│   ├── cli.ts               # CLI command dispatcher
│   ├── context.ts           # Context engine & prompt assembler
│   ├── runtime.ts           # Public runtime facade
│   └── types.ts             # TypeScript type definitions
├── skills/                  # 30+ bundled SKILL.md guides
├── docs/                    # Architecture, benchmarks, and API documentation
└── package.json
```
