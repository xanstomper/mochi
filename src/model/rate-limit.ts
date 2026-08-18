import { ProviderError } from '../utils/http-error.js';

// Rate-limit-safe model calls: instead of a single fire-and-fail request (or the
// loop's one immediate re-request), every model round-trip goes through an
// exponential backoff with jitter that:
//
//   - retries ONLY transient failures (429, 5xx, timeouts, transport errors),
//     never 400/401/403/404 (those are permanent and must surface at once),
//   - honors a `Retry-After` header / retry-after field when the provider sends
//     one (it wins over the exponential schedule for 429s),
//   - is bounded: a hard max on attempts AND a hard cap on total backoff time,
//     so we never hammer the endpoint or hang a run indefinitely,
//   - logs when it backs off so a user can see "rate limited, sleeping 3s".

export interface RetryOptions {
  maxAttempts?: number;    // total tries including the first
  maxTotalWaitMs?: number; // hard cap on accumulated backoff across retries
  baseDelayMs?: number;    // first backoff when no Retry-After is given
  maxDelayMs?: number;     // ceiling for the exponential term
  jitter?: number;         // fraction of the delay to randomize (default 0.3)
  onBackoff?: (attempt: number, delayMs: number, error: unknown) => void;
}

const DEFAULT: Required<Omit<RetryOptions, 'onBackoff'>> = {
  maxAttempts: 4,
  maxTotalWaitMs: 60_000,
  baseDelayMs: 400,
  maxDelayMs: 12_000,
  jitter: 0.3,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RateLimitInfo {
  retryable: boolean;
  retryAfterMs?: number;
}

// We retry transient network/transport conditions (a hung or reset connection)
// but NOT misconfiguration-style refusals: ECONNREFUSED / ENOTFOUND mean the
// endpoint is wrong or not listening (a permanent condition we must not hammer
// with backoff -- and which a test's unreachable mock relies on surfacing fast).
const RATE_LIMIT_WORDS = /rate.?limit|too many|throttl|quota|overloaded|exhausted|busy|429|502|503|504|server error|temporar|transient|ECONNRESET|ETIMEDOUT|\bnetwork\b|fetch failed|failed to fetch/i;

const RETRYABLE_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN']);
// Codes that mean a permanent misconfiguration, not a transient overload.
const NONRETRYABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH']);

function causeCodes(err: unknown): string[] {
  const codes: string[] = [];
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 6) {
    const code = (cur as { code?: unknown })?.code;
    if (typeof code === 'string') codes.push(code);
    cur = (cur as { cause?: unknown })?.cause;
    depth++;
  }
  return codes;
}

/** Decide whether an error is transient (retry) or permanent (surface now). */
export function classifyError(err: unknown): RateLimitInfo {
  if (err instanceof ProviderError) {
    if (err.retryAfter !== undefined && err.status === 429) {
      return { retryable: true, retryAfterMs: Math.max(0, err.retryAfter * 1000) };
    }
    return { retryable: err.retryable };
  }
  // Inspect the Node fetch cause chain for a transport code.
  const codes = causeCodes(err);
  if (codes.some((c) => NONRETRYABLE_CODES.has(c))) return { retryable: false };
  const msg = err instanceof Error ? err.message : String(err);
  const looksTransient = codes.some((c) => RETRYABLE_CODES.has(c)) || RATE_LIMIT_WORDS.test(msg);
  return { retryable: looksTransient };
}

function applyJitter(base: number, jitter: number): number {
  return Math.max(0, base + (Math.random() * 2 - 1) * base * jitter);
}

/**
 * Run `fn()` with bounded, jittered exponential backoff for transient provider
 * failures. Rethrows the LAST error once retries are exhausted.
 */
export async function withRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT.maxAttempts;
  const maxTotalWaitMs = opts.maxTotalWaitMs ?? DEFAULT.maxTotalWaitMs;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT.maxDelayMs;
  const jitter = opts.jitter ?? DEFAULT.jitter;

  let attempts = 0;
  let waited = 0;
  while (true) {
    attempts++;
    try {
      return await fn();
    } catch (err) {
      if (attempts >= maxAttempts) throw err;

      const info = classifyError(err);
      if (!info.retryable) throw err;

      // 429 with an explicit Retry-After wins over the exponential default, but
      // never past the total-wait cap. A `retryAfter: 0` still retries (with a
      // floor so we never spin synchronously / hot).
      let delay = info.retryAfterMs !== undefined
        ? info.retryAfterMs
        : Math.min(maxDelayMs, baseDelayMs * 2 ** (attempts - 1));
      delay = Math.max(1, applyJitter(delay, jitter));
      if (delay > maxTotalWaitMs - waited) {
        if (maxTotalWaitMs - waited <= 0) throw err; // wait budget fully exhausted
        delay = maxTotalWaitMs - waited;             // otherwise burn the rest
      }

      opts.onBackoff?.(attempts, delay, err);
      await sleep(delay);
      waited += delay;
    }
  }
}