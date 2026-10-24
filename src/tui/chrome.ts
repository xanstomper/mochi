// Shared terminal-chrome geometry: the SINGLE source of truth for how rows
// are divided between the tab bar, transcript, busy line, composer, and status
// bars. renderFrame, transcriptGeometry (selection math), and the autocomplete
// dropdown MUST all use this.
import { wrap } from './wrap.js';

export interface ChromeLayout {
  /** Tab-bar rows pinned at the top (0 when tabs hidden, normally 1). */
  topRows: number;
  statusRows: number;
  composerRows: number;
  bottomRows: number;
  /** Transcript content height (excludes chrome). */
  contentH: number;
  /** Transcript message width at this terminal width. */
  chatMw: number;
  /** Visible transcript rows (minus the busy line when running). */
  availableH: number;
}

export function chromeLayout(opts: {
  w: number;
  h: number;
  /** Current composer text (drives composer growth). */
  inputText: string;
  busy: boolean;
  topRows?: number;
  indent?: number;
  /** Rows reserved for the subagent panel ABOVE the status bar (0 when no
   *  children in the spawn ledger). Transcript height shrinks by this. */
  panelRows?: number;
}): ChromeLayout {
  const { w, h, inputText, busy } = opts;
  const topRows = opts.topRows ?? 0;
  const panelRows = opts.panelRows ?? 0;
  // Sleek, minimal status bar: 2 rows on normal terminals (>= 24), 1 row on compact/short windowed mode.
  const statusRows = h >= 24 ? 2 : 1;
  const innerW = Math.max(1, w - 6);
  const rawRows = inputText ? wrap(inputText, innerW) : [''];
  // Composer expands as the user types, up to 1/3 of screen height.
  // In short windowed mode (h < 24) use 3 rows for single-line input, 4 for multiline.
  const minComposer = h < 24 ? (rawRows.length > 1 ? 4 : 3) : 3;
  const composerRows = Math.min(Math.max(minComposer, Math.floor(h / 3)), rawRows.length + 2);
  // Bottom consists of composer and status bar(s) — clean, un-bunched, professional.
  const bottomRows = composerRows + statusRows;
  // The subagent panel (when live) carves its rows out of the transcript.
  const contentH = Math.max(1, h - bottomRows - topRows - panelRows);
  const indent = opts.indent ?? 2;
  const chatMw = Math.min(w - indent * 2, Math.max(24, w - 4));
  const availableH = busy ? Math.max(1, contentH - 1) : contentH;
  return { topRows, statusRows, composerRows, bottomRows, contentH, chatMw, availableH };
}

