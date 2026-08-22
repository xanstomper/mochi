"""API Adapters — Provider-specific API adapters with retry, streaming, and cost tracking."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import random
import re
import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Callable, Dict, Generator, Iterator, List, Optional, Tuple, TypeVar, Union

logger = logging.getLogger(__name__)

T = TypeVar("T")


# ═════════════════════════════════════════════════════════════════════════════
# EXCEPTIONS
# ═════════════════════════════════════════════════════════════════════════════

class AdapterError(Exception):
    """Base exception for all adapter errors."""
    pass

class AuthError(AdapterError):
    """Authentication failure."""
    pass

class RateLimitError(AdapterError):
    """Rate limit exceeded."""
    pass

class TimeoutError(AdapterError):
    """Request timed out."""
    pass

class ServerError(AdapterError):
    """Server returned an error."""
    def __init__(self, status_code: int, message: str = ""):
        self.status_code = status_code
        super().__init__(f"Server error {status_code}: {message}")

class StreamError(AdapterError):
    """Error during streaming."""
    pass

class ConfigurationError(AdapterError):
    """Invalid configuration."""
    pass


# ═════════════════════════════════════════════════════════════════════════════
# DATA CLASSES
# ═════════════════════════════════════════════════════════════════════════════

@dataclass
class TokenUsage:
    """Token usage tracking for API calls."""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cached_tokens: int = 0
    
    def __post_init__(self):
        self.total_tokens = self.prompt_tokens + self.completion_tokens
    
    @property
    def cost_usd(self) -> float:
        """Estimate cost in USD using default rates."""
        return (self.prompt_tokens * 0.0000015 + self.completion_tokens * 0.000006)
    
    def merge(self, other: TokenUsage) -> TokenUsage:
        """Merge with another usage record."""
        return TokenUsage(
            prompt_tokens=self.prompt_tokens + other.prompt_tokens,
            completion_tokens=self.completion_tokens + other.completion_tokens,
            cached_tokens=self.cached_tokens + other.cached_tokens,
        )


@dataclass
class AdapterResponse:
    """Standardized response from any API adapter."""
    content: str
    model: str
    usage: TokenUsage = field(default_factory=TokenUsage)
    latency_ms: float = 0.0
    finish_reason: str = "stop"
    raw_response: Optional[Dict[str, Any]] = None
    
    @property
    def success(self) -> bool:
        return bool(self.content and len(self.content) > 0)


@dataclass
class StreamChunk:
    """A single chunk from a streaming response."""
    content: str = ""
    finish_reason: Optional[str] = None
    usage: Optional[TokenUsage] = None
    model: str = ""


@dataclass
class RetryConfig:
    """Configuration for retry behavior."""
    max_retries: int = 3
    base_delay: float = 1.0
    max_delay: float = 60.0
    backoff_factor: float = 2.0
    retry_on_status: Tuple[int, ...] = (429, 500, 502, 503, 504)
    retry_on_exceptions: Tuple[type, ...] = (TimeoutError, ConnectionError)


@dataclass
class AdapterConfig:
    """Configuration for an API adapter."""
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    max_tokens: int = 4096
    temperature: float = 0.1
    top_p: float = 0.95
    timeout: float = 60.0
    max_retries: int = 3
    stream: bool = False
    organization: str = ""
    extra_headers: Dict[str, str] = field(default_factory=dict)
    extra_body: Dict[str, Any] = field(default_factory=dict)


# ═════════════════════════════════════════════════════════════════════════════
# RETRY UTILITY
# ═════════════════════════════════════════════════════════════════════════════

def with_retry(
    fn: Callable[..., T],
    config: RetryConfig = None,
    **kwargs,
) -> T:
    """Execute a function with exponential backoff retry."""
    if config is None:
        config = RetryConfig()
    
    last_exception = None
    for attempt in range(config.max_retries + 1):
        try:
            return fn(**kwargs)
        except (RateLimitError, ServerError, TimeoutError, ConnectionError) as e:
            last_exception = e
            if attempt >= config.max_retries:
                raise
            delay = min(
                config.base_delay * (config.backoff_factor ** attempt) + random.random() * 0.1,
                config.max_delay,
            )
            logger.warning(
                "Retry %d/%d after %s: %s (retrying in %.1fs)",
                attempt + 1, config.max_retries, type(e).__name__, e, delay,
            )
            time.sleep(delay)
    
    raise last_exception  # type: ignore[misc]


# ═════════════════════════════════════════════════════════════════════════════
# TOKEN COUNTER
# ═════════════════════════════════════════════════════════════════════════════

def count_tokens(text: str, model: str = "default") -> int:
    """Estimate token count for a text string.
    
    Uses a simple heuristic: ~4 chars per token for most models.
    For specific models, applies model-specific adjustments.
    """
    if not text:
        return 0
    
    char_count = len(text)
    
    # Model-specific adjustments
    model_multipliers = {
        "claude": 3.5,
        "gpt": 4.0,
        "gemini": 4.0,
        "deepseek": 3.8,
        "grok": 4.2,
        "llama": 4.0,
        "qwen": 3.8,
        "glm": 3.5,
        "mistral": 4.0,
    }
    
    multiplier = 4.0  # default
    for key, val in model_multipliers.items():
        if key in model.lower():
            multiplier = val
            break
    
    estimated = int(char_count / multiplier)
    return max(1, estimated)

def count_messages_tokens(messages: List[Dict[str, str]], model: str = "default") -> int:
    """Count tokens for a list of messages."""
    total = 0
    per_message_overhead = 4  # <im_start>, <im_end>, role markers
    
    for msg in messages:
        total += per_message_overhead
        total += count_tokens(msg.get("content", ""), model)
        total += count_tokens(msg.get("role", ""), model)
    
    # Final overhead
    total += 2  # <|im_start|>assistant
    return total


# ═════════════════════════════════════════════════════════════════════════════
# COST ESTIMATOR
# ═════════════════════════════════════════════════════════════════════════════

MODEL_PRICING: Dict[str, Dict[str, float]] = {
    # Anthropic
    "claude-opus-4-8": {"input": 15.0, "output": 75.0},
    "claude-opus-4-7": {"input": 15.0, "output": 75.0},
    "claude-opus-4-6": {"input": 15.0, "output": 75.0},
    "claude-opus-4-5": {"input": 15.0, "output": 75.0},
    "claude-sonnet-5": {"input": 3.0, "output": 15.0},
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
    "claude-fable-5": {"input": 25.0, "output": 125.0},
    "claude-haiku-4-5": {"input": 0.8, "output": 4.0},
    # OpenAI
    "gpt-5.5": {"input": 15.0, "output": 60.0},
    "gpt-5.4": {"input": 10.0, "output": 40.0},
    "gpt-5.3": {"input": 10.0, "output": 40.0},
    "gpt-5.6": {"input": 20.0, "output": 80.0},
    "gpt-4o": {"input": 2.5, "output": 10.0},
    "gpt-4o-mini": {"input": 0.15, "output": 0.6},
    "o3": {"input": 10.0, "output": 40.0},
    "o4-mini": {"input": 1.1, "output": 4.4},
    # DeepSeek
    "deepseek-reasoner": {"input": 0.55, "output": 2.19},
    "deepseek-r1": {"input": 0.55, "output": 2.19},
    "deepseek-v3": {"input": 0.27, "output": 1.10},
    "deepseek-v2": {"input": 0.22, "output": 0.89},
    # Google
    "gemini-3.1-pro": {"input": 5.0, "output": 20.0},
    "gemini-3.1-flash": {"input": 0.5, "output": 2.0},
    "gemini-2.5-pro": {"input": 1.25, "output": 5.0},
    "gemini-2.0-flash": {"input": 0.1, "output": 0.4},
    # xAI
    "grok-4.5": {"input": 5.0, "output": 15.0},
    "grok-4.4": {"input": 5.0, "output": 15.0},
    "grok-4.3": {"input": 5.0, "output": 15.0},
    # Qwen
    "qwen-3.7-max": {"input": 2.0, "output": 8.0},
    "qwen-3.5": {"input": 2.0, "output": 8.0},
    "qwen-3": {"input": 2.0, "output": 8.0},
    # Meta / Together
    "llama-4-maverick": {"input": 0.9, "output": 0.9},
    "llama-4-scout": {"input": 0.9, "output": 0.9},
    # Zhipu / GLM
    "glm-5.2": {"input": 1.0, "output": 4.0},
    "glm-5.1": {"input": 1.0, "output": 4.0},
    "glm-5": {"input": 1.0, "output": 4.0},
    # OpenRouter (catch-all)
    "default": {"input": 1.0, "output": 4.0},
}


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """Estimate API call cost in USD."""
    pricing = MODEL_PRICING.get(model, MODEL_PRICING["default"])
    input_cost = input_tokens * pricing["input"] / 1_000_000
    output_cost = output_tokens * pricing["output"] / 1_000_000
    return round(input_cost + output_cost, 6)


# ═════════════════════════════════════════════════════════════════════════════
# ABSTRACT BASE ADAPTER
# ═════════════════════════════════════════════════════════════════════════════

class BaseAdapter(ABC):
    """Abstract base class for all API adapters."""
    
    def __init__(self, config: AdapterConfig = None):
        self.config = config or AdapterConfig()
        self._total_usage = TokenUsage()
        self._total_cost: float = 0.0
        self._call_count: int = 0
        self._error_count: int = 0
        self._last_call_time: float = 0.0
        self._rate_limit_rpm: int = 60
        self._min_interval: float = 60.0 / self._rate_limit_rpm
    
    @abstractmethod
    def generate(self, prompt: str, **kwargs) -> AdapterResponse:
        """Generate a response from the model."""
        ...
    
    @abstractmethod
    def generate_stream(self, prompt: str, **kwargs) -> Generator[StreamChunk, None, AdapterResponse]:
        """Stream a response from the model."""
        ...
    
    @abstractmethod
    def count_tokens(self, text: str) -> int:
        """Count tokens for the given text."""
        ...
    
    def estimate_cost(self, prompt: str, max_tokens: int = 4096) -> float:
        """Estimate the cost of a generation call."""
        input_tok = self.count_tokens(prompt)
        return estimate_cost(self.config.model, input_tok, max_tokens)
    
    def get_usage_stats(self) -> Dict[str, Any]:
        """Get usage statistics for this adapter."""
        return {
            "model": self.config.model,
            "total_calls": self._call_count,
            "total_errors": self._error_count,
            "total_prompt_tokens": self._total_usage.prompt_tokens,
            "total_completion_tokens": self._total_usage.completion_tokens,
            "total_cost_usd": round(self._total_cost, 6),
        }
    
    def _rate_limit_wait(self):
        """Wait if needed to respect rate limits."""
        if self._last_call_time > 0:
            elapsed = time.time() - self._last_call_time
            if elapsed < self._min_interval:
                time.sleep(self._min_interval - elapsed)
        self._last_call_time = time.time()
    
    def _track_usage(self, response: AdapterResponse):
        """Track usage from a response."""
        self._total_usage = self._total_usage.merge(response.usage)
        self._total_cost += response.usage.cost_usd
        self._call_count += 1
    
    def _track_error(self):
        self._error_count += 1


# ═════════════════════════════════════════════════════════════════════════════
# HTTP ADAPTER (shared implementation for REST-based APIs)
# ═════════════════════════════════════════════════════════════════════════════

class HTTPAdapter(BaseAdapter):
    """Adapter for standard REST API providers."""
    
    PROVIDER_CONFIGS: Dict[str, Dict[str, Any]] = {
        "openai": {
            "base_url": "https://api.openai.com/v1",
            "headers": {"Content-Type": "application/json"},
            "auth_header": "Authorization",
            "auth_prefix": "Bearer ",
            "chat_endpoint": "/chat/completions",
            "models_endpoint": "/models",
        },
        "anthropic": {
            "base_url": "https://api.anthropic.com/v1",
            "headers": {"Content-Type": "application/json", "anthropic-version": "2023-06-01"},
            "auth_header": "x-api-key",
            "auth_prefix": "",
            "chat_endpoint": "/messages",
            "models_endpoint": "/models",
        },
        "deepseek": {
            "base_url": "https://api.deepseek.com/v1",
            "headers": {"Content-Type": "application/json"},
            "auth_header": "Authorization",
            "auth_prefix": "Bearer ",
            "chat_endpoint": "/chat/completions",
            "models_endpoint": "/models",
        },
        "google": {
            "base_url": "https://generativelanguage.googleapis.com/v1beta",
            "headers": {"Content-Type": "application/json"},
            "auth_header": "x-goog-api-key",
            "auth_prefix": "",
            "chat_endpoint": "/models/{model}:generateContent",
            "models_endpoint": "/models",
        },
        "xai": {
            "base_url": "https://api.x.ai/v1",
            "headers": {"Content-Type": "application/json"},
            "auth_header": "Authorization",
            "auth_prefix": "Bearer ",
            "chat_endpoint": "/chat/completions",
            "models_endpoint": "/models",
        },
        "together": {
            "base_url": "https://api.together.xyz/v1",
            "headers": {"Content-Type": "application/json"},
            "auth_header": "Authorization",
            "auth_prefix": "Bearer ",
            "chat_endpoint": "/chat/completions",
            "models_endpoint": "/models",
        },
        "zhipu": {
            "base_url": "https://open.bigmodel.cn/api/paas/v4",
            "headers": {"Content-Type": "application/json"},
            "auth_header": "Authorization",
            "auth_prefix": "Bearer ",
            "chat_endpoint": "/chat/completions",
            "models_endpoint": "/models",
        },
        "openrouter": {
            "base_url": "https://openrouter.ai/api/v1",
            "headers": {"Content-Type": "application/json"},
            "auth_header": "Authorization",
            "auth_prefix": "Bearer ",
            "chat_endpoint": "/chat/completions",
            "models_endpoint": "/models",
        },
        "qwen": {
            "base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            "headers": {"Content-Type": "application/json"},
            "auth_header": "Authorization",
            "auth_prefix": "Bearer ",
            "chat_endpoint": "/chat/completions",
            "models_endpoint": "/models",
        },
    }
    
    def __init__(self, provider: str, config: AdapterConfig = None):
        super().__init__(config)
        self.provider = provider.lower()
        if self.provider not in self.PROVIDER_CONFIGS:
            raise ConfigurationError(f"Unknown provider: {provider}")
        
        self._provider_config = dict(self.PROVIDER_CONFIGS[self.provider])
        
        # Apply config overrides
        if config and config.base_url:
            self._provider_config["base_url"] = config.base_url
        if config and config.api_key:
            self._provider_config["api_key"] = config.api_key
        
        self._session = None
        self._init_session()
    
    def _init_session(self):
        """Initialize HTTP session."""
        try:
            import httpx
            headers = dict(self._provider_config["headers"])
            auth_header = self._provider_config["auth_header"]
            auth_prefix = self._provider_config["auth_prefix"]
            api_key = self.config.api_key or os.getenv(f"{self.provider.upper()}_API_KEY", "")
            
            if api_key:
                headers[auth_header] = f"{auth_prefix}{api_key}"
            
            # Add extra headers from config
            if self.config.extra_headers:
                headers.update(self.config.extra_headers)
            
            self._session = httpx.Client(
                base_url=self._provider_config["base_url"],
                headers=headers,
                timeout=self.config.timeout,
            )
        except ImportError:
            logger.warning("httpx not available, using urllib fallback")
            self._session = None
    
    def _build_chat_url(self) -> str:
        endpoint = self._provider_config["chat_endpoint"]
        if "{model}" in endpoint:
            return endpoint.replace("{model}", self.config.model)
        return endpoint
    
    def _build_request_body(self, prompt: str, **kwargs) -> Dict[str, Any]:
        messages = kwargs.get("messages", None)
        if messages is None:
            messages = [{"role": "user", "content": prompt}]
        
        body: Dict[str, Any] = {
            "model": kwargs.get("model", self.config.model),
            "messages": messages,
            "max_tokens": kwargs.get("max_tokens", self.config.max_tokens),
            "temperature": kwargs.get("temperature", self.config.temperature),
            "top_p": kwargs.get("top_p", self.config.top_p),
            "stream": kwargs.get("stream", self.config.stream),
        }
        
        # Anthropic-specific format
        if self.provider == "anthropic":
            body.pop("messages", None)
            system = kwargs.get("system", "")
            if system:
                body["system"] = system
            body["messages"] = messages
            body["max_tokens"] = kwargs.get("max_tokens", self.config.max_tokens)
        
        # Google-specific format
        if self.provider == "google":
            body = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "maxOutputTokens": kwargs.get("max_tokens", self.config.max_tokens),
                    "temperature": kwargs.get("temperature", self.config.temperature),
                }
            }
        
        # Apply extra body from config
        if self.config.extra_body:
            body.update(self.config.extra_body)
        
        return body
    
    def generate(self, prompt: str, **kwargs) -> AdapterResponse:
        """Generate a completion from the API."""
        self._rate_limit_wait()
        
        body = self._build_request_body(prompt, **kwargs)
        url = self._build_chat_url()
        
        def _do_request() -> Dict[str, Any]:
            if self._session:
                response = self._session.post(url, json=body)
            else:
                import urllib.request
                import urllib.error
                data = json.dumps(body).encode()
                req = urllib.request.Request(
                    f"{self._provider_config['base_url']}{url}",
                    data=data,
                    headers={"Content-Type": "application/json"},
                )
                with urllib.request.urlopen(req) as resp:
                    return json.loads(resp.read().decode())
            
            if response.status_code == 401:
                raise AuthError("Invalid API key or authentication expired")
            elif response.status_code == 429:
                raise RateLimitError("Rate limit exceeded")
            elif response.status_code >= 500:
                raise ServerError(response.status_code, response.text[:200])
            elif response.status_code >= 400:
                raise AdapterError(f"HTTP {response.status_code}: {response.text[:200]}")
            
            return response.json()
        
        try:
            t0 = time.time()
            data = with_retry(_do_request, RetryConfig(max_retries=self.config.max_retries))
            elapsed = (time.time() - t0) * 1000
            
            response = self._parse_response(data)
            response.latency_ms = elapsed
            self._track_usage(response)
            return response
        except Exception as e:
            self._track_error()
            raise
    
    def generate_stream(self, prompt: str, **kwargs) -> Generator[StreamChunk, None, AdapterResponse]:
        """Stream a completion from the API."""
        kwargs["stream"] = True
        body = self._build_request_body(prompt, **kwargs)
        url = self._build_chat_url()
        
        if not self._session:
            raise AdapterError("Streaming requires httpx library")
        
        full_content = ""
        usage = TokenUsage()
        t0 = time.time()
        
        with self._session.stream("POST", url, json=body) as response:
            if response.status_code != 200:
                error_text = response.text[:200]
                if response.status_code == 429:
                    raise RateLimitError(f"Rate limited: {error_text}")
                raise AdapterError(f"Stream error {response.status_code}: {error_text}")
            
            for line in response.iter_lines():
                if not line or line.startswith(":"):
                    continue
                if line.startswith("data: "):
                    data_str = line[6:].strip()
                    if data_str == "[DONE]":
                        break
                    try:
                        data = json.loads(data_str)
                        chunk = self._parse_stream_chunk(data)
                        if chunk:
                            full_content += chunk.content
                            yield chunk
                            if chunk.usage:
                                usage = chunk.usage
                    except json.JSONDecodeError:
                        continue
        
        elapsed = (time.time() - t0) * 1000
        result = AdapterResponse(
            content=full_content,
            model=self.config.model,
            usage=usage,
            latency_ms=elapsed,
        )
        self._track_usage(result)
        return result  # type: ignore[return-value]
    
    def _parse_response(self, data: Dict[str, Any]) -> AdapterResponse:
        """Parse API response into standardized format."""
        model = data.get("model", self.config.model)
        content = ""
        usage = TokenUsage()
        finish_reason = "stop"
        
        if self.provider == "anthropic":
            # Anthropic format
            for block in data.get("content", []):
                if block.get("type") == "text":
                    content += block.get("text", "")
            usage = TokenUsage(
                prompt_tokens=data.get("usage", {}).get("input_tokens", 0),
                completion_tokens=data.get("usage", {}).get("output_tokens", 0),
            )
            finish_reason = data.get("stop_reason", "end_turn")
        elif self.provider == "google":
            # Google format
            candidates = data.get("candidates", [])
            if candidates:
                parts = candidates[0].get("content", {}).get("parts", [])
                for p in parts:
                    content += p.get("text", "")
                finish_reason = candidates[0].get("finishReason", "STOP")
            usage_meta = data.get("usageMetadata", {})
            usage = TokenUsage(
                prompt_tokens=usage_meta.get("promptTokenCount", 0),
                completion_tokens=usage_meta.get("candidatesTokenCount", 0),
            )
        else:
            # OpenAI-compatible format (OpenAI, DeepSeek, xAI, Together, OpenRouter, etc.)
            choices = data.get("choices", [])
            if choices:
                content = choices[0].get("message", {}).get("content", "")
                finish_reason = choices[0].get("finish_reason", "stop")
            usage_data = data.get("usage", {})
            usage = TokenUsage(
                prompt_tokens=usage_data.get("prompt_tokens", 0),
                completion_tokens=usage_data.get("completion_tokens", 0),
            )
        
        return AdapterResponse(
            content=content,
            model=model,
            usage=usage,
            finish_reason=finish_reason,
            raw_response=data,
        )
    
    def _parse_stream_chunk(self, data: Dict[str, Any]) -> Optional[StreamChunk]:
        """Parse a streaming chunk into standardized format."""
        if self.provider == "anthropic":
            # Anthropic streaming
            if data.get("type") == "content_block_delta":
                delta = data.get("delta", {})
                return StreamChunk(
                    content=delta.get("text", ""),
                    model=data.get("model", self.config.model),
                )
            elif data.get("type") == "message_stop":
                usage_data = data.get("usage", {})
                return StreamChunk(
                    finish_reason="stop",
                    usage=TokenUsage(
                        prompt_tokens=usage_data.get("input_tokens", 0),
                        completion_tokens=usage_data.get("output_tokens", 0),
                    ),
                )
        else:
            # OpenAI-compatible streaming
            choices = data.get("choices", [])
            if choices:
                delta = choices[0].get("delta", {})
                content = delta.get("content", "")
                finish = choices[0].get("finish_reason")
                return StreamChunk(
                    content=content,
                    finish_reason=finish,
                    model=data.get("model", self.config.model),
                )
        return None
    
    def count_tokens(self, text: str) -> int:
        return count_tokens(text, self.config.model)
    
    def close(self):
        """Clean up resources."""
        if self._session:
            self._session.close()
