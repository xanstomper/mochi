---
name: tui-development
description: Instructions for building terminal user interfaces with Mochi. Covers library choices (ink, blessed, chalk, etc.), real-time dashboards, interactive menus, progress bars, animated/colored output, and correct terminal handling.
tools:
  - shell
  - write
  - read
  - edit
---

# Terminal UI (TUI) Development Skill

## When to Use
- Building or extending a terminal/CLI interface with interactive elements.
- Adding a dashboard, menu, progress bar, or colored/streaming output.

## Library Selection
- **ink** (React for CLIs): best when you already think in React components; ideal for interactive multi-screen apps and menus.
- **blessed / blessed-contrib:** low-level, full control over the full-screen terminal; good for advanced layouts and dashboards, at the cost of more manual logic.
- **chalk:** colors/styles only (no layout); pair with anything.
- **ora:** spinners; **cli-table3:** tables; **boxen:** boxes/borders; **figlet / gradient-string:** banners and gradients; **@clack/prompts** or **inquirer**: high-level interactive prompts.

## Correct Terminal Handling
- **Detect interactivity:** use `process.stdout.isTTY` (or a lib) to decide between animated output and plain, log-friendly output when piped.
- **Handle signals:** catch `SIGINT` so you can restore the cursor and clear alternate buffers before exiting; never leave the terminal in raw/alternate-screen mode.
- **Respect width:** get the real terminal size and wrap/clamp content, especially in small panes; truncate with an ellipsis rather than hard-wrapping.
- **Avoid raw ANSI disaster:** prefer libraries that manage SGR reset correctly; always reset attributes after styling.

## Real-Time Dashboards
- Refresh a region in place (clear line/`\r`, or `blessed`/`ink` full-redraw) rather than scrolling new lines.
- Keep per-frame work cheap; throttle redraws (e.g. 10-30fps) and coalesce rapid data updates.
- Separate **data** (state) from **render** so you redraw only when the relevant state changes.

## Interactive Menus & Prompts
- Use a modal/dropdown with a selection pointer and highlight bar; keep selected rows readable (light text on accent bar).
- Support keyboard navigation (arrows, enter, esc) and hide/omit it gracefully in non-TTY mode.
- Size menus to content and clamp to terminal width/height; show scroll-state and a count when the list overflows.

## Progress Bars & Animations
- Show **indeterminate** spinners when progress is unknown; switch to a determinate bar once you have a total.
- Do not emit newlines mid-frame; use CR (`\r`) or cursor-up sequences to overwrite the same line.
- Always clear/complete the animation on both success and error so output is not left garbled.

## Accessibility & Productivity
- Prefer **semantic primitives** over hand-rolled escape sequences so behavior (colors, reset, width) is correct across terminals.
- Keep output quiet when `--json`/`--no-color`/non-TTY so scripts can parse it.
- Make the important line (status/error) distinct from scrolling log noise.

## Workflow
1. **Read** the existing CLI/TUI entry point to match its style and libraries.
2. **Pick** the right primitives for the feature (menu, bar, table, dashboard).
3. **Write** it with correct resize/signal/TTY handling.
4. **Verify** it in a real terminal at a range of widths, plus as piped/non-TTY output.
5. **Confirm** on Ctrl-C the terminal is restored cleanly and output is not corrupted.