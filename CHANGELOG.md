# Changelog

All notable changes to Mochi will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- New cell-based canvas renderer (`internal/ui/canvas`)
  - Cell, Framebuffer, dirty-region tracking
  - Double-buffered presentation
  - Per-cell fg/bg/attrs with wide-character support
  - 11 passing tests
- Animated status bar (`internal/ui/statusbar`)
  - 8 agent states with smooth color transitions
  - Animated spinner with state-specific rune pools
  - Token counter with thousands separators
  - Latency and cost display
  - Pluggable palette system
  - 5 passing tests
- Streaming visualization (`internal/ui/streamviz`)
  - Type-on effect with configurable pacing
  - HSV color cycling on the head character
  - Particle trail with gravity
  - Word-wrap with line tracking
  - 6 passing tests
- Animated banner (`internal/ui/banner`)
  - Gradient sweep reveal
  - Falling particles on each cell reveal
  - Gentle breathing effect
  - Mochi wordmark included
  - 5 passing tests
- Interactive demo (`internal/ui/demo`) showing all components working together
- `mochi extras` subcommand with memory, cron, sysinfo, and version commands
- Memory and cron backends (`internal/mochi/extras/`)
- Comprehensive README, CONTRIBUTING, CODE_OF_CONDUCT, LICENSE, CHANGELOG, ROADMAP

### Changed
- Module path: `github.com/charmbracelet/mochi` → `github.com/mochi/mochi`
- All package references updated to use the new module path
- Branding scrubbed of references to charmbracelet and crush

### Fixed
- All build errors from the original crush codebase have been resolved
- LSP cache shows stale errors; trust `go build ./...` output

## [0.4.0] — 2026-06-05

### Added
- Initial Mochi release, forked from crush v0.4
- 200+ Go files
- Multi-provider LLM support (Anthropic, OpenAI, Gemini, Bedrock, Copilot, Hyper, MiniMax, Vercel)
- Bubble Tea v2 TUI with Ultraviolet screen-based rendering
- MCP server support
- LSP integration
- Session persistence (SQLite)
- Hooks engine
- Skill discovery
- Prompt history
- File tracker
- Background jobs
- Permission system

[Unreleased]: https://github.com/xanstomper/mochi/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/xanstomper/mochi/releases/tag/v0.4.0
