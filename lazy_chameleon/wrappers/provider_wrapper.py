"""ProviderWrapper — Unified wrapper around all LLM providers."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
import logging

logger = logging.getLogger(__name__)

@dataclass
class WrapperConfig:
    default_provider: str = "auto"
    timeout: float = 60.0
    max_retries: int = 3
    cache_enabled: bool = True
    stream: bool = False

class ProviderWrapper:
    def __init__(self, config: Optional[WrapperConfig] = None):
        self.config = config or WrapperConfig()
        self._providers: Dict[str, Any] = {}
        self._stats: Dict[str, int] = {}

    def get_provider(self, name: str = None):
        name = name or self.config.default_provider
        if name == "auto":
            name = self._select_best_provider()
        if name not in self._providers:
            from lazy_chameleon.bridges import ProviderRegistry
            self._providers[name] = ProviderRegistry().get_bridge(name)
        return self._providers[name]

    def generate(self, prompt: str, provider: str = None):
        p = self.get_provider(provider)
        self._stats[p.provider] = self._stats.get(p.provider, 0) + 1
        return p.generate(prompt)

    def _select_best_provider(self) -> str:
        return "single_model"

    def get_stats(self) -> Dict:
        return dict(self._stats)
