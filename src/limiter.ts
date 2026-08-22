/**
 * In-memory token bucket rate limiter.
 *
 * A bucket holds up to `capacity` tokens. Each `consume(tokens)` call draws
 * tokens from the bucket and returns `true` if enough were available (and
 * removes them), otherwise `false` and leaves the bucket untouched. `refill()`
 * restores the bucket to full capacity.
 */
export class TokenBucket {
  private readonly capacity: number;
  private tokens: number;

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`capacity must be a positive finite number, got ${capacity}`);
    }
    this.capacity = capacity;
    this.tokens = capacity;
  }

  /** Attempt to consume `tokens` from the bucket. Returns true on success. */
  consume(tokens: number): boolean {
    if (!Number.isFinite(tokens) || tokens <= 0) {
      throw new Error(`tokens must be a positive finite number, got ${tokens}`);
    }
    if (tokens > this.tokens) {
      return false;
    }
    this.tokens -= tokens;
    return true;
  }

  /** Refill the bucket back to full capacity. */
  refill(): void {
    this.tokens = this.capacity;
  }

  /** Current number of available tokens. */
  available(): number {
    return this.tokens;
  }
}