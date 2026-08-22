"""
Cloud Teacher Adapter — wraps any OpenAI-compatible / cloud-hosted model
as a teacher for large-scale distillation (480B–10T parameter scale).
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Any

import httpx

log = logging.getLogger(__name__)

# ── Constants ──────────────────────────────────────────────────────────────────

CACHE_DIR = Path.home() / ".lazy_chameleon" / "teacher_cache"

PROVIDER_URLS: dict[str, str] = {
    "opencode":     "https://opencode.ai/zen/v1",
    "opencode-zen": "https://opencode.ai/zen/v1",
    "opencode-go":  "https://opencode.ai/zen/go/v1",
    "openai":       "https://api.openai.com/v1",
    "anthropic":    "https://api.anthropic.com/v1",
    "openrouter":   "https://openrouter.ai/api/v1",
}

MODEL_CAPACITY: dict[str, int] = {
    "gpt-4o":              1_000_000_000_000,
    "gpt-5":               5_000_000_000_000,
    "claude-opus-4":      10_000_000_000_000,
    "claude-sonnet-5":     5_000_000_000_000,
    "claude-sonnet-4":     2_000_000_000_000,
    "claude-haiku-4":        500_000_000_000,
    "deepseek-v4":         1_000_000_000_000,
    "deepseek-v3":           671_000_000_000,
    "deepseek-v4-flash":     45_000_000_000,
    "deepseek-v3-flash":     37_000_000_000,
}

DEFAULT_TEACHER_CAPACITY = 500_000_000_000
DEFAULT_STUDENT_CAPACITY = 50_000_000_000


# ── Helpers ────────────────────────────────────────────────────────────────────

def _resolve_model_name(model: str) -> str:
    ALIASES = {
        "opus": "claude-opus-4-8", "sonnet": "claude-sonnet-5",
        "haiku": "claude-haiku-4-5-20251001", "dv4": "deepseek-v4",
        "dv4f": "deepseek-v4-flash", "gpt4o": "gpt-4o",
    }
    return ALIASES.get(model.lower(), model)


def _find_api_key(provider: str = "opencode-go") -> str:
    provider = provider.lower().replace("-", "_")
    for key in [
        f"{provider.upper()}_API_KEY",
        "OPENCODE_ZEN_API_KEY", "OPENCODE_GO_API_KEY",
        "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
    ]:
        val = os.environ.get(key)
        if val:
            return val
    hermes_env = Path.home() / ".hermes" / ".env"
    if hermes_env.exists():
        for line in hermes_env.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                if any(x in k.upper() for x in ["API_KEY", "TOKEN"]) and v:
                    return v
    return ""


def _estimate_model_capacity(model: str) -> int:
    return MODEL_CAPACITY.get(_resolve_model_name(model), DEFAULT_TEACHER_CAPACITY)


class TeacherResponseCache:
    """Disk-backed cache for teacher model responses (SHA-256 keyed)."""

    def __init__(self, cache_dir: str | Path = CACHE_DIR):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._hit_count = 0
        self._miss_count = 0
        self._write_count = 0

    def _key(self, model: str, prompt: str, system: str = "", temperature: float = 0.0) -> str:
        raw = f"{model}||{system}||{prompt}||{temperature}"
        return hashlib.sha256(raw.encode()).hexdigest()[:24]

    def get(self, model: str, prompt: str, system: str = "", temperature: float = 0.0) -> str | None:
        key = self._key(model, prompt, system, temperature)
        path = self.cache_dir / f"{key}.json"
        if path.exists():
            try:
                with open(path) as f:
                    data = json.load(f)
                self._hit_count += 1
                return data["response"]
            except (json.JSONDecodeError, KeyError, OSError):
                pass
        self._miss_count += 1
        return None

    def set(self, model: str, prompt: str, response: str, system: str = "", temperature: float = 1.0):
        key = self._key(model, prompt, system, temperature)
        path = self.cache_dir / f"{key}.json"
        with self._lock:
            try:
                with open(path, "w") as f:
                    json.dump({"model": model, "response": response, "cached_at": time.time()}, f)
                self._write_count += 1
            except OSError:
                pass

    def stats(self) -> dict:
        return {"hits": self._hit_count, "misses": self._miss_count,
                "written": self._write_count, "cache_dir": str(self.cache_dir)}

    def clear(self):
        count = 0
        for f in self.cache_dir.glob("*.json"):
            f.unlink()
            count += 1
        self._hit_count = self._miss_count = self._write_count = 0
        return count


# ── Teacher Adapter ────────────────────────────────────────────────────────────

@dataclass
class TeacherCall:
    model: str
    provider: str
    prompt: str
    response: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_ms: float = 0.0
    cached: bool = False
    timestamp: float = field(default_factory=time.time)


@dataclass
class CloudTeacherConfig:
    provider: str = "opencode-go"
    model: str = "deepseek-v4-flash"
    api_key: str = ""
    base_url: str = ""
    temperature: float = 0.7
    max_tokens: int = 4096
    timeout: float = 120.0
    max_retries: int = 3
    cache_enabled: bool = True
    cache_dir: str | Path = CACHE_DIR
    cost_tracking: bool = True
    max_daily_cost_usd: float = 50.0

    def __post_init__(self):
        if not self.api_key:
            self.api_key = _find_api_key(self.provider)
        if not self.base_url:
            self.base_url = PROVIDER_URLS.get(self.provider, PROVIDER_URLS["opencode-go"])
        self.model = _resolve_model_name(self.model)


class CloudTeacherAdapter:
    """Wraps any cloud-hosted model as a teacher for distillation."""

    def __init__(self, config: CloudTeacherConfig | None = None):
        self.config = config or CloudTeacherConfig()
        self.cache = TeacherResponseCache(self.config.cache_dir) if self.config.cache_enabled else None
        self._calls: list[TeacherCall] = []
        self._total_cost: float = 0.0
        self._daily_cost: float = 0.0
        self._cost_reset_day = time.time()
        self._lock = threading.Lock()

    def generate(self, prompt: str, system: str = "",
                 temperature: float | None = None, max_tokens: int | None = None,
                 use_cache: bool = True) -> str:
        temp = temperature if temperature is not None else self.config.temperature
        mt = max_tokens or self.config.max_tokens
        if use_cache and self.cache:
            cached = self.cache.get(self.config.model, prompt, system, temp)
            if cached is not None:
                self._calls.append(TeacherCall(self.config.model, self.config.provider, prompt, cached, cached=True))
                return cached
        self._check_daily_budget()
        t0 = time.time()
        if self.config.provider == "anthropic":
            response = self._call_anthropic(prompt, system, temp, mt)
        else:
            response = self._call_openai_compat(prompt, system, temp, mt)
        latency = (time.time() - t0) * 1000
        self._calls.append(TeacherCall(self.config.model, self.config.provider, prompt, response, latency_ms=latency))
        self._track_cost(response, prompt)
        if use_cache and self.cache:
            self.cache.set(self.config.model, prompt, response, system, temp)
        return response

    def generate_batch(self, prompts: list[str], system: str = "",
                       temperature: float | None = None, max_tokens: int | None = None) -> list[str]:
        responses: list[str] = []
        for i, prompt in enumerate(prompts):
            try:
                responses.append(self.generate(prompt, system, temperature, max_tokens))
            except Exception as e:
                log.warning("Teacher call %d/%d failed: %s", i + 1, len(prompts), e)
                responses.append("")
            if i < len(prompts) - 1:
                time.sleep(0.25)
        return responses

    def total_cost(self) -> float:
        return self._total_cost

    def call_count(self) -> int:
        return len(self._calls)

    def stats(self) -> dict:
        cached = sum(1 for c in self._calls if c.cached)
        total = len(self._calls)
        avg_lat = sum(c.latency_ms for c in self._calls if not c.cached) / max(total - cached, 1)
        return {"model": self.config.model, "provider": self.config.provider,
                "total_calls": total, "cached": cached,
                "cache_hit_rate": cached / max(total, 1),
                "avg_latency_ms": round(avg_lat, 1),
                "total_cost_usd": round(self._total_cost, 4),
                "daily_cost_usd": round(self._daily_cost, 4),
                "cache_stats": self.cache.stats() if self.cache else {}}

    def reset_daily_cost(self):
        with self._lock:
            self._daily_cost = 0.0
            self._cost_reset_day = time.time()

    def _call_openai_compat(self, prompt: str, system: str, temperature: float, max_tokens: int) -> str:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        payload = {"model": self.config.model, "messages": messages,
                   "temperature": temperature, "max_tokens": max_tokens}
        url = f"{self.config.base_url.rstrip('/')}/chat/completions"
        headers = {"Authorization": f"Bearer {self.config.api_key}", "Content-Type": "application/json"}
        for attempt in range(self.config.max_retries):
            try:
                with httpx.Client(timeout=self.config.timeout) as client:
                    return client.post(url, json=payload, headers=headers).json()["choices"][0]["message"]["content"]
            except httpx.HTTPStatusError as e:
                if e.response.status_code in (429, 503, 529):
                    time.sleep(2 ** attempt + 1)
                    continue
                raise
            except (httpx.TimeoutException, httpx.ConnectError):
                time.sleep(2 ** attempt + 1)
                continue
        raise RuntimeError(f"Teacher API failed after {self.config.max_retries} retries")

    def _call_anthropic(self, prompt: str, system: str, temperature: float, max_tokens: int) -> str:
        payload = {"model": self.config.model, "max_tokens": max_tokens,
                   "temperature": temperature, "messages": [{"role": "user", "content": prompt}]}
        if system:
            payload["system"] = system
        url = f"{self.config.base_url.rstrip('/')}/messages"
        headers = {"x-api-key": self.config.api_key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"}
        for attempt in range(self.config.max_retries):
            try:
                with httpx.Client(timeout=self.config.timeout) as client:
                    return client.post(url, json=payload, headers=headers).json()["content"][0]["text"]
            except httpx.HTTPStatusError as e:
                if e.response.status_code in (429, 503, 529):
                    time.sleep(2 ** attempt + 1)
                    continue
                raise
            except (httpx.TimeoutException, httpx.ConnectError):
                time.sleep(2 ** attempt + 1)
                continue
        raise RuntimeError(f"Anthropic API failed after {self.config.max_retries} retries")

    def _check_daily_budget(self):
        if not self.config.cost_tracking:
            return
        now = time.time()
        if now - self._cost_reset_day > 86400:
            self.reset_daily_cost()
        if self._daily_cost >= self.config.max_daily_cost_usd:
            raise RuntimeError(f"Daily teacher budget (${self.config.max_daily_cost_usd:.2f}) exceeded.")

    def _track_cost(self, response: str, prompt: str):
        if not self.config.cost_tracking:
            return
        in_tokens = len(prompt) // 4
        out_tokens = len(response) // 4
        cost = (in_tokens / 1_000_000) * 15 + (out_tokens / 1_000_000) * 60
        with self._lock:
            self._total_cost += cost
            self._daily_cost += cost

    def __repr__(self) -> str:
        return f"CloudTeacherAdapter({self.config.provider}/{self.config.model}, calls={self.call_count()})"


# ── Teacher Ensemble ───────────────────────────────────────────────────────────

@dataclass
class TeacherEnsembleConfig:
    teachers: list[CloudTeacherConfig] = field(default_factory=lambda: [
        CloudTeacherConfig(provider="opencode-go", model="deepseek-v4-flash", temperature=0.7),
    ])
    strategy: str = "best_of"

    def __post_init__(self):
        if not self.teachers:
            self.teachers = [CloudTeacherConfig()]


class CloudTeacherEnsemble:
    """Manages an ensemble of cloud teacher models for distillation."""

    def __init__(self, config: TeacherEnsembleConfig | None = None):
        self.config = config or TeacherEnsembleConfig()
        self.adapters: list[CloudTeacherAdapter] = [CloudTeacherAdapter(tc) for tc in self.config.teachers]
        self._responses: list[tuple[str, str, float]] = []

    def generate(self, prompt: str, system: str = "", temperature: float | None = None) -> str:
        self._responses.clear()
        temp = temperature if temperature is not None else 0.7
        for adapter in self.adapters:
            try:
                resp = adapter.generate(prompt, system, temperature=temp)
                score = self._score(resp, prompt)
                self._responses.append((adapter.config.model, resp, score))
            except Exception as e:
                log.warning("Teacher %s failed: %s", adapter.config.model, e)
        if not self._responses:
            raise RuntimeError("All teachers failed")
        if self.config.strategy == "best_of":
            return max(self._responses, key=lambda x: x[2])[1]
        return self._responses[0][1]

    def _score(self, response: str, task: str) -> float:
        if not response:
            return 0.0
        s = 0.5
        if len(response) > 500:
            s += 0.1
        if len(response) > 2000:
            s += 0.1
        if "```" in response:
            s += 0.05
        if any(w in response.lower() for w in ["therefore", "reason", "step", "example"]):
            s += 0.1
        return min(s, 0.99)

    def stats(self) -> dict:
        return {"strategy": self.config.strategy, "num_teachers": len(self.adapters),
                "teacher_stats": {a.config.model: a.stats() for a in self.adapters}}

    def __repr__(self) -> str:
        models = [a.config.model for a in self.adapters]
        return f"CloudTeacherEnsemble(strategy={self.config.strategy}, teachers={models})"


# ═════════════════════════════════════════════════════════════════════════════
# TEACHER PROVIDER PRESETS — Pre-configured teacher model configurations
# ═════════════════════════════════════════════════════════════════════════════

TEACHER_PRESETS: Dict[str, Dict[str, Any]] = {
    "claude_opus_4_7": {
        "provider": "anthropic",
        "model": "claude-opus-4-7",
        "max_tokens": 8192,
        "temperature": 0.3,
        "top_p": 0.95,
        "supports_thinking": True,
        "cost_input_per_1m": 15.0,
        "cost_output_per_1m": 75.0,
        "strengths": ["reasoning", "math", "coding", "analysis"],
        "context_window": 200000,
    },
    "claude_opus_4_8": {
        "provider": "anthropic",
        "model": "claude-opus-4-8",
        "max_tokens": 16384,
        "temperature": 0.3,
        "top_p": 0.95,
        "supports_thinking": True,
        "cost_input_per_1m": 15.0,
        "cost_output_per_1m": 75.0,
        "strengths": ["frontier_reasoning", "math_competition", "advanced_coding"],
        "context_window": 200000,
    },
    "claude_fable_5": {
        "provider": "anthropic",
        "model": "claude-fable-5",
        "max_tokens": 32768,
        "temperature": 0.4,
        "top_p": 0.95,
        "supports_thinking": True,
        "cost_input_per_1m": 25.0,
        "cost_output_per_1m": 125.0,
        "strengths": ["frontier_reasoning", "creative", "expert_knowledge", "research"],
        "context_window": 200000,
    },
    "claude_sonnet_5": {
        "provider": "anthropic",
        "model": "claude-sonnet-5",
        "max_tokens": 8192,
        "temperature": 0.5,
        "top_p": 0.95,
        "supports_thinking": True,
        "cost_input_per_1m": 3.0,
        "cost_output_per_1m": 15.0,
        "strengths": ["reasoning", "coding", "analysis", "speed"],
        "context_window": 200000,
    },
    "gpt_5_5": {
        "provider": "openai",
        "model": "gpt-5.5",
        "max_tokens": 16384,
        "temperature": 0.4,
        "top_p": 0.95,
        "supports_thinking": False,
        "cost_input_per_1m": 15.0,
        "cost_output_per_1m": 60.0,
        "strengths": ["coding", "reasoning", "science", "math_competition"],
        "context_window": 256000,
    },
    "gpt_5_4": {
        "provider": "openai",
        "model": "gpt-5.4",
        "max_tokens": 8192,
        "temperature": 0.5,
        "top_p": 0.95,
        "supports_thinking": False,
        "cost_input_per_1m": 10.0,
        "cost_output_per_1m": 40.0,
        "strengths": ["coding", "reasoning", "general", "analysis"],
        "context_window": 128000,
    },
    "deepseek_r1": {
        "provider": "deepseek",
        "model": "deepseek-reasoner",
        "max_tokens": 8192,
        "temperature": 0.6,
        "top_p": 0.95,
        "supports_thinking": True,
        "cost_input_per_1m": 0.55,
        "cost_output_per_1m": 2.19,
        "strengths": ["math", "reasoning", "code", "cost_effective"],
        "context_window": 128000,
    },
    "grok_4_4": {
        "provider": "xai",
        "model": "grok-4.4",
        "max_tokens": 8192,
        "temperature": 0.5,
        "top_p": 0.95,
        "supports_thinking": False,
        "cost_input_per_1m": 5.0,
        "cost_output_per_1m": 15.0,
        "strengths": ["reasoning", "science", "code", "analysis"],
        "context_window": 128000,
    },
    "gemini_3_1_pro": {
        "provider": "google",
        "model": "gemini-3.1-pro",
        "max_tokens": 16384,
        "temperature": 0.4,
        "top_p": 0.95,
        "supports_thinking": True,
        "cost_input_per_1m": 5.0,
        "cost_output_per_1m": 20.0,
        "strengths": ["reasoning", "code", "long_context", "multimodal"],
        "context_window": 1000000,
    },
    "qwen_3_7_max": {
        "provider": "qwen",
        "model": "qwen-3.7-max",
        "max_tokens": 8192,
        "temperature": 0.5,
        "top_p": 0.95,
        "supports_thinking": False,
        "cost_input_per_1m": 2.0,
        "cost_output_per_1m": 8.0,
        "strengths": ["reasoning", "code", "math", "multilingual"],
        "context_window": 128000,
    },
    "llama_4_maverick": {
        "provider": "together",
        "model": "llama-4-maverick",
        "max_tokens": 8192,
        "temperature": 0.6,
        "top_p": 0.95,
        "supports_thinking": False,
        "cost_input_per_1m": 0.9,
        "cost_output_per_1m": 0.9,
        "strengths": ["reasoning", "code", "general", "cost_effective"],
        "context_window": 128000,
    },
    "glm_5_2": {
        "provider": "zhipu",
        "model": "glm-5.2",
        "max_tokens": 8192,
        "temperature": 0.5,
        "top_p": 0.95,
        "supports_thinking": False,
        "cost_input_per_1m": 1.0,
        "cost_output_per_1m": 4.0,
        "strengths": ["code", "reasoning", "multilingual", "security"],
        "context_window": 128000,
    },
}


# ═════════════════════════════════════════════════════════════════════════════
# TEACHER ENSEMBLE STRATEGIES — How to combine multiple teacher outputs
# ═════════════════════════════════════════════════════════════════════════════

ENSEMBLE_STRATEGIES: Dict[str, Dict[str, Any]] = {
    "best_of_n": {
        "description": "Generate n responses, pick the best by quality score",
        "requires_scoring": True,
        "diversity": "low",
        "cost_multiplier": 1.0,
        "recommended_n": 3,
    },
    "majority_vote": {
        "description": "Generate n responses, take majority answer",
        "requires_scoring": False,
        "diversity": "medium",
        "cost_multiplier": 1.0,
        "recommended_n": 5,
        "only_for": ["math", "multiple_choice", "classification"],
    },
    "mixture_of_teachers": {
        "description": "Each teacher generates independently, merge via router",
        "requires_scoring": True,
        "diversity": "high",
        "cost_multiplier": 3.0,
        "recommended_n": 3,
        "teachers": ["claude-opus-4-8", "gpt-5.5", "deepseek-r1"],
    },
    "debate": {
        "description": "Teachers debate, judge selects best answer",
        "requires_scoring": True,
        "diversity": "high",
        "cost_multiplier": 5.0,
        "recommended_n": 2,
        "teachers": ["claude-fable-5", "gpt-5.5"],
        "rounds": 3,
    },
    "chain_of_teachers": {
        "description": "Teacher A generates, Teacher B refines, Teacher C verifies",
        "requires_scoring": False,
        "diversity": "low",
        "cost_multiplier": 3.0,
        "recommended_n": 1,
        "chain": ["deepseek-r1", "claude-sonnet-5", "claude-opus-4-8"],
    },
    "domain_expert": {
        "description": "Route each domain to the best teacher for that domain",
        "requires_scoring": False,
        "diversity": "medium",
        "cost_multiplier": 2.0,
        "routing": {
            "math": "deepseek-r1",
            "code": "gpt-5.5",
            "science": "claude-opus-4-8",
            "creative": "claude-fable-5",
            "analysis": "grok-4.4",
            "general": "claude-sonnet-5",
        },
    },
}
