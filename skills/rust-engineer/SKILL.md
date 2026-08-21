---
name: rust-engineer
description: Rust systems programming, borrow checker mastery, Tokio async runtime, Cargo workspace management, and zero-cost abstractions.
tools: [read, write, edit, patch, shell, glob, search, verify]
---

# Rust Systems Engineering Skill

## Idiomatic Rust Conventions
- **Error Handling:** Use `Result<T, E>` with `?` operator. Use `thiserror` for library error types and `anyhow` for applications/CLI drivers.
- **Memory & Lifetimes:** Prefer ownership and borrowing (`&str`, `&[T]`) over unnecessary `.clone()` calls. Use `Arc<Mutex<T>>` or `tokio::sync::RwLock<T>` for cross-thread shared state.
- **Async Concurrency:** Use `tokio` runtime. Always drop locks across `.await` points to prevent deadlocks.
- **Cargo Workspaces:** Structure multi-crate repositories with a top-level `Cargo.toml` workspace definition.
- **Verification:** Test with `cargo test --all-targets` and format/lint with `cargo clippy -- -D warnings`.
