"""
Google Bridge — Gemini 2.5 Pro, Gemini 3.1 Pro/Flash

Supports:
  - Gemini 2.5 Pro (multimodal reasoning)
  - Gemini 3.1 Pro (next-gen reasoning)
  - Gemini 3.1 Flash (fast, cost-optimized)
  - Native Google Generative Language API
  - Streaming via SSE
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
# Gemini Model Catalog
# ═══════════════════════════════════════════════════════════════════════════════

GEMINI_MODELS: Dict[str, Dict[str, Any]] = {
    "gemini-2.5-pro": {
        "description": "Gemini 2.5 Pro — advanced multimodal reasoning",
        "max_tokens": 1048576,
        "max_output": 65536,
        "pricing": (0.0005, 0.0020),
        "supports_streaming": True,
        "supports_vision": True,
        "supports_tools": True,
        "supports_code_execution": True,
        "family": "gemini-2.5",
    },
    "gemini-3.1-pro": {
        "description": "Gemini 3.1 Pro — next-gen reasoning frontier",
        "max_tokens": 2097152,
        "max_output": 131072,
        "pricing": (0.0005, 0.0020),
        "supports_streaming": True,
        "supports_vision": True,
        "supports_tools": True,
        "supports_code_execution": True,
        "family": "gemini-3",
    },
    "gemini-3.1-flash": {
        "description": "Gemini 3.1 Flash — fast, cost-optimized",
        "max_tokens": 1048576,
        "max_output": 65536,
        "pricing": (0.00015, 0.0006),
        "supports_streaming": True,
        "supports_vision": True,
        "supports_tools": True,
        "supports_code_execution": True,
        "family": "gemini-3",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# Gemini Stream Handler
# ═══════════════════════════════════════════════════════════════════════════════


class GeminiStreamHandler:
    """Parses Google Gemini SSE stream chunks into BridgeStreamEvents."""

    def __init__(self, model: str) -> None:
        self.model = model
        self._chunk_index: int = 0
        self._accumulated_content: str = ""
        self._final_usage: Optional[TokenUsage] = None

    def process_line(self, line: str) -> Optional[BridgeStreamEvent]:
        """Process a single SSE line from Gemini's stream."""
        if not line or not line.startswith("data: "):
            return None

        raw = line[6:].strip()
        if not raw:
            return None

        try:
            chunk = json.loads(raw)
        except json.JSONDecodeError:
            return None

        candidates = chunk.get("candidates", [])
        if not candidates:
            # Check for usage metadata in non-candidate chunks
            usage_meta = chunk.get("usageMetadata", {})
            if usage_meta:
                self._final_usage = TokenUsage(
                    prompt_tokens=usage_meta.get("promptTokenCount", 0),
                    completion_tokens=usage_meta.get("candidatesTokenCount", 0),
                    total_tokens=usage_meta.get("totalTokenCount", 0),
                )
                return BridgeStreamEvent(
                    event_type=BridgeStreamEventType.USAGE,
                    usage=self._final_usage,
                    model=self.model,
                    index=self._chunk_index,
                )
            return None

        candidate = candidates[0]
        content = candidate.get("content", {})
        parts = content.get("parts", [])
        finish_reason = candidate.get("finishReason")

        text = ""
        for part in parts:
            text += part.get("text", "")

        if text:
            self._accumulated_content += text

        if text or finish_reason:
            evt_type = BridgeStreamEventType.CHUNK if text else BridgeStreamEventType.DONE
            event = BridgeStreamEvent(
                event_type=evt_type,
                content=text,
                finish_reason=finish_reason,
                model=self.model,
                index=self._chunk_index,
            )
            self._chunk_index += 1
            return event

        return None

    @property
    def accumulated_content(self) -> str:
        return self._accumulated_content


# ═══════════════════════════════════════════════════════════════════════════════
# Google Bridge
# ═══════════════════════════════════════════════════════════════════════════════


