"""
Provider Bridge Package — Lazy Chameleon v2.2

Abstraction layer over LLM providers with unified interfaces for
generate, generate_stream, count_tokens, estimate_cost, and get_model_list.

Bridges
-------
- OpenAIBridge        GPT-4o, o3, o4-mini, GPT-5.x series
- AnthropicBridge     Claude Opus 4.5-4.8, Sonnet 4.6-5, Fable 5, Haiku
- DeepSeekBridge      DeepSeek R1, V3, V2 MoE
- GoogleBridge        Gemini 2.5 Pro, Gemini 3.1 Pro/Flash
- GrokBridge          Grok 4, Grok 4.4, Grok 4.5
- TogetherBridge      Llama 4 Maverick, Qwen3
- ZhipuBridge         GLM 5, GLM 5.1, GLM 5.2
- OpenRouterBridge    Aggregator for all models
"""

from __future__ import annotations

from .base import (
    BaseProviderBridge,
    BridgeConfig,
    BridgeResponse,
    BridgeStreamEvent,
    TokenUsage,
    RateLimitExceeded,
    AuthError,
    TimeoutError,
    ServerError,
    BridgeError,
    count_tokens_heuristic,
    estimate_cost_heuristic,
    with_exponential_backoff,
)
from .openai_bridge import OpenAIBridge, OpenAIStreamHandler, GPT5Config
from .anthropic_bridge import AnthropicBridge, AnthropicStreamHandler, ClaudeThinkingHandler
from .deepseek_bridge import DeepSeekBridge, DeepSeekStreamHandler
from .google_bridge import GoogleBridge, GeminiStreamHandler
from .xai_bridge import GrokBridge, GrokStreamHandler
from .together_bridge import TogetherBridge, TogetherStreamHandler
from .zhipu_bridge import ZhipuBridge, GLMStreamHandler
from .openrouter_bridge import OpenRouterBridge, OpenRouterStreamHandler
from .registry import ProviderRegistry, ModelCatalog, PricingTable, RateLimitConfig

__all__ = [
    # Base
    "BaseProviderBridge",
    "BridgeConfig",
    "BridgeResponse",
    "BridgeStreamEvent",
    "TokenUsage",
    "RateLimitExceeded",
    "AuthError",
    "TimeoutError",
    "ServerError",
    "BridgeError",
    "count_tokens_heuristic",
    "estimate_cost_heuristic",
    "with_exponential_backoff",
    # OpenAI
    "OpenAIBridge",
    "OpenAIStreamHandler",
    "GPT5Config",
    # Anthropic
    "AnthropicBridge",
    "AnthropicStreamHandler",
    "ClaudeThinkingHandler",
    # DeepSeek
    "DeepSeekBridge",
    "DeepSeekStreamHandler",
    # Google
    "GoogleBridge",
    "GeminiStreamHandler",
    # xAI
    "GrokBridge",
    "GrokStreamHandler",
    # Together
    "TogetherBridge",
    "TogetherStreamHandler",
    # Zhipu
    "ZhipuBridge",
    "GLMStreamHandler",
    # OpenRouter
    "OpenRouterBridge",
    "OpenRouterStreamHandler",
    # Registry
    "ProviderRegistry",
    "ModelCatalog",
    "PricingTable",
    "RateLimitConfig",
]
