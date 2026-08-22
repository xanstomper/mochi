"""Multi-provider API client — v2.2

Supported providers:
- opencode / opencode-zen / opencode-go  (OpenCode AI)
- anthropic                              (Native Anthropic Messages API)
- openai                                 (OpenAI-compatible, any base_url)
- openrouter                             (OpenRouter aggregator)

Features
--------
- Auto-detect provider from model name or base_url
- Native Anthropic Messages API (no shim)
- Retry with exponential back-off
- Token tracking per call, cumulative totals
- Streaming support (line-buffered SSE)
"""
from __future__ import annotations

import json
import time
from typing import Optional

import httpx


# ---------------------------------------------------------------------------
# Provider presets  — update these when new providers / models are added
# ---------------------------------------------------------------------------
PROVIDER_PRESETS: dict[str, dict] = {
    "opencode": {
        "base_url": "https://opencode.ai/zen/v1",
        "default_model": "deepseek-v4-flash",
    },
    "opencode-zen": {
        "base_url": "https://opencode.ai/zen/v1",
        "default_model": "deepseek-v4-flash",
    },
    "opencode-go": {
        "base_url": "https://opencode.ai/zen/go/v1",
        "default_model": "deepseek-v4-flash",
    },
    "openai": {
        "base_url": "https://api.openai.com/v1",
        "default_model": "gpt-4o",
    },
    "anthropic": {
        "base_url": "https://api.anthropic.com/v1",
        "default_model": "claude-sonnet-5",
    },
    "openrouter": {
        "base_url": "https://openrouter.ai/api/v1",
        "default_model": "anthropic/claude-sonnet-5",
    },
}

# Claude model short-names → full IDs
CLAUDE_ALIASES: dict[str, str] = {
    "haiku":   "claude-haiku-4-5-20251001",
    "haiku-4": "claude-haiku-4-5-20251001",
    "haiku45": "claude-haiku-4-5-20251001",
    "sonnet":  "claude-sonnet-5",
    "sonnet-5": "claude-sonnet-5",
    "opus":    "claude-opus-4-8",
    "opus-4":  "claude-opus-4-8",
    "fable":   "claude-fable-5",
    "fable-5": "claude-fable-5",
}


def resolve_model(model: str) -> str:
    """Expand short aliases to full model IDs."""
    return CLAUDE_ALIASES.get(model.lower(), model)


def detect_provider(model: str, base_url: str = "") -> str:
    """Infer provider from model name or base_url."""
    url = base_url.lower()
    mdl = model.lower()

    if "opencode" in url or "zen" in url:
        return "opencode"
    if "openrouter" in url:
        return "openrouter"
    if "anthropic" in url:
        return "anthropic"
    if "openai" in url:
        return "openai"

    if mdl.startswith("claude-"):
        return "anthropic"
    if mdl.startswith("gpt-") or mdl.startswith("o1") or mdl.startswith("o3"):
        return "openai"
    if mdl.startswith("deepseek-"):
        return "opencode"

    return "openai"  # safe default (OpenAI-compatible)


