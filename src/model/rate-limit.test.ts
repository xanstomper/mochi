import { describe, it, expect } from 'vitest';
import { withRetries, classifyError } from './rate-limit.js';
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