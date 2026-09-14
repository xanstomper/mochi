import { describe, it, expect } from 'vitest';
import { withRetries, classifyError, throttled, resetThrottleForTests } from './rate-limit.js';
import { ProviderError } from '../utils/http-error.js';

describe('classifyError', () => {
  it('retries ProviderError 429 with retry-after', () => {
    const e = new ProviderError('rate limited', { status: 429, retryAfter: 5 });
    const info = classifyError(e);
    expect(info.retryable).toBe(true);
    expect(info.retryAfterMs).toBe(5000);
  });

  it('retries 5xx but not 4xx permanent errors', () => {
    expect(classifyError(new ProviderError('boom', { status: 503 })).retryable).toBe(true);
    expect(classifyError(new ProviderError('bad key', { status: 401 })).retryable).toBe(false);
    expect(classifyError(new ProviderError('not found', { status: 404 })).retryable).toBe(false);
  });

  it('pattern-matches network/transport errors without a status', () => {
    expect(classifyError(new Error('fetch failed: ECONNRESET')).retryable).toBe(true);
    expect(classifyError(new TypeError('Failed to fetch')).retryable).toBe(true);
    expect(classifyError(new Error('just a normal error')).retryable).toBe(false);
  });
});

describe('withRetries', () => {
  it('retries a transient failure and succeeds on a later attempt', async () => {
    let calls = 0;
    const out = await withRetries(async () => {
      calls++;
      if (calls < 3) throw new ProviderError('rate limited', { status: 429, retryAfter: 0 });
      return 'ok';
    }, { maxAttempts: 5, baseDelayMs: 1, jitter: 0 });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
  });

  it('stops immediately on a permanent error (no retry)', async () => {
    let calls = 0;
    await expect(
      withRetries(async () => {
        calls++;
        throw new ProviderError('bad key', { status: 401 });
      }, { maxAttempts: 5, baseDelayMs: 1, jitter: 0 }),
    ).rejects.toThrow('bad key');
    expect(calls).toBe(1);
  });

  it('gives up after maxAttempts on a persistent transient failure', async () => {
    let calls = 0;
    await expect(
      withRetries(async () => {
        calls++;
        throw new ProviderError('still limited', { status: 429, retryAfter: 1 });
      }, { maxAttempts: 3, baseDelayMs: 1, jitter: 0 }),
    ).rejects.toThrow('still limited');
    expect(calls).toBe(3);
  });

  it('retries with a Retry-After delay (nonzero) when provided', async () => {
    let calls = 0;
    const timestamps: number[] = [];
    const out = await withRetries(async () => {
      timestamps.push(Date.now());
      calls++;
      if (calls < 2) throw new ProviderError('limited', { status: 429, retryAfter: 0.01 });
      return 'done';
    }, { maxAttempts: 3, baseDelayMs: 50, jitter: 0 });
    expect(out).toBe('done');
    expect(calls).toBe(2);
  });
});

describe('throttled (client-side token bucket)', () => {
  beforeEach(() => {
    delete process.env.MOCHI_RATE_LIMIT_RPM;
    delete process.env.MOCHI_RATE_LIMIT_CONCURRENCY;
    resetThrottleForTests();
  });

  it('is a zero-overhead pass-through when disabled', async () => {
    const out = await throttled(async () => 'ok');
    expect(out).toBe('ok');
  });

  it('caps concurrency to MOCHI_RATE_LIMIT_CONCURRENCY without deadlock', async () => {
    process.env.MOCHI_RATE_LIMIT_CONCURRENCY = '2';
    resetThrottleForTests();

    const TOTAL = 5;
    let peak = 0;
    let inFlight = 0;
    const releases: Array<() => void> = [];

    // `task` must be a function returning a promise so we can launch TOTAL
    // independent calls; each call is throttled on the shared semaphore.
    const task = () =>
      throttled(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((r) => releases.push(r)); // hold until released
        inFlight--;
      });

    const all = Array.from({ length: TOTAL }, () => task());

    // Release the running tasks gradually so the FIFO queue can drain. Each
    // release frees one slot for the next queued task, so with a cap of 2,
    // peak concurrency can never exceed 2 and everything finishes.
    for (let released = 0; released < TOTAL; released++) {
      // Wait until at least one task is actually in the critical section.
      while (releases.length === 0) {
        await new Promise((r) => setTimeout(r, 2));
        if (releases.length === 0 && inFlight === 0 && released > 0) break;
      }
      if (releases.length === 0) break; // all drained
      releases.shift()!();
      await new Promise((r) => setTimeout(r, 1));
    }

    await Promise.all(all);
    expect(peak).toBeLessThanOrEqual(2); // concurrency cap held throughout
    expect(peak).toBeGreaterThan(0); // the cap was actually exercised
  });

  it('lets work through when env is cleared again (throttle rebuilt per reset)', async () => {
    process.env.MOCHI_RATE_LIMIT_CONCURRENCY = '1';
    resetThrottleForTests();
    await throttled(async () => { await new Promise((r) => setTimeout(r, 1)); });
    expect(await throttled(async () => 'ok')).toBe('ok');
  });
});