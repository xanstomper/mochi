"""InferenceEngine — Universal inference engine for all model providers."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Generator, List, Optional, Tuple, TypeVar
import time
import logging

logger = logging.getLogger(__name__)

@dataclass
class EngineConfig:
    model: str = "default"
    provider: str = "auto"
    max_tokens: int = 4096
    temperature: float = 0.1
    top_p: float = 0.95
    top_k: int = 40
    repetition_penalty: float = 1.0
    presence_penalty: float = 0.0
    frequency_penalty: float = 0.0
    stop_sequences: List[str] = field(default_factory=list)
    seed: Optional[int] = None
    num_beams: int = 1
    do_sample: bool = True
    use_cache: bool = True
    timeout: float = 60.0
    max_retries: int = 3

@dataclass
class EngineResult:
    text: str
    model: str
    provider: str
    tokens_prompt: int = 0
    tokens_completion: int = 0
    latency_ms: float = 0.0
    finish_reason: str = "stop"
    cost_usd: float = 0.0

class InferenceEngine:
    def __init__(self, config: Optional[EngineConfig] = None):
        self.config = config or EngineConfig()
        self._total_calls = 0
        self._total_latency = 0.0
        self._total_cost = 0.0

    def generate(self, prompt: str, **kwargs) -> EngineResult:
        t0 = time.time()
        merged = {k: v for k, v in self.config.__dict__.items()}
        merged.update(kwargs)
        result = self._call_model(prompt, merged)
        result.latency_ms = (time.time() - t0) * 1000
        self._total_calls += 1
        self._total_latency += result.latency_ms
        self._total_cost += result.cost_usd
        return result

    def generate_stream(self, prompt: str, **kwargs) -> Generator[str, None, EngineResult]:
        t0 = time.time()
        merged = {k: v for k, v in self.config.__dict__.items()}
        merged.update(kwargs)
        full_text = ""
        for chunk in self._stream_model(prompt, merged):
            full_text += chunk
            yield chunk
        result = EngineResult(text=full_text, model=self.config.model, provider=self.config.provider,
                              latency_ms=(time.time()-t0)*1000)
        return result

    def _call_model(self, prompt: str, config: Dict) -> EngineResult:
        from lazy_chameleon.bridges import ProviderRegistry
        registry = ProviderRegistry()
        bridge = registry.get_bridge(config.get("provider", self.config.provider))
        response = bridge.generate(prompt, **config)
        return EngineResult(
            text=response.content, model=response.model,
            provider=config.get("provider", self.config.provider),
            tokens_prompt=response.usage.prompt_tokens,
            tokens_completion=response.usage.completion_tokens,
        )

    def _stream_model(self, prompt: str, config: Dict) -> Generator[str, None, None]:
        from lazy_chameleon.bridges import ProviderRegistry
        registry = ProviderRegistry()
        bridge = registry.get_bridge(config.get("provider", self.config.provider))
        for chunk in bridge.generate_stream(prompt, **config):
            yield chunk.content

    def get_stats(self) -> Dict:
        return {"total_calls": self._total_calls, "total_latency_ms": round(self._total_latency, 2),
                "total_cost_usd": round(self._total_cost, 6), "avg_latency_ms": round(self._total_latency / max(self._total_calls, 1), 2)}
