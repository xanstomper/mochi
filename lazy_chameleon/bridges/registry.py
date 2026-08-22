"""
Provider Registry — Maps model names to bridges, catalogs capabilities, pricing, and rate limits.

Components
---------
- ProviderRegistry — Factory: model name → bridge instance
- ModelCatalog — All models with metadata and capabilities
- PricingTable — Per-model USD pricing
- RateLimitConfig — Per-provider rate limit presets
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple, Type

from .base import BaseProviderBridge, BridgeConfig

log = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════════
# Pricing Table
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class PricingEntry:
    """Pricing for a single model.

    Attributes:
        input_per_1k:   Cost per 1,000 input tokens (USD).
        output_per_1k:  Cost per 1,000 output tokens (USD).
        cached_input_per_1k: Cost per 1,000 cached input tokens (USD).
    """

    input_per_1k: float
    output_per_1k: float
    cached_input_per_1k: float = 0.0

    @property
    def input_token_cost(self) -> float:
        return self.input_per_1k / 1000.0

    @property
    def output_token_cost(self) -> float:
        return self.output_per_1k / 1000.0

    def cost_for(self, input_tokens: int, output_tokens: int, cached_tokens: int = 0) -> float:
        """Compute total cost for given token counts."""
        cost = (input_tokens - cached_tokens) * self.input_token_cost
        cost += cached_tokens * (self.cached_input_per_1k / 1000.0 if self.cached_input_per_1k else self.input_token_cost)
        cost += output_tokens * self.output_token_cost
        return cost


class PricingTable:
    """Central pricing table for all known models.

    Provides per-model cost lookups and calculations.
    """

    _instance: Optional[PricingTable] = None
    _lock: threading.Lock = threading.Lock()

    def __init__(self) -> None:
        self._entries: Dict[str, PricingEntry] = {}
        self._load_defaults()

    @classmethod
    def get_instance(cls) -> PricingTable:
        """Singleton accessor."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def _load_defaults(self) -> None:
        """Load default pricing for all known models."""
        defaults: Dict[str, Tuple[float, float, float]] = {
            # OpenAI
            "gpt-4o":          (0.0025, 0.010, 0.00125),
            "gpt-4o-mini":     (0.00015, 0.0006, 0.000075),
            "gpt-4.1":         (0.0025, 0.010, 0.00125),
            "o1":              (0.015, 0.060, 0.0075),
            "o1-mini":         (0.0011, 0.0044, 0.00055),
            "o3-mini":         (0.0011, 0.0044, 0.00055),
            "o4-mini":         (0.0004, 0.0016, 0.0002),
            "gpt-5.3":         (0.0020, 0.008, 0.0010),
            "gpt-5.4":         (0.0015, 0.006, 0.00075),
            "gpt-5.5":         (0.0030, 0.012, 0.0015),
            "gpt-5.6":         (0.0040, 0.016, 0.0020),
            # Anthropic
            "claude-opus":     (0.015, 0.075, 0.0075),
            "claude-sonnet":   (0.003, 0.015, 0.0015),
            "claude-haiku":    (0.00025, 0.00125, 0.000125),
            "claude-fable":    (0.005, 0.025, 0.0025),
            # DeepSeek
            "deepseek-r1":     (0.00055, 0.00219, 0.000275),
            "deepseek-v3":     (0.00027, 0.00110, 0.000135),
            "deepseek-v2":     (0.00022, 0.00076, 0.00011),
            "deepseek-chat":   (0.00027, 0.00110, 0.000135),
            "deepseek-coder":  (0.00027, 0.00110, 0.000135),
            # Google
            "gemini-2.5":      (0.0005, 0.0020, 0.00025),
            "gemini-3":        (0.0005, 0.0020, 0.00025),
            # xAI
            "grok-4":          (0.003, 0.015, 0.0015),
            "grok-4.4":        (0.003, 0.015, 0.0015),
            "grok-4.5":        (0.005, 0.025, 0.0025),
            # Together
            "llama-4":         (0.0002, 0.0006, 0.0001),
            "qwen3":           (0.0002, 0.0006, 0.0001),
            # Zhipu
            "glm-5":           (0.0005, 0.0020, 0.00025),
            "glm-5.1":         (0.0005, 0.0020, 0.00025),
            "glm-5.2":         (0.0008, 0.0030, 0.0004),
            # OpenRouter
            "openrouter":      (0.001, 0.003, 0.0005),
        }

        for key, (inp, out, cached) in defaults.items():
            self._entries[key] = PricingEntry(
                input_per_1k=inp,
                output_per_1k=out,
                cached_input_per_1k=cached,
            )

    def register(self, model_key: str, pricing: PricingEntry) -> None:
        """Register or update pricing for a model."""
        self._entries[model_key] = pricing

    def get(self, model: str) -> Optional[PricingEntry]:
        """Look up pricing for a model by matching substrings."""
        model_lower = model.lower()
        for key, entry in self._entries.items():
            if key in model_lower:
                return entry
        return None

    def get_exact(self, model: str) -> Optional[PricingEntry]:
        """Look up pricing by exact model key."""
        model_lower = model.lower()
        if model_lower in self._entries:
            return self._entries[model_lower]
        # Try with stripped provider prefix
        if "/" in model_lower:
            stripped = model_lower.split("/", 1)[1]
            if stripped in self._entries:
                return self._entries[stripped]
        return None

    def calculate_cost(
        self,
        model: str,
        input_tokens: int,
        output_tokens: int,
        cached_tokens: int = 0,
    ) -> float:
        """Calculate cost for a given model and token counts."""
        entry = self.get(model)
        if entry is None:
            # Fallback: estimate at default rate
            return (input_tokens * 0.0000015) + (output_tokens * 0.000006)
        return entry.cost_for(input_tokens, output_tokens, cached_tokens)

    def list_pricing(self) -> Dict[str, Dict[str, float]]:
        """Return all registered pricing as dict."""
        return {
            k: {
                "input_per_1k": v.input_per_1k,
                "output_per_1k": v.output_per_1k,
                "cached_input_per_1k": v.cached_input_per_1k,
            }
            for k, v in self._entries.items()
        }


# ═══════════════════════════════════════════════════════════════════════════════
# Rate Limit Configuration
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class RateLimitConfig:
    """Rate limit configuration per provider.

    Attributes:
        requests_per_minute: Maximum requests per minute.
        tokens_per_minute:   Maximum tokens per minute.
        burst_multiplier:    Short burst headroom multiplier.
        concurrent_limit:    Maximum concurrent requests.
    """

    requests_per_minute: int = 30
    tokens_per_minute: int = 100_000
    burst_multiplier: float = 1.5
    concurrent_limit: int = 10

    @property
    def requests_per_second(self) -> float:
        return self.requests_per_minute / 60.0

    @property
    def tokens_per_second(self) -> float:
        return self.tokens_per_minute / 60.0

    @property
    def burst_requests(self) -> int:
        return int(self.requests_per_minute * self.burst_multiplier)

    @property
    def burst_tokens(self) -> int:
        return int(self.tokens_per_minute * self.burst_multiplier)


# Default rate limit presets per provider
PROVIDER_RATE_LIMITS: Dict[str, RateLimitConfig] = {
    "openai": RateLimitConfig(
        requests_per_minute=60,
        tokens_per_minute=500_000,
        concurrent_limit=50,
    ),
    "anthropic": RateLimitConfig(
        requests_per_minute=50,
        tokens_per_minute=100_000,
        concurrent_limit=20,
    ),
    "deepseek": RateLimitConfig(
        requests_per_minute=60,
        tokens_per_minute=500_000,
        concurrent_limit=50,
    ),
    "google": RateLimitConfig(
        requests_per_minute=30,
        tokens_per_minute=100_000,
        concurrent_limit=10,
    ),
    "xai": RateLimitConfig(
        requests_per_minute=30,
        tokens_per_minute=100_000,
        concurrent_limit=10,
    ),
    "together": RateLimitConfig(
        requests_per_minute=60,
        tokens_per_minute=300_000,
        concurrent_limit=30,
    ),
    "zhipu": RateLimitConfig(
        requests_per_minute=30,
        tokens_per_minute=100_000,
        concurrent_limit=10,
    ),
    "openrouter": RateLimitConfig(
        requests_per_minute=20,
        tokens_per_minute=200_000,
        concurrent_limit=10,
    ),
    "default": RateLimitConfig(
        requests_per_minute=30,
        tokens_per_minute=100_000,
        concurrent_limit=10,
    ),
}


def get_rate_limit(provider: str) -> RateLimitConfig:
    """Get rate limit config for a provider, falling back to default."""
    return PROVIDER_RATE_LIMITS.get(provider.lower(), PROVIDER_RATE_LIMITS["default"])


