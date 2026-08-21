---
name: git-wizard
description: Git operations, interactive rebasing, merge conflict resolution, branch management, worktrees, and atomic commit structuring.
tools: [read, edit, patch, shell, git, glob, search]
---

# Git Wizard Skill

## Atomic & Conventional Commits
- Structure commits logically: each commit represents one coherent change.
- Format: `type(scope): description` (e.g., `feat(auth): add jwt validation`, `fix(tui): prevent mouse escape leak`).
- Always verify `git status` and `git diff` before staging to avoid committing scratch files, secrets, or temporary logs.

## Merge Conflict Resolution
1. Run `git status` to identify unmerged paths (`both modified:`).
2. Inspect conflict markers: `<<<<<<< HEAD`, `=======`, `>>>>>>> incoming`.
3. Understand the intent of both branches before resolving:
   - Combine complementary changes cleanly.
   - Remove conflict markers completely.
4. Run project test suite and typechecker to verify resolution validity before completing merge/rebase.

## Safe Git Operations
- Never force push (`--force`) to shared branches (`main`, `master`, `prod`). Use `--force-with-lease` when necessary on feature branches.
- Use `git stash push -m "description"` to save uncommitted work when switching contexts.
- Use Git Worktrees (`git worktree add <path> <branch>`) to isolate experimental edits without affecting the main working tree.
