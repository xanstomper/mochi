import { describe, expect, it } from 'vitest';
import { TokenBucket } from './limiter';

describe('TokenBucket', () => {
  it('starts full at capacity', () => {
    const b = new TokenBucket(5);
    expect(b.available()).toBe(5);
  });

  it('consumes tokens and reports success', () => {
    const b = new TokenBucket(5);
    expect(b.consume(3)).toBe(true);
    expect(b.available()).toBe(2);
  });

  it('rejects consumption beyond available tokens', () => {
    const b = new TokenBucket(2);
    expect(b.consume(3)).toBe(false);
    expect(b.available()).toBe(2);
  });

  it('consuming exactly the balance succeeds and empties the bucket', () => {
    const b = new TokenBucket(2);
    expect(b.consume(2)).toBe(true);
    expect(b.available()).toBe(0);
  });

  it('refill restores the bucket to full capacity', () => {
    const b = new TokenBucket(4);
    b.consume(3);
    expect(b.available()).toBe(1);
    b.refill();
    expect(b.available()).toBe(4);
  });

  it('rejects non-positive capacity', () => {
    expect(() => new TokenBucket(0)).toThrow();
    expect(() => new TokenBucket(-1)).toThrow();
  });

  it('rejects non-positive consume amounts', () => {
    const b = new TokenBucket(3);
    expect(() => b.consume(0)).toThrow();
    expect(() => b.consume(-2)).toThrow();
  });

  it('does not mutate state on a failed consume', () => {
    const b = new TokenBucket(1);
    expect(b.consume(2)).toBe(false);
    expect(b.available()).toBe(1);
  });
});