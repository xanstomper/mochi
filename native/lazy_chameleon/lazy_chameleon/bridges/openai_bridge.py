"""
OpenAI Bridge — GPT-4o, o1, o3, o4-mini, GPT-5.x series

Supports:
  - GPT-4o, GPT-4o-mini, GPT-4.1
  - o1, o3-mini, o4-mini
  - GPT-5.3, GPT-5.4, GPT-5.5, GPT-5.6
  - Streaming via SSE
  - OpenAI-compatible endpoints (any base_url)
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
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
# GPT-5 Specific Configuration
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class GPT5Config:
    """Configuration specific to GPT-5.x models.

    GPT-5.3 — fast, cost-optimized (successor to GPT-4o-mini)
    GPT-5.4 — general-purpose balanced model
    GPT-5.5 — high-intelligence reasoning model
    GPT-5.6 — frontier / max capability

    Attributes:
        reasoning_effort:  Controls depth of reasoning: "low", "medium", "high"
        max_reasoning_tokens: Max tokens the model uses for internal reasoning
        parallel_tool_calls: Whether to execute tool calls in parallel
        structured_outputs: Whether to enforce structured JSON output
    """

    reasoning_effort: str = "medium"
    max_reasoning_tokens: Optional[int] = None
    parallel_tool_calls: bool = True
    structured_outputs: bool = False


# ═══════════════════════════════════════════════════════════════════════════════
# OpenAI Model Catalog
# ═══════════════════════════════════════════════════════════════════════════════

OPENAI_MODELS: Dict[str, Dict[str, Any]] = {
    "gpt-4o": {
        "description": "GPT-4 Omni multimodal model",
        "max_tokens": 128000,
        "max_output": 16384,
        "pricing": (0.0025, 0.010),
        "supports_streaming": True,
        "supports_vision": True,
        "supports_tools": True,
        "supports_structured_output": True,
        "family": "gpt-4o",
    },
    "gpt-4o-mini": {
        "description": "GPT-4 Omni mini — cost-optimized",
        "max_tokens": 128000,
        "max_output": 16384,
        "pricing": (0.00015, 0.0006),
        "supports_streaming": True,
        "supports_vision": True,
        "supports_tools": True,
        "supports_structured_output": True,
        "family": "gpt-4o",
    },
    "gpt-4.1": {
        "description": "GPT-4.1 — improved reasoning",
        "max_tokens": 128000,
        "max_output": 16384,
        "pricing": (0.0025, 0.010),
        "supports_streaming": True,
        "supports_vision": True,
        "supports_tools": True,
        "family": "gpt-4",
    },
    "o1": {
        "description": "o1 — advanced reasoning",
        "max_tokens": 200000,
        "max_output": 100000,
        "pricing": (0.015, 0.060),
        "supports_streaming": True,
        "supports_vision": True,
        "supports_reasoning": True,
        "family": "o-series",
    },
    "o1-mini": {
        "description": "o1-mini — cost-optimized reasoning",
        "max_tokens": 128000,
        "max_output": 65536,
        "pricing": (0.0011, 0.0044),
        "supports_streaming": True,
        "supports_reasoning": True,
        "family": "o-series",
    },
    "o3-mini": {
        "description": "o3-mini — efficient reasoning",
        "max_tokens": 200000,
        "max_output": 100000,
        "pricing": (0.0011, 0.0044),
        "supports_streaming": True,
        "supports_reasoning": True,
        "family": "o-series",
    },
    "o4-mini": {
        "description": "o4-mini — next-gen small reasoning model",
        "max_tokens": 200000,
        "max_output": 100000,
        "pricing": (0.0004, 0.0016),
        "supports_streaming": True,
        "supports_reasoning": True,
        "family": "o-series",
    },
    "gpt-5.3": {
        "description": "GPT-5.3 — fast, cost-optimized",
        "max_tokens": 256000,
        "max_output": 32768,
        "pricing": (0.0020, 0.008),
        "supports_streaming": True,
        "supports_vision": True,
        "supports_tools": True,
        "supports_reasoning": True,
        "family": "gpt-5",
    },
    "gpt-5.4": {
        "description": "GPT-5.4 — general-purpose balanced",
        "max_tokens": 256000,
        "max_output": 65536,
        "pricing": (0.0015, 0.006),
        "supports_streaming": True,
        "supports_vision": True,
        "supports_tools": True,
        "supports_reasoning": True,
        "family": "gpt-5",
    },
    "gpt-5.5": {
        "description": "GPT-5.5 — high-intelligence reasoning",
        "max_tokens": 512000,
        "max_output": 131072,
        "pricing": (0.0030, 0.012),
        "supports_streaming": True,
        "supports_vision": True,
        "supports_tools": True,
        "supports_reasoning": True,
        "family": "gpt-5",
    },
    "gpt-5.6": {
        "description": "GPT-5.6 — frontier max capability",
        "max_tokens": 1048576,
        "max_output": 262144,
        "pricing": (0.0040, 0.016),
        "supports_streaming": True,
        "supports_vision": True,
        "supports_tools": True,
        "supports_reasoning": True,
        "family": "gpt-5",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# OpenAI Stream Handler
# ═══════════════════════════════════════════════════════════════════════════════


class OpenAIStreamHandler:
    """Parses OpenAI SSE stream chunks into BridgeStreamEvents."""

    def __init__(self, model: str) -> None:
        self.model = model
        self._buffer: str = ""
        self._chunk_index: int = 0
        self._accumulated_content: str = ""

    def process_line(self, line: str) -> Optional[BridgeStreamEvent]:
        """Process a single SSE line. Returns None for keepalives."""
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
            log.warning("OpenAI stream: failed to parse chunk: %s", raw[:100])
            return None

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
                cached_tokens=usage_data.get("cached_tokens", 0) or usage_data.get("prompt_tokens_details", {}).get("cached_tokens", 0),
            )

        event = BridgeStreamEvent(
            event_type=BridgeStreamEventType.CHUNK if content else (
                BridgeStreamEventType.USAGE if usage else BridgeStreamEventType.DONE
            ),
            content=content,
            finish_reason=finish_reason,
            usage=usage,
            model=self.model,
            index=self._chunk_index,
        )
        self._chunk_index += 1
        return event

    def flush(self) -> Optional[BridgeStreamEvent]:
        """Return any remaining data as a final event."""
        if self._accumulated_content:
            return BridgeStreamEvent(
                event_type=BridgeStreamEventType.DONE,
                finish_reason="stop",
                model=self.model,
                index=self._chunk_index,
            )
        return None

    @property
    def accumulated_content(self) -> str:
        return self._accumulated_content


# ═══════════════════════════════════════════════════════════════════════════════
# OpenAI Bridge
# ═══════════════════════════════════════════════════════════════════════════════


class OpenAIBridge(BaseProviderBridge):
    """Bridge for OpenAI and OpenAI-compatible APIs.

    Supports GPT-4o, o1, o3, o4-mini, and GPT-5.x models.
    Works with any OpenAI-compatible endpoint by setting base_url.
    """

    def __init__(
        self,
        config: Optional[BridgeConfig] = None,
        gpt5_config: Optional[GPT5Config] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(config, **kwargs)
        self._gpt5_config = gpt5_config or GPT5Config()

        # Auto-resolve API key
        api_key = self._config.api_key or os.environ.get("OPENAI_API_KEY", "")
        self._config.api_key = api_key

        # Default base_url
        if not self._config.base_url:
            self._config.base_url = "https://api.openai.com/v1"

        # Default model
        if not self._config.default_model:
            self._config.default_model = "gpt-4o"

    def _derive_provider_name(self) -> str:
        return "openai"

    def _build_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._config.api_key}",
        }
        if self._config.organization:
            headers["OpenAI-Organization"] = self._config.organization
        headers.update(self._config.extra_headers)
        return headers

    def _build_chat_url(self) -> str:
        base = self._config.base_url.rstrip("/")
        return f"{base}/chat/completions"

    def _build_messages(
        self,
        prompt: str,
        system: Optional[str] = None,
    ) -> List[Dict[str, str]]:
        messages: List[Dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        return messages

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

        # GPT-5.x reasoning parameters
        family = self._get_model_family(model)
        if family == "gpt-5":
            if self._gpt5_config.reasoning_effort:
                body["reasoning_effort"] = self._gpt5_config.reasoning_effort
            if self._gpt5_config.max_reasoning_tokens:
                body["max_reasoning_tokens"] = self._gpt5_config.max_reasoning_tokens

        # o-series reasoning parameters
        if family == "o-series":
            if self._gpt5_config.reasoning_effort:
                body["reasoning_effort"] = self._gpt5_config.reasoning_effort
            body.pop("temperature", None)

        # Remove None values
        body = {k: v for k, v in body.items() if v is not None}

        body.update(kwargs)
        return body

    def _get_model_family(self, model: str) -> str:
        """Determine the model family for a given model ID."""
        for model_id, info in OPENAI_MODELS.items():
            if model_id in model:
                return info["family"]
        if "gpt-5" in model:
            return "gpt-5"
        if "gpt-4" in model or "gpt-4" in model:
            return "gpt-4"
        if model.startswith("o"):
            return "o-series"
        return "gpt-4o"

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
            cached_tokens=usage_data.get("prompt_tokens_details", {}).get("cached_tokens", 0) if isinstance(usage_data.get("prompt_tokens_details"), dict) else 0,
        )

        return BridgeResponse(
            content=content,
            model=model,
            usage=usage,
            finish_reason=finish_reason,
            raw_response=data,
            id=data.get("id", ""),
            created=data.get("created", 0),
        )

    def _parse_stream_chunk(
        self, chunk_data: Dict[str, Any], model: str
    ) -> Optional[BridgeStreamEvent]:
        handler = OpenAIStreamHandler(model)
        raw_json = json.dumps(chunk_data)
        line = f"data: {raw_json}"
        return handler.process_line(line)

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
        handler = OpenAIStreamHandler(effective_model)

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
                error=f"Stream timed out: {e}",
                model=effective_model,
            )
            self._total_errors += 1
            return
        except BridgeError:
            self._total_errors += 1
            raise
        except Exception as e:
            log.exception("OpenAI stream error")
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
            index=handler._chunk_index + 1,
        )
        yield BridgeStreamEvent(
            event_type=BridgeStreamEventType.DONE,
            finish_reason="stop",
            model=effective_model,
            index=handler._chunk_index + 2,
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
        return list(OPENAI_MODELS.keys())

    def get_model_info(self, model: str) -> Optional[Dict[str, Any]]:
        """Return metadata for a specific model."""
        for model_id, info in OPENAI_MODELS.items():
            if model_id in model:
                return info
        return None
