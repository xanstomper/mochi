// Token bucket rate limiter. `now()` returns milliseconds (injectable).
class TokenBucket {
  constructor({ capacity, refillPerSec, now = Date.now }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
    this.tokens = capacity; // starts full
    this.lastRefillMs = now();
  }
  _refill() {
    const t = this.now();
    const elapsedSec = (t - this.lastRefillMs) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.lastRefillMs = t;
    }
  }
  tryRemove(n = 1) {
    this._refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
  retryAfterSec() {
    this._refill();
    if (this.tokens >= 1) return 0;
    return Math.max(1, Math.ceil((1 - this.tokens) / this.refillPerSec));
  }
}
module.exports = { TokenBucket };
