// Stream degeneracy detector: free/low-tier models occasionally fall into a
// verbatim repetition loop mid-stream — the same sentence/paragraph emitted
// over and over (observed live: 3,508 reasoning events / ~115 copies of the
// same block in ~60s, then task failure). Silence watchdogs cannot see it
// because chunks keep arriving.
//
// Design: normalize the stream (strip ANSI escapes, collapse all whitespace
// incl. NBSP — formatting-only differences must not defeat detection), then
// track rolling 192-char windows via a cheap hash with EXACT verification.
// A window that re-occurs within MAX_GAP_CHARS means the model is literally
// re-emitting identical bytes nearby. Requiring several such recurrences AND
// a minimum SPAN of the repeated region filters legitimate repetition:
// imports spread across files, table rows with changing numbers, spacers,
// short stamps — either differ inside every window or stay under the span
// floor. Alternating 2-sentence loops (A B A B …) also trip this, which is
// intended: they are equally user-hostile and token-burning.
export const WINDOW_CHARS = 192;
export const STREAK_LIMIT = 4;       // occurrences needed (incl. first)
export const MAX_GAP_CHARS = 2048;   // max distance between repetitions to count
export const MIN_SPAN_CHARS = 700;   // how much ground the looped region must cover

const BASE = 131_071;
const MOD_MASK = (1 << 24) - 1; // power-of-two modulus keeps hashing cheap

/** Normalize a chunk into comparable form. */
function normalize(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+/g, ' ');
}

interface Recurrence { first: number; last: number; streak: number }

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h * BASE) + s.charCodeAt(i)) & MOD_MASK;
  return h;
}

export interface DegenStats {
  streak: number;
  spanChars: number;
}

export class DegenerationDetector {
  private canon = '';    // normalized stream, tail-capped
  private raw = '';      // un-normalized tail kept only to join chunks safely
  private seen = new Map<number, Recurrence>(); // windowHash -> recurrence info
  private streak = 0;
  private span = 0;
  private finished = false;

  /** Feed one streamed delta (reasoning and content both flow through here).
   *  Returns true ONCE when degeneration is detected. */
  feed(delta: string | undefined): boolean {
    if (!delta || this.finished) return false;
    // Append to the raw tail, then rebuild canon from the raw tail — deltas
    // are small and normalization of a few KB per chunk is cheap. Keeping the
    // raw tail avoids mis-normalizing whitespace/escape sequences split
    // across chunk boundaries.
    this.raw = (this.raw + delta).slice(-8_000);
    const rebuilt = normalize(this.raw);
    this.canon = rebuilt.length > 40_000 ? rebuilt.slice(-40_000) : rebuilt;
    return this.scan();
  }

  live(): DegenStats {
    return { streak: this.streak, spanChars: this.span };
  }

  abortFlagged(): boolean {
    return this.finished;
  }

  /** Scan recent windows of the normalized stream for short-gap recurrence. */
  private scan(): boolean {
    const c = this.canon;
    if (c.length < WINDOW_CHARS) return false;
    const start = Math.max(WINDOW_CHARS, c.length - 6_000);
    for (let pos = start; pos + WINDOW_CHARS <= c.length; pos++) {
      const win = c.slice(pos, pos + WINDOW_CHARS);
      const h = hashStr(win);
      let r = this.seen.get(h);
      if (!r) {
        this.seen.set(h, { first: pos, last: pos, streak: 1 });
        continue;
      }
      // Verify exactly before counting: our hash space is small by design,
      // collisions must not fabricate loops.
      if (c.slice(r.last, r.last + WINDOW_CHARS) !== win) continue;
      const gap = pos - r.last;
      r.streak = gap <= MAX_GAP_CHARS ? r.streak + 1 : 1;
      r.last = pos;
      const span = r.last - r.first + WINDOW_CHARS;
      if (r.streak >= STREAK_LIMIT && span >= MIN_SPAN_CHARS) {
        this.streak = r.streak;
        this.span = span;
        this.finished = true;
        return true;
      }
    }
    return false;
  }
}
