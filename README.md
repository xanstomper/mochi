# Mochi — the fast, beautiful AI CLI, SDK, and terminal agent.

> Fast. Beautiful. Built for humans.
> A modular AI agent that lives in your terminal, a library you can embed in your own tools, and an animated UI that gets out of your way.

---

<p align="center">
  <a href="https://github.com/xanstomper/mochi/blob/main/LICENSE.md"><img alt="License" src="https://img.shields.io/badge/License-FSL--1.1--MIT-ff4d94?style=for-the-badge&logo=opensourceinitiative&logoColor=white"></a>
  <a href="https://github.com/xanstomper/mochi/releases"><img alt="Release" src="https://img.shields.io/github/v/release/xanstomper/mochi?style=for-the-badge&color=ff80b5&logo=github&logoColor=white&label=Release"></a>
  <a href="https://github.com/xanstomper/mochi/actions"><img alt="Build Status" src="https://img.shields.io/github/actions/workflow/status/xanstomper/mochi/ci.yml?style=for-the-badge&label=Build&color=9ece6a&logo=githubactions&logoColor=white"></a>
  <a href="https://goreportcard.com/report/github.com/mochi/mochi"><img alt="Go Report Card" src="https://img.shields.io/badge/Go_Report-A%2B-7dcfff?style=for-the-badge&logo=go&logoColor=white"></a>
  <a href="https://github.com/xanstomper/mochi/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/xanstomper/mochi?style=for-the-badge&color=ffb347&logo=github&logoColor=white"></a>
</p>

<p align="center">
  <a href="https://github.com/xanstomper/mochi"><img alt="GitHub Repo" src="https://img.shields.io/badge/GitHub-xanstomper%2Fmochi-1a1b26?style=for-the-badge&logo=github&logoColor=ff4d94"></a>
  <a href="https://pkg.go.dev/github.com/mochi/mochi"><img alt="Go Reference" src="https://img.shields.io/badge/pkg.go.dev-reference-00add8?style=for-the-badge&logo=go&logoColor=white"></a>
  <a href="https://discord.gg/mochi"><img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20us-5865f2?style=for-the-badge&logo=discord&logoColor=white"></a>
  <a href="https://twitter.com/mochi_cli"><img alt="Twitter" src="https://img.shields.io/badge/Twitter-@mochi__cli-1da1f2?style=for-the-badge&logo=twitter&logoColor=white"></a>
</p>

---

<p align="center">
  <img src="docs/assets/banner.png" alt="Mochi — the fast, beautiful AI CLI, SDK, and terminal agent" width="100%">
</p>

<p align="center">
  <em>AI CLI · SDK · Terminal Agent</em>
</p>

---

## What is Mochi?

**Mochi** is three things in one repo:

1. **A terminal AI agent** (`mochi`) that connects to any LLM, gives it tools to read, write, and execute code, and lives in your shell session with a responsive Bubble Tea v2 TUI.
2. **A Go SDK** (`github.com/mochi/mochi`) you can import to build your own AI-powered tools, CLIs, or services. The LLM abstraction, tool registry, agent runtime, pub/sub bus, and event log are all reusable.
3. **A rendering toolkit** (`internal/ui/canvas`, `streamviz`, `statusbar`, `banner`) for building next-generation terminal UIs with cell-based framebuffers, dirty-region tracking, double buffering, animated transitions, particle systems, and gradient rendering.

Mochi is **provider-agnostic** (Anthropic, OpenAI, Gemini, Bedrock, Copilot, Hyper, MiniMax, Vercel, local Ollama, and more), **extensible** (MCP servers, skills, hooks, plugins), and **fast** (single static binary, no runtime, < 50ms cold start).

---

## Why Mochi?

