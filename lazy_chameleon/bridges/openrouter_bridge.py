"""
OpenRouter Bridge — Aggregator for all models

Supports:
  - All models available through OpenRouter
  - Auto model routing (openrouter/auto)
  - OpenAI-compatible API format
  - Provider routing preferences
  - Streaming support
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Generator, List, Optional, Tuple

import httpx

from .base import (
    BaseProviderBridge,
    BridgeConfig,
    BridgeResponse,
    BridgeStreamEvent,
    BridgeStreamEventType,
    TokenUsage,
    AuthError,
    RateLimitExceeded,
    TimeoutError,
    ServerError,
    BridgeError,
    count_tokens_heuristic,
    estimate_cost_heuristic,
    with_exponential_backoff,
)

log = logging.getLogger(__name__)

# ═══════════════════════════════════════════════════════════════════════════════
# OpenRouter Model Catalog
# ═══════════════════════════════════════════════════════════════════════════════

OPENROUTER_MODELS: Dict[str, Dict[str, Any]] = {
    "openrouter/auto": {
        "description": "OpenRouter auto-routing — picks best model",
        "max_tokens": 200000,
        "max_output": 65536,
        "pricing": (0.001, 0.003),
        "supports_streaming": True,
        "family": "openrouter",
    },
    "anthropic/claude-sonnet-5": {
        "description": "Claude Sonnet 5 via OpenRouter",
        "max_tokens": 200000,
        "max_output": 32768,
        "pricing": (0.003, 0.015),
        "supports_streaming": True,
        "family": "openrouter",
    },
    "anthropic/claude-opus-4-8": {
        "description": "Claude Opus 4.8 via OpenRouter",
        "max_tokens": 200000,
        "max_output": 32768,
        "pricing": (0.015, 0.075),
        "supports_streaming": True,
        "family": "openrouter",
    },
    "anthropic/claude-haiku-4-5": {
        "description": "Claude Haiku 4.5 via OpenRouter",
        "max_tokens": 200000,
        "max_output": 8192,
        "pricing": (0.00025, 0.00125),
        "supports_streaming": True,
        "family": "openrouter",
    },
    "openai/gpt-4o": {
        "description": "GPT-4o via OpenRouter",
        "max_tokens": 128000,
        "max_output": 16384,
        "pricing": (0.0025, 0.010),
        "supports_streaming": True,
        "family": "openrouter",
    },
    "openai/gpt-5.4": {
        "description": "GPT-5.4 via OpenRouter",
        "max_tokens": 256000,
        "max_output": 65536,
        "pricing": (0.0015, 0.006),
        "supports_streaming": True,
        "family": "openrouter",
    },
    "google/gemini-2.5-pro": {
        "description": "Gemini 2.5 Pro via OpenRouter",
        "max_tokens": 1048576,
        "max_output": 65536,
        "pricing": (0.0005, 0.0020),
        "supports_streaming": True,
        "family": "openrouter",
    },
    "deepseek/deepseek-r1": {
        "description": "DeepSeek-R1 via OpenRouter",
        "max_tokens": 128000,
        "max_output": 8192,
        "pricing": (0.00055, 0.00219),
        "supports_streaming": True,
        "family": "openrouter",
    },
    "meta-llama/llama-4-maverick": {
        "description": "Llama 4 Maverick via OpenRouter",
        "max_tokens": 131072,
        "max_output": 8192,
        "pricing": (0.0002, 0.0006),
        "supports_streaming": True,
        "family": "openrouter",
    },
    "xai/grok-4": {
        "description": "Grok 4 via OpenRouter",
        "max_tokens": 131072,
        "max_output": 8192,
        "pricing": (0.003, 0.015),
        "supports_streaming": True,
        "family": "openrouter",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# OpenRouter Stream Handler
# ═══════════════════════════════════════════════════════════════════════════════


class OpenRouterStreamHandler:
    """Parses OpenRouter SSE stream chunks (OpenAI-compatible, with extras)."""

    def __init__(self, model: str) -> None:
        self.model = model
        self._chunk_index: int = 0
        self._accumulated_content: str = ""

    def process_line(self, line: str) -> Optional[BridgeStreamEvent]:
        """Process a single SSE line."""
        if not line or not line.startswith("data: "):
            return None

        raw = line[6:].strip()

        if raw == "[DONE]":
            return BridgeStreamEvent(
                event_type=BridgeStreamEventType.DONE,
                finish_reason="stop",
                model=self.model,
                index=self._chunk_index,
            )

        try:
            chunk = json.loads(raw)
        except json.JSONDecodeError:
            return None

        # OpenRouter may include provider info in the response
        provider = chunk.get("provider", chunk.get("model", ""))

        choices = chunk.get("choices", [])
        if not choices:
            return None

        choice = choices[0]
        delta = choice.get("delta", {})
        finish_reason = choice.get("finish_reason")

        content = delta.get("content", "")
        if content:
            self._accumulated_content += content

        usage_data = chunk.get("usage")
        usage: Optional[TokenUsage] = None
        if usage_data:
            usage = TokenUsage(
                prompt_tokens=usage_data.get("prompt_tokens", 0),
                completion_tokens=usage_data.get("completion_tokens", 0),
                total_tokens=usage_data.get("total_tokens", 0),
            )

        extra: Optional[Dict[str, Any]] = None
        if provider and isinstance(provider, str) and provider != self.model:
            extra = {"provider": provider}

        if content or finish_reason or usage:
            evt_type = BridgeStreamEventType.CHUNK if content else (
                BridgeStreamEventType.USAGE if usage else BridgeStreamEventType.DONE
            )
            event = BridgeStreamEvent(
                event_type=evt_type,
                content=content,
                finish_reason=finish_reason,
                usage=usage,
                model=self.model,
                index=self._chunk_index,
                extra=extra,
            )
            self._chunk_index += 1
            return event

        return None

    @property
    def accumulated_content(self) -> str:
        return self._accumulated_content


# ═══════════════════════════════════════════════════════════════════════════════
# OpenRouter Bridge
# ═══════════════════════════════════════════════════════════════════════════════


class OpenRouterBridge(BaseProviderBridge):
    """Bridge for OpenRouter API (OpenAI-compatible aggregator).

    Supports all models available through OpenRouter.
    Uses OpenRouter-specific headers for provider preferences.
    """

    def __init__(
        self,
        config: Optional[BridgeConfig] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(config, **kwargs)

        # Auto-resolve API key
        api_key = self._config.api_key or os.environ.get("OPENROUTER_API_KEY", "")
        self._config.api_key = api_key

        # Default base_url
        if not self._config.base_url:
            self._config.base_url = "https://openrouter.ai/api/v1"

        # Default model
        if not self._config.default_model:
            self._config.default_model = "openrouter/auto"

        # Provider routing preferences
        self._ordered_providers: Optional[List[str]] = None
        self._ignore_providers: Optional[List[str]] = None

    def _derive_provider_name(self) -> str:
        return "openrouter"

    def _build_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._config.api_key}",
        }

        # OpenRouter-specific headers
        if self._config.organization:
            headers["HTTP-Referer"] = self._config.organization

        headers.update(self._config.extra_headers)
        return headers

    def _build_chat_url(self) -> str:
        base = self._config.base_url.rstrip("/")
        return f"{base}/chat/completions"

    def _build_request_body(
        self,
        messages: List[Dict[str, str]],
        model: str,
        max_tokens: Optional[int] = None,
        temperature: Optional[float] = None,
        stop: Optional[List[str]] = None,
        stream: bool = False,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        body: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens or self._config.max_tokens,
            "temperature": temperature if temperature is not None else self._config.temperature,
            "top_p": self._config.top_p,
            "stream": stream,
            **self._config.extra_body,
        }

        if stop:
            body["stop"] = stop

        # Provider routing
        route: Dict[str, Any] = {}
        if self._ordered_providers:
            route["order"] = self._ordered_providers
        if self._ignore_providers:
            route["ignore"] = self._ignore_providers
        if route:
            body["provider"] = route

        # Remove None values
        body = {k: v for k, v in body.items() if v is not None}
        body.update(kwargs)
        return body

    def _parse_response(self, data: Dict[str, Any], model: str) -> BridgeResponse:
        choices = data.get("choices", [])
        content = ""
        finish_reason = "stop"

        if choices:
            message = choices[0].get("message", {})
            content = message.get("content", "") or ""
            finish_reason = choices[0].get("finish_reason", "stop") or "stop"

        usage_data = data.get("usage", {})
        usage = TokenUsage(
            prompt_tokens=usage_data.get("prompt_tokens", 0),
            completion_tokens=usage_data.get("completion_tokens", 0),
            total_tokens=usage_data.get("total_tokens", 0),
        )

        extra: Dict[str, Any] = {}
        if data.get("provider"):
            extra["provider"] = data["provider"]

        return BridgeResponse(
            content=content,
            model=data.get("model", model),
            usage=usage,
            finish_reason=finish_reason,
            raw_response={**data, **extra},
            id=data.get("id", ""),
        )

    def _parse_stream_chunk(
        self, chunk_data: Dict[str, Any], model: str
    ) -> Optional[BridgeStreamEvent]:
        handler = OpenRouterStreamHandler(model)
        raw_json = json.dumps(chunk_data)
        line = f"data: {raw_json}"
        return handler.process_line(line)

    def set_provider_routing(
        self,
        ordered_providers: Optional[List[str]] = None,
        ignore_providers: Optional[List[str]] = None,
    ) -> None:
        """Configure OpenRouter provider routing preferences."""
        self._ordered_providers = ordered_providers
        self._ignore_providers = ignore_providers

    # ── Core Methods ──────────────────────────────────────────────────────────

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
        effective_model = model or self._config.default_model
        messages = self._build_messages(prompt, system)
        body = self._build_request_body(
            messages=messages,
            model=effective_model,
            max_tokens=max_tokens,
            temperature=temperature,
            stop=stop,
            stream=False,
            **kwargs,
        )

        url = self._build_chat_url()
        headers = self._build_headers()
        client = self._get_client()

        t0 = time.time()

        def _do_request() -> httpx.Response:
            try:
                resp = client.post(url, json=body, headers=headers)
            except httpx.TimeoutException as e:
                raise TimeoutError(f"Request timed out after {self._config.timeout}s", original=e)
            except httpx.ConnectError as e:
                raise TimeoutError(f"Connection failed: {e}", original=e)
            except httpx.HTTPError as e:
                raise BridgeError(f"HTTP error: {e}", original=e)

            self._raise_for_status(resp)
            return resp

        try:
            response = with_exponential_backoff(
                _do_request,
                max_retries=self._config.max_retries,
            )
        except BridgeError:
            self._total_errors += 1
            raise

        elapsed_ms = (time.time() - t0) * 1000
        data = response.json()
        bridge_response = self._parse_response(data, effective_model)
        bridge_response.latency_ms = elapsed_ms

        self._total_calls += 1
        self._total_latency_ms += elapsed_ms
        self._cumulative_usage += bridge_response.usage

        return bridge_response

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
        effective_model = model or self._config.default_model
        messages = self._build_messages(prompt, system)
        body = self._build_request_body(
            messages=messages,
            model=effective_model,
            max_tokens=max_tokens,
            temperature=temperature,
            stop=stop,
            stream=True,
            **kwargs,
        )

        url = self._build_chat_url()
        headers = self._build_headers()
        client = self._get_client()
        handler = OpenRouterStreamHandler(effective_model)

        t0 = time.time()

        try:
            with client.stream("POST", url, json=body, headers=headers) as response:
                self._raise_for_status(response)

                for line in response.iter_lines():
                    decoded = line.decode("utf-8") if isinstance(line, bytes) else line
                    event = handler.process_line(decoded)
                    if event is not None:
                        yield event
                        if event.event_type == BridgeStreamEventType.DONE:
                            break

        except httpx.TimeoutException as e:
            yield BridgeStreamEvent(
                event_type=BridgeStreamEventType.ERROR,
                error=f"OpenRouter stream timed out: {e}",
                model=effective_model,
            )
            self._total_errors += 1
            return
        except BridgeError:
            self._total_errors += 1
            raise
        except Exception as e:
            log.exception("OpenRouter stream error")
            yield BridgeStreamEvent(
                event_type=BridgeStreamEventType.ERROR,
                error=str(e),
                model=effective_model,
            )
            self._total_errors += 1
            return

        elapsed_ms = (time.time() - t0) * 1000

        final_usage = TokenUsage(
            prompt_tokens=count_tokens_heuristic(prompt, effective_model),
            completion_tokens=count_tokens_heuristic(handler.accumulated_content, effective_model),
        )
        yield BridgeStreamEvent(
            event_type=BridgeStreamEventType.USAGE,
            usage=final_usage,
            model=effective_model,
        )
        yield BridgeStreamEvent(
            event_type=BridgeStreamEventType.DONE,
            finish_reason="stop",
            model=effective_model,
        )

        self._total_calls += 1
        self._total_latency_ms += elapsed_ms
        self._cumulative_usage += final_usage

    def count_tokens(self, text: str, model: Optional[str] = None) -> int:
        m = model or self._config.default_model
        return count_tokens_heuristic(text, m)

    def estimate_cost(
        self,
        prompt_tokens: int,
        completion_tokens: int,
        model: Optional[str] = None,
    ) -> float:
        m = model or self._config.default_model
        return estimate_cost_heuristic(prompt_tokens, completion_tokens, m)

    def get_model_list(self) -> List[str]:
        return list(OPENROUTER_MODELS.keys())

    def get_model_info(self, model: str) -> Optional[Dict[str, Any]]:
        for model_id, info in OPENROUTER_MODELS.items():
            if model_id in model:
                return info
        return None
