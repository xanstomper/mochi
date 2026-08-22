"""
Base Provider Bridge — Abstract base class, shared types, and utilities.

Defines the contract every provider bridge must implement:
    generate()           — synchronous text generation
    generate_stream()    — streaming text generation (SSE-style events)
    count_tokens()       — estimate token count for a string
    estimate_cost()      — estimate USD cost for a request
    get_model_list()     — return supported model identifiers

All bridges share:
    BridgeConfig         — configuration dataclass
    BridgeResponse       — standardized response format
    BridgeStreamEvent    — SSE-style streaming chunk
    TokenUsage           — prompt / completion / cached token tracking

Error hierarchy:
    BridgeError
    ├── AuthError           401 / 403
    ├── RateLimitExceeded   429
    ├── TimeoutError        Connection / read timeouts
    └── ServerError         500+
"""

from __future__ import annotations

import json
import logging
import os
import random
import time
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, AsyncGenerator, Dict, Generator, List, Optional, Tuple, TypeVar, Union

import httpx

log = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════════
# Error Hierarchy
# ═══════════════════════════════════════════════════════════════════════════════


class BridgeError(Exception):
    """Base exception for all bridge-layer errors."""

    def __init__(self, message: str, original: Optional[Exception] = None) -> None:
        self.original = original
        super().__init__(message)


class AuthError(BridgeError):
    """Authentication / authorization failure (401, 403)."""

    def __init__(
        self, message: str = "Authentication failed", original: Optional[Exception] = None
    ) -> None:
        super().__init__(message, original=original)


class RateLimitExceeded(BridgeError):
    """Rate limit exceeded (429)."""

    def __init__(
        self,
        message: str = "Rate limit exceeded",
        retry_after: Optional[float] = None,
        original: Optional[Exception] = None,
    ) -> None:
        self.retry_after = retry_after
        super().__init__(message, original=original)


class TimeoutError(BridgeError):
    """Request timed out (connection / read / write)."""

    def __init__(
        self, message: str = "Request timed out", original: Optional[Exception] = None
    ) -> None:
        super().__init__(message, original=original)


class ServerError(BridgeError):
    """Server-side error (500+)."""

    def __init__(
        self,
        status_code: int,
        message: str = "Server error",
        original: Optional[Exception] = None,
    ) -> None:
        self.status_code = status_code
        super().__init__(f"Server error {status_code}: {message}", original=original)


# ═══════════════════════════════════════════════════════════════════════════════
# Data Classes
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class TokenUsage:
    """Token usage tracking for a single API call.

    Attributes:
        prompt_tokens:     Number of tokens in the prompt (input).
        completion_tokens: Number of tokens in the completion (output).
        total_tokens:      Sum of prompt + completion tokens.
        cached_tokens:     Number of prompt tokens served from cache.
    """

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cached_tokens: int = 0

    def __post_init__(self) -> None:
        if self.total_tokens == 0:
            self.total_tokens = self.prompt_tokens + self.completion_tokens

    def __add__(self, other: TokenUsage) -> TokenUsage:
        """Merge two usage records together."""
        return TokenUsage(
            prompt_tokens=self.prompt_tokens + other.prompt_tokens,
            completion_tokens=self.completion_tokens + other.completion_tokens,
            cached_tokens=self.cached_tokens + other.cached_tokens,
        )

    def __iadd__(self, other: TokenUsage) -> TokenUsage:
        self.prompt_tokens += other.prompt_tokens
        self.completion_tokens += other.completion_tokens
        self.cached_tokens += other.cached_tokens
        self.total_tokens = self.prompt_tokens + self.completion_tokens
        return self

    @property
    def cost_usd(self) -> float:
        """Rough default cost estimate in USD (can be overridden per model)."""
        return (self.prompt_tokens * 0.0000015) + (self.completion_tokens * 0.000006)

    def to_dict(self) -> Dict[str, int]:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
            "cached_tokens": self.cached_tokens,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, int]) -> TokenUsage:
        return cls(
            prompt_tokens=data.get("prompt_tokens", 0),
            completion_tokens=data.get("completion_tokens", 0),
            total_tokens=data.get("total_tokens", 0),
            cached_tokens=data.get("cached_tokens", 0),
        )


@dataclass
class BridgeConfig:
    """Configuration for a provider bridge.

    Attributes:
        api_key:        API key for authentication.
        base_url:       Base URL of the provider API.
        default_model:  Default model identifier to use when none specified.
        max_tokens:     Maximum tokens in the completion.
        temperature:    Sampling temperature (0.0 — 2.0).
        top_p:          Nucleus sampling parameter.
        timeout:        HTTP request timeout in seconds.
        max_retries:    Maximum number of retry attempts on failures.
        organization:   Organization ID (OpenAI/OpenRouter).
        extra_headers:  Additional HTTP headers to include.
        extra_body:     Additional JSON body fields.
        stream_options: Options dict passed in streaming requests.
        proxy:          HTTP/HTTPS proxy URL.
        max_connections: Maximum concurrent connections in the connection pool.
    """

    api_key: str = ""
    base_url: str = ""
    default_model: str = ""
    max_tokens: int = 4096
    temperature: float = 0.1
    top_p: float = 0.95
    timeout: float = 60.0
    max_retries: int = 3
    organization: str = ""
    extra_headers: Dict[str, str] = field(default_factory=dict)
    extra_body: Dict[str, Any] = field(default_factory=dict)
    stream_options: Dict[str, Any] = field(default_factory=dict)
    proxy: str = ""
    max_connections: int = 100

    def resolve_api_key(self, env_var: str = "") -> str:
        """Return the API key, falling back to an environment variable."""
        if self.api_key:
            return self.api_key
        if env_var:
            key = os.environ.get(env_var, "")
            if key:
                return key
        return ""

    def merge(self, overrides: Dict[str, Any]) -> BridgeConfig:
        """Return a new config with overrides applied."""
        kwargs = {k: getattr(self, k) for k in self.__dataclass_fields__}
        kwargs.update(overrides)
        return BridgeConfig(**kwargs)


@dataclass
class BridgeResponse:
    """Standardized response from any provider bridge.

    Attributes:
        content:       Generated text content.
        model:         Model identifier used.
        usage:         Token usage statistics.
        latency_ms:    Request round-trip time in milliseconds.
        finish_reason: Why generation stopped (stop, length, content_filter, tool_calls).
        raw_response:  Full raw response from the provider (for debugging).
        id:            Unique identifier for this response.
        created:       Unix timestamp of when the response was generated.
    """

    content: str
    model: str
    usage: TokenUsage = field(default_factory=TokenUsage)
    latency_ms: float = 0.0
    finish_reason: str = "stop"
    raw_response: Optional[Dict[str, Any]] = None
    id: str = ""
    created: int = 0

    def __post_init__(self) -> None:
        if not self.id:
            self.id = f"bridgeresp-{uuid.uuid4().hex[:12]}"
        if not self.created:
            self.created = int(time.time())

    @property
    def success(self) -> bool:
        """Whether the response contains meaningful content."""
        return bool(self.content and len(self.content.strip()) > 0)

    @property
    def cost_usd(self) -> float:
        """Estimated cost in USD based on token usage."""
        return self.usage.cost_usd

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "content": self.content,
            "model": self.model,
            "usage": self.usage.to_dict(),
            "latency_ms": self.latency_ms,
            "finish_reason": self.finish_reason,
            "created": self.created,
        }


class BridgeStreamEventType(Enum):
    """Types of events emitted during streaming."""

    CHUNK = "chunk"
    DONE = "done"
    ERROR = "error"
    USAGE = "usage"


@dataclass
class BridgeStreamEvent:
    """A single event in a streaming response sequence.

    Attributes:
        event_type:    Type of streaming event.
        content:       Text content for CHUNK events.
        finish_reason: Why generation finished (for DONE events).
        usage:         Token usage (for USAGE / DONE events).
        model:         Model identifier.
        index:         Sequential chunk index (0-based).
        error:         Error message for ERROR events.
        extra:         Arbitrary extra data.
    """

    event_type: BridgeStreamEventType = BridgeStreamEventType.CHUNK
    content: str = ""
    finish_reason: Optional[str] = None
    usage: Optional[TokenUsage] = None
    model: str = ""
    index: int = 0
    error: Optional[str] = None
    extra: Optional[Dict[str, Any]] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "event": self.event_type.value,
            "index": self.index,
        }
        if self.content:
            d["content"] = self.content
        if self.finish_reason:
            d["finish_reason"] = self.finish_reason
        if self.usage:
            d["usage"] = self.usage.to_dict()
        if self.model:
            d["model"] = self.model
        if self.error:
            d["error"] = self.error
        if self.extra:
            d["extra"] = self.extra
        return d

    def __repr__(self) -> str:
        ev = self.event_type.value
        if self.event_type == BridgeStreamEventType.CHUNK:
            return f"<BridgeStreamEvent chunk[{self.index}] content={self.content[:50]!r}>"
        elif self.event_type == BridgeStreamEventType.DONE:
            return f"<BridgeStreamEvent DONE reason={self.finish_reason}>"
        elif self.event_type == BridgeStreamEventType.ERROR:
            return f"<BridgeStreamEvent ERROR {self.error}>"
        return f"<BridgeStreamEvent {ev}>"

# ═══════════════════════════════════════════════════════════════════════════════
# Retry / Backoff Utility
# ═══════════════════════════════════════════════════════════════════════════════

T = TypeVar("T")


def with_exponential_backoff(
    fn: Callable[..., T],
    max_retries: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 60.0,
    backoff_factor: float = 2.0,
    retryable_statuses: Tuple[int, ...] = (429, 500, 502, 503, 504),
    retryable_exceptions: Tuple[type, ...] = (
        RateLimitExceeded, ServerError, TimeoutError, httpx.TimeoutException,
        httpx.ConnectError, httpx.RemoteProtocolError, ConnectionError,
    ),
    **kwargs: Any,
) -> T:
    """Execute *fn* with exponential backoff retry.

    Retries on configured HTTP status codes and exception types.
    On 429 (RateLimitExceeded), respects the Retry-After header via
    the exception's *retry_after* attribute.

    Args:
        fn:                    Callable to execute.
        max_retries:           Maximum retry attempts (0 = no retry).
        base_delay:            Initial delay in seconds.
        max_delay:             Maximum delay in seconds.
        backoff_factor:        Multiplier applied to delay each attempt.
        retryable_statuses:    HTTP status codes that trigger a retry.
        retryable_exceptions:  Exception types that trigger a retry.
        **kwargs:              Forwarded to *fn*.

    Returns:
        The return value of *fn*.

    Raises:
        The last exception encountered if all retries are exhausted.
    """
    last_exception: Optional[Exception] = None

    for attempt in range(max_retries + 1):
        try:
            return fn(**kwargs)
        except RateLimitExceeded as e:
            last_exception = e
            if attempt >= max_retries:
                raise
            delay = e.retry_after if e.retry_after else _compute_delay(
                attempt, base_delay, max_delay, backoff_factor
            )
            log.warning(
                "RateLimited — retry %d/%d after %.1fs: %s",
                attempt + 1, max_retries, delay, e,
            )
            time.sleep(delay)
        except tuple(retryable_exceptions) as e:
            last_exception = e
            if attempt >= max_retries:
                raise
            delay = _compute_delay(attempt, base_delay, max_delay, backoff_factor)
            log.warning(
                "Retry %d/%d after %.1fs: %s: %s",
                attempt + 1, max_retries, delay, type(e).__name__, e,
            )
            time.sleep(delay)
        except BridgeError:
            # Non-retryable bridge errors propagate immediately.
            raise
        except Exception as e:
            # Unknown errors — still retry within limit, then raise.
            last_exception = e
            if attempt >= max_retries:
                raise
            delay = _compute_delay(attempt, base_delay, max_delay, backoff_factor)
            log.warning(
                "Unexpected error — retry %d/%d after %.1fs: %s: %s",
                attempt + 1, max_retries, delay, type(e).__name__, e,
            )
            time.sleep(delay)

    # Should not be reached — but satisfies the type-checker.
    if last_exception:
        raise last_exception
    raise RuntimeError("Unexpected: retry loop exhausted with no exception")


