---
name: webui-development
description: Instructions for building web UIs with Mochi. Covers React+Vite, Next.js, SvelteKit, Tailwind, component architecture, responsive and accessible design, dark mode, and a scaffolding workflow.
tools:
  - shell
  - write
  - read
  - edit
  - web-search
---

# Web UI Development Skill

## When to Use
- Scaffolding or building frontend features and pages.
- Improving component architecture, responsiveness, accessibility, or theming.
- Reviewing a large refactor of a web UI.

## Framework Selection
- **React + Vite:** the default for a new SPA; fast dev server, simple, well-supported.
- **Next.js:** when you need SSR/SSG, file-based routing, API routes, or server components.
- **SvelteKit:** leaner runtime and simpler reactivity; good for content and moderately interactive apps.
- **Tailwind CSS** for styling plus a component kit (**shadcn/ui**, **Radix UI**) for accessible, unstyleable-with-headless components; **Framer Motion** for animation when needed.
- Choose based on deployment and interactivity needs, not trend; prefer the simplest stack that meets requirements.

## Component Architecture
- **Single responsibility:** each component does one thing; separate *presentation*, *state/logic*, and *data-fetching* (e.g. containers/views vs presentational components).
- **Composable over monolithic:** build small primitives and compose them; avoid one giant component that does everything.
- **Data flow one way:** lift shared state up; use props callbacks and a state store only where global state truly lives.
- **Keep it typed:** model props and state with TypeScript; derive types from data where possible.
- Prefer **server/data-fetching boundaries clean**: distinguish client-only, server-only, and shared code to avoid hydration bugs in server-rendered apps.

## Responsive & Layout
- **Mobile-first:** style for small screens first, then layer `sm:`/`md:` breakpoints.
- Use fluid containers (fractions, `minmax`, `auto-fit`) instead of fixed pixel widths where possible.
- Test at 360px, tablet, and desktop; ensure no horizontal scroll on the narrowest target.
- Respect text reflow: never clip text with fixed heights that break at larger font sizes.

## Dark Mode & Theming
- Drive theme from a CSS **variable** (`color-scheme` / custom props) and a toggle, not from scattered hardcoded colors.
- Persist the preference (`localStorage`) and avoid a flash-of-wrong-theme by applying the initial theme before first paint (inline script or `prefers-color-scheme`).
- Ensure every palette token has a contrast-checked pairing for both themes (see a11y below).

## Accessibility (a11y)
- **Semantics first:** real `<button>`, `<nav>`, headings, landmarks; ARIA only to enhance semantics, never as a substitute.
- **Keyboard:** everything interactive must be reachable and operable by keyboard; visible focus states mandatory.
- **Contrast:** meet WCAG AA (4.5:1 text); check dark and light themes.
- **Labels:** every input/icon has an accessible name (`aria-label`, `label`, or associated text).
- **Reduced motion:** respect `prefers-reduced-motion` and avoid animating layout when it could induce motion sensitivity.

## Scaffolding Workflow
1. **Read** the existing app to match its framework, styling, and conventions.
2. **Scaffold/place** the component(s) under the right structure; add typed props and styles.
3. **Wire** state, events, and data with one-way data flow.
4. **Verify** responsive at narrow/wide widths and confirm keyboard + contrast accessibility.
5. **Check** build/runtime for hydration warnings or unused-style bloat; keep the change reviewable.