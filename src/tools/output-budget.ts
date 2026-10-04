/**
 * Shared output budgeting for tool results.
 *
 * Tool output goes back into the transcript and is RE-SENT on every subsequent
 * model request until compaction. A single 256KB shell result (~65K tokens)
 * can cost that many tokens on every remaining iteration of a task. These
 * helpers keep results small WITHOUT losing the parts models actually use:
 *
 * - The HEAD of output (file lists, the first error in a build).
 * - The TAIL of output (test frameworks, compilers, and git print their
 *   failure summary at the END: "X failed, Y passed", final diffs, hints).
 *
 * The middle is elided with an honest marker that states how much was cut,
 * so the model knows the result is partial and can re-run a narrower command.
 */

/** Default per-tool-result budget in characters (~12K tokens at chars/3.8). */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = parseEnvInt('MOCHI_TOOL_RESULT_MAX_CHARS', 48_000);

/** Chars kept from the start when clipping. */
export const HEAD_CHARS = Math.max(1_000, Math.floor(DEFAULT_TOOL_RESULT_MAX_CHARS * 0.6));

/** Chars kept from the end when clipping (failure summaries live here). */
export const TAIL_CHARS = Math.max(1_000, Math.floor(DEFAULT_TOOL_RESULT_MAX_CHARS * 0.25));

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface ClipOptions {
  /** Overrides the default budget for this result. */
  maxChars?: number;
}

/**
 * Clip oversized tool output to head + elision marker + tail.
 * Returns the input unchanged when it already fits.
 */
export function clipToolOutput(output: string, opts: ClipOptions = {}): string {
  const max = opts.maxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  if (output.length <= max) return output;

  const omitted = output.length - HEAD_CHARS - TAIL_CHARS;
  const marker =
    `\n... [mochi: elided ${omitted.toLocaleString('en-US')} chars of middle output ` +
    `(${output.length.toLocaleString('en-US')} total, kept first ${HEAD_CHARS.toLocaleString('en-US')} + last ${TAIL_CHARS.toLocaleString('en-US')}); ` +
    `narrow the command or raise MOCHI_TOOL_RESULT_MAX_CHARS if you truly need more] ...\n`;

  return output.slice(0, HEAD_CHARS) + marker + output.slice(output.length - TAIL_CHARS);
}
