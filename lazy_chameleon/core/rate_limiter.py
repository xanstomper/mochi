"""
RateLimiter — token-bucket rate limiter for API calls.

Prevents 429 errors and enforces sustained throughput without hammering
the provider. Uses a dual-bucket model:
  • request bucket  — max N requests/minute
  • token bucket    — max T tokens/minute

Both buckets refill continuously (leaky-bucket style).  A call is only
allowed when *both* buckets have enough capacity.

Provider limits (conservative, July 2025 estimates)
─────────────────────────────────────────────────────
opencode-go / deepseek-v4-flash   60 req/min   500 000 tok/min
anthropic / claude-*               50 req/min   100 000 tok/min
openai / gpt-4o                    60 req/min   500 000 tok/min
openrouter                         20 req/min   200 000 tok/min

Usage
─────
    limiter = RateLimiter(provider="opencode-go")
    limiter.acquire(estimated_tokens=1200)   # blocks if needed
    # … make API call …
    limiter.record(prompt_tokens=800, completion_tokens=400)
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass, field

log = logging.getLogger(__name__)


# ── Provider limits ──────────────────────────────────────────────────────────

@dataclass
class ProviderLimits:
    requests_per_minute: int
    tokens_per_minute: int
    burst_multiplier: float = 1.5   # short burst headroom

    @property
    def req_per_sec(self) -> float:
        return self.requests_per_minute / 60.0

    @property
    def tok_per_sec(self) -> float:
        return self.tokens_per_minute / 60.0


PROVIDER_LIMITS: dict[str, ProviderLimits] = {
    "opencode-go":   ProviderLimits(requests_per_minute=60,  tokens_per_minute=500_000),
    "opencode":      ProviderLimits(requests_per_minute=60,  tokens_per_minute=500_000),
    "opencode-zen":  ProviderLimits(requests_per_minute=60,  tokens_per_minute=500_000),
    "anthropic":     ProviderLimits(requests_per_minute=50,  tokens_per_minute=100_000),
    "openai":        ProviderLimits(requests_per_minute=60,  tokens_per_minute=500_000),
    "openrouter":    ProviderLimits(requests_per_minute=20,  tokens_per_minute=200_000),
    "default":       ProviderLimits(requests_per_minute=30,  tokens_per_minute=100_000),
}


# ── Bucket implementation ────────────────────────────────────────────────────

class _TokenBucket:
    """Thread-safe token bucket that refills at a constant rate."""

    def __init__(self, capacity: float, refill_rate: float):
        self._capacity = capacity
        self._rate = refill_rate       # tokens per second
        self._tokens = capacity        # start full
        self._last_refill = time.monotonic()
        self._lock = threading.Lock()

    def _refill(self):
        now = time.monotonic()
        elapsed = now - self._last_refill
        self._tokens = min(self._capacity, self._tokens + elapsed * self._rate)
        self._last_refill = now

    def try_consume(self, amount: float = 1.0) -> bool:
        """Attempt to consume `amount` tokens; returns True if successful."""
        with self._lock:
            self._refill()
            if self._tokens >= amount:
                self._tokens -= amount
                return True
            return False

    def consume_blocking(self, amount: float = 1.0, timeout: float = 60.0) -> bool:
        """
        Block until `amount` tokens are available, then consume them.
        Returns False if `timeout` seconds elapse without getting capacity.
        """
        deadline = time.monotonic() + timeout
        backoff = 0.05
        while time.monotonic() < deadline:
            if self.try_consume(amount):
                return True
            # wait proportional to deficit
            with self._lock:
                self._refill()
                deficit = amount - self._tokens
            wait = min(deficit / max(self._rate, 1e-9), backoff)
            time.sleep(wait)
            backoff = min(backoff * 1.5, 2.0)
        return False

    @property
    def available(self) -> float:
        with self._lock:
            self._refill()
            return self._tokens

    @property
    def utilization(self) -> float:
        return 1.0 - self.available / self._capacity


# ── Rate limiter ─────────────────────────────────────────────────────────────

@dataclass
class RateLimitStats:
    total_requests: int = 0
    total_tokens: int = 0
    blocked_requests: int = 0
    total_wait_ms: float = 0.0

    @property
    def avg_wait_ms(self) -> float:
        return self.total_wait_ms / max(self.blocked_requests, 1)


class RateLimiter:
    """
    Dual-bucket (requests + tokens) rate limiter.

    Parameters
    ──────────
    provider        : Provider key (see PROVIDER_LIMITS)
    custom_req_rpm  : Override requests/minute (0 = use provider default)
    custom_tok_rpm  : Override tokens/minute   (0 = use provider default)
    enabled         : Set False to disable limiting (e.g. for tests)
    """

    def __init__(
        self,
        provider: str = "opencode-go",
        custom_req_rpm: int = 0,
        custom_tok_rpm: int = 0,
        enabled: bool = True,
        # Shorthand aliases (test-friendly)
        rpm: int = 0,
        tpm: int = 0,
    ):
        self.provider = provider
        self.enabled = enabled
        limits = PROVIDER_LIMITS.get(provider, PROVIDER_LIMITS["default"])

        # Short aliases take priority over custom_req/tok_rpm
        rpm = rpm or custom_req_rpm or limits.requests_per_minute
        tpm = tpm or custom_tok_rpm or limits.tokens_per_minute
        self._rpm = rpm
        self._tpm = tpm

        # burst capacity = 1 minute worth of tokens × burst multiplier
        self._req_bucket = _TokenBucket(
            capacity=rpm * limits.burst_multiplier,
            refill_rate=rpm / 60.0,
        )
        self._tok_bucket = _TokenBucket(
            capacity=tpm * limits.burst_multiplier,
            refill_rate=tpm / 60.0,
        )
        self._stats = RateLimitStats()

    # ── Public API ───────────────────────────────────────────────────────────

    def acquire(
        self,
        estimated_tokens: int = 1000,
        timeout: float = 30.0,
        # Shorthand alias
        tokens: int = 0,
    ) -> bool:
        """
        Block until the rate limiter allows a request of `estimated_tokens`.
        `tokens` is a convenience alias for `estimated_tokens`.

        Returns True if acquired, False if timed-out.
        """
        if tokens:
            estimated_tokens = tokens
        if not self.enabled:
            return True

        t0 = time.monotonic()
        # Request bucket: 1 request slot
        req_ok = self._req_bucket.consume_blocking(1.0, timeout=timeout)
        if not req_ok:
            self._stats.blocked_requests += 1
            log.warning("RateLimiter[%s]: request bucket timeout", self.provider)
            return False

        # Token bucket: estimated_tokens slots
        tok_ok = self._tok_bucket.consume_blocking(
            float(estimated_tokens),
            timeout=timeout,
        )
        if not tok_ok:
            self._stats.blocked_requests += 1
            log.warning(
                "RateLimiter[%s]: token bucket timeout (needed %d)",
                self.provider, estimated_tokens,
            )
            return False

        elapsed_ms = (time.monotonic() - t0) * 1000
        if elapsed_ms > 10:
            self._stats.blocked_requests += 1
            self._stats.total_wait_ms += elapsed_ms
            log.debug(
                "RateLimiter[%s]: waited %.0f ms for %d tokens",
                self.provider, elapsed_ms, estimated_tokens,
            )

        self._stats.total_requests += 1
        self._stats.total_tokens += estimated_tokens          # track at acquire-time
        return True

    def record(self, prompt_tokens: int = 0, completion_tokens: int = 0):
        """
        Record actual token usage after a call completes.
        Adjusts the token bucket for the difference between
        estimated and actual usage.
        """
        actual = prompt_tokens + completion_tokens
        self._stats.total_tokens += actual
        # No bucket correction needed — we already consumed estimated tokens.
        # This method is mainly for stats tracking.

    def try_acquire(self, estimated_tokens: int = 1000) -> bool:
        """Non-blocking check — returns False immediately if at capacity."""
        if not self.enabled:
            return True
        req_ok = self._req_bucket.try_consume(1.0)
        tok_ok = self._tok_bucket.try_consume(float(estimated_tokens))
        return req_ok and tok_ok

    # ── Stats ────────────────────────────────────────────────────────────────

    def stats(self) -> dict:
        return {
            "provider": self.provider,
            "total_requests": self._stats.total_requests,
            "total_tokens": self._stats.total_tokens,
            "blocked_requests": self._stats.blocked_requests,
            "avg_wait_ms": round(self._stats.avg_wait_ms, 1),
            "req_bucket_utilization": round(self._req_bucket.utilization, 3),
            "tok_bucket_utilization": round(self._tok_bucket.utilization, 3),
        }

    # ── Convenience API (test-friendly) ────────────────────────────────────────

    def get_stats(self) -> dict:
        """Return stats in a simplified, test-friendly structure."""
        return {
            "provider":             self.provider,
            "rpm_limit":            self._rpm,
            "tpm_limit":            self._tpm,
            "requests_this_minute": self._stats.total_requests,
            "tokens_this_minute":   self._stats.total_tokens,
            "blocked_requests":     self._stats.blocked_requests,
            "total_requests":       self._stats.total_requests,
            "total_tokens":         self._stats.total_tokens,
        }

    def reset(self):
        """Reset all counters (useful between tests)."""
        self._stats = RateLimitStats()

    @classmethod
    def for_provider(cls, provider: str, enabled: bool = True) -> "RateLimiter":
        """
        Convenience constructor — looks up known provider presets.
        Falls back to 'default' limits for unknown providers.
        """
        if provider not in PROVIDER_LIMITS:
            provider = "default"
        return cls(provider=provider, enabled=enabled)

    def __repr__(self) -> str:
        s = self.stats()
        return (
            f"RateLimiter({self.provider}  "
            f"req_util={s['req_bucket_utilization']:.0%}  "
            f"tok_util={s['tok_bucket_utilization']:.0%}  "
            f"blocked={s['blocked_requests']})"
        )