# ═══════════════════════════════════════════════════════════════════════════════
# Model Catalog
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class ModelInfo:
    """Metadata and capabilities for a model.

    Attributes:
        id:                  Canonical model identifier.
        provider:            Provider name.
        description:         Human-readable description.
        max_input_tokens:    Maximum input context length.
        max_output_tokens:   Maximum output token count.
        supports_streaming:  Whether streaming is supported.
        supports_vision:     Whether image inputs are supported.
        supports_tools:      Whether function/tool calling is supported.
        supports_reasoning:  Whether reasoning mode is supported.
        supports_structured_output: Whether structured JSON output is supported.
        family:              Model family group.
        pricing:             Optional per-1k pricing tuple (input, output).
    """

    id: str
    provider: str
    description: str = ""
    max_input_tokens: int = 128000
    max_output_tokens: int = 8192
    supports_streaming: bool = True
    supports_vision: bool = False
    supports_tools: bool = False
    supports_reasoning: bool = False
    supports_structured_output: bool = False
    family: str = ""
    pricing: Optional[Tuple[float, float]] = None


class ModelCatalog:
    """Catalog of all known models with their capabilities.

    Provides lookup, filtering, and discovery of models.
    """

    _instance: Optional[ModelCatalog] = None
    _lock: threading.Lock = threading.Lock()

    def __init__(self) -> None:
        self._models: Dict[str, ModelInfo] = {}
        self._load_defaults()

    @classmethod
    def get_instance(cls) -> ModelCatalog:
        """Singleton accessor."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def _load_defaults(self) -> None:
        """Load default model catalog entries."""
        defaults: List[ModelInfo] = [
            # OpenAI
            ModelInfo(id="gpt-4o", provider="openai", description="GPT-4 Omni",
                      max_input_tokens=128000, max_output_tokens=16384,
                      supports_vision=True, supports_tools=True, supports_structured_output=True,
                      family="gpt-4o", pricing=(0.0025, 0.010)),
            ModelInfo(id="gpt-4o-mini", provider="openai", description="GPT-4 Omni Mini",
                      max_input_tokens=128000, max_output_tokens=16384,
                      supports_vision=True, supports_tools=True, supports_structured_output=True,
                      family="gpt-4o", pricing=(0.00015, 0.0006)),
            ModelInfo(id="gpt-4.1", provider="openai", description="GPT-4.1",
                      max_input_tokens=128000, max_output_tokens=16384,
                      supports_vision=True, supports_tools=True,
                      family="gpt-4", pricing=(0.0025, 0.010)),
            ModelInfo(id="o1", provider="openai", description="o1 reasoning",
                      max_input_tokens=200000, max_output_tokens=100000,
                      supports_reasoning=True, supports_vision=True,
                      family="o-series", pricing=(0.015, 0.060)),
            ModelInfo(id="o3-mini", provider="openai", description="o3-mini reasoning",
                      max_input_tokens=200000, max_output_tokens=100000,
                      supports_reasoning=True,
                      family="o-series", pricing=(0.0011, 0.0044)),
            ModelInfo(id="o4-mini", provider="openai", description="o4-mini reasoning",
                      max_input_tokens=200000, max_output_tokens=100000,
                      supports_reasoning=True,
                      family="o-series", pricing=(0.0004, 0.0016)),
            ModelInfo(id="gpt-5.3", provider="openai", description="GPT-5.3 fast",
                      max_input_tokens=256000, max_output_tokens=32768,
                      supports_vision=True, supports_tools=True, supports_reasoning=True,
                      family="gpt-5", pricing=(0.0020, 0.008)),
            ModelInfo(id="gpt-5.4", provider="openai", description="GPT-5.4 balanced",
                      max_input_tokens=256000, max_output_tokens=65536,
                      supports_vision=True, supports_tools=True, supports_reasoning=True,
                      family="gpt-5", pricing=(0.0015, 0.006)),
            ModelInfo(id="gpt-5.5", provider="openai", description="GPT-5.5 high-intelligence",
                      max_input_tokens=512000, max_output_tokens=131072,
                      supports_vision=True, supports_tools=True, supports_reasoning=True,
                      family="gpt-5", pricing=(0.0030, 0.012)),
            ModelInfo(id="gpt-5.6", provider="openai", description="GPT-5.6 frontier",
                      max_input_tokens=1048576, max_output_tokens=262144,
                      supports_vision=True, supports_tools=True, supports_reasoning=True,
                      family="gpt-5", pricing=(0.0040, 0.016)),
            # Anthropic
            ModelInfo(id="claude-opus-4-5-20251001", provider="anthropic",
                      description="Claude Opus 4.5",
                      max_input_tokens=200000, max_output_tokens=16384,
                      supports_vision=True, supports_tools=True, supports_reasoning=True,
                      family="opus", pricing=(0.015, 0.075)),
            ModelInfo(id="claude-opus-4-8", provider="anthropic",
                      description="Claude Opus 4.8",
                      max_input_tokens=200000, max_output_tokens=32768,
                      supports_vision=True, supports_tools=True, supports_reasoning=True,
                      family="opus", pricing=(0.015, 0.075)),
            ModelInfo(id="claude-sonnet-5", provider="anthropic",
                      description="Claude Sonnet 5",
                      max_input_tokens=200000, max_output_tokens=32768,
                      supports_vision=True, supports_tools=True, supports_reasoning=True,
                      family="sonnet", pricing=(0.003, 0.015)),
            ModelInfo(id="claude-fable-5", provider="anthropic",
                      description="Claude Fable 5",
                      max_input_tokens=200000, max_output_tokens=65536,
                      supports_vision=True, supports_tools=True, supports_reasoning=True,
                      family="fable", pricing=(0.005, 0.025)),
            ModelInfo(id="claude-haiku-4-5-20251001", provider="anthropic",
                      description="Claude Haiku 4.5",
                      max_input_tokens=200000, max_output_tokens=8192,
                      supports_vision=True, supports_tools=True,
                      family="haiku", pricing=(0.00025, 0.00125)),
            # DeepSeek
            ModelInfo(id="deepseek-r1", provider="deepseek", description="DeepSeek-R1 reasoning",
                      max_input_tokens=128000, max_output_tokens=8192,
                      supports_reasoning=True,
                      family="r1", pricing=(0.00055, 0.00219)),
            ModelInfo(id="deepseek-v3", provider="deepseek", description="DeepSeek-V3",
                      max_input_tokens=128000, max_output_tokens=8192,
                      family="v3", pricing=(0.00027, 0.00110)),
            ModelInfo(id="deepseek-v2", provider="deepseek", description="DeepSeek-V2 MoE",
                      max_input_tokens=128000, max_output_tokens=8192,
                      family="v2", pricing=(0.00022, 0.00076)),
            # Google
            ModelInfo(id="gemini-2.5-pro", provider="google", description="Gemini 2.5 Pro",
                      max_input_tokens=1048576, max_output_tokens=65536,
                      supports_vision=True, supports_tools=True,
                      family="gemini-2.5", pricing=(0.0005, 0.0020)),
            ModelInfo(id="gemini-3.1-pro", provider="google", description="Gemini 3.1 Pro",
                      max_input_tokens=2097152, max_output_tokens=131072,
                      supports_vision=True, supports_tools=True,
                      family="gemini-3", pricing=(0.0005, 0.0020)),
            ModelInfo(id="gemini-3.1-flash", provider="google", description="Gemini 3.1 Flash",
                      max_input_tokens=1048576, max_output_tokens=65536,
                      supports_vision=True, supports_tools=True,
                      family="gemini-3", pricing=(0.00015, 0.0006)),
            # xAI
            ModelInfo(id="grok-4", provider="xai", description="Grok 4",
                      max_input_tokens=131072, max_output_tokens=8192,
                      family="grok-4", pricing=(0.003, 0.015)),
            ModelInfo(id="grok-4.5", provider="xai", description="Grok 4.5 frontier",
                      max_input_tokens=262144, max_output_tokens=32768,
                      supports_vision=True,
                      family="grok-4", pricing=(0.005, 0.025)),
            # Together
            ModelInfo(id="meta-llama/Llama-4-Maverick-17B-128E", provider="together",
                      description="Llama 4 Maverick MoE",
                      max_input_tokens=131072, max_output_tokens=8192,
                      supports_tools=True,
                      family="llama", pricing=(0.0002, 0.0006)),
            ModelInfo(id="Qwen/Qwen3-235B-A22B", provider="together",
                      description="Qwen3 235B MoE",
                      max_input_tokens=131072, max_output_tokens=8192,
                      supports_tools=True,
                      family="qwen", pricing=(0.0002, 0.0006)),
            # Zhipu
            ModelInfo(id="glm-5", provider="zhipu", description="GLM-5",
                      max_input_tokens=131072, max_output_tokens=8192,
                      supports_tools=True,
                      family="glm-5", pricing=(0.0005, 0.0020)),
            ModelInfo(id="glm-5.2", provider="zhipu", description="GLM-5.2 frontier",
                      max_input_tokens=262144, max_output_tokens=32768,
                      supports_vision=True, supports_tools=True,
                      family="glm-5", pricing=(0.0008, 0.0030)),
            # OpenRouter
            ModelInfo(id="openrouter/auto", provider="openrouter", description="OpenRouter auto",
                      max_input_tokens=200000, max_output_tokens=65536,
                      family="openrouter", pricing=(0.001, 0.003)),
        ]

        for m in defaults:
            self._models[m.id] = m

    def register(self, model: ModelInfo) -> None:
        """Register a model in the catalog."""
        self._models[model.id] = model

    def get(self, model_id: str) -> Optional[ModelInfo]:
        """Get model info by exact ID."""
        return self._models.get(model_id)

    def find(self, query: str) -> List[ModelInfo]:
        """Find models matching a query substring."""
        q = query.lower()
        results = []
        for model in self._models.values():
            if q in model.id.lower() or q in model.description.lower():
                results.append(model)
        return results

    def list_by_provider(self, provider: str) -> List[ModelInfo]:
        """List all models from a specific provider."""
        p = provider.lower()
        return [m for m in self._models.values() if m.provider == p]

    def list_by_capability(self, capability: str) -> List[ModelInfo]:
        """List models supporting a given capability."""
        cap = capability.lower()
        results = []
        for model in self._models.values():
            if cap == "vision" and model.supports_vision:
                results.append(model)
            elif cap == "tools" and model.supports_tools:
                results.append(model)
            elif cap == "reasoning" and model.supports_reasoning:
                results.append(model)
            elif cap == "streaming" and model.supports_streaming:
                results.append(model)
            elif cap == "structured_output" and model.supports_structured_output:
                results.append(model)
        return results

    def all_models(self) -> List[ModelInfo]:
        """Return all registered models."""
        return list(self._models.values())

    def all_ids(self) -> List[str]:
        """Return all registered model IDs."""
        return list(self._models.keys())

    def all_providers(self) -> List[str]:
        """Return all provider names in the catalog."""
        return sorted(set(m.provider for m in self._models.values()))


# ═══════════════════════════════════════════════════════════════════════════════
# Provider Registry
# ═══════════════════════════════════════════════════════════════════════════════


class ProviderRegistry:
    """Maps model names / provider strings to bridge instances.

    Acts as a factory and cache for bridge instances.
    """

    _instance: Optional[ProviderRegistry] = None
    _lock: threading.Lock = threading.Lock()

    def __init__(self) -> None:
        self._bridges: Dict[str, BaseProviderBridge] = {}
        self._model_to_provider: Dict[str, str] = {}
        self._load_default_mappings()

    @classmethod
    def get_instance(cls) -> ProviderRegistry:
        """Singleton accessor."""
        if cls._instance is None:
            with cls._lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def _load_default_mappings(self) -> None:
        """Load default model-to-provider mappings."""
        for model_id, info in self._get_default_catalog().items():
            self._model_to_provider[model_id] = info["provider"]

    @staticmethod
    def _get_default_catalog() -> Dict[str, Dict[str, str]]:
        return {
            # OpenAI
            "gpt-4o":           {"provider": "openai"},
            "gpt-4o-mini":      {"provider": "openai"},
            "gpt-4.1":          {"provider": "openai"},
            "o1":               {"provider": "openai"},
            "o1-mini":          {"provider": "openai"},
            "o3-mini":          {"provider": "openai"},
            "o4-mini":          {"provider": "openai"},
            "gpt-5.3":          {"provider": "openai"},
            "gpt-5.4":          {"provider": "openai"},
            "gpt-5.5":          {"provider": "openai"},
            "gpt-5.6":          {"provider": "openai"},
            # Anthropic
            "claude-opus":      {"provider": "anthropic"},
            "claude-sonnet":    {"provider": "anthropic"},
            "claude-haiku":     {"provider": "anthropic"},
            "claude-fable":     {"provider": "anthropic"},
            # DeepSeek
            "deepseek":         {"provider": "deepseek"},
            # Google
            "gemini":           {"provider": "google"},
            # xAI
            "grok":             {"provider": "xai"},
            # Together
            "llama":            {"provider": "together"},
            "qwen":             {"provider": "together"},
            # Zhipu
            "glm":              {"provider": "zhipu"},
            # OpenRouter
            "openrouter":       {"provider": "openrouter"},
        }

    def _import_bridge_class(self, provider: str) -> Type[BaseProviderBridge]:
        """Dynamically import the bridge class for a provider."""
        from .openai_bridge import OpenAIBridge
        from .anthropic_bridge import AnthropicBridge
        from .deepseek_bridge import DeepSeekBridge
        from .google_bridge import GoogleBridge
        from .xai_bridge import GrokBridge
        from .together_bridge import TogetherBridge
        from .zhipu_bridge import ZhipuBridge
        from .openrouter_bridge import OpenRouterBridge

        mapping: Dict[str, Type[BaseProviderBridge]] = {
            "openai": OpenAIBridge,
            "anthropic": AnthropicBridge,
            "deepseek": DeepSeekBridge,
            "google": GoogleBridge,
            "xai": GrokBridge,
            "together": TogetherBridge,
            "zhipu": ZhipuBridge,
            "openrouter": OpenRouterBridge,
        }

        cls = mapping.get(provider.lower())
        if cls is None:
            raise ValueError(f"Unknown provider: {provider}. Known: {list(mapping.keys())}")
        return cls

    def detect_provider(self, model: str) -> str:
        """Detect provider from a model string."""
        model_lower = model.lower()

        # Direct lookup
        if model_lower in self._model_to_provider:
            return self._model_to_provider[model_lower]

        # Substring matching
        for key, info in self._get_default_catalog().items():
            if key in model_lower:
                return info["provider"]

        # Provider prefix in model name (e.g. anthropic/claude-sonnet-5)
        if "/" in model_lower:
            prefix = model_lower.split("/")[0]
            if prefix in ("openai", "anthropic", "deepseek", "google", "xai", "together", "zhipu", "openrouter"):
                return prefix

        # Fallback: OpenAI-compatible
        return "openai"

    def register_bridge(self, key: str, bridge: BaseProviderBridge) -> None:
        """Register a bridge instance under a given key."""
        self._bridges[key] = bridge

    def get_bridge(
        self,
        model: Optional[str] = None,
        provider: Optional[str] = None,
        config: Optional[BridgeConfig] = None,
    ) -> BaseProviderBridge:
        """Get a bridge instance for the given model or provider.

        Args:
            model:    Model name to detect provider from.
            provider: Explicit provider name (overrides model detection).
            config:   Configuration for the bridge.

        Returns:
            A bridge instance (may be cached).
        """
        if provider:
            prov = provider.lower()
        elif model:
            prov = self.detect_provider(model)
        else:
            prov = "openai"

        cache_key = f"{prov}:{config.default_model if config else ''}"

        # Return cached bridge if available
        if cache_key in self._bridges:
            return self._bridges[cache_key]

        # Create new bridge
        bridge_cls = self._import_bridge_class(prov)

        if config is None:
            env_key_map = {
                "openai": "OPENAI_API_KEY",
                "anthropic": "ANTHROPIC_API_KEY",
                "deepseek": "DEEPSEEK_API_KEY",
                "google": "GOOGLE_API_KEY",
                "xai": "XAI_API_KEY",
                "together": "TOGETHER_API_KEY",
                "zhipu": "ZHIPU_API_KEY",
                "openrouter": "OPENROUTER_API_KEY",
            }
            api_key = os.environ.get(env_key_map.get(prov, ""), "")
            config = BridgeConfig(api_key=api_key)

        bridge = bridge_cls(config=config)

        # Cache the bridge
        self._bridges[cache_key] = bridge
        return bridge

    def get_or_create(
        self,
        provider: str,
        config: Optional[BridgeConfig] = None,
        **kwargs: Any,
    ) -> BaseProviderBridge:
        """Get or create a bridge by provider name."""
        prov = provider.lower()
        return self.get_bridge(provider=prov, config=config)

    def list_registered(self) -> List[str]:
        """List all registered bridge keys."""
        return list(self._bridges.keys())

    def clear_cache(self) -> None:
        """Clear all cached bridge instances."""
        self._bridges.clear()

    def close_all(self) -> None:
        """Close all cached bridge instances."""
        for bridge in self._bridges.values():
            try:
                bridge.close()
            except Exception as e:
                log.warning("Error closing bridge %s: %s", bridge, e)
        self._bridges.clear()
