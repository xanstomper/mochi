<div align="center">

<img src="docs/mochi-mascot.png" alt="Mochi mascot" width="420"/>

# Mochi

### *Minimal Orchestrative Coding Harness Intelligence*

**A minimal, fast, autonomous coding agent for the terminal.**

Goals · Task DAGs · Multi-agent Teams · Persistent Daemon · Deep Run Traces · Rust Native Core

[![Version](https://img.shields.io/badge/version-0.27.0-8b5cf6?style=for-the-badge&labelColor=1c1233)](https://github.com/xanstomper/mochi/releases)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=0d1f12)](https://nodejs.org)
[![Rust Core](https://img.shields.io/badge/core-rust--native-dea584?style=for-the-badge&logo=rust&logoColor=white&labelColor=2b1a0e)](native/mochi_core)
[![Tests](https://img.shields.io/badge/tests-2821%20passing-3fb950?style=for-the-badge&labelColor=0e2415)](#testing)
[![Deps](https://img.shields.io/badge/runtime%20deps-0-cf222e?style=for-the-badge&labelColor=2b0d0d)](#architecture)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge&labelColor=0d1b2e)](LICENSE)
[![CI](https://img.shields.io/badge/CI-linux%20%C2%B7%20macOS%20%C2%B7%20windows-2094d3?style=for-the-badge&logo=githubactions&logoColor=white&labelColor=0a1d2b)](https://github.com/xanstomper/mochi/actions)

[![Get Started](https://img.shields.io/badge/Quick_Start-8b5cf6?style=for-the-badge&labelColor=1c1233)](#quick-start)
[![Docs](https://img.shields.io/badge/Documentation-2563eb?style=for-the-badge&logo=gitbook&logoColor=white&labelColor=0d1b3e)](docs/ARCHITECTURE.md)
[![Benchmarks](https://img.shields.io/badge/Benchmarks-f59e0b?style=for-the-badge&logo=speedtestbyookla&logoColor=white&labelColor=2e1e05)](docs/BENCHMARKS.md)
[![CLI](https://img.shields.io/badge/CLI_Reference-10b981?style=for-the-badge&logo=terminal&logoColor=white&labelColor=05291c)](docs/CLI_REFERENCE.md)
[![Changelog](https://img.shields.io/badge/Changelog-a855f7?style=for-the-badge&logo=keepachangelog&logoColor=white&labelColor=2a1140)](CHANGELOG.md)
[![Issues](https://img.shields.io/badge/Report_a_Bug-da3633?style=for-the-badge&logo=github&logoColor=white&labelColor=2d0b0a)](https://github.com/xanstomper/mochi/issues)

---

</div>

Mochi is a from-scratch re-imagining of the terminal coding-agent harness. It keeps the best ideas from Pi (tools, sessions, context files, minimal TUI) and adds first-class support for **goals, task DAGs, teams, persistent state, checkpoints, verification, recovery, budgets, hooks, retrieval, memory, and local harness learning** — all on a **zero-dependency Rust runtime core** with a TypeScript frontend.

```bash
mochi "add a rate limiter to the auth service"   # one-shot agent run
mochi daemon start --host 0.0.0.0                # persistent agent over HTTP
mochi daemon send "finish the auth flow"         # drive it from anywhere
mochi team "ship the payments refactor"          # role-diverse agent team
mochi trace <goalId>                             # replay any run end to end
```

Zero runtime JS dependencies. Runs under **Node 22** or **Bun**, and ships a standalone native binary (`npm run build:bin`) that needs no runtime at all. The performance core is a zero-dependency Rust crate (`native/mochi_core`): tokenization, budget math, context compaction planning, and agent-loop decisions run natively — every native path has a parity-tested TypeScript fallback, so nothing breaks when the Rust binary is absent (CI, cold installs). The harness is polyglot: an 18-ecosystem repo detector, a 10-language tree-sitter codegraph, and native Rust/C++ accelerators in the `edit`/`patch` hot paths.

<div align="center">

---

**[Website](https://xanstomper.github.io/mochi)** · **[Documentation](docs/ARCHITECTURE.md)** · **[Benchmarks](docs/BENCHMARKS.md)** · **[CLI Reference](docs/CLI_REFERENCE.md)** · **[TECHMAP](TECHMAP.md)** · **[Changelog](CHANGELOG.md)**

---

</div>

## Table of Contents

- [Why Mochi](#why-mochi)
- [Performance Highlights](#performance-highlights)
- [Quick Start](#quick-start)
- [CLI Command Reference](#cli-command-reference)
- [Comprehensive Documentation](#comprehensive-documentation)
- [Architecture](#architecture)
- [The Agent Loop](#the-agent-loop)
- [Rust Native Core](#rust-native-core)
- [Configuration](#configuration)
- [Environment Variables](#environment-variables)
- [Safety, Permissions, and Sandboxing](#safety-permissions-and-sandboxing)
- [Plan-then-Act Mode](#plan-then-act-mode)
- [Execution Modes](#execution-modes)
- [Agent Profiles](#agent-profiles)
- [Teams](#teams)
- [Hooks](#hooks)
- [Project Memory](#project-memory)
- [Model Routing, Failover, and Escalation](#model-routing-failover-and-escalation)
- [Rate Throttling for Concurrent Agents](#rate-throttling-for-concurrent-agents)
- [MCP Servers](#mcp-servers)
- [Daemon (Persistent Agent over HTTP)](#daemon-persistent-agent-over-http)
- [Editor Integration (ACP)](#editor-integration-acp)
- [Interactive TUI](#interactive-tui)
- [Interactive Commands](#interactive-commands)
- [Integrations](#integrations)
- [Symbol Graph Backends](#symbol-graph-backends)
- [Light Mode](#light-mode)
- [Run Traces](#run-traces)
- [Sessions](#sessions)
- [Checkpoints and Rollback](#checkpoints-and-rollback)
- [Skills](#skills)
- [Daemon Cron (Scheduled Jobs)](#daemon-cron-scheduled-jobs)
- [Building](#building)
- [Testing](#testing)
- [Benchmarks](#benchmarks)
- [Project Layout](#project-layout)
- [Design Principles](#design-principles)
- [Contributing](#contributing)
- [License](#license)

---

## Demo

From your shell to a working answer in one command:

<table>
<tr>
<td align="center"><img src="docs/assets/demo/tui_demo.gif" alt="mochi: shell -> TUI -> hello -> answer" width="720"></td>
</tr>
</table>

The terminal types `mochi`, the TUI launches, `hello` goes in — spinner, thinking bar, response, token stats. All of it real.

**And a full build, end to end** — `code me a snake game`: splash boot, agent plans, writes 4 files (snake-core.js, game.js, index.html, styles.css), and reports back with how to run it:


*Note TUI may have issues in gif due to automated headless gif recording rendering issues, it will look normal when using*

<table>
<tr>
<td align="center"><img src="docs/assets/demo/tui_snake.gif" alt="mochi: code me a snake game — full agent build" width="720"></td>
</tr>
</table>


## Why Mochi

Most terminal agents are either thin wrappers around one model call, or heavyweight platforms that need a cloud account. Mochi takes a third path: a **complete harness** — every loop, guard, budget, and recovery path owned in-repo — that is deliberately *minimal* in surface and *maximal* in verified behavior.

| | What that means in practice |
|---|---|
| **Autonomous by default** | Give it a goal; it plans, executes, verifies, recovers, and reports. `--auto` for hands-off, `--plan` for read-only research. |
| **Verified work, not vibes** | Every task runs through verification gates: baseline comparison so pre-existing repo debt doesn't fail correct work, proportionate auto-detected test runs, diff-hygiene and self-review gates, and rule-based BLOCK on unverified changes — goal/DAG tasks additionally get an independent verifier and a model outcome judge. |
| **Honest accounting** | Budgets on tokens, cost, wall time, tool calls, model calls, and agent count. Structured stop reasons (`completed` / `aborted` / `runtime_limit` / `budget` / `model_error`) on every run. |
| **Recovery is a first-class path** | Failover across providers, key-pool rotation, model auto-escalation after repeated verification failures, warm-start resume with prior transcript injection, and local learning of successful recovery strategies. |
| **The model sees its own struggles** | The harness detects consecutive tool errors, repeated identical results, empty responses, and verification loops — and injects a STRUGGLE STATE + escape-plan directive into the model's own prompt before the next move. |
| **Fast and tiny** | 11.2 ms time-to-first-frame, 18.2 MB PSS for a single session, 0.12 ms compaction-cut calculation from the Rust core. Numbers below, methodology in [docs/BENCHMARKS.md](docs/BENCHMARKS.md). |
| **Yours, locally** | No cloud account, no telemetry dependency. Works with any OpenAI-compatible endpoint, Anthropic, and Gemini. State lives in your project's `.mochi/`. |

## Performance Highlights

<div align="center">

**Reproducible cross-harness matrix** — `bench/cli-matrix.mjs` measures cold-start wall time and kernel peak RSS for every installed coding-agent CLI (`--version`, N runs, p50/mean).

</div>

| Benchmark Metric | Mochi (Rust Core) | jcode | Cursor Agent | Claude Code | OpenCode |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **1 Active Session (PSS)** | **18.2 MB** [1st] | 27.8 MB | 214.9 MB | 386.6 MB | 371.5 MB |
| **10 Active Sessions (PSS)** | **84.5 MB** [1st] | 117.0 MB | 1632.4 MB | 2300.6 MB | 3237.2 MB |
| **Time to First Frame (TTFF)** | **11.2 ms** [1st] | 14.0 ms | 1949.7 ms | 3436.9 ms | 1035.9 ms |
| **Time to First Input (TTFI)** | **38.2 ms** [1st] | 48.7 ms | 1978.7 ms | 3512.8 ms | 1047.9 ms |
| **Compaction Cut Calculation** | **0.12 ms** (Rust) [1st] | 0.45 ms | 14.5 ms | 35.0 ms | 19.8 ms |

<div align="center">

Full methodology, PTY probe scripts, and the 9-agent comparison tables live in **[docs/BENCHMARKS.md](docs/BENCHMARKS.md)**.

Multi-round arena (6 standardized tasks, same model, same backend):

<br/>

[![Mochi 12/12](https://img.shields.io/badge/Mochi-12%2F12%20PASS%20%C2%B7%2021.7s%20median-3fb950?style=for-the-badge&labelColor=0e2415)](docs/BENCHMARKS.md)
[![jcode 11/12](https://img.shields.io/badge/jcode-11%2F12%20%C2%B7%2010.0s-8b949e?style=for-the-badge&labelColor=1c1f24)](docs/BENCHMARKS.md)

*The only harness with a perfect multi-round record in the comparison set. Token cost: ~15–21 K input / 0.8–3.7 K output per task.*

</div>

## Quick Start

Requires Node 22+ (or Bun). No other toolchain needed — the Rust core ships as prebuilt binaries with a pure-TS fallback.

**1 · Build**

```bash
git clone https://github.com/xanstomper/mochi.git
cd mochi
npm install
npm run build
```

**2 · Link globally (optional)**

```bash
ln -s $(pwd)/dist/cli.js ~/.local/bin/mochi
```

**3 · Set an API key** (any OpenAI-compatible endpoint)

```bash
export Anthropic=sk-...
```

**4 · Run**

```bash
mochi                                   # interactive TUI
mochi -p "list all TypeScript files"    # one-shot, print and exit
mochi plan "refactor authentication"    # plan only, no edits
mochi goal "fix all failing tests"      # autonomous goal
mochi team "build a REST API for users" # multi-agent team
mochi inspect "SessionManager"          # inspect a symbol or subsystem
mochi speculate "difficult TS2345"      # speculative reasoning
mochi term                              # own terminal window (190x45, black bg)
mochi term --geometry 100x30 -- goal "fix auth"
eval "$(mochi completion bash)"         # shell completions (bash|zsh|fish)
```

```bash
curl -fsSL https://raw.githubusercontent.com/xanstomper/mochi/main/install.sh | bash
# then: mochi onboard
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/xanstomper/mochi/main/install.ps1 | iex
```

No Node.js needed — the installer fetches a standalone binary for your OS from the [releases page](https://github.com/xanstomper/mochi/releases) and puts `mochi` on your PATH (with a from-source fallback when no binary matches). Details and uninstall: `docs/INSTALL.md`.

### Install via npm

```bash
npm install -g @mochi/agent
```

### Run via Docker

Containerized API + OpenAI-compatible server (healthcheck on `/api/health`, token printed on start):

```bash
docker build -t mochi .
docker run --rm -p 8787:8787 -v "$PWD:/workspace" -w /workspace mochi
```

### Prebuilt native binary

For deployments where even Node/Bun aren't guaranteed, compile Mochi into a single self-contained executable. The binary embeds the runtime and all modules — no `node_modules`, no runtime install:

```bash
npm run build:bin   # produces ./dist/mochi-bin (Bun required)
./dist/mochi-bin --version
```

Fully functional end to end (agent loop, tools, config, workspaces); drop it onto a low-spec or headless box as-is. The compiled binary also ships via [GitHub Releases](https://github.com/xanstomper/mochi/releases).

## CLI Command Reference

`mochi --help` is self-documenting and version-pinned; shell completions are generated from the same command table (a test fails if any command lacks completion coverage). Full flag-by-flag reference: [docs/CLI_REFERENCE.md](docs/CLI_REFERENCE.md).

| Command | Purpose |
|---|---|
| `mochi ["prompt"]` | Interactive TUI, or one-shot prompt with `-p` |
| `mochi goal "..."` | Autonomous goal with task decomposition and DAG scheduling |
| `mochi team "..."` | Role-diverse multi-agent team run |
| `mochi plan "..."` | Plan-then-act: research and return a plan, no edits |
| `mochi resume` | Warm-start resume of the last interrupted session |
| `mochi checkpoint save/list/restore` | Named git snapshots and rollback |
| `mochi rollback [<name>]` | Roll back to the last or a named checkpoint |
| `mochi trace [<goalId>]` | Replay any run end to end from its JSONL trace |
| `mochi session list / search "..."` | Full-text search across past transcripts |
| `mochi inspect "<query>"` | Symbol / subsystem inspection via the codegraph |
| `mochi speculate "<question>"` | Speculative reasoning pass on a hard question |
| `mochi mode <normal\|spec\|security\|codemod\|chaos>` | Execution mode |
| `mochi reasoning [low\|med\|high\|max]` | View or set reasoning depth |
| `mochi rules [list\|add]` | Modular project rules |
| `mochi bg [list\|logs\|kill]` | Async background task management |
| `mochi review [--strict] [--json] [--diff-only]` | AI code review of the git diff |
| `mochi fix [--auto-commit]` | Feed a crash log, get a fix |
| `mochi security` / `mochi audit` | Static security and credential audit |
| `mochi docgen [--write]` | Architecture diagram + API reference generation |
| `mochi daemon start/status/jobs/send/approve/resume/rotate/cron/restart/stop` | Persistent HTTP agent service |
| `mochi acp` | Agent Client Protocol server for editors |
| `mochi connectors [status]` | List messaging gateways (aliases: `gateways`/`channels`/`platforms`) |
| `mochi discord run` / `mochi telegram run` / `mochi slack run` / `mochi bluebubbles run` | Messaging gateways (Discord, Telegram, Slack, iMessage via BlueBubbles) |
| `mochi interop claude [--dry-run]` | Import Claude Code hooks, agents, and commands |
| `mochi dashboard` / `mochi web` | Web dashboard |
| `mochi plugin add/remove/list` | Plugin registry |
| `mochi goal "<objective>" --enhance [--mode <mode>]` | Inject Chameleon reasoning enhancement into a goal/team run |
| `mochi termix ["<task>"] [--coms\|--sep] [--sessions N]` | Multi-session split panes |
| `mochi term [--title T] [--geometry CxR]` | Dedicated native terminal window |
| `mochi workspace create/list/switch` | Multiple workspaces |
| `mochi profiles` | List agent profiles |
| `mochi memory` | Inspect project memory |
| `mochi skills pack/unpack` | Bundle and install skill packs |
| `mochi mcp search/add` | Discover and install MCP servers |
| `mochi completion <bash\|zsh\|fish>` | Shell completion script |
| `mochi doctor` | Self-inspect the full harness |
| `mochi self-train [N] [focus]` | Cycles of self-review + skill curation |
| `mochi gate run\|baseline\|freeze\|check` | Frozen regression gate: hash-pinned task set + independent diff analyser for harness changes |
| `mochi sleeptime [--cap <usd>] [--dry-run]` | Nightly consolidation pipeline (skill repair, curator, gate, curriculum) under a hard spend cap |
| `mochi perf` | Stream-pipeline micro-benchmarks |

## Comprehensive Documentation

- **[Technical Architecture Blueprint](docs/ARCHITECTURE.md)** — deep dive into the dual-engine Rust Core + TypeScript TUI architecture, compaction protocols, and event loops. Auto-generated coverage of 298 modules / 3105 symbols via `mochi docgen`.
- **[Complete Capabilities Reference](docs/CAPABILITIES.md)** — the 17 specialized agent roles, 81 native tools, 150 skills, and MCP/ACP protocols.
- **[Empirical Benchmarks](docs/BENCHMARKS.md)** — standardized PSS memory, TTFF, TTFI, and compaction latency vs jcode, Claude Code, Cursor, Copilot, and OpenCode, with reproducible probe scripts.
- **[CLI & Interface Reference](docs/CLI_REFERENCE.md)** — complete flags, daemon endpoints, slash commands, and keybindings.
- **[Editor Integrations](docs/EDITORS.md)** — VS Code, Cursor, JetBrains, Zed, Neovim, Claude Desktop via MCP/ACP stdio servers.
- **[TECHMAP.md](TECHMAP.md)** — every repo path mapped, nothing mystery-meat.
- **[MOCHI.md](MOCHI.md)** — project conventions for agents working *in* this repo.

## Architecture

Two engines, one process: a **zero-dependency Rust crate** for per-byte compute and a **TypeScript frontend** for everything that touches the outside world (model I/O, TUI, tools). Every Rust path has a parity-tested TS fallback engaged automatically when the native binary is absent.

```text
Mochi
├── Runtime
│   ├── Config / Workspace / EventBus / HookManager / GoalEngine
├── Goals
│   ├── Persistent goal state
│   ├── Task DAG + Scheduler
│   └── Decomposition via model
├── Teams
│   ├── Dynamic agent spawning
│   ├── Agent profiles
│   └── Role-based model selection
├── Agent Loop
│   ├── ContextEngine (token budget, compaction, freshness)
│   ├── RetrievalEngine (files, symbols, references, git history)
│   ├── Model provider / router / failover
│   ├── Tool bus (81 tools, tiered advertising)
│   ├── BudgetEngine
│   └── Verification / Recovery / Pulse
├── Memory
│   ├── Curated project facts
│   └── Local recovery learning
├── Performance Pipeline
│   ├── Incremental stream parser
│   ├── FastEventBus
│   ├── Batched state store
│   ├── Dirty-region renderer
│   └── Measured frame budget
├── native/mochi_core        ← Rust: zero-dep, prebuilt + TS fallback
└── CLI / TUI                ← TypeScript entrypoints
```

### Source organization

`src/` is organized topically — `model/`, `stream/`, `memory/`, `skills/`, `state/`, `security/`, `daemon/`, `repo/`, `observability/`, `core/`, `tools/`, `tui/` — with the root holding entrypoints only. `mochi docgen` regenerates the architecture graph and API reference from the tree.

## The Agent Loop

The runtime loop is `preflight → model → tools → verify → recover → pulse`, with every stage owned in-repo:

1. **Preflight** — context packet built in ~325 ms cold (batched binary probing, fingerprint-cached rules/memory so multi-hundred-iteration tasks don't re-read disk every call).
2. **Model** — tiered tool advertising (21 lean tools / ~3K tokens on the first call, 7 for chat, 16 for research, 65 on demand via `load_tools` recovery), speculative preflight on hard tasks, streaming with mid-stream Ctrl-C abort on the wire.
3. **Tools** — 81 tools through a permission-gated bus; every shell command risk-classified (17 destructive + 16 network patterns); output folded head/tail through the Rust core; secrets redacted on every output, trace line, and disk write.
4. **Verify** — baseline + proportionate verification (goal-engine tasks add the independent verifier and outcome judge with rule-based veto on contradictory PASSes).
5. **Recover** — provider failover, key rotation, model auto-escalation, checkpoint/rollback, warm-start resume.
6. **Pulse / Struggle injection** — consecutive tool errors, repeated identical tool results (3+ reads of the same content), empty responses, and verification loops are surfaced to the model as a STRUGGLE STATE system message plus an escape-plan directive, so a struggling model never starts its next turn blind to its own failure history. Healthy runs pay nothing (zero-cost no-op).

## Rust Native Core

`native/mochi_core` is a zero-dependency crate (empty `[dependencies]` — a load-bearing constraint that keeps the static binary tiny). Ported hot paths:

| Op | What it does |
|---|---|
| `estimateTokens` / `countTokens` | Token estimation; batched whole-history counting over the stdio daemon |
| `skeletonizeSource` | Per-byte source compaction |
| `diffNumstat` | Diff statistics |
| `redactSecrets` | 10-pattern secret redaction as a hand-rolled byte-scanner DFA (sk-, AIza, GitHub PATs ×5, JWT, Bearer, AKIA, xox, glpat, private keys) |
| `budgetDecide` | Per-turn budget phase (exhausted → verify → cheap → reduced → full) |
| `classifyCommand` | Shell-command risk classification (destructive + network patterns, word-boundary aware) |
| `foldOutput` | Tool-output head/tail line selection |
| `stripAnsi` | Full ECMA-48 CSI stripping (0x40–0x7E terminators) |
| `commandAvailable` | Batched which-style binary probes |
| `estimateCostUsd` | Model cost math with free-tier short-circuit |
| `searchDir` | Directory search |

Each op follows the same proven template: zero-dep Rust module → Rust unit tests → `lib.rs` C-ABI export → `napi.rs` JS binding (routed through the C-ABI as single source of truth) → TS wrapper (`core.ts`) with N-API + Bun FFI dual surface → caller-side native-first with TS fallback → differential parity tests (including adversarial cases: braces inside tool args, UTF-8 around keys, idempotency).

<details>
<summary><strong>Build the native core yourself</strong></summary>

```bash
npm run build:native   # or: cd native/mochi_core && cargo build --release
# artifacts: mochi-agent (~440KB, stdio daemon, 2MB RSS) + libmochi_core.so (~452KB)
```

The stdio daemon is verified end to end: `echo '{"op":"ping"}' | ./native/bin/mochi-agent plan`.

</details>

**FFI honesty note (measured, do not re-learn):** for *cheap* ops the FFI round-trip is ~80× slower than pure TS (call overhead dominates). Native wins on heavy per-byte work and resident memory — the selection rule is *only port ops whose result is small relative to their input*. Bulk-text ops stay in TS on purpose.

## Configuration

Global: `~/.config/mochi/config.json` · Project: `.mochi/config.json`

```json
{
  "model": {
    "provider": "opencode-zen",
    "apiKey": "sk-...",
    "model": "opencode/deepseek-v4-flash-free",
    "profiles": {
      "fast": "opencode/deepseek-v4-flash-free",
      "coding": "opencode/deepseek-v4-flash-free",
      "reasoning": "opencode/deepseek-v4-flash",
      "review": "opencode/deepseek-v4-flash"
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
    "maxToolCalls": 200,
    "sandbox": "off"
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

> **Speculative preflight** (`model.speculative.preflight: true`): for hard non-chat tasks, Mochi runs a cheap speculative pass before the main loop call and injects the chosen approach + alternatives as a system hint, so the model commits to a better plan before firing tools. `selfCritique: true` reinforces the failure-repair flow on the first verification miss. Both are opt-in and never block the task — a failed or skipped preflight degrades to a normal run.

## Environment Variables

| Variable | Effect |
|---|---|
| `MOCHI_YOLO=1` | Auto-approve everything (same as `--yolo`) |
| `MOCHI_SAFETY=auto` | Safety mode override (`safe\|ask\|auto\|uncensored`) |
| `MOCHI_SANDBOX=auto` | Bubblewrap isolation when available (`off\|auto\|bubblewrap`) |
| `MOCHI_REASONING=max` | Reasoning depth override |
| `MOCHI_RATE_LIMIT_RPM=20` | Leaky-bucket request-rate cap |
| `MOCHI_RATE_LIMIT_CONCURRENCY=3` | Concurrent in-flight request cap |
| `MOCHI_CPG_BACKEND=tree-sitter` | Tree-sitter symbol-graph backend (falls back to TS-AST) |
| `MOCHI_LIGHT=1` | Disable embedded SQLite index + WASM parser |
| `FREEINFERENCE_API_KEY=...` | Provider key (or any OpenAI-compatible env) |

**41 built-in providers** — OpenAI, Anthropic, Gemini, Google Antigravity, DeepSeek, OpenRouter, Groq, Mistral, xAI, Together, Fireworks, Cerebras, Azure, AWS Bedrock, GitHub Models, DeepInfra, Cloudflare Workers AI, HuggingFace, Perplexity, SambaNova, SiliconFlow, Moonshot/Kimi, MiniMax, Zhipu, Z.AI, Cohere, Alibaba Qwen, Upstage/Solar, Nebius, Novita, AI21/Jamba, Ollama, LM Studio, llama.cpp, OpenCode Zen, OpenCode Go, FreeInference, TokenJuice, OpenAI Codex, ClinePass, Kilo Code — all with failover, key-pool rotation, and capability-tier routing. Adding one is a single registry entry plus tests (see the `provider-registration` skill).

Unknown values for `MOCHI_SAFETY` / `MOCHI_SANDBOX` / `MOCHI_REASONING` warn at startup rather than being silently ignored.

## Safety, Permissions, and Sandboxing

- **Permission system** — `safe` / `ask` / `auto` per action class; `gitDestructive` gated separately.
- **Central exec policy** — every subprocess (shell tool, verification, hooks, cron notify) goes through one policy: timeout → SIGTERM → SIGKILL, output caps, argv-vs-shell discipline, and an audit hook.
- **Command risk classification** — every shell call runs through the native risk gate before execution.
- **Secret redaction** — 10-pattern DFA runs on every tool output, trace line, and disk write. Traces are safe to share.
- **Sandboxing** — opt-in bubblewrap isolation (`safety.sandbox`): read-only root, writable cwd/tmp/dev-caches, optional `--unshare-net`. Surfaced in `mochi doctor`.
- **Daemon security** — bearer-token auth, `daemon rotate` kills the old token immediately, binds to `127.0.0.1` by default.

## Plan-then-Act Mode

Set `"planMode": true` or pass `--plan` on any run: every agent researches with read-only tools and returns a plan (steps, files, risks, verification). Mutating tools (`write` / `edit` / `delete` / `shell`) are vetoed, the model is redirected to produce the plan, and no files change. In the TUI, Tab toggles plan/act inline in the composer hint row.

## Execution Modes

`mochi mode <mode>` sets the harness posture:

| Mode | Use for |
|---|---|
| `normal` | Everyday coding |
| `spec` | Speculative multi-pass reasoning |
| `security` | Security-sensitive review and audit |
| `codemod` | Large mechanical rewrites |
| `chaos` | Adversarial robustness testing |

## Agent Profiles

Lightweight role definitions in `.mochi/agents/`:

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

## Teams

`mochi team "..."` spawns a role-diverse set of agents (architect, implementer, reviewer, verifier — 17 specialized roles available) sharing one budget and workspace, coordinating through the task DAG. Each role can route to a different configured model tier.

## Hooks

Create `.mochi/hooks.json`:

```json
{
  "before_shell": "echo running command",
  "after_edit": "npm test",
  "before_goal": "true"
}
```

All 17 hook lifecycle points (`before_*`, `after_*`, `on_*`) are pinned by a static test that fails on any future hook name without a call site. A failing `before_*` hook vetoes the action; `after_*` hooks observe completed actions. Hook subprocesses run under the central exec policy (timeout → SIGKILL, output cap).

## Project Memory

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

Agents add durable facts through the `memory` tool. Conversation history is never dumped into memory. Project rules (`mochi rules add`) and memory are fingerprint-cached per iteration.

## Model Routing, Failover, and Escalation

- **Capability-profile routing** — `fast` / `coding` / `reasoning` / `review` tiers map to different configured models per task type (`classifyTaskTier` is wired into provider selection).
- **Provider failover** — transient failures (429 / 5xx / timeout) retry with exponential backoff honoring `Retry-After`; credential pools rotate multi-key on 401 / 429 / 403; empty responses escalate fast (2 blanks → switch model, 3 → switch provider).
- **Model auto-escalation** — after 3 consecutive verification failures the task hands one tier up (fast → coding → reasoning) to a *different configured* model, once per task, with an explicit handoff note. Free models attempt first, stronger models rescue stuck work.
- **Prompt caching** — stable system prompt ships as a single `cache_control: ephemeral` block on Anthropic (and the OpenAI equivalent), so it isn't rebilled every turn.
- **Vision everywhere** — data-URI and remote-URL images map to native parts on OpenAI, Anthropic (base64 blocks), and Gemini (inlineData).

## Rate Throttling for Concurrent Agents

Every model call retries transient failures, but when several processes or sub-agents share **one free-tier endpoint** they can trip limits faster than retries recover. An opt-in leaky-bucket throttle sits ahead of the wire so concurrent agents self-regulate their collective burst:

```bash
MOCHI_RATE_LIMIT_RPM=10 mochi "..."                # ~10 calls/minute
MOCHI_RATE_LIMIT_CONCURRENCY=2 mochi "..."         # max 2 in-flight
MOCHI_RATE_LIMIT_RPM=20 MOCHI_RATE_LIMIT_CONCURRENCY=3 mochi daemon start
```

The bucket only delays up to the configured refill pace and is a no-op when neither variable is set.

## MCP Servers

`mcpServers` entries are stdio MCP servers (spawned per run) or HTTP servers (`{ "url": "https://…", "headers": {...} }` for Streamable-HTTP). Each handshakes over JSON-RPC and its tools register natively as `serverName__toolName` with `network` permission. Failed servers are logged and skipped; a crashed server rejects its pending calls instead of hanging the run. Servers exposing MCP **resources** also get `serverName__resources_list` / `serverName__resources_read` tools.

Skip the JSON hand-editing (24 built-in servers: filesystem, GitHub, Postgres, Brave, Playwright, Context7, Tavily, Firecrawl, Exa, Supabase, Neon, Kubernetes, and more):

```bash
mochi mcp search <keywords>    # discover servers (also /mcp search in the TUI)
mochi mcp add <server-id>      # write .mcp.json for you
mochi mcp test [id]            # live handshake check before you rely on it
```

OAuth for servers needing bearer tokens uses pre-registered client credentials (no browser flow) — `${ENV}` refs keep secrets out of the file; tokens cache under `~/.mochi/mcp-oauth.json` (0600) and refresh automatically.

## Daemon (Persistent Agent over HTTP)

Run Mochi as a background service and drive it from anything — scripts, phone, a Discord gateway, a dashboard:

```bash
mochi daemon start --port 8642 --token sekret   # serve on localhost:8642
mochi daemon status                             # is it up? jobs running?
mochi daemon jobs                               # list persisted goals + status
mochi daemon send "finish the auth flow"        # enqueue a goal
mochi daemon approve                            # approve queued shell commands (safe mode)
mochi daemon resume <goalId>                    # resume a persisted goal over HTTP
mochi daemon rotate                             # fresh token; old one dies immediately
mochi daemon restart                            # stop + start on the same port
mochi daemon stop
```

HTTP surface (auth via `Authorization: Bearer ***`): `POST /api/goal {objective}`, `POST /api/status`, `POST /api/jobs`, `POST /api/plan`, `POST /api/approve`, `POST /api/resume {goalId}`, `POST /api/inspect {query}`. Goals persist across daemon restarts — a goal created by one instance can be resumed by a fresh one via `/api/resume`, so interrupted or failed work survives daemon shutdown.

By default the daemon binds to `127.0.0.1` only. For LAN access bind explicitly and keep the token secret; prefer a tunnel over a raw public bind:

```bash
mochi daemon start --host 0.0.0.0 --port 8642 --token sekret
ssh -R 8649:localhost:8649 your-server   # internet via reverse tunnel
```

## Editor Integration (ACP)

`mochi acp` starts an Agent Client Protocol v1 server over JSON-RPC stdio, so ACP-capable editors (VS Code, Zed, JetBrains) can drive Mochi natively:

```bash
mochi acp   # spawn as an editor subprocess; ACP v1 on stdin/stdout
```

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

Streaming updates (`session/update`): `tool_call`, `tool_call_update`, `agent_message_chunk`, `usage_update`, `plan`. Prompts accept ACP `ContentBlock[]` payloads; each run returns a `stopReason`.

## Interactive TUI

A minimal, fast, keyboard-first interface built on a measured frame budget:

- **Multi-tab sessions** — opencode-style pill tabs with a clickable `+ New session` button; `Alt+T` new, `Alt+W` close, `Alt+1-8` switch, `/tab` commands. Each tab is an isolated runtime (own abort/session/budget); background runs continue and badge unread.
- **Themes** — 12+ styles including signature **Mochi Purple** (default): crisp white + violet on near-black purple surfaces. Dark themes paint every row over pure black (terminal-profile gray can never show through; SGR tint leaks killed by the frame-level leak guard). Light themes and `NO_COLOR` stay transparent.
- **Streaming transcript** — dirty-region rendering; no high-frequency event causes full-state propagation or full-tree rendering.
- **Plan/act toggle** — inline in the composer hint row: `● Plan · Enter send · Tab plan/act · ESC stop · / for commands`.
- **Live meters** — context bar, token counts, model gauges with track colors that read correctly on black and light themes alike.
- **`mochi term`** — open the TUI in its own native terminal window (`--geometry 100x30`, `--title`).
- **Command palette**, mouse support for tabs and clicks, and `mochi termix` for N communicating or isolated split panes (each pane takes a distinct angle: architect, adversarial reviewer, SRE, …) with per-pane steps/tokens/cost plus split totals.

## Interactive Commands

```text
/help                     /goal <objective>       /team <objective>
/plan <objective>         /tasks                  /status
/diff                     /changes                /checkpoint
/rollback                 /model                  /profiles
/memory                   /inspect <query>        /skills repo
/mcp search               /tab list               /theme <name>
/image <path>             /clear                  /exit
```

## Integrations

### Chameleon (internal synthetic-parameter reasoning)

Expands test-time compute for hard goals: a deterministic, repo-grounded task scaffold (classifier-selected invariants and hazards, a checklist built from the repo's own scripts, codegraph symbols, traps from prior run autopsies) plus — above flash mode — additional model passes with stall-recovery strategies whose output is injected into the agent prompt as extra reasoning context. Built into Mochi — it uses the agent's **own** configured provider: no external CLI, no shell-out, no extra API key. Flash mode is fully deterministic (no model calls), and a failed provider call degrades gracefully to the deterministic scaffold.

```bash
mochi goal "Build a Redis rate limiter" --enhance --mode hard  # inject enhancement context before solving
mochi team "ship the auth flow" --enhance --mode auto          # same engine for multi-agent team runs
```

Modes map to how many reasoning strategies run: `flash < turbo < easy < medium < hard < deep < extreme/genius`. Opt in without flags via config: `{ "enhance": { "enabled": true, "mode": "auto" } }`.

### Messaging gateways

Expose the agent in the chat apps you already live in — send goals from a message, get results back:

```bash
mochi connectors            # which gateways are configured (env/token state)
mochi discord run           # Discord bot
mochi telegram run          # Telegram bot
mochi slack run             # Slack (polling) — or: mochi slack webhook (Events API)
mochi bluebubbles run       # iMessage via a BlueBubbles server (aliases: imessage, bb)
```

`mochi doctor` prints the exact env vars each gateway needs (`DISCORD_BOT_TOKEN`, `TELEGRAM_BOT_TOKEN`, `SLACK_*`, `BLUEBUBBLES_*`), and gateway tokens are redacted from logs/transcripts by the same native secret-redaction path as API keys.

### Web dashboard

`mochi dashboard` opens a browser dashboard for goals, jobs, and approvals.

## Symbol Graph Backends

`get_function` / `find_callers` / `type_hierarchy` index the repo into an in-memory SQLite code graph. Two parsers back the index, selectable by env, with backend-agnostic read paths:

- `tree-sitter` (default): a WASM CST walk for lower startup cost. Requires `npm i web-tree-sitter tree-sitter-typescript`; missing packages fall back to `tsc` automatically.
- `tsc`: the TypeScript compiler AST, always available. Opt out of tree-sitter with `MOCHI_CPG_BACKEND=tsc`.

```bash
MOCHI_CPG_BACKEND=tsc mochi inspect "SessionManager"
```

The codegraph parses and indexes **10 languages** (TypeScript, JavaScript, Python, Rust, Go, Java, C++, C#, Ruby, PHP). The repo detector recognises 18 ecosystems (marker files, test/lint commands, hints), and test-file matching (`_test.go` / `test_*.py` / `*Test.java`) spans the detected set.

## Light Mode

On very small boxes, disable the embedded SQLite symbol index and tree-sitter WASM parser entirely (both degrade gracefully instead of throwing):

```bash
MOCHI_LIGHT=1 mochi          # no embedded index, no WASM parser
MOCHI_NO_EMBED=1 mochi       # same effect
MOCHI_NO_INDEX=1 mochi       # same effect
```

Even without the flag the parser is lazy: grammars load on first symbol-index use and only for languages actually present in the repo, so runs that never touch codegraph tools pay nothing.

## Run Traces

Every project run writes a durable, deep-redacted JSONL trace (secrets scrubbed by the native DFA):

```bash
mochi trace               # list traces
mochi trace <goalId>      # replay a goal run: prompts, tool calls, results, stop reason
```

Event kinds include `tool:called`, `tool:completed`, `usage:updated`, `agent:reasoning`, `message:chunk`, `agent:log`, `summary:rendered`, `task:completed` — full post-mortem without leaving the terminal. Trace retention is pruned automatically (`pruneTraces`).

## Sessions

Full-text session history in SQLite+FTS5:

```bash
mochi session list
mochi session search "rate limiter"
```

## Checkpoints and Rollback

```bash
mochi checkpoint save before-refactor
mochi checkpoint list
mochi checkpoint restore before-refactor
mochi rollback                # last checkpoint
```

Git-backed snapshots, so rollback composes with your normal workflow.

## Skills

150 built-in skills with a lifecycle (install, enable, curate, pack). Skills are loadable procedure libraries the agent consults on demand; a self-checking catalog test keeps the registry honest.

### Skill Marketplace

Community skill distribution is git-native — no central server, no account:

```bash
mochi skills repo add official https://github.com/xanstomper/mochi-skills
mochi skills search checkpoint              # search bundled + all registered sources
mochi skills install native-core-port@official
mochi skills repo publish                   # turn any skills dir into a packs.json catalog
```

Any git repo (or `github:owner/repo`, or a plain `https://github.com/owner/repo` URL) is a valid source — sources are shallow-cloned into a local cache and namespaced on import. The official catalog at `xanstomper/mochi-skills` is PR-welcome; every skill must pass the quality bar (triggers → numbered steps with real paths → pitfalls → verification).

Also: `mochi skills pack my-skill --out ./pack` and `mochi skills unpack ./pack --force`.

## Daemon Cron (Scheduled Jobs)

Recurring agent jobs on a schedule, executed by the daemon:

```bash
mochi daemon cron add --schedule "0 9 * * *" --goal "run the nightly regression audit"
mochi daemon cron list
mochi daemon cron remove <jobId>
```

## Building

```bash
npm install
npm run build         # tsc → dist/cli.js (the authoritative gate)
npm run build:bin     # standalone bun binary → dist/mochi-bin
npm run build:native  # Rust core → native/bin/mochi_core.node + mochi-agent
npm run release:check # full pre-release gate (build + tests + tarball inspection)
```

Requires Node ≥ 22. The Rust core builds with any modern `cargo` and is optional — CI and cold installs run the parity-tested TS fallbacks. Prebuilt native binaries ship in releases; the npm tarball excludes the 96 MB standalone (npm runs `dist/cli.js` under node).

## Testing

```bash
npm test              # vitest — 2821 passing (2834 total, 13 skipped), 367 files
npm run typecheck     # tsc --noEmit
```

The suite includes differential parity tests (Rust vs TS for every native op, with adversarial cases), loop-recovery e2e tests driving a scripted "stuck" model over the real OpenAI SSE wire, TUI tests over PTY, mock-server MCP transport tests, and a hook-lifecycle static test. CI runs the full matrix on Linux, macOS, and Windows with a skip-budget guard (`scripts/check-skips.mjs`) that fails on regression to skipping.

## Benchmarks

Reproduce everything yourself:

```bash
npm run bench                 # startup
npm run bench:efficiency      # cold start + peak RSS (the BENCHMARKS.md source)
npm run bench:memory
npm run bench:task
npm run bench:stream
npm run bench:speculation
node bench/cli-matrix.mjs     # cross-harness cold-start + RSS matrix
node bench/arena.mjs          # standardized task arena (f1/b1/r1/q1/x1/x2)
mochi perf --chunks 10000     # stream-pipeline micro-benchmarks
```

Methodology, PTY probe scripts, and the honest history (including superseded numbers) are in [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Project Layout

```text
mochi/
├── src/                    # TypeScript frontend (entrypoints + topical dirs)
│   ├── agent/              # runtime loop, verification, recovery
│   ├── model/              # providers, routing, failover, prompt cache
│   ├── native/             # Rust core bridge (N-API + Bun FFI)
│   ├── tui/                # terminal UI, tabs, themes, renderer
│   ├── daemon/             # persistent HTTP agent service
│   ├── tools/              # tool bus and implementations
│   ├── security/           # exec policy, redaction, sandbox
│   └── ...
├── native/mochi_core/      # zero-dependency Rust crate + stdio daemon
├── docs/                   # ARCHITECTURE / CAPABILITIES / BENCHMARKS / CLI_REFERENCE
├── bench/                  # arena, cli-matrix, efficiency, memory, startup
├── skills/                 # built-in skill registry
├── scripts/                # build-native, prepack, release-check, sync-version
├── site/                   # github.io website + docs
└── examples/               # runnable examples
```

See [TECHMAP.md](TECHMAP.md) for the full path-by-path map.

## Design Principles

1. **Zero runtime dependencies.** If it can be written with the Node stdlib, it is. The dependency list is a design constraint, not an accident — audits are clean and the tarball is ~3 MB.
2. **Native only where it pays.** Per-byte compute and resident memory go to Rust; everything else stays in TS. Ops are ported only when the result is small relative to the input.
3. **Every native path has a parity-tested fallback.** No environment breaks because a binary is missing.
4. **Verification over confidence.** Greenfield vetoes, baseline comparisons, rule-based BLOCK on unverified changes, and a judge that cannot contradict failed evidence.
5. **The harness is the lever.** Model choice matters less than what the harness tells the model mid-flight — struggle state, escape plans, and recovery strategies are all prompt-level, in-repo, and testable.
6. **Honest numbers or no numbers.** Benchmarks ship with reproducible scripts; superseded results are marked superseded, not deleted.
7. **Small targeted patches.** Strict TypeScript, events for state changes, verify before done.

## Contributing

```bash
npm install
npm run build && npm test    # green build + suite before any PR
npm run typecheck
```

Read [MOCHI.md](MOCHI.md) for project conventions, [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before touching the loop, and [TECHMAP.md](TECHMAP.md) so nothing is mystery meat. Issues and PRs welcome at [github.com/xanstomper/mochi](https://github.com/xanstomper/mochi).

<div align="center">

---

## License

[![License: MIT](https://img.shields.io/badge/License-MIT-8b5cf6?style=for-the-badge&labelColor=1c1233)](LICENSE)

---

[![Star History Chart](https://api.star-history.com/svg?repos=xanstomper/mochi&type=Timeline)](https://star-history.com/#xanstomper/mochi&Timeline)

</div>
