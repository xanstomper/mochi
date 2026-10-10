# MOCHI SITE v6 — MASTER DESIGN PROMPT

## North Star
A serious, editorial, infrastructure-grade marketing site for Mochi (terminal coding agent).
Reference quality: linear.app, vercel.com, clerk.com, postman.com — sites that treat
engineering software like a serious product, not a lifestyle brand.

This is the ANTI-vibecode manifesto. No dreamlike sky gradients. No emoji-laden cards.
No glassmorphism. No glow/pulse/float animations competing for attention.
If it looks like a generic AI SaaS template, it's a bug.

## Design Tokens (locked — professional infra palette)
colors:
  canvas:      #FFFFFF  (page bg — pure white)
  surface:     #FAFAFA  (cards, section alt)
  surface-2:   #F5F5F5  (subtle section bg)
  ink:         #111827  (headings — near black)
  body:        #374151  (paragraphs)
  muted:       #6B7280  (labels, eyebrows)
  accent:      #0F4394  (primary — deep blue, serious)
  accent-hover: #1e3a8a  (accent hover)
  hairline:    #E5E7EB  (borders)
  dark:        #111827  (dark sections)
  on-dark:     #F9FAFB
  success:     #10B981  (green — for Mochi wins in benchmarks)
  warning:     #F59E0B  (amber)

typography:
  display:  "Inter", system-ui — 48-72px, weight 700-800, tight tracking
  heading:  "Inter", system-ui — 28-42px, weight 600-700
  body:     "Inter", system-ui — 16-18px, line-height 1.7
  mono:     "JetBrains Mono", monospace — 13-14px, eyebrows, stats, code
  eyebrow:  12px, uppercase, letter-spacing 0.12em, mono

spacing: 8px base scale — sections 100-140px apart, cards 24px, text blocks 16px
radius:  10px cards, 6px inputs, 999px pills
shadow:  0 1px 3px rgba(17,24,39,.08), 0 4px 6px rgba(17,24,39,.12)

## Layout Principles
1. Max content width: 1120px
2. Sections: 100-140px vertical padding, hairline #E5E7EB dividers
3. Cards: white surface, 1px hairline border, 10px radius, subtle shadow on hover
4. Dark sections: #111827 bg, white text, blue accent
5. Grid: clean, asymmetric when interesting, never more than 4 stats in a row
6. Mobile-first: stack everything below 768px, font sizes clamp

## Animation System (restrained, purposeful)
Motion serves the content, not decoration. Two classes:
1. **Entrance**: subtle slide-up + fade on scroll (40px translate, 600ms, ease-out)
2. **Data**: bar-width growth on scroll for benchmarks, number count-up for stats
No floating blobs. No parallax drift. No cursor-following elements.
Everything behind `prefers-reduced-motion`.

## Component Inventory
Background:  Clean white — NO shader, NO gradient sky. Optional: subtle static noise texture (0.5% opacity).
Nav:         Sticky, white → hairline bottom border on scroll. Active = blue underline.
Hero:        Full-viewport, giant display headline, 16px mono eyebrow, 2 CTAs,
             stats strip pinned below the fold (mono, clean).
Stats:       4-up grid, clean cards, count-up numbers, mono labels.
Manifesto:   2-col (text left, terminal screenshot right).
Flow:        5 numbered steps, vertical rules, clean.
Terminal:    Real macOS-style terminal, syntax colors, typing animation.
Benchmark:   Horizontal bar chart, animated width, blue for Mochi, gray for others.
Features:    3-up cards, no emoji, icon + title + body.
Repo:        Clean file browser, collapsible tree.
Coda:        Clean dark section, simple headline, 2 CTAs.
Footer:      Minimal, hairline top border, clean links.

## Page Structure (single scroll)
1. Nav (sticky)
2. Hero (100vh)
3. Stats (4-up)
4. Manifesto (2-col)
5. Flow (5 steps)
6. Terminal demo
7. Features (3-up)
8. Benchmarks (bar chart)
9. Repo browser
10. Coda (dark)
11. Footer

## Quality Bar
- Motion is restrained and purposeful
- Text is always readable (proper contrast, no overlays)
- No element is >2 levels deep in z-index
- No layout shifts after load
- Mobile: every section stacks, font sizes clamp
- No emoji in feature cards or any content
- No glassmorphism, no glowing orb blobs, no dreamlike skies
