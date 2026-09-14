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
  /** Fired before each retry for a retryable error (after backoff). Lets a
   *  provider rotate credentials (401/429) to a fresh pool key between
   *  attempts. */
  onRetryable?: (attempt: number, error: unknown) => void;
}

const DEFAULT: Required<Omit<RetryOptions, 'onBackoff' | 'onRetryable'>> = {
  maxAttempts: 4,
  maxTotalWaitMs: 60_000,
  baseDelayMs: 400,
  maxDelayMs: 12_000,
  jitter: 0.3,
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Client-side request throttle (shared token bucket) ─────────────────────
//
// The individual retry path (withRetries) recovers from a 429 after it happens,
// but when several agents/sessions share one free-tier endpoint they can trip
// rate limits FASTER than recovery can keep up (user-reported "rate limits and
// freezes" under concurrent Terminus sessions). A lightweight leaky-bucket
// throttle ahead of the wire lets concurrent agents self-regulate the burst so
// they collectively land under the provider's RPM ceiling instead of hammering
// it. Retries then absorb only the residual jitter.
//
// Opt-in (default OFF so docs, tests, and single-agent runs keep their current
// latency): MOCHI_RATE_LIMIT_RPM=<n> allows ~n parallel-ish calls/minute;
// MOCHI_RATE_LIMIT_CONCURRENCY=<n> caps simultaneous in-flight requests.
// Both share one module-global bucket because a free-tier provider is one
// budget regardless of how many agents are driving us.

/** A process-global, provider-agnostic token bucket. */
class TokenBucket {
  private capacity: number;
  private tokens: number;
  private refillPerMs: number;
  private lastRefill: number;

  constructor(capacity: number, refillPerMs: number) {
    this.capacity = Math.max(1, capacity);
    this.refillPerMs = refillPerMs;
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
      this.lastRefill = now;
    }
  }

  /** Wait until at least one token is available, then consume it. */
  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      await sleep(Math.max(5, Math.ceil(deficit / this.refillPerMs)));
    }
  }
}

// A semaphore for the concurrency cap. Requestors queue on a FIFO promise
// chain; when one finishes it releases the next waiting caller.
class Semaphore {
  private max: number;
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.wait();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private wait(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // hand the slot straight to the next waiter (active stays the same)
    } else {
      this.active--;
    }
  }
}

function readThrottleConfig(): { bucket: TokenBucket | null; sem: Semaphore | null } {
  const rpm = Number(process.env.MOCHI_RATE_LIMIT_RPM);
  const conc = Number(process.env.MOCHI_RATE_LIMIT_CONCURRENCY);
  const haveRpm = Number.isFinite(rpm) && rpm > 0;
  const haveConc = Number.isFinite(conc) && conc > 0;
  return {
    bucket: haveRpm ? new TokenBucket(rpm, rpm / 60_000) : null,
    sem: haveConc ? new Semaphore(conc) : null,
  };
}

// Built once per process; both knobs are read at first use.
let THROTTLE: { bucket: TokenBucket | null; sem: Semaphore | null } | undefined;

function throttle(): { bucket: TokenBucket | null; sem: Semaphore | null } {
  if (!THROTTLE) THROTTLE = readThrottleConfig();
  return THROTTLE;
}

export function resetThrottleForTests(): void {
  THROTTLE = undefined;
}

/**
 * Apply the shared client-side throttle around `fn`: waits for a token AND a
 * concurrency slot (if configured) before running. Never blocks past the
 * provider's retry budget because it only delays up to the leaky bucket's
 * refill pace and releases immediately if the throttle is disabled.
 */
export async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const { bucket, sem } = throttle();
  if (!bucket && !sem) return fn(); // throttle disabled — zero overhead path
  const run = async () => {
    if (bucket) await bucket.acquire();
    return fn();
  };
  return sem ? sem.run(run) : run();
}

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
// Local abort codes from the DOM/fetch layer (signal.abort() by the stall-guard
// watchdog or the caller). These are NOT provider overloads: the request was torn
// down locally, so re-entering the retry loop would restart it and then wait
// another full stall window before aborting again (a multi-minute freeze).
const ABORT_CODES = new Set(['ABORT_ERR', 'UND_ERR_ABORTED', 'ECONNABORTED']);
const ABORT_RE = /abort/i;

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

/** True when the error is a LOCAL abort (our signal was aborted by the stall-guard
 *  watchdog or the caller) rather than a real provider/transport overload. */
export function isAbort(err: unknown): boolean {
  if ((err as { name?: unknown })?.name === 'AbortError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  if (ABORT_RE.test(msg)) return true;
  return causeCodes(err).some((c) => ABORT_CODES.has(c));
}

/** Decide whether an error is transient (retry) or permanent (surface now). */
export function classifyError(err: unknown): RateLimitInfo {
  if (err instanceof ProviderError) {
    if (err.retryAfter !== undefined && err.status === 429) {
      return { retryable: true, retryAfterMs: Math.max(0, err.retryAfter * 1000) };
    }
    return { retryable: err.retryable };
  }
  // A local abort is never a provider overload: surface it immediately so a
  // stall-guard / caller abort cannot be dragged back into a retry loop that
  // would freeze for another full stall window on each attempt. This check runs
  // before the generic transport regex so an abort message can't incidentally
  // match a transient term.
  if (isAbort(err)) return { retryable: false };
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
      // Run the caller's work behind the shared client-side throttle (token
      // bucket + optional concurrency cap) so concurrent agents sharing one
      // free-tier endpoint self-regulate instead of tripping 429s in a burst.
      // The throttle is a no-op unless MOCHI_RATE_LIMIT_RPM/_CONCURRENCY is set.
      return await throttled(fn);
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
      opts.onRetryable?.(attempts, err);
      await sleep(delay);
      waited += delay;
    }
  }
}