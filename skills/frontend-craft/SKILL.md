---
name: frontend-craft
description: Frontend UI engineering, React/Next.js/Vue/Svelte, CSS layout, Tailwind, state management, responsive design, and web accessibility (a11y).
tools: [read, write, edit, patch, glob, search, verify]
---

# Frontend Craft & UI Engineering Skill

## Architectural Best Practices
- **Component Decomposition:** Single Responsibility Principle. Separate container/data-fetching components from pure presentational components.
- **State Management:** Keep state as local as possible. Lift state only when multiple components require shared synchronization. Use URL search params for bookmarkable/shareable UI filters.
- **Accessibility (WCAG 2.1 AA):**
  - Semantic HTML tags (`<nav>`, `<main>`, `<article>`, `<header>`, `<footer>`, `<button>`).
  - Correct `aria-label`, `aria-expanded`, and keyboard navigation support (`tabIndex`, Enter/Space handlers).
  - Explicit form labels associated with inputs (`htmlFor` / `id`).

## Modern Styling & CSS Layout
- Mobile-first responsive breakpoints.
- CSS Grid for 2D macro-layouts (dashboards, cards); Flexbox for 1D micro-alignments (navbars, button groups).
- Eliminate layout shifts (CLS) by giving images and placeholders explicit dimensions.
