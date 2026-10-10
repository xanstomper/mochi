---
name: web-design
description: Production web UI design — design tokens, responsive layout, semantic HTML, real design-system polish (Stripe/Linear/Vercel class), accessibility, and verification.
tools: [read, write, edit, patch, glob, search, shell, browser]
---

# Web Design Skill

## Foundations
- **Design tokens first:** spacing scale (4/8px rhythm), type scale (1.2–1.25 ratio), color roles (bg/surface/text-primary/text-muted/border/accent) as CSS custom properties or Tailwind config — never hard-coded hex in components.
- **Semantic HTML:** `<button>` not `<div onclick>`, `<nav>/<main>/<section>`, headings in order. This is 60% of a11y for free.
- **Dark mode:** design both themes from the token set; test contrast (WCAG AA: 4.5:1 body, 3:1 large text/UI).

## Polish bar (Stripe/Linear/Vercel class)
- Shadows: layered, low-opacity (`0 1px 2px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.08)`) — never hard black.
- Radii consistent: one value per component class (e.g. inputs 6px, cards 10px, modals 14px).
- Motion: 150–250ms ease-out for enters, 100–150ms for exits; `prefers-reduced-motion` respected.
- Empty states, loading skeletons, and error states designed for every data view — no blank boxes.

## State coverage (hard rule)
Every interactive element ships with **hover, focus-visible, active, disabled, and loading** states. A toggle that looks the same on/off fails review.

## Verification
- Screenshot at 360px, 768px, 1440px widths; check for horizontal scrollbars and clipped text.
- Keyboard-walk the page: tab order matches visual order; focus visible on every stop.
- Lighthouse a11y ≥ 90 on any shipped page.