| Why | How |
|-----|-----|
| **Fast** | Single static Go binary, sub-50ms cold start, no Node/Python runtime. |
| **Beautiful** | Cell-based canvas renderer with double buffering, smooth animations, gradient status bar, particle effects. |
| **Composable** | Every component (LLM, tools, agent, pub/sub, TUI) is a reusable Go package. |
| **Extensible** | MCP servers, agent skills, lifecycle hooks, custom tools, themes, and palettes. |
| **Multi-provider** | Anthropic, OpenAI, Gemini, Bedrock, Copilot, Hyper, MiniMax, Vercel, and any OpenAI-compatible API. |
| **LSP-aware** | Auto-discovers language servers, provides code intelligence to the agent. |
| **Cross-platform** | Builds for macOS, Linux, Windows, FreeBSD; runs on x86, arm64, and WASI. |
| **Persistent** | SQLite session log, prompt history, file tracker, project memory, cron scheduler. |
| **Animated UI** | Cell-based canvas, particle systems, smooth color transitions, gradient renders. |

---

## Installation

Mochi is distributed as a single static binary. Pick your platform:

### Quick install (one-liner)

<p align="left">
  <a href="#macos--linux--homebrew"><img alt="homebrew" src="https://img.shields.io/badge/homebrew-Install-ff4d94?style=for-the-badge&logo=homebrew&logoColor=white"></a>&nbsp;
  <a href="#windows--scoop"><img alt="scoop" src="https://img.shields.io/badge/scoop-Install-7dcfff?style=for-the-badge&logo=powertoys&logoColor=white"></a>&nbsp;
  <a href="#go-install"><img alt="go install" src="https://img.shields.io/badge/go_install-Install-00add8?style=for-the-badge&logo=go&logoColor=white"></a>&nbsp;
  <a href="#npm"><img alt="npm" src="https://img.shields.io/badge/npm-Install-cb3837?style=for-the-badge&logo=npm&logoColor=white"></a>&nbsp;
  <a href="#docker"><img alt="docker" src="https://img.shields.io/badge/docker-Install-2496ed?style=for-the-badge&logo=docker&logoColor=white"></a>&nbsp;
  <a href="#curl--unix"><img alt="curl" src="https://img.shields.io/badge/curl-Install-9ece6a?style=for-the-badge&logo=curl&logoColor=white"></a>
</p>

### macOS / Linux — Homebrew

```bash
brew install xanstomper/tap/mochi
mochi --version
```

### Windows — Scoop

```powershell
scoop bucket add xanstomper https://github.com/xanstomper/scoop-bucket
scoop install mochi
mochi --version
```

### Go install

Requires Go 1.24+.

```bash
go install github.com/mochi/mochi@latest
mochi --version
```

### npm

```bash
npm install -g @xanstomper/mochi
mochi --version
```

### Docker

```bash
docker run --rm -it -v "$PWD:/workspace" -v "$HOME/.mochi:/root/.mochi" ghcr.io/xanstomper/mochi:latest
```

### curl (Unix)

```bash
curl -fsSL https://raw.githubusercontent.com/xanstomper/mochi/main/install.sh | bash
```

### PowerShell (Windows)

```powershell
irm https://raw.githubusercontent.com/xanstomper/mochi/main/install.ps1 | iex
```

### Pre-built binaries

