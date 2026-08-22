"""
Anthropic Bridge — Claude Opus 4.5-4.8, Sonnet 4.6-5, Fable 5, Haiku

Supports:
  - Native Anthropic Messages API (separate system parameter)
  - Extended thinking / chain-of-thought (ClaudeThinkingHandler)
  - Claude Opus 4.5, 4.6, 4.7, 4.8
  - Claude Sonnet 4.6, 4.7, 5
  - Claude Fable 5
  - Claude Haiku 4.5
  - Streaming via SSE (content_block_delta, message_stop)
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
# Claude Model Catalog
# ═══════════════════════════════════════════════════════════════════════════════

CLAUDE_MODELS: Dict[str, Dict[str, Any]] = {
    "claude-opus-4-5-20251001": {
        "description": "Claude Opus 4.5 — frontier intelligence",
        "max_tokens": 200000,
        "max_output": 16384,
        "pricing": (0.015, 0.075),
        "supports_streaming": True,
        "supports_thinking": True,
        "supports_vision": True,
        "supports_tools": True,
        "family": "opus",
    },
    "claude-opus-4-6": {
        "description": "Claude Opus 4.6 — enhanced reasoning",
        "max_tokens": 200000,
        "max_output": 16384,
        "pricing": (0.015, 0.075),
        "supports_streaming": True,
        "supports_thinking": True,
        "supports_vision": True,
        "supports_tools": True,
        "family": "opus",
    },
    "claude-opus-4-7": {
        "description": "Claude Opus 4.7 — improved reliability",
        "max_tokens": 200000,
        "max_output": 32768,
        "pricing": (0.015, 0.075),
        "supports_streaming": True,
        "supports_thinking": True,
        "supports_vision": True,
        "supports_tools": True,
        "family": "opus",
    },
    "claude-opus-4-8": {
        "description": "Claude Opus 4.8 — frontier max",
        "max_tokens": 200000,
        "max_output": 32768,
        "pricing": (0.015, 0.075),
        "supports_streaming": True,
        "supports_thinking": True,
        "supports_vision": True,
        "supports_tools": True,
        "family": "opus",
    },
    "claude-sonnet-4-6": {
        "description": "Claude Sonnet 4.6 — balanced intelligence",
        "max_tokens": 200000,
        "max_output": 16384,
        "pricing": (0.003, 0.015),
        "supports_streaming": True,
        "supports_thinking": True,
        "supports_vision": True,
        "supports_tools": True,
        "family": "sonnet",
    },
    "claude-sonnet-4-7": {
        "description": "Claude Sonnet 4.7 — enhanced",
        "max_tokens": 200000,
        "max_output": 16384,
        "pricing": (0.003, 0.015),
        "supports_streaming": True,
        "supports_thinking": True,
        "supports_vision": True,
        "supports_tools": True,
        "family": "sonnet",
    },
    "claude-sonnet-5": {
        "description": "Claude Sonnet 5 — next-gen balanced",
        "max_tokens": 200000,
        "max_output": 32768,
        "pricing": (0.003, 0.015),
        "supports_streaming": True,
        "supports_thinking": True,
        "supports_vision": True,
        "supports_tools": True,
        "family": "sonnet",
    },
    "claude-fable-5": {
        "description": "Claude Fable 5 — creative frontier model",
        "max_tokens": 200000,
        "max_output": 65536,
        "pricing": (0.005, 0.025),
        "supports_streaming": True,
        "supports_thinking": True,
        "supports_vision": True,
        "supports_tools": True,
        "family": "fable",
    },
    "claude-haiku-4-5-20251001": {
        "description": "Claude Haiku 4.5 — fastest, cost-optimized",
        "max_tokens": 200000,
        "max_output": 8192,
        "pricing": (0.00025, 0.00125),
        "supports_streaming": True,
        "supports_thinking": False,
        "supports_vision": True,
        "supports_tools": True,
        "family": "haiku",
    },
    "claude-haiku-5": {
        "description": "Claude Haiku 5 — next-gen fast",
        "max_tokens": 200000,
        "max_output": 16384,
        "pricing": (0.00025, 0.00125),
        "supports_streaming": True,
        "supports_thinking": True,
        "supports_vision": True,
        "supports_tools": True,
        "family": "haiku",
    },
}

# Short-name aliases
CLAUDE_ALIASES: Dict[str, str] = {
    "haiku": "claude-haiku-4-5-20251001",
    "haiku-4": "claude-haiku-4-5-20251001",
    "haiku-4.5": "claude-haiku-4-5-20251001",
    "haiku45": "claude-haiku-4-5-20251001",
    "haiku-5": "claude-haiku-5",
    "sonnet": "claude-sonnet-5",
    "sonnet-4": "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "sonnet-4.7": "claude-sonnet-4-7",
    "sonnet-5": "claude-sonnet-5",
    "opus": "claude-opus-4-8",
    "opus-4": "claude-opus-4-8",
    "opus-4.5": "claude-opus-4-5-20251001",
    "opus-4.6": "claude-opus-4-6",
    "opus-4.7": "claude-opus-4-7",
    "opus-4.8": "claude-opus-4-8",
    "fable": "claude-fable-5",
    "fable-5": "claude-fable-5",
}


# ═══════════════════════════════════════════════════════════════════════════════
# Claude Thinking Handler
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class ClaudeThinkingConfig:
    """Configuration for Claude extended thinking (CoT).

    Attributes:
        enabled:            Whether to enable extended thinking.
        budget_tokens:      Token budget for the thinking process.
        include_signature:  Include the thinking signature in output.
    """

    enabled: bool = False
    budget_tokens: int = 4096
    include_signature: bool = False


@dataclass
class ClaudeThinkingResult:
    """Result of Claude's extended thinking process.

    Attributes:
        thinking_text:  The chain-of-thought text.
        signature:      Optional cryptographic signature of the thinking.
        content:        The final visible content after thinking.
    """

    thinking_text: str = ""
    signature: Optional[str] = None
    content: str = ""


class ClaudeThinkingHandler:
    """Handles Claude's extended thinking / chain-of-thought.

    In thinking mode, Claude returns:
    1. A thinking content block (text/signature)
    2. A text content block (visible answer)

    This handler extracts and separates both parts.
    """

    def __init__(self, config: Optional[ClaudeThinkingConfig] = None) -> None:
        self.config = config or ClaudeThinkingConfig()
        self._thinking_parts: List[str] = []
        self._content_parts: List[str] = []
        self._signature: Optional[str] = None
        self._in_thinking_block: bool = False
        self._in_text_block: bool = False

    def process_content_block(self, block: Dict[str, Any]) -> None:
        """Process a content block from the response."""
        block_type = block.get("type", "")

        if block_type == "thinking":
            self._in_thinking_block = True
            self._in_text_block = False
            text = block.get("thinking", "")
            if text:
                self._thinking_parts.append(text)
            sig = block.get("signature")
            if sig:
                self._signature = sig

        elif block_type == "text":
            self._in_thinking_block = False
            self._in_text_block = True
            text = block.get("text", "")
            if text:
                self._content_parts.append(text)

    def process_stream_delta(self, delta: Dict[str, Any]) -> Optional[str]:
        """Process a streaming delta. Returns the visible text chunk."""
        delta_type = delta.get("type", "")

        if delta_type == "thinking_delta":
            text = delta.get("thinking", "")
            if text:
                self._thinking_parts.append(text)
            return ""

        elif delta_type == "text_delta":
            text = delta.get("text", "")
            if text:
                self._content_parts.append(text)
            return text

        elif delta_type == "signature_delta":
            self._signature = delta.get("signature")
            return ""

        return ""

    def get_result(self) -> ClaudeThinkingResult:
        """Return the assembled thinking result."""
        return ClaudeThinkingResult(
            thinking_text="".join(self._thinking_parts),
            signature=self._signature,
            content="".join(self._content_parts),
        )

    @property
    def has_thinking(self) -> bool:
        return len(self._thinking_parts) > 0

    @property
    def thinking(self) -> str:
        return "".join(self._thinking_parts)

    @property
    def content(self) -> str:
        return "".join(self._content_parts)


# ═══════════════════════════════════════════════════════════════════════════════
# Anthropic Stream Handler
# ═══════════════════════════════════════════════════════════════════════════════


class AnthropicStreamHandler:
    """Parses Anthropic SSE stream events into BridgeStreamEvents."""

    def __init__(self, model: str, thinking_config: Optional[ClaudeThinkingConfig] = None) -> None:
        self.model = model
        self._chunk_index: int = 0
        self._accumulated_content: str = ""
        self._thinking_handler = ClaudeThinkingHandler(thinking_config)
        self._final_usage: Optional[TokenUsage] = None

    def process_line(self, line: str) -> Optional[BridgeStreamEvent]:
        """Process a single SSE line from Anthropic's stream."""
        if not line or not line.startswith("data: "):
            return None

        raw = line[6:].strip()
        if not raw:
            return None

        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            return None

        event_type = event.get("type", "")

        if event_type == "content_block_delta":
            delta = event.get("delta", {})
            text = self._thinking_handler.process_stream_delta(delta)
            if text:
                self._accumulated_content += text
                self._chunk_index += 1
                return BridgeStreamEvent(
                    event_type=BridgeStreamEventType.CHUNK,
                    content=text,
                    model=self.model,
                    index=self._chunk_index - 1,
                )

        elif event_type == "content_block_start":
            content_block = event.get("content_block", {})
            self._thinking_handler.process_content_block(content_block)
            # If it's a text block and has initial text, emit it
            if content_block.get("type") == "text":
                text = content_block.get("text", "")
                if text:
                    self._accumulated_content += text
                    self._chunk_index += 1
                    return BridgeStreamEvent(
                        event_type=BridgeStreamEventType.CHUNK,
                        content=text,
                        model=self.model,
                        index=self._chunk_index - 1,
                    )

        elif event_type == "message_stop":
            usage_data = event.get("usage", {})
            if usage_data:
                self._final_usage = TokenUsage(
                    prompt_tokens=usage_data.get("input_tokens", 0),
                    completion_tokens=usage_data.get("output_tokens", 0),
                    total_tokens=usage_data.get("input_tokens", 0) + usage_data.get("output_tokens", 0),
                )
                return BridgeStreamEvent(
                    event_type=BridgeStreamEventType.USAGE,
                    usage=self._final_usage,
                    model=self.model,
                    index=self._chunk_index,
                )

        elif event_type == "message_delta":
            delta = event.get("delta", {})
            stop_reason = delta.get("stop_reason")
            usage_data = event.get("usage", {})
            if usage_data:
                self._final_usage = TokenUsage(
                    prompt_tokens=usage_data.get("input_tokens", 0),
                    completion_tokens=usage_data.get("output_tokens", 0),
                )
            if stop_reason:
                return BridgeStreamEvent(
                    event_type=BridgeStreamEventType.DONE,
                    finish_reason=stop_reason,
                    model=self.model,
                    index=self._chunk_index,
                )

        elif event_type == "error":
            error = event.get("error", {})
            error_msg = error.get("message", str(event))
            return BridgeStreamEvent(
                event_type=BridgeStreamEventType.ERROR,
                error=error_msg,
                model=self.model,
                index=self._chunk_index,
            )

        return None

    @property
    def accumulated_content(self) -> str:
        return self._accumulated_content

    @property
    def thinking_handler(self) -> ClaudeThinkingHandler:
        return self._thinking_handler