def _compute_delay(
    attempt: int, base_delay: float, max_delay: float, backoff_factor: float
) -> float:
    """Compute exponential backoff delay with jitter."""
    delay = min(base_delay * (backoff_factor ** attempt), max_delay)
    jitter = random.uniform(0, 0.1 * delay)
    return delay + jitter


# ═══════════════════════════════════════════════════════════════════════════════
# Token / Cost Heuristics
# ═══════════════════════════════════════════════════════════════════════════════

_MODEL_MULTIPLIERS: Dict[str, float] = {
    "claude": 3.5,
    "gpt": 4.0,
    "gemini": 4.0,
    "deepseek": 3.8,
    "grok": 4.2,
    "llama": 4.0,
    "qwen": 3.8,
    "glm": 3.5,
    "mistral": 4.0,
    "opus": 3.5,
    "sonnet": 3.5,
    "haiku": 3.8,
    "fable": 3.3,
}

_BASE_PRICING: Dict[str, Tuple[float, float]] = {
    # (input_per_1k, output_per_1k)
    "gpt-4o":       (0.0025, 0.010),
    "gpt-4o-mini":  (0.00015, 0.0006),
    "o1":           (0.015, 0.060),
    "o3-mini":      (0.0011, 0.0044),
    "o4-mini":      (0.0004, 0.0016),
    "gpt-5":        (0.0025, 0.010),
    "gpt-5.3":      (0.0020, 0.008),
    "gpt-5.4":      (0.0015, 0.006),
    "gpt-5.5":      (0.0030, 0.012),
    "gpt-5.6":      (0.0040, 0.016),
    "claude-opus":  (0.015, 0.075),
    "claude-sonnet": (0.003, 0.015),
    "claude-haiku": (0.00025, 0.00125),
    "claude-fable": (0.005, 0.025),
    "deepseek-r1":  (0.00055, 0.00219),
    "deepseek-v3":  (0.00027, 0.00110),
    "deepseek-v2":  (0.00022, 0.00076),
    "gemini-2.5":   (0.0005, 0.0020),
    "gemini-3":     (0.0005, 0.0020),
    "grok-4":       (0.003, 0.015),
    "llama-4":      (0.0002, 0.0006),
    "qwen3":        (0.0002, 0.0006),
    "glm-5":        (0.0005, 0.0020),
    "openrouter":   (0.001, 0.003),
}


def count_tokens_heuristic(text: str, model: str = "default") -> int:
    """Estimate token count for a text string.

    Uses a simple heuristic: ~4 chars per token for most models.
    Model-specific adjustments refine the estimate.
    """
    if not text:
        return 0
    char_count = len(text)
    multiplier = 4.0
    model_lower = model.lower()
    for key, val in _MODEL_MULTIPLIERS.items():
        if key in model_lower:
            multiplier = val
            break
    estimated = int(char_count / multiplier)
    return max(1, estimated)


def count_messages_tokens_heuristic(
    messages: List[Dict[str, str]], model: str = "default"
) -> int:
    """Count tokens for a list of messages (OpenAI format)."""
    total = 0
    per_message_overhead = 4
    for msg in messages:
        total += per_message_overhead
        total += count_tokens_heuristic(msg.get("content", ""), model)
        total += count_tokens_heuristic(msg.get("role", ""), model)
    total += 2
    return total


def estimate_cost_heuristic(
    prompt_tokens: int,
    completion_tokens: int,
    model: str = "default",
    pricing_override: Optional[Tuple[float, float]] = None,
) -> float:
    """Estimate cost in USD for a given token count and model.

    Args:
        prompt_tokens:     Number of input tokens.
        completion_tokens: Number of output tokens.
        model:             Model identifier for price lookup.
        pricing_override:  Optional (input_per_1k, output_per_1k) tuple.

    Returns:
        Estimated cost in USD.
    """
    if pricing_override:
        input_rate, output_rate = pricing_override
    else:
        model_lower = model.lower()
        input_rate = 0.0015
        output_rate = 0.006
        for key, (inp, out) in _BASE_PRICING.items():
            if key in model_lower:
                input_rate, output_rate = inp, out
                break
    cost = (prompt_tokens / 1000.0) * input_rate
    cost += (completion_tokens / 1000.0) * output_rate
    return cost


