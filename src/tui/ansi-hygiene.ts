// ANSI hygiene helpers (shared).
//
// Two failure classes this fixes:
//  1. Colored tool output (npm/git --color=always) enters the MODEL CONTEXT
//     with raw escape codes; the model then parrots broken fragments of them
//     into its prose ("138;43,226m", "250m" — payload of a 38;2;r;g;b SGR
//     whose ESC byte was lost).
//  2. Stream chunk boundaries split a sequence mid-flight: one chunk ends
//     "\x1b[38;2;1", the next starts "38;43;226m". The leading ESC+CSI never
//     reassembles, so every "strip ANSI" regex misses the orphan tail.

/** Complete ANSI/CSI sequences (cursor moves, colors, etc.). */
export const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

/** SGR color payloads whose ESC+CSI prefix was lost (or a comma-mangled
 *  variant the model copied by eye). Three shapes occur in the wild:
 *   - the full payload "38;2;R;G;Bm" / "48;5;Nm" (ESC+[ bytes already
 *     stripped by an upstream layer), glued onto whatever preceded it;
 *   - the comma-mangled 38;2 tail that lost "38;2;" entirely: "138;43,226m"
 *     (the comma is the tell — real prose never writes "43,226m" as a
 *     semicolon-delimited unit);
 *   - the bare 256-color remainder ";250m" where "48;5" was dropped too —
 *     matched ONLY when the ';' is NOT preceded by a digit, so prose like
 *     "3;1m" (3.1 meters) and "version 1.2.3m" always survive. */
export const ORPHAN_SGR_RE =
  /(?:38|48);(?:2;[\d,;]{1,15}|5;\d{1,3})m|\d{1,3};\d{1,3},\d{1,3}m|(?<!\d);\d{1,3}m/g;

/** A dangling "\x1b[..." with no terminator at the end of a string. */
export const PARTIAL_CSI_TAIL_RE = /\x1b\[[0-9;]*$/;

/** Strip every escape sequence — for text entering the model context. */
export function stripAllAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Strip complete sequences AND the orphaned fragments they decay into.
 *  For text headed to the SCREEN (model prose, streamed chunks). */
export function scrubAnsiFragments(s: string): string {
  return s.replace(ANSI_RE, '').replace(ORPHAN_SGR_RE, '').replace(PARTIAL_CSI_TAIL_RE, '');
}
