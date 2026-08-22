"""SynthesisCache — lightweight TTL-based in-memory + optional SQLite cache
for Lazy Chameleon synthesis results.

Usage:
    from lazy_chameleon.synthesis.cache import SynthesisCache
    cache = SynthesisCache()
    cache.set("Build a rate limiter", "easy", result_str)
    hit = cache.get("Build a rate limiter", "easy")   # returns str or None
    stats = cache.get_stats()
"""
from __future__ import annotations

import hashlib
import time
from typing import Optional


class _Entry:
    __slots__ = ("value", "mode", "created_at", "hits")

    def __init__(self, value: str, mode: str) -> None:
        self.value = value
        self.mode = mode
        self.created_at = time.time()
        self.hits = 0


class SynthesisCache:
    """In-memory TTL cache for synthesis results.

    Keys are (task, mode) pairs hashed to SHA-256 for fast lookup and
    to avoid memory leaks from giant task strings.
    """

    def __init__(self, ttl_seconds: int = 3600, max_entries: int = 512) -> None:
        self._ttl = ttl_seconds
        self._max = max_entries
        self._store: dict[str, _Entry] = {}

    # ------------------------------------------------------------------
    @staticmethod
    def _key(task: str, mode: str) -> str:
        raw = f"{mode}::{task}"
        return hashlib.sha256(raw.encode()).hexdigest()

    def _is_expired(self, entry: _Entry) -> bool:
        return (time.time() - entry.created_at) > self._ttl

    def _evict_expired(self) -> None:
        dead = [k for k, v in self._store.items() if self._is_expired(v)]
        for k in dead:
            del self._store[k]

    def _evict_lru(self) -> None:
        """Evict oldest entry when over capacity."""
        if len(self._store) >= self._max:
            oldest_key = min(self._store, key=lambda k: self._store[k].created_at)
            del self._store[oldest_key]

    # ------------------------------------------------------------------
    def get(self, task: str, mode: str) -> Optional[str]:
        """Return cached result string, or None on miss/expiry.

        TTL validation: entries older than ``self._ttl`` seconds are treated
        as non-existent and are evicted on read (lazy expiry).
        """
        k = self._key(task, mode)
        entry = self._store.get(k)
        if entry is None:
            return None
        if self._is_expired(entry):
            del self._store[k]
            return None
        entry.hits += 1
        return entry.value

    def generate_fast(self, task: str, mode: str) -> Optional[str]:
        """Return a cached result immediately, or ``None`` if not in cache.

        This is a *non-blocking* read path — it never triggers any compute.
        Use it on latency-sensitive code paths that need to fall back to a full
        synthesis call when the cache is cold.

        Example::

            result = cache.generate_fast(task, mode)
            if result is None:
                result = slow_synthesis(task, mode)
                cache.set(task, mode, result)
        """
        return self.get(task, mode)

    def set(self, task: str, mode: str, value: str) -> None:
        """Store a result.  Evicts expired entries first, then LRU if full."""
        self._evict_expired()
        self._evict_lru()
        k = self._key(task, mode)
        self._store[k] = _Entry(value, mode)

    def invalidate(self, task: str, mode: str) -> bool:
        """Remove a specific entry.  Returns True if it existed."""
        k = self._key(task, mode)
        return self._store.pop(k, None) is not None

    def clear(self) -> int:
        """Flush all entries.  Returns count removed."""
        n = len(self._store)
        self._store.clear()
        return n

    # ------------------------------------------------------------------
    def get_stats(self) -> dict:
        """Return cache health statistics."""
        self._evict_expired()
        total = len(self._store)
        total_hits = sum(e.hits for e in self._store.values())
        modes: dict[str, int] = {}
        for e in self._store.values():
            modes[e.mode] = modes.get(e.mode, 0) + 1
        ages = [time.time() - e.created_at for e in self._store.values()]
        return {
            "total_entries": total,
            "total_hits": total_hits,
            "max_entries": self._max,
            "ttl_seconds": self._ttl,
            "by_mode": modes,
            "avg_age_seconds": round(sum(ages) / max(total, 1), 1),
        }

    def __len__(self) -> int:
        return len(self._store)

    def __contains__(self, key: object) -> bool:
        """Support ``(task, mode) in cache`` membership test."""
        if isinstance(key, tuple) and len(key) == 2:
            task, mode = key
            return self.get(str(task), str(mode)) is not None
        return False

    def keys(self) -> list[str]:
        """Return all live (non-expired) cache keys (SHA-256 hashes)."""
        self._evict_expired()
        return list(self._store.keys())

    def values(self) -> list[str]:
        """Return all live cached values."""
        self._evict_expired()
        return [e.value for e in self._store.values()]

    def items(self) -> list[tuple[str, str]]:
        """Return all live (key, value) pairs."""
        self._evict_expired()
        return [(k, e.value) for k, e in self._store.items()]

    def resize(self, new_max: int) -> None:
        """Change the maximum capacity at runtime.

        If the new limit is smaller than the current entry count the oldest
        entries are evicted immediately to fit within the new budget.
        """
        if new_max < 1:
            raise ValueError("new_max must be >= 1")
        self._max = new_max
        while len(self._store) > self._max:
            oldest_key = min(self._store, key=lambda k: self._store[k].created_at)
            del self._store[oldest_key]

    def export(self) -> list[dict]:
        """Return a JSON-serialisable snapshot of all live entries."""
        self._evict_expired()
        now = time.time()
        return [
            {
                "key": k,
                "mode": e.mode,
                "value": e.value,
                "age_seconds": round(now - e.created_at, 1),
                "hits": e.hits,
            }
            for k, e in self._store.items()
        ]

    def import_(self, data: list[dict]) -> int:
        """Restore entries from a snapshot produced by ``export()``.

        Entries that would already be expired (based on their recorded age)
        are silently skipped.  Returns the number of entries imported.
        """
        imported = 0
        now = time.time()
        for item in data:
            age = item.get("age_seconds", 0)
            if age >= self._ttl:
                continue  # would already be expired — skip
            key = item["key"]
            entry = _Entry(value=item["value"], mode=item.get("mode", ""))
            entry.created_at = now - age
            entry.hits = item.get("hits", 0)
            self._evict_lru()
            self._store[key] = entry
            imported += 1
        return imported

    def __repr__(self) -> str:
        return (
            f"SynthesisCache(entries={len(self._store)}, "
            f"ttl={self._ttl}s, max={self._max})"
        )
