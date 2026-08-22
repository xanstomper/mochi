"""CacheWrapper — Intelligent response caching for LLM calls."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict, Optional
import hashlib
import json
import time
from collections import OrderedDict

@dataclass
class CacheConfig:
    max_size: int = 1000
    ttl_seconds: float = 3600.0
    enabled: bool = True

class CacheWrapper:
    def __init__(self, config: Optional[CacheConfig] = None):
        self.config = config or CacheConfig()
        self._cache: OrderedDict = OrderedDict()
        self._timestamps: Dict[str, float] = {}
        self._hits = 0
        self._misses = 0

    def _make_key(self, prompt: str, **kwargs) -> str:
        data = {"prompt": prompt, **kwargs}
        return hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()

    def get(self, prompt: str, **kwargs) -> Optional[Any]:
        if not self.config.enabled:
            return None
        key = self._make_key(prompt, **kwargs)
        if key in self._cache:
            if time.time() - self._timestamps[key] < self.config.ttl_seconds:
                self._hits += 1
                self._cache.move_to_end(key)
                return self._cache[key]
            else:
                del self._cache[key]
                del self._timestamps[key]
        self._misses += 1
        return None

    def set(self, prompt: str, response: Any, **kwargs):
        if not self.config.enabled:
            return
        key = self._make_key(prompt, **kwargs)
        self._cache[key] = response
        self._timestamps[key] = time.time()
        if len(self._cache) > self.config.max_size:
            self._cache.popitem(last=False)

    def stats(self) -> Dict:
        total = self._hits + self._misses
        return {"hits": self._hits, "misses": self._misses, "hit_rate": round(self._hits / max(total, 1), 4), "size": len(self._cache)}