# ═══════════════════════════════════════════════════════════════════════════════
# Anthropic Bridge
# ═══════════════════════════════════════════════════════════════════════════════


class AnthropicBridge(BaseProviderBridge):
    """Bridge for Anthropic's Claude API (Messages API).

    Supports:
      - Claude Opus 4.5, 4.6, 4.7, 4.8
      - Claude Sonnet 4.6, 4.7, 5
      - Claude Fable 5
      - Claude Haiku 4.5, Haiku 5
      - Extended thinking (chain-of-thought)
      - Native streaming (content_block_delta / message_stop)
    """

    ANTHROPIC_VERSION = "2025-01-01"

    def __init__(
        self,
        config: Optional[BridgeConfig] = None,
        thinking_config: Optional[ClaudeThinkingConfig] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(config, **kwargs)
        self._thinking_config = thinking_config or ClaudeThinkingConfig()

        # Auto-resolve API key
        api_key = self._config.api_key or os.environ.get("ANTHROPIC_API_KEY", "")
        self._config.api_key = api_key

        # Default base_url
        if not self._config.base_url:
            self._config.base_url = "https://api.anthropic.com/v1"

        # Default model
        if not self._config.default_model:
            self._config.default_model = "claude-sonnet-5"

    def _derive_provider_name(self) -> str:
        return "anthropic"

    def _build_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "Content-Type": "application/json",
            "x-api-key": self._config.api_key,
            "anthropic-version": self.ANTHROPIC_VERSION,
        }
        headers.update(self._config.extra_headers)
        return headers

    def _build_chat_url(self) -> str:
        base = self._config.base_url.rstrip("/")
        return f"{base}/messages"

    def _build_request_body(
        self,
        messages: List[Dict[str, str]],
        system: Optional[str],
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
            "stream": stream,
            **self._config.extra_body,
        }

        if system:
            body["system"] = system

        if stop:
            body["stop_sequences"] = stop

        # Extended thinking
        if self._thinking_config.enabled:
            body["thinking"] = {
                "type": "enabled",
                "budget_tokens": self._thinking_config.budget_tokens,
            }

        # Remove None values
        body = {k: v for k, v in body.items() if v is not None}
        body.update(kwargs)
        return body

    def _parse_response(self, data: Dict[str, Any], model: str) -> BridgeResponse:
        content = ""
        thinking_result: Optional[ClaudeThinkingResult] = None

        # Parse content blocks
        content_blocks = data.get("content", [])
        thinking_handler = ClaudeThinkingHandler(self._thinking_config)
        for block in content_blocks:
            thinking_handler.process_content_block(block)

        content = thinking_handler.content

        usage_data = data.get("usage", {})
        usage = TokenUsage(
            prompt_tokens=usage_data.get("input_tokens", 0),
            completion_tokens=usage_data.get("output_tokens", 0),
            total_tokens=usage_data.get("input_tokens", 0) + usage_data.get("output_tokens", 0),
        )

        finish_reason = data.get("stop_reason", "end_turn") or "end_turn"

        extra: Dict[str, Any] = {}
        if thinking_handler.has_thinking:
            extra["thinking"] = thinking_handler.thinking
            if thinking_handler._signature:
                extra["thinking_signature"] = thinking_handler._signature

        return BridgeResponse(
            content=content,
            model=model,
            usage=usage,
            finish_reason=finish_reason,
            raw_response={**data, **extra},
            id=data.get("id", ""),
        )

    def _parse_stream_chunk(
        self, chunk_data: Dict[str, Any], model: str
    ) -> Optional[BridgeStreamEvent]:
        handler = AnthropicStreamHandler(model, self._thinking_config)
        raw_json = json.dumps(chunk_data)
        line = f"data: {raw_json}"
        return handler.process_line(line)

    def _resolve_model(self, model: Optional[str] = None) -> str:
        m = model or self._config.default_model
        return CLAUDE_ALIASES.get(m.lower(), m)

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
        effective_model = self._resolve_model(model)
        messages = self._build_messages(prompt, None)
        body = self._build_request_body(
            messages=messages,
            system=system,
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
        effective_model = self._resolve_model(model)
        messages = self._build_messages(prompt, None)
        body = self._build_request_body(
            messages=messages,
            system=system,
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
        handler = AnthropicStreamHandler(effective_model, self._thinking_config)

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
                        if event.event_type == BridgeStreamEventType.ERROR:
                            self._total_errors += 1
                            return

        except httpx.TimeoutException as e:
            yield BridgeStreamEvent(
                event_type=BridgeStreamEventType.ERROR,
                error=f"Anthropic stream timed out: {e}",
                model=effective_model,
            )
            self._total_errors += 1
            return
        except BridgeError:
            self._total_errors += 1
            raise
        except Exception as e:
            log.exception("Anthropic stream error")
            yield BridgeStreamEvent(
                event_type=BridgeStreamEventType.ERROR,
                error=str(e),
                model=effective_model,
            )
            self._total_errors += 1
            return

        elapsed_ms = (time.time() - t0) * 1000

        if handler._final_usage is None:
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
            finish_reason="end_turn",
            model=effective_model,
        )

        self._total_calls += 1
        self._total_latency_ms += elapsed_ms
        if handler._final_usage:
            self._cumulative_usage += handler._final_usage

    def count_tokens(self, text: str, model: Optional[str] = None) -> int:
        m = self._resolve_model(model)
        return count_tokens_heuristic(text, m)

    def estimate_cost(
        self,
        prompt_tokens: int,
        completion_tokens: int,
        model: Optional[str] = None,
    ) -> float:
        m = self._resolve_model(model)
        return estimate_cost_heuristic(prompt_tokens, completion_tokens, m)

    def get_model_list(self) -> List[str]:
        return list(CLAUDE_MODELS.keys()) + list(CLAUDE_ALIASES.keys())

    def get_model_info(self, model: str) -> Optional[Dict[str, Any]]:
        """Return metadata for a specific model."""
        full = CLAUDE_ALIASES.get(model.lower(), model)
        for model_id, info in CLAUDE_MODELS.items():
            if model_id == full:
                return info
        return None

    def resolve_model_name(self, alias: str) -> str:
        """Resolve a short alias to a full model ID."""
        return CLAUDE_ALIASES.get(alias.lower(), alias)
