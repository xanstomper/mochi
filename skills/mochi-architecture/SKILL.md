---
name: mochi-architecture
description: Mochi internal architecture, dual Rust runtime core, 16 agent roles, tool suite, and orchestration design
---

# Mochi System Architecture & Engineering Protocol

Mochi is an autonomous, high-performance software engineering agent harness designed with a dual-engine architecture:

## 1. Dual-Engine Runtime Design

```
┌─────────────────────────────────────────────────────────────┐
│                    TypeScript Frontend                      │
│   (Model Streaming, 15 Themes, TUI View, MCP/ACP Protocol)  │
└──────────────────────────────┬──────────────────────────────┘
                               │ N-API / stdio JSON-lines
┌──────────────────────────────▼──────────────────────────────┐
│                  Native Rust Core Runtime                   │
│         (BPE Tokenizer, Compaction Math, Fast Indexer)      │
└─────────────────────────────────────────────────────────────┘
```

### A. Compiled Rust Core (`native/mochi_core`)
- Zero third-party dependencies; compiles in <0.1s using `cargo build --release`.
- **BPE Tokenization (`nativeCountTokens`)**: Sub-millisecond byte-pair encoding estimates.
- **Compaction Math (`plan_compaction_cut`)**: Calculates valid transcript cuts (never leaves dangling tool results) with zero GC pressure.
- **Native Workspace Indexing (`nativeSearchDir`)**: N-API C-ABI bindings for fast regex/substring file searching across 50,000+ files in ~3.8ms.

### B. TypeScript Orchestration Layer (`src/`)
- **Agent Loop (`src/agent/loop.ts`)**: Preflight → Model Stream → Tool Dispatch → Verify → Recovery.
- **Task DAG Scheduler (`src/goals/scheduler.ts`)**: Manages dependency-aware task graphs and parallel agent execution.
- **Context Engine (`src/context.ts`)**: Assembles surgical token-budgeted prompts, loads project rules, and prunes stale history.
- **Session Persistence (`src/session-store.ts`)**: SQLite+FTS5 full-text indexed session storage.

---

## 2. The 16 Specialized Subagents

Mochi dynamically dispatches tasks across 16 specialized agent roles:
1. **`lead`**: Decomposes complex goals, coordinates swarms, evaluates outputs.
2. **`coder`**: Writes surgical code changes, runs compiler & test suite verifications.
3. **`reviewer`**: Read-only diff inspector, SOLID/DRY auditor, regression catcher.
4. **`tester`**: Writes unit/integration tests and headless bug reproduction scripts.
5. **`researcher`**: Read-only AST inspector (`get_function`, `find_callers`), web search & crawling.
6. **`debugger`**: Root-cause diagnostic specialist, hypothesis testing, telemetry injection.
7. **`security`**: OWASP Top 10 auditor, data-flow threat modeler, CVE checker.
8. **`architect`**: API contract designer, schema definer, system boundary validator.
9. **`devops`**: Docker, Kubernetes, CI/CD pipelines (GitHub Actions), Terraform.
10. **`db_admin`**: SQL migrations, normalized schemas, query plan optimization.
11. **`frontend`**: React/Vue/Svelte, CSS Grid/Tailwind, responsive design, a11y.
12. **`backend`**: RESTful/GraphQL/gRPC APIs, concurrency, distributed locking.
13. **`performance`**: CPU hotspot profiling, memory leak detection, Big-O optimization.
14. **`tech_writer`**: Architecture Decision Records (ADRs), READMEs, Mermaid diagrams.
15. **`qa_engineer`**: End-to-end automation (Playwright/Cypress), visual regression.
16. **`data_scientist`**: Pandas/Polars wrangling, PyTorch/TensorFlow modeling, analytics.

---

## 3. Tool Dispatch & Operating Rules

1. **Information Density**: Batch independent tool calls in parallel. Do not read entire files when symbol lookup (`get_function`) or targeted search will suffice.
2. **Surgical Modifications**: Prefer `edit` or `patch` over full-file rewrites.
3. **Verification First**: Never mark a task complete without executing a concrete verification command.
4. **Zero-Chatter**: Keep user-facing explanations minimal, concise, and direct. Reason internally.