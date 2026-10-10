# MOCHI SITE v4 — MASTER DESIGN PROMPT

## North Star
A premium, editorial, single-page-scroll experience for Mochi (terminal coding agent).
Reference quality: reactbits.dev components + Claude.ai warmth + Vercel/Linear polish.
NOT a template. NOT "AI slanted-gradient slop". Every element must earn its place.

## Design Tokens (locked)
colors:
  canvas:      #FBF6EE  (warm cream — page bg)
  surface:     #FFFFFF  (cards, nav)
  surface-2:   #F5EDE0  (subtle sections)
  ink:         #2A1E18  (headings — deep mocha)
  body:        #5C4A3E  (paragraphs)
  muted:       #8A6F5B  (labels, eyebrows)
  pink:        #F2A7B8  (primary accent — CTAs, highlights)
  pink-deep:   #D97A94  (hover, emphasis)
  pink-ink:    #8A2D4E  (text on light pink)
  mocha:       #8A6F5B  (secondary text)
  hairline:    #E8DCC8  (borders)
  dark:        #2A1E18  (dark sections — coda, terminal)
  on-dark:     #FBF6EE
  amber:       #E8B04B  (tertiary accent — sparing)

typography:
  display:  "Fraunces", serif — 72-120px, weight 400-600, tight tracking
  heading:  "Fraunces", serif — 36-56px
  body:     "Inter", sans — 16-18px, line-height 1.7
  mono:     "JetBrains Mono", monospace — 13-14px, eyebrows, stats, code
  eyebrow:  11px, uppercase, letter-spacing 0.14em, mono

spacing: 8px base scale — sections 120px apart, cards 24px, text blocks 16px
radius:  16px cards, 999px pills/buttons, 8px code blocks
shadow:  0 1px 2px rgba(42,30,24,.04), 0 8px 32px rgba(42,30,24,.06)

## Layout Principles
1. Max content width: 1120px (not 1240 — tighter = more premium)
2. Sections: generous 120px vertical padding, hairline dividers between
3. Cards: white surface, 1px hairline border, 16px radius, NO shadow on rest, soft shadow on hover
4. Dark sections: full-bleed #2A1E18, cream text, pink accents
5. Grid: 12-col mental model, 2-3 col card layouts, never more than 4 stats in a row
6. Mobile-first: stack everything below 768px

## Animation System (reactbits-inspired, all CSS/JS no deps)
Entrance (on scroll into view):
  - SplitText: per-char staggered rise, 40ms between chars, cubic-bezier(.22,1,.36,1)
  - BlurIn: opacity 0→1 + blur(8px)→0, 600ms
  - SlideUp: translateY(40px)→0, opacity, 700ms
  - ScaleIn: scale(.94)→1, opacity, 500ms
  - StaggerGroup: children cascade with 80ms delay each
Scroll-linked:
  - ParallaxY: element translates at 0.6× scroll speed
  - ProgressBar: 2px pink bar at very top, scaleX tracks scroll
Hover:
  - Lift: translateY(-4px) + shadow, 250ms
  - Magnetic: button drifts toward cursor (strength 0.25)
  - Glow: box-shadow pink halo
Continuous:
  - Marquee2: infinite scroll, 28s loop, seamless
  - Counter: number counts up on view, 1.4s easeOutQuart

## Component Inventory
Background:  Iridescence (WebGL, dimmed to opacity .28, cream veil)
Nav:         Sticky, transparent→cream on scroll, active = pink underline (not pill)
Hero:        Full-viewport, giant serif MOCHI, typewriter subtitle, 2 CTAs,
             stats ticker pinned to bottom edge (frosted blur, mono text, scrolling right)
Stats:       4-up grid, white cards, hairline borders, count-up numbers, mono labels
Manifesto:   2-col (text left, mascot right), serif pull-quote, orbit-ring mascot
Flow:        5 numbered steps, horizontal rule dividers, hover: number turns pink
Terminal:    Dark card, macOS chrome dots, syntax-colored output, typing animation on view
Benchmark:   Horizontal bar chart, animated width, pink for Mochi, gray for others
Features:    3-up cards, icon + title + body, hover lift
Repo:        Embedded file browser, collapsible tree, syntax highlighting
Coda:        Dark section, giant serif "SMALL IS THE FEATURE", 2 CTAs
Footer:      Minimal, hairline top border, mono copyright + links

## Page Structure (single scroll)
1. Nav (sticky)
2. Hero (100vh)
3. Stats ticker (pinned to hero bottom)
4. Receipts (4-up stat cards)
5. Manifesto (2-col)
6. Flow (5 steps)
7. Terminal demo (dark card)
8. Features (3-up)
9. Benchmarks (bar chart)
10. Repo browser
11. Coda (dark)
12. Footer

## Quality Bar
- Every scroll triggers at least one animation
- Text is always readable (text-shadow halo over shader)
- No element is >2 levels deep in z-index
- No layout shifts after load (reserve space for all animations)
- Mobile: every section stacks, font sizes clamp, ticker stays pinned
