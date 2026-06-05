# Roadmap

This document tracks the planned and completed work for Mochi.

> **Status legend:** `[x]` done · `[~]` in progress · `[ ]` planned

## v1.0 — Stable API (Q4 2026)

The goal of v1.0 is a stable, documented, governance-ready API that third-party developers can rely on.

- [x] Core agent runtime (multi-provider, tool registry, hooks, MCP, skills)
- [x] Bubble Tea v2 TUI with hybrid screen/string/canvas rendering
- [x] SQLite session persistence
- [x] LSP integration
- [x] Background jobs
- [x] File tracker
- [x] Cell-based canvas renderer
- [x] Animated status bar, streaming visualization, banner
- [~] Stable public API for `github.com/mochi/mochi/sdk`
- [ ] API documentation site (pkg.go.dev + custom docs)
- [ ] Governance: CODEOWNERS, MAINTAINERS.md, RFC process
- [ ] Security audit
- [ ] Performance benchmarks in CI
- [ ] Long-term support guarantee (LTS releases every 6 months)

## v0.5 — Voice (Q3 2026)

- [ ] Voice input via Whisper (local or API)
- [ ] Voice output via TTS
- [ ] Push-to-talk hotkey
- [ ] Streaming transcription overlay
- [ ] Configurable wake word

## v0.6 — Plugin marketplace (Q3 2026)

- [ ] Plugin manifest format
- [ ] Plugin discovery and installation via `mochi plugin install`
- [ ] Plugin sandboxing
- [ ] Community plugin registry
- [ ] Verified publisher program

## v0.7 — Web UI (Q4 2026)

- [ ] HTTP/WebSocket server
- [ ] Browser-based terminal (xterm.js)
- [ ] Multi-session management
- [ ] Mobile-friendly layout
- [ ] End-to-end encryption option

## v0.8 — WASM (Q1 2027)

- [ ] Compile to WebAssembly
- [ ] Run in browser as a worker
- [ ] IndexedDB session storage
- [ ] WebLLM provider for in-browser inference
- [ ] Offline-first PWA

## v2.0 — Multi-agent orchestration (Q2 2027)

- [ ] Agent-to-agent messaging
- [ ] Shared workspace
- [ ] Conflict resolution
- [ ] Cost budgeting across agents
- [ ] Visual orchestration graph

## Completed milestones

### v0.4 — Cell-based canvas (June 2026)

- [x] Cell, Framebuffer, dirty-region tracking
- [x] Double-buffered presentation
- [x] Animated status bar
- [x] Streaming visualization with type-on effect
- [x] Animated banner
- [x] Interactive demo
- [x] 27 new tests across 4 packages

### v0.3 — Hooks, skills, multi-agent (May 2026)

- [x] Hook engine with PreToolUse, PostToolUse, Stop
- [x] Skill discovery and loading
- [x] Multi-agent coordinator (named agents)
- [x] Permissions system

### v0.2 — MCP and LSP (April 2026)

- [x] MCP client integration
- [x] Docker MCP support
- [x] LSP client manager
- [x] Auto-discovery of language servers
- [x] On-demand LSP startup

### v0.1 — Core agent (March 2026)

- [x] Multi-provider LLM (Anthropic, OpenAI, Gemini)
- [x] Tool registry (bash, edit, write, view, glob, grep, web, etc.)
- [x] Bubble Tea v2 TUI
- [x] SQLite session log
- [x] Prompt history
- [x] Config file (MOCHI.json)

## Non-goals

To keep scope clear, the following are explicitly **not** planned:

- **GUI desktop app** — Mochi is a terminal tool. A web UI is in scope (v0.7), but a native desktop app is not.
- **Code completion / IDE plugin** — Mochi is a chat-style agent, not a Copilot-style completion engine.
- **Self-hosted model training** — Mochi uses existing model providers. We do not train our own models.
- **Mobile app** — The web UI (v0.7) is designed to be mobile-friendly. A native app is not planned.

## How to influence the roadmap

- Open a [feature request](https://github.com/xanstomper/mochi/issues/new?template=feature_request.md) on GitHub.
- Upvote existing requests with a 👍 reaction.
- Join the [Discord](https://discord.gg/mochi) to discuss.
- Submit a [RFC](https://github.com/xanstomper/mochi/tree/main/docs/rfcs) for large changes.

## Release cadence

- **Minor versions** (0.x) every 4-6 weeks.
- **Patch versions** (0.x.y) as needed for bug fixes.
- **Major versions** (x.0) on the schedule above, or when a breaking API change is required.
- **LTS releases** (1.0, 1.6, 2.0, etc.) supported for 12 months each.

See [CHANGELOG.md](CHANGELOG.md) for the full release history.