# ═══════════════════════════════════════════════════════════════════════════════
# Abstract Base Provider Bridge
# ═══════════════════════════════════════════════════════════════════════════════


class BaseProviderBridge(ABC):
    """Abstract base class for all provider bridges.

    Subclasses MUST implement:
        generate()
        generate_stream()
        count_tokens()
        estimate_cost()
        get_model_list()
        _build_headers()
        _build_chat_url()
        _parse_response()
        _parse_stream_chunk()

    Subclasses MAY override:
        __init__()
        close()
        get_stats()
        reset_stats()
    """

    def __init__(
        self,
        config: Optional[BridgeConfig] = None,
        **kwargs: Any,
    ) -> None:
        """Initialize the bridge.

        Args:
            config: Bridge configuration. If None, created from kwargs.
            **kwargs: Individual configuration overrides.
        """
        if config is not None:
            self._config = config
        else:
            self._config = BridgeConfig(**kwargs)

        self._provider_name: str = self._derive_provider_name()
        self._cumulative_usage = TokenUsage()
        self._total_calls: int = 0
        self._total_errors: int = 0
        self._total_latency_ms: float = 0.0
        self._client: Optional[httpx.Client] = None
        self._async_client: Optional[httpx.AsyncClient] = None
        log.info(
            "Initialised %s bridge — model=%s endpoint=%s",
            self._provider_name,
            self._config.default_model or "(not set)",
            self._config.base_url or "(not set)",
        )

    # ── Properties ────────────────────────────────────────────────────────────

    @property
    def config(self) -> BridgeConfig:
        return self._config

    @property
    def provider_name(self) -> str:
        return self._provider_name

    @property
    def cumulative_usage(self) -> TokenUsage:
        return self._cumulative_usage

    @property
    def total_calls(self) -> int:
        return self._total_calls

    @property
    def total_errors(self) -> int:
        return self._total_errors

    # ── HTTP Client (lazy) ────────────────────────────────────────────────────

    def _get_client(self) -> httpx.Client:
        """Get or create the synchronous HTTP client."""
        if self._client is None:
            limits = httpx.Limits(
                max_connections=self._config.max_connections,
                max_keepalive_connections=20,
            )
            timeout = httpx.Timeout(
                self._config.timeout,
                connect=self._config.timeout * 0.3,
                read=self._config.timeout,
                write=self._config.timeout * 0.5,
            )
            client_kwargs: Dict[str, Any] = {
                "timeout": timeout,
                "limits": limits,
                "follow_redirects": True,
            }
            if self._config.proxy:
                client_kwargs["proxies"] = self._config.proxy
            self._client = httpx.Client(**client_kwargs)
        return self._client

    def _get_async_client(self) -> httpx.AsyncClient:
        """Get or create the asynchronous HTTP client."""
        if self._async_client is None:
            limits = httpx.Limits(
                max_connections=self._config.max_connections,
                max_keepalive_connections=20,
            )
            timeout = httpx.Timeout(
                self._config.timeout,
                connect=self._config.timeout * 0.3,
                read=self._config.timeout,
                write=self._config.timeout * 0.5,
            )
            client_kwargs: Dict[str, Any] = {
                "timeout": timeout,
                "limits": limits,
                "follow_redirects": True,
            }
            if self._config.proxy:
                client_kwargs["proxies"] = self._config.proxy
            self._async_client = httpx.AsyncClient(**client_kwargs)
        return self._async_client

    # ── Abstract Methods ──────────────────────────────────────────────────────

    @abstractmethod
    def _derive_provider_name(self) -> str:
        """Return the canonical provider name for this bridge."""
        ...

    @abstractmethod
    def _build_headers(self) -> Dict[str, str]:
        """Build HTTP headers for authentication and content type."""
        ...

    @abstractmethod
    def _build_chat_url(self) -> str:
        """Build the chat completions endpoint URL."""
        ...

    @abstractmethod
    def _parse_response(self, data: Dict[str, Any], model: str) -> BridgeResponse:
        """Parse a non-streaming JSON response into BridgeResponse."""
        ...

    @abstractmethod
    def _parse_stream_chunk(
        self, chunk_data: Dict[str, Any], model: str
    ) -> Optional[BridgeStreamEvent]:
        """Parse a single streaming chunk into BridgeStreamEvent.

        Returns None if the chunk should be skipped (e.g. keepalive).
        """
        ...

    @abstractmethod
    def generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        stop: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> BridgeResponse:
        """Synchronous text generation."""
        ...

    @abstractmethod
    def generate_stream(
        self,
        prompt: str,
        system: Optional[str] = None,
        model: Optional[str] = None,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        stop: Optional[List[str]] = None,
        **kwargs: Any,
    ) -> Generator[BridgeStreamEvent, None, None]:
        """Streaming text generation."""
        ...

    @abstractmethod
    def count_tokens(self, text: str, model: Optional[str] = None) -> int:
        """Count tokens in *text* for the given model."""
        ...

    @abstractmethod
    def estimate_cost(
        self,
        prompt_tokens: int,
        completion_tokens: int,
        model: Optional[str] = None,
    ) -> float:
        """Estimate cost in USD for the given token counts."""
        ...

    @abstractmethod
    def get_model_list(self) -> List[str]:
        """Return the list of supported model identifiers."""
        ...

    # ── Helper: Build Messages ────────────────────────────────────────────────

    def _build_messages(
        self,
        prompt: str,
        system: Optional[str] = None,
    ) -> List[Dict[str, str]]:
        """Build a messages list from prompt and optional system message."""
        messages: List[Dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        return messages

    # ── Error Handling ────────────────────────────────────────────────────────

    def _raise_for_status(self, response: httpx.Response) -> None:
        """Check HTTP response status and raise appropriate BridgeError."""
        status = response.status_code
        if 200 <= status < 300:
            return

        body_text = ""
        try:
            body = response.json()
            body_text = str(body)
        except Exception:
            body_text = response.text[:500]

        if status == 401 or status == 403:
            raise AuthError(
                message=f"Authentication failed ({status}): {body_text}",
            )
        if status == 429:
            retry_after = None
            try:
                retry_after = float(response.headers.get("Retry-After", ""))
            except (ValueError, TypeError):
                pass
            raise RateLimitExceeded(
                message=f"Rate limit exceeded: {body_text}",
                retry_after=retry_after,
            )
        if status >= 500:
            raise ServerError(
                status_code=status,
                message=body_text or f"Server error {status}",
            )
        # Other client errors
        raise BridgeError(f"HTTP {status}: {body_text}")

    # ── Stats ─────────────────────────────────────────────────────────────────

    def get_stats(self) -> Dict[str, Any]:
        """Return cumulative usage statistics."""
        return {
            "provider": self._provider_name,
            "model": self._config.default_model,
            "total_calls": self._total_calls,
            "total_errors": self._total_errors,
            "total_latency_ms": round(self._total_latency_ms, 1),
            "avg_latency_ms": round(
                self._total_latency_ms / max(self._total_calls, 1), 1
            ),
            "cumulative_usage": self._cumulative_usage.to_dict(),
        }

    def reset_stats(self) -> None:
        """Reset all cumulative counters."""
        self._cumulative_usage = TokenUsage()
        self._total_calls = 0
        self._total_errors = 0
        self._total_latency_ms = 0.0

    # ── Resource Cleanup ──────────────────────────────────────────────────────

    def close(self) -> None:
        """Close HTTP clients and release resources."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self) -> BaseProviderBridge:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(provider={self._provider_name!r}, "
            f"model={self._config.default_model!r}, "
            f"calls={self._total_calls})"
        )
