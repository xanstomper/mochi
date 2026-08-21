---
name: code-refactoring
description: Code refactoring, clean architecture, SOLID principles, design patterns, dead code elimination, and type safety hardening without behavioral regressions.
tools: [read, write, edit, patch, replace_symbol, search_replace_multi, glob, search, verify]
---

# Code Refactoring & Architecture Skill

## Principles of Safe Refactoring
- **Behavior Preservation:** Refactoring changes internal structure without altering external observable behavior. All pre-existing unit/integration tests must pass before and after each refactoring step.
- **Micro-Steps:** Refactor in small, discrete, verifiable transformations (Rename -> Extract Function -> Move -> Inline).

## High-Leverage Refactoring Patterns
1. **Extract Function / Component:** Break down monolithic functions (>40 lines) into small, single-responsibility units with clear parameters and return types.
2. **Replace Conditional with Polymorphism / Strategy Pattern:** Replace sprawling `switch` or nested `if-else` blocks with dispatch maps or polymorphic classes.
3. **Parameter Object / Interface:** Consolidate long parameter lists (>4 arguments) into structured interfaces or configuration objects.
4. **Dead Code Elimination:** Search for unused exports, unreferenced variables, and dead branches using AST tools before deletion.
5. **Symbol-Level Renaming:** Use surgical symbol refactoring tools (`replace_symbol`) to update definitions, imports, and references across all call sites atomically.
