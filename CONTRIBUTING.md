# Contributing to Mochi

First off, thank you for considering contributing to Mochi.
This project is built by a community of developers, and every contribution counts.

## Code of Conduct

This project and everyone participating in it is governed by the
[Mochi Code of Conduct](CODE_OF_CONDUCT.md).
By participating, you are expected to uphold this code.

## How can I contribute?

### Reporting bugs

- Check the [issue tracker](https://github.com/xanstomper/mochi/issues) to see if the bug has already been reported.
- If not, [open a new bug report](https://github.com/xanstomper/mochi/issues/new?template=bug_report.md).
- Include as much detail as possible: Go version, OS, mochi version, steps to reproduce, expected vs actual behavior.

### Suggesting enhancements

- Open a [feature request](https://github.com/xanstomper/mochi/issues/new?template=feature_request.md).
- Explain the use case and why this would be valuable to other users.

### Improving documentation

- The [README](README.md) and [docs/](docs/) directory are always in need of clarification.
- Fix typos, add examples, expand on tricky concepts.

### Submitting pull requests

1. **Fork the repo** and create a branch from `main`.
2. **Make your changes.** Follow the code style (see below).
3. **Add tests** for any new functionality.
4. **Run the linter and tests** locally.
5. **Update the CHANGELOG.md** if your change is user-visible.
6. **Open a PR** with a clear description of the change.

## Development setup

```bash
# Clone your fork
git clone https://github.com/<you>/mochi
cd mochi

# Install Go 1.24+
go version  # should be 1.24 or later

# Install development tools
go install mvdan.cc/gofumpt@latest
go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
go install golang.org/x/tools/cmd/goimports@latest

# Build
go build .

# Run tests
go test ./...

# Run the linter
gofumpt -l .
golangci-lint run
```

## Code style

- **Go version:** 1.24+. Use generics, range-over-func, and modern stdlib features.
- **Formatting:** Always run `gofumpt -w .` before committing.
- **Imports:** Use `goimports` to organize imports. Group: stdlib, third-party, internal.
- **Naming:** Standard Go conventions. Avoid stuttering (`mochi.MochiConfig` → `mochi.Config`).
- **Comments:** Public symbols must have doc comments starting with the symbol name.
- **Errors:** Wrap with `fmt.Errorf("doing thing: %w", err)`. Start messages lowercase.
- **Tests:** Use `testify/require`, parallel tests, `t.Tempdir()` for temp dirs.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: add new streaming visualization`
- `fix: status bar flickering on resize`
- `refactor: split banner package into reveal and breathe`
- `docs: add architecture diagram to README`
- `test: cover streamviz word wrap edge cases`
- `chore: bump catwalk to v0.8.2`

## Project structure

See the [Architecture section](README.md#architecture) in the README for a
high-level overview. Key directories:

- `internal/agent/` — Agent runtime, tools, prompts
- `internal/ui/` — TUI components (canvas, statusbar, streamviz, banner, chat, etc.)
- `internal/cmd/` — CLI commands
- `docs/` — Documentation and assets

## Review process

1. A maintainer will review your PR within 3 business days.
2. We may request changes. Please don't take it personally — code review is collaborative.
3. Once approved, a maintainer will squash-merge your PR.

## Release process

Mochi uses [release-please](https://github.com/googleapis/release-please) for
automated releases. Commits to `main` trigger a release PR. When merged, a new
GitHub release is created with pre-built binaries.

## License

By contributing, you agree that your contributions will be licensed under the
[FSL-1.1-MIT License](LICENSE.md).
