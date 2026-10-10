---
name: tui-design
description: Professional terminal UI design — Bubble Tea/Lipgloss patterns, Textual, muted dark palettes, keyboard-first layouts, spinners, tables, and pixel-consistent alignment.
tools: [read, write, edit, patch, glob, search, shell]
---

# TUI Design Skill

## Palette & Style
- **Muted dark palettes:** background `#1a1b26`-family, foreground `#a9b1d6`-family; accents desaturated (indigo `#7aa2f7`, teal `#73daca`, amber `#e0af68`). Never pure `#000`/`#fff`.
- **Semantic roles over literals:** define tokens (primary, muted, success, warn, error, border) once; reference roles everywhere.
- **Lipgloss patterns:** one `styles.go`/`theme.ts` module owning every style; components never inline ad-hoc colors.

## Layout
- **Zones:** full-screen apps use header (title/status) → body (primary content) → footer (key hints) with fixed heights for header/footer.
- **Box-drawing consistency:** one border style per app; padding 0/1/2 only; never mix `┌` and `+` corners.
- **Pixel consistency:** same table column widths on every render — compute widths from data once, don't let rows reflow.
- **Alignment:** pad cells with `lipgloss.Width` (not rune count) so CJK/emoji don't break columns.

## Interaction
- **Keyboard-first:** every action reachable by keys; visible focus; `?` toggles help; `q`/`esc`/`ctrl+c` exit paths always work.
- **No stuck controls:** disabled ≠ hidden — gray out unavailable actions with a reason in the status line.
- **Spinners:** show for any async op >150ms; never block input on a spinner.

## Anti-patterns (hard fails)
- Matrix rain / starfield / random-color flair in business tools.
- Mixed markup: raw ANSI strings interleaved with styled components.
- Layouts that assume terminal size without handling `WindowSizeMsg` / resize.

## Verify
- Render to a fixed-size pty (`printf '\e[8;40;120t'`) or `teatest`/`Textual` snapshot; diff the frame, don't trust the code.