class GoogleBridge(BaseProviderBridge):
    """Bridge for Google Gemini API.

    Supports Gemini 2.5 Pro, Gemini 3.1 Pro, and Gemini 3.1 Flash.
    Uses Google's Generative Language API format.
    """

    def __init__(
        self,
        config: Optional[BridgeConfig] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(config, **kwargs)

        # Auto-resolve API key
        api_key = self._config.api_key or os.environ.get("GOOGLE_API_KEY", "") or os.environ.get("GEMINI_API_KEY", "")
        self._config.api_key = api_key

        # Default base_url
        if not self._config.base_url:
            self._config.base_url = "https://generativelanguage.googleapis.com/v1beta"

        # Default model
        if not self._config.default_model:
            self._config.default_model = "gemini-2.5-pro"

    def _derive_provider_name(self) -> str:
        return "google"

    def _build_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "Content-Type": "application/json",
        }
        headers.update(self._config.extra_headers)
        return headers

    def _build_chat_url(self) -> str:
        base = self._config.base_url.rstrip("/")
        model = self._config.default_model
        key = self._config.api_key
        return f"{base}/models/{model}:generateContent?key={key}"

    def _build_stream_url(self, model: str) -> str:
        base = self._config.base_url.rstrip("/")
        key = self._config.api_key
        return f"{base}/models/{model}:streamGenerateContent?key={key}"

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
        # Convert OpenAI-style messages to Gemini format
        contents: List[Dict[str, Any]] = []
        system_instruction: Optional[str] = None

        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            if role == "system":
                system_instruction = content
                continue

            gemini_role = "model" if role in ("assistant", "model") else "user"
            contents.append({
                "role": gemini_role,
                "parts": [{"text": content}],
            })

        body: Dict[str, Any] = {
            "contents": contents,
            "generationConfig": {
                "maxOutputTokens": max_tokens or self._config.max_tokens,
                "temperature": temperature if temperature is not None else self._config.temperature,
                "topP": self._config.top_p,
            },
            **self._config.extra_body,
        }

        if system_instruction:
            body["systemInstruction"] = {"parts": [{"text": system_instruction}]}

        if stop:
            body["generationConfig"]["stopSequences"] = stop

        # Remove None values from generationConfig
        body["generationConfig"] = {
            k: v for k, v in body["generationConfig"].items() if v is not None
        }

        body.update(kwargs)
        return body

    def _build_messages(
        self, prompt: str, system: Optional[str] = None
    ) -> List[Dict[str, str]]:
        messages: List[Dict[str, str]] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        return messages

    def _parse_response(self, data: Dict[str, Any], model: str) -> BridgeResponse:
        content = ""
        finish_reason = "STOP"

        candidates = data.get("candidates", [])
        if candidates:
            parts = candidates[0].get("content", {}).get("parts", [])
            for part in parts:
                content += part.get("text", "")
            finish_reason = candidates[0].get("finishReason", "STOP") or "STOP"

        usage_meta = data.get("usageMetadata", {})
        usage = TokenUsage(
            prompt_tokens=usage_meta.get("promptTokenCount", 0),
            completion_tokens=usage_meta.get("candidatesTokenCount", 0),
            total_tokens=usage_meta.get("totalTokenCount", 0),
        )

        return BridgeResponse(
            content=content,
            model=model,
            usage=usage,
            finish_reason=finish_reason,
            raw_response=data,
        )

    def _parse_stream_chunk(
        self, chunk_data: Dict[str, Any], model: str
    ) -> Optional[BridgeStreamEvent]:
        handler = GeminiStreamHandler(model)
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

        url = f"{self._config.base_url.rstrip('/')}/models/{effective_model}:generateContent?key={self._config.api_key}"
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

        url = f"{self._config.base_url.rstrip('/')}/models/{effective_model}:streamGenerateContent?key={self._config.api_key}"
        headers = self._build_headers()
        client = self._get_client()
        handler = GeminiStreamHandler(effective_model)

        t0 = time.time()

        try:
            with client.stream("POST", url, json=body, headers=headers) as response:
                self._raise_for_status(response)

                for line in response.iter_lines():
                    decoded = line.decode("utf-8") if isinstance(line, bytes) else line
                    event = handler.process_line(decoded)
                    if event is not None:
                        yield event

        except httpx.TimeoutException as e:
            yield BridgeStreamEvent(
                event_type=BridgeStreamEventType.ERROR,
                error=f"Gemini stream timed out: {e}",
                model=effective_model,
            )
            self._total_errors += 1
            return
        except BridgeError:
            self._total_errors += 1
            raise
        except Exception as e:
            log.exception("Gemini stream error")
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
            self._cumulative_usage += final_usage
        else:
            self._cumulative_usage += handler._final_usage

        yield BridgeStreamEvent(
            event_type=BridgeStreamEventType.DONE,
            finish_reason="STOP",
            model=effective_model,
        )

        self._total_calls += 1
        self._total_latency_ms += elapsed_ms

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
        return list(GEMINI_MODELS.keys())

    def get_model_info(self, model: str) -> Optional[Dict[str, Any]]:
        for model_id, info in GEMINI_MODELS.items():
            if model_id in model:
                return info
        return None