Download the binary for your platform from the [latest release](https://github.com/xanstomper/mochi/releases/latest):

<p align="left">
  <a href="https://github.com/xanstomper/mochi/releases/latest"><img alt="Download" src="https://img.shields.io/github/downloads/xanstomper/mochi/total?style=for-the-badge&color=ff4d94&logo=github&logoColor=white&label=Downloads"></a>
</p>

| Platform | Architecture | File |
|----------|-------------|------|
| macOS    | Apple Silicon (M1+) | `mochi-darwin-arm64.tar.gz` |
| macOS    | Intel               | `mochi-darwin-amd64.tar.gz` |
| Linux    | x86_64              | `mochi-linux-amd64.tar.gz` |
| Linux    | arm64               | `mochi-linux-arm64.tar.gz` |
| Linux    | musl (static)       | `mochi-linux-musl-amd64.tar.gz` |
| Windows  | x86_64              | `mochi-windows-amd64.zip` |
| Windows  | arm64               | `mochi-windows-arm64.zip` |
| FreeBSD  | amd64               | `mochi-freebsd-amd64.tar.gz` |

---

## Quick start

```bash
# 1. Install mochi
brew install xanstomper/tap/mochi

# 2. Configure your API key
mochi login anthropic
# Follow the prompt to paste your API key

# 3. Try it in any project
cd ~/my-project
mochi
# TUI opens. Type your first prompt.
```

That's it. The TUI launches, the agent has read/write/exec tools, your project context is auto-loaded from `AGENTS.md`, `MOCHI.md`, `CLAUDE.md`, or `GEMINI.md`.

### Example session

```text
$ mochi
╭─ mochi ───────────────────────────────────────────────╮
│  ✦ thinking...  claude-3-5-sonnet  tok: 1,234  230ms  │
╰───────────────────────────────────────────────────────╯

  › Refactor the auth module to use JWT and add tests.

  ● I'll start by exploring the auth code...
    $ ls internal/auth/
    auth.go  auth_test.go  middleware.go

  ● Reading auth.go to understand the current structure...
    ✓ Read 142 lines

  ● Here's the refactored implementation with JWT...
```

---

## Features

### AI agent

- **Multi-provider LLM** — Anthropic, OpenAI, Gemini, Bedrock, Copilot, Hyper, MiniMax, Vercel, any OpenAI-compatible endpoint.
- **Tool registry** — bash, edit, write, view, glob, grep, LSP diagnostics, MCP, web fetch, web search, file tracker, todos, references, multi-edit, plus a system info tool and a custom logger.
- **LSP integration** — Auto-discovers `gopls`, `pyright`, `tsserver`, `rust-analyzer`, `clangd`, and more. Provides code intelligence to the agent.
- **MCP support** — Connect any [Model Context Protocol](https://modelcontextprotocol.io) server. Docker MCP, filesystem, GitHub, databases, custom servers.
- **Hooks** — Run user-defined shell commands on lifecycle events (`PreToolUse`, `PostToolUse`, `Stop`, etc.) with structured JSON I/O. Compatible with both `MOCHI` and `Claude Code` hook protocols.
- **Skills** — File-based skill packs. Drop a directory in `.mochi/skills/` and the agent picks them up.
- **Sessions** — Persistent conversation history in SQLite, resumable across restarts.
- **Multi-agent** — Named agents (e.g. `coder`, `task`) with their own system prompts and tool sets.
- **Background jobs** — `&` suffix to run shell commands in the background, `mochi_logs`, `job_output`, `job_kill` to manage them.

### Terminal UI

- **Cell-based canvas** (`internal/ui/canvas`) — Double-buffered, dirty-region-tracking renderer. Only changed cells are written to the terminal.
- **Animated status bar** (`internal/ui/statusbar`) — Always-visible state indicator with smooth color transitions across 8 agent states.
- **Streaming visualization** (`internal/ui/streamviz`) — Real-time token-by-token type-on effect with HSV-cycling head character and particle trail.
- **Animated banner** (`internal/ui/banner`) — Gradient sweep reveal with falling particles and gentle breathing effect.
- **Hybrid rendering** — Screen-based via Ultraviolet for layout, string-based for sub-components, canvas-based for the new high-perf layer.
- **Themes** — MochiPink (default), Tokyo Night, Dracula, Light, Monokai. Hot-swap at runtime.
- **Mouse + keyboard** — Full mouse support (drag, click, double-click, scroll wheel), vim-style and emacs-style keybindings.

### Memory & persistence

- **Session log** — Every conversation persisted in SQLite with full token counts, costs, and timing.
- **Project memory** (`mochi extras memory`) — Tagged key-value store. Agent can save and recall facts across sessions.
- **Cron scheduler** (`mochi extras cron`) — Periodic tasks with go-cron syntax.
- **Prompt history** — Fuzzy-searchable history with `Ctrl+R`.
- **File tracker** — Per-session record of every file the agent touched, useful for code review.

### Developer experience

- **Sub-50ms cold start** — Pure Go, no runtime, single static binary.
- **Tab completion** — Generated completion scripts for bash, zsh, fish, and PowerShell.
- **Telemetry opt-in** — PostHog integration for usage analytics. Off by default.
- **Configurable** — `~/.mochi/MOCHI.json` for global, `.mochi/MOCHI.json` for per-project.
- **Context files** — Auto-loads `AGENTS.md`, `MOCHI.md`, `CLAUDE.md`, `GEMINI.md` (and `.local` variants) from the working directory.
- **Profile mode** — `mochi --profile` enables CPU + memory profiling for debugging.

---

## Usage

### Interactive TUI

```bash
mochi                     # launch TUI in current directory
mochi --model gpt-4o      # use a specific model
mochi --profile           # with profiling
mochi --debug             # with debug logging
```

### One-shot prompts

```bash
mochi run "explain this codebase"
mochi run "add unit tests for the auth module" --auto-apply
mochi run --no-tui "what is the type of foo?"
```

### Models

```bash
mochi models              # list all available models
mochi models --provider anthropic
mochi login anthropic     # set API key
mochi login openai
mochi login gemini
```

### Sessions

```bash
mochi sessions            # list all sessions
mochi session <id>        # resume a session
mochi stats               # show usage statistics
```

### Extras (mochi-only)

```bash
mochi extras memory list                       # show all remembered facts
mochi extras memory add "favorite-editor" "neovim"
mochi extras memory search "auth"
mochi extras cron list                         # show scheduled jobs
mochi extras cron add "0 */2 * * *" "run tests"
mochi extras sysinfo                           # show system info
mochi extras version                           # show version info
```

---

## Architecture

```
mochi
├── main.go                          CLI entry (cobra)
├── internal/
│   ├── app/                         Top-level wiring (DB, config, agents, LSP, MCP)
│   ├── agent/                       SessionAgent + Coordinator + tools
│   │   ├── tools/                   bash, edit, view, grep, glob, mcp, ...
│   │   └── templates/               System prompt templates
│   ├── cmd/                         CLI commands (run, login, models, sessions, extras)
│   ├── config/                      Config struct, MOCHI.json loading
│   ├── hooks/                       Lifecycle hook engine
│   ├── session/                     Session persistence (SQLite)
│   ├── message/                     Message model and content types
│   ├── db/                          SQLite via sqlc
│   ├── lsp/                         LSP client manager
│   ├── permission/                  Tool permission checks
│   ├── skills/                      Skill discovery
│   ├── shell/                       Bash execution + background jobs
│   ├── event/                       PostHog telemetry
│   ├── pubsub/                      Internal pub/sub bus
│   ├── filetracker/                 Per-session file tracking
│   ├── history/                     Prompt history
│   └── ui/                          Bubble Tea v2 TUI
│       ├── canvas/                  ⭐ NEW — cell-based framebuffer
│       ├── statusbar/               ⭐ NEW — animated status bar
│       ├── streamviz/               ⭐ NEW — streaming visualization
│       ├── banner/                  ⭐ NEW — animated banner
│       ├── demo/                    ⭐ NEW — interactive demo
│       ├── anim/                    Animated spinner
│       ├── chat/                    Chat message renderers
│       ├── dialog/                  Modal dialogs
│       ├── completions/             Autocomplete
│       ├── attachments/             File attachments
│       ├── list/                    Lazy-rendered scrollable list
│       ├── common/                  Shared utilities
│       ├── styles/                  All style definitions
│       ├── diffview/                Diff rendering
│       ├── image/                   Terminal image (Kitty graphics)
│       ├── logo/                    Mochi wordmark and mascots
│       └── util/                    Small helpers
└── docs/                            Documentation + assets
```

### Data flow

```
                 ┌─────────────────────────────────────┐
                 │         LLM PROVIDER (any)          │
                 │  Anthropic · OpenAI · Gemini · ...  │
                 └──────────┬──────────────────────────┘
                            │ streaming tokens
                 ┌──────────▼──────────────────────────┐
                 │       AGENT RUNTIME                  │
                 │  SessionAgent + Coordinator          │
                 │  tools · hooks · skills · MCP        │
                 └──────────┬──────────────────────────┘
                            │ pubsub.Event[T]
                 ┌──────────▼──────────────────────────┐
                 │         UI LAYER                     │
                 │  Ultraviolet + canvas + Bubble Tea  │
                 │  statusbar · streamviz · banner      │
                 └──────────┬──────────────────────────┘
                            │ ANSI escape sequences
                 ┌──────────▼──────────────────────────┐
                 │         TERMINAL                    │
                 │  (any UTF-8, xterm-256color, true)  │
                 └─────────────────────────────────────┘
```

---

## Comparison

| Feature | Mochi | Crush | OpenCode | Claude Code | Codex CLI |
|---------|:-----:|:-----:|:--------:|:-----------:|:---------:|
| Multi-provider LLM | ✓ | ✓ | ✓ | ✗ (Claude only) | ✓ |
| Single static binary | ✓ | ✓ | ✗ (Node) | ✗ (Node) | ✗ (Node) |
| LSP integration | ✓ | ✓ | ✓ | ✓ | ✗ |
| MCP servers | ✓ | ✓ | ✓ | ✓ | ✗ |
| Cell-based canvas renderer | ✓ | ✗ | ✗ | ✗ | ✗ |
| Animated status bar | ✓ | ✗ | ✗ | ✗ | ✗ |
| Streaming type-on effect | ✓ | ✗ | ✗ | ✗ | ✗ |
| Particle systems | ✓ | ✗ | ✗ | ✗ | ✗ |
| Project memory | ✓ | ✗ | ✗ | ✗ | ✗ |
| Cron scheduler | ✓ | ✗ | ✗ | ✗ | ✗ |
| Hooks (PreToolUse etc.) | ✓ | ✗ | ✓ | ✓ | ✗ |
| SQLite session log | ✓ | ✓ | ✓ | ✗ | ✗ |
| Cross-platform static binary | ✓ | ✓ | ✗ | ✗ | ✗ |
| Open source (FSL-1.1 → MIT) | ✓ | ✓ | ✓ | ✗ | ✓ (Apache) |
| Themes | ✓ | ✓ | ✓ | ✗ | ✗ |
| Animated UI primitives | ✓ | ✗ | ✗ | ✗ | ✗ |
| **Cold start** | **< 50ms** | ~80ms | ~600ms | ~900ms | ~500ms |
| **Bundle size** | **~110MB** | ~95MB | ~50MB (deps) | ~120MB (deps) | ~80MB (deps) |

> Benchmark: `time mochi --version` on macOS M2, 2024. "Cold start" excludes shell startup, includes Go runtime init.

---

## Performance

Mochi is fast. Like, really fast. Here's how we got there:

- **No Node, no Python, no runtime.** Pure Go, single static binary, CGO disabled.
- **Cell-based canvas renderer.** Only changed cells are written to the terminal. A 24×80 frame with 5% of cells dirty emits ~150 bytes of ANSI, not 4KB.
- **Async streaming.** The agent returns a `tea.Cmd` for every async operation. The render loop never blocks.
- **Lazy list rendering.** The chat list only renders visible items. A 10,000-message session scrolls at 60fps.
- **Pre-rendered spinner frames.** The animated spinner pre-renders 10 frames at init time. The render loop is just a slice lookup.
- **Connection pooling.** HTTP/2 with keepalive for all LLM providers. No reconnect cost between requests.

Run the benchmark yourself:

```bash
mochi bench           # renders 1000 frames, reports FPS + memory
```

---

## Configuration

Mochi is configured via a `MOCHI.json` file. Locations (in order of precedence):

1. `./.mochi/MOCHI.json` (per-project)
2. `./MOCHI.json` (per-project, legacy)
3. `~/.mochi/MOCHI.json` (per-user)
4. `/etc/mochi/MOCHI.json` (system)

```json
{
  "$schema": "https://raw.githubusercontent.com/xanstomper/mochi/main/schema.json",
  "providers": {
    "anthropic": {
      "api_key": "sk-ant-...",
      "models": ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"]
    },
    "openai": {
      "api_key": "sk-...",
      "models": ["gpt-4o", "gpt-4-turbo"]
    }
  },
  "default_provider": "anthropic",
  "default_model": "claude-3-5-sonnet-latest",
  "theme": "mochi-pink",
  "agents": {
    "coder": { "model": "claude-3-5-sonnet-latest" },
    "task":  { "model": "claude-3-5-haiku-latest" }
  },
  "hooks": {
    "PreToolUse": [
      { "command": "echo $TOOL_NAME | tee -a ~/.mochi/audit.log" }
    ]
  },
  "skills": [".mochi/skills/*"],
  "mcp_servers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
  }
}
```

---

## Themes

Mochi ships with several built-in themes:

| Theme | Background | Accent | Preview |
|-------|-----------|--------|---------|
| **MochiPink** (default) | `#1A1B26` | `#FF4D94` | soft pinks, deep background |
| **Tokyo Night** | `#1A1B27` | `#7AA2F7` | cool blues, focused, modern |
| **Dracula** | `#282A36` | `#BD93F9` | purples, classic |
| **Light** | `#FAFAFA` | `#0061A4` | clean, daytime |
| **Monokai** | `#272822` | `#F92672` | warm, high-contrast |

Switch themes at runtime: `Ctrl+T` opens the theme picker.

---

## Contributing

We love contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

Quick start:

```bash
git clone https://github.com/xanstomper/mochi
cd mochi
go test ./...
go run .
```

Before opening a PR:

- Run `task lint:fix` (or `gofumpt -w .`)
- Run `go test ./...`
- Add tests for new functionality
- Update [CHANGELOG.md](CHANGELOG.md)

---

## Community

<p align="left">
  <a href="https://discord.gg/mochi"><img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20us-5865f2?style=for-the-badge&logo=discord&logoColor=white"></a>&nbsp;
  <a href="https://github.com/xanstomper/mochi/discussions"><img alt="GitHub Discussions" src="https://img.shields.io/badge/GitHub-Discussions-1a1b26?style=for-the-badge&logo=github&logoColor=ff4d94"></a>&nbsp;
  <a href="https://twitter.com/mochi_cli"><img alt="Twitter" src="https://img.shields.io/badge/Twitter-@mochi__cli-1da1f2?style=for-the-badge&logo=twitter&logoColor=white"></a>&nbsp;
  <a href="https://www.reddit.com/r/mochi/"><img alt="Reddit" src="https://img.shields.io/badge/Reddit-r/mochi-ff4500?style=for-the-badge&logo=reddit&logoColor=white"></a>
</p>

---

## Roadmap

- [x] v0.1 — Core agent + TUI + 5 providers
- [x] v0.2 — MCP support + LSP integration
- [x] v0.3 — Hooks + skills + multi-agent
- [x] v0.4 — Cell-based canvas renderer + animated UI
- [ ] v0.5 — Voice input/output
- [ ] v0.6 — Plugin marketplace
- [ ] v0.7 — Web UI (terminal over HTTP)
- [ ] v0.8 — WASM build for browser
- [ ] v1.0 — Stable API + governance

See [ROADMAP.md](ROADMAP.md) for details.

---

## Acknowledgments

Mochi stands on the shoulders of giants:

- [Charm](https://charm.land) — Bubble Tea, Lip Gloss, Glamour, Ultraviolet, Catwalk. The best TUI toolkit on Earth.
- [Anthropic](https://anthropic.com) — Claude, the model family that inspired this project.
- [OpenAI](https://openai.com) — GPT-4, the original instruction-following LLM.
- [Google](https://deepmind.google) — Gemini.
- The [Model Context Protocol](https://modelcontextprotocol.io) team.
- The Go community for the best programming language ever designed.

And special thanks to all our [contributors](https://github.com/xanstomper/mochi/graphs/contributors) and [stargazers](https://github.com/xanstomper/mochi/stargazers). You make this possible.

---

## License

[Functional Source License v1.1, MIT Future License](LICENSE.md) — © 2026 mochi contributors.

This project uses the [FSL-1.1-MIT](https://fsl.software/) license: source-available now, automatically converting to MIT two years after each release. You can use, modify, and redistribute the code for any purpose, including commercial use; the only restriction is that you may not sell a competing product based on the source code itself until the MIT conversion date for that release.

<p align="center">
  <img src="docs/assets/banner.png" alt="Mochi" width="60%">
</p>

<p align="center">
  Made with care by the mochi team.
</p>