# ---------------------------------------------------------------------------
class FlashModelAPI:
    """Multi-provider LLM client with auto-detection and retry."""

    def __init__(
        self,
        api_key: str,
        provider: str = "opencode",
        model: str = "",
        base_url: str = "",
        max_retries: int = 3,
        timeout: float = 120.0,
    ) -> None:
        self.api_key = api_key
        self.total_tokens: int = 0
        self.total_calls: int = 0
        self.total_errors: int = 0
        self.max_retries = max_retries
        self.timeout = timeout

        preset = PROVIDER_PRESETS.get(provider, {})
        self.base_url = base_url or preset.get("base_url", "https://api.openai.com/v1")
        self.model = resolve_model(model or preset.get("default_model", "gpt-4o"))
        self.provider_name = provider

        # Re-detect in case provider string doesn't match exactly
        if not provider or provider not in PROVIDER_PRESETS:
            self.provider_name = detect_provider(self.model, self.base_url)

        self.headers = self._build_headers()
        self.client = httpx.Client(timeout=self.timeout, headers=self.headers)

    # ------------------------------------------------------------------
    def _build_headers(self) -> dict:
        if self.provider_name == "anthropic":
            return {
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    # ------------------------------------------------------------------
    def generate(
        self,
        prompt: str,
        system: str = "",
        max_tokens: int = 8192,
        temperature: float = 0.1,
    ) -> str:
        """Generate a completion with exponential-back-off retry."""
        last_err: Exception | None = None
        for attempt in range(self.max_retries):
            try:
                result = self._call(prompt, system, max_tokens, temperature)
                self.total_calls += 1
                return result
            except Exception as exc:
                last_err = exc
                self.total_errors += 1
                wait = 2 ** attempt
                time.sleep(wait)
        raise RuntimeError(f"API failed after {self.max_retries} attempts: {last_err}")

    # ------------------------------------------------------------------
    def _call(
        self,
        prompt: str,
        system: str,
        max_tokens: int,
        temperature: float,
    ) -> str:
        if self.provider_name == "anthropic":
            return self._call_anthropic(prompt, system, max_tokens, temperature)
        return self._call_openai_compat(prompt, system, max_tokens, temperature)

    # ------------------------------------------------------------------
    def _call_openai_compat(
        self,
        prompt: str,
        system: str,
        max_tokens: int,
        temperature: float,
    ) -> str:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        resp = self.client.post(f"{self.base_url}/chat/completions", json=payload)
        resp.raise_for_status()
        data = resp.json()
        usage = data.get("usage", {})
        self.total_tokens += usage.get("total_tokens", 0)
        return data["choices"][0]["message"]["content"]

    # ------------------------------------------------------------------
    def _call_anthropic(
        self,
        prompt: str,
        system: str,
        max_tokens: int,
        temperature: float,
    ) -> str:
        """Native Anthropic Messages API call."""
        payload: dict = {
            "model": self.model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system:
            payload["system"] = system

        resp = self.client.post(f"{self.base_url}/messages", json=payload)
        resp.raise_for_status()
        data = resp.json()
        usage = data.get("usage", {})
        self.total_tokens += usage.get("input_tokens", 0) + usage.get("output_tokens", 0)
        return data["content"][0]["text"]

    # ------------------------------------------------------------------
    def stream(
        self,
        prompt: str,
        system: str = "",
        max_tokens: int = 8192,
        temperature: float = 0.1,
    ):
        """Yield text chunks as they arrive (SSE / streaming)."""
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": True,
        }
        with self.client.stream(
            "POST", f"{self.base_url}/chat/completions", json=payload
        ) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line or not line.startswith("data: "):
                    continue
                raw = line[6:]
                if raw.strip() == "[DONE]":
                    break
                try:
                    chunk = json.loads(raw)
                    delta = chunk["choices"][0].get("delta", {})
                    text = delta.get("content", "")
                    if text:
                        yield text
                except (json.JSONDecodeError, KeyError):
                    continue

    # ------------------------------------------------------------------
    def get_usage(self) -> dict:
        """Return a lightweight usage snapshot (calls, tokens, errors).

        Unlike :meth:`stats` this only returns counters and is safe to call
        frequently without triggering any network I/O.
        """
        return {
            "calls": self.total_calls,
            "tokens": self.total_tokens,
            "errors": self.total_errors,
        }

    def reset_stats(self) -> None:
        """Reset all cumulative counters (calls, tokens, errors) to zero."""
        self.total_calls = 0
        self.total_tokens = 0
        self.total_errors = 0

    @staticmethod
    def list_models(provider: str = "") -> list[str]:
        """Return known model short-names for *provider* (or all providers).

        This is a static convenience lookup — it does **not** call any API.
        Pass an empty string to get every known model across all providers.
        """
        _KNOWN: dict[str, list[str]] = {
            "anthropic": list(CLAUDE_ALIASES.keys()),
            "openai": ["gpt-4o", "gpt-4o-mini", "o1", "o1-mini", "o3-mini"],
            "openrouter": ["openrouter-auto"],
            "opencode": ["opencode-go", "opencode-zen"],
            "deepseek": ["deepseek-v4-flash"],
        }
        if provider:
            return _KNOWN.get(provider.lower(), [])
        all_models: list[str] = []
        for models in _KNOWN.values():
            all_models.extend(models)
        return sorted(set(all_models))

    def stats(self) -> dict:
        return {
            "total_calls": self.total_calls,
            "total_tokens": self.total_tokens,
            "total_errors": self.total_errors,
            "model": self.model,
            "provider": self.provider_name,
        }

    def __repr__(self) -> str:
        return (
            f"FlashModelAPI(provider={self.provider_name!r}, "
            f"model={self.model!r}, calls={self.total_calls})"
        )
