---
name: golang-pro
description: Go idiomatic programming, goroutines, channels, context cancellation, table-driven testing, and microservice engineering.
tools: [read, write, edit, patch, shell, glob, search, verify]
---

# Idiomatic Go Engineering Skill

## Core Go Conventions
- **Explicit Error Handling:** Never ignore errors: `if err != nil { return fmt.Errorf("context: %w", err) }`. Wrap errors using `%w`.
- **Context Propagation:** Always pass `ctx context.Context` as the first argument in I/O and network functions to support deadlines and graceful cancellation.
- **Goroutines & Concurrency:** Never start a goroutine without knowing how and when it will stop. Use `sync.WaitGroup` or `errgroup.Group`.
- **Interfaces:** Keep interfaces small and define them on the consumer side (`io.Reader`, `io.Closer`).
- **Testing:** Use table-driven tests (`for _, tt := range tests { t.Run(...) }`).
