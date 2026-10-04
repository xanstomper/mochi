import { describe, it, expect } from 'vitest';
import { describeProviderFailure } from './provider-failure.js';

describe('describeProviderFailure', () => {
  it('classifies cooldown as transient with retry delay', () => {
    const f = describeProviderFailure(new Error('Provider freeinference is cooling down after failures. Try again in ~2.1s.'));
    expect(f.kind).toBe('transient');
    expect(f.provider).toBe('freeinference');
    expect(f.retryAfterMs).toBeCloseTo(2100, 0);
    expect(f.headline).toContain('busy');
  });

  it('classifies network aborts as transient', () => {
    for (const msg of ['The operation was aborted.', 'fetch failed', 'socket hang up', 'connect ETIMEDOUT']) {
      expect(describeProviderFailure(new Error(msg)).kind).toBe('transient');
    }
  });

  it('classifies rate limits as transient', () => {
    expect(describeProviderFailure(new Error('429 Too Many Requests, retry later')).headline).toContain('rate-limited');
    expect(describeProviderFailure(new Error('provider overloaded (529)')).headline).toContain('backing off');
  });

  it('classifies auth failures as fatal with a clean headline', () => {
    const f = describeProviderFailure(new Error('request failed: 401 Unauthorized: invalid api key'));
    expect(f.kind).toBe('fatal');
    expect(f.headline).toContain('auth');
  });

  it('never leaks multi-line stack noise into the headline', () => {
    const f = describeProviderFailure(new Error('inner\nsecond line\n    at someFrame (\n    at otherFrame ('));
    expect(f.headline).not.toContain('\n');
    expect(f.headline.length).toBeLessThanOrEqual(140);
  });
});
