// Token bucket rate limiter. `now()` returns milliseconds (injectable).
class TokenBucket {
  constructor({ capacity, refillPerSec, now = Date.now }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.now = now;
  }
  tryRemove(n = 1) {
    return true; // TODO: implement
  }
  retryAfterSec() {
    return 0; // TODO: implement
  }
}
module.exports = { TokenBucket };
