---
name: typescript-master
description: Advanced TypeScript, strict type safety, conditional types, mapped types, template literal types, AST manipulation, and zero-runtime overhead typing.
tools: [read, write, edit, patch, shell, glob, search, verify]
---

# Advanced TypeScript Master Skill

## Type System Mastery
- **Strict Mode Invariants:** `strict: true`, `noImplicitAny: true`, `strictNullChecks: true`.
- **Discriminated Unions:** Model state machines with explicit discriminant fields (`type State = { status: 'idle' } | { status: 'loading' } | { status: 'error'; error: Error }`).
- **Exhaustive Matching:**
  ```typescript
  function assertNever(x: never): never {
    throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
  }
  ```
- **Utility & Mapped Types:** Use `Readonly<T>`, `Partial<T>`, `Pick<T, K>`, `Omit<T, K>`, `Record<K, V>`.
- **No Type Assertions (`as any`):** Use type guards (`x is Type`) or Zod schema validation instead of unsafe casts.
