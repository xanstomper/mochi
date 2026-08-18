# Mochi Project Memory

## architecture: Terminal-native harness

Mochi is a layered coding-agent runtime. The runtime owns goals, tasks, agents, context, tools, verification, budgeting, and persistence.

Source: src/runtime.ts

## convention: Minimal dependencies

Runtime dependencies are intentionally avoided. Prefer the Node standard library and small, direct implementations.

Source: package.json

## convention: Evidence-based completion

Agents do not mark meaningful tasks complete until verification commands or an independent verifier pass.

Source: src/verification.ts
