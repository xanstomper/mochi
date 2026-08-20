---
name: fullstack-dev
description: Fullstack development patterns and workflows for React, Next.js, Vue, Tailwind, FastAPI, Axum, and Express services. Use when scaffolding or extending a full-stack application.
tools: [read, write, edit, patch, shell, glob, search, sql_codebase_query]
---

# Fullstack Development Skill

## Conventions
- Keep API contracts explicit: define a shared schema (TypeScript types, Zod, or OpenAPI) before wiring routes.
- Frontend components go in `src/components/`; pages/routes in `src/pages|app/`; API handlers in `src/api|server/` for the framework in use.
- Use the project's existing styling system (Tailwind config or CSS vars); do not invent a parallel design system.

## Next.js / React
- App Router: colocate loaders/server components; keep client components marked `'use client'`.
- Data fetching: use caching/revalidation primitives from the framework; avoid fire-and-forget fetches in effects.

## FastAPI / Express / Axum
- Validation at the boundary (Pydantic / zod / validator) — never trust raw request bodies.
- Prefer async handlers; keep database access behind a repository/service layer so routes stay thin.
- Return consistent error envelopes (`{ ok, error, code }`).

## Testing
- Add at least one test per new route/component: request-path tests for the API, render behavior for UI.
- Use the repo's existing runner (vitest/jest/pytest/cargo test) — do not introduce a second framework.

## Finishing
- Verify with the app's build + typecheck + test commands; a full-stack change is not done until all three pass.