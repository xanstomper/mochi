"""Configuration & Settings v2.1 — Latest Claude Models"""
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ModelConfig:
    """Flash model API config."""
    provider: str = "anthropic"
    model: str = "claude-haiku-4-5-20251001"
    base_url: str = "https://api.anthropic.com/v1"
    api_key: str = ""
    temperature: float = 0.0
    max_tokens: int = 64000


@dataclass
class HarnessConfig:
    """Harness configuration controlling parameter hallucination."""
    mode: str = "auto"

    # Latest Claude model IDs
    fast_model: str = "claude-haiku-4-5-20251001"
    balanced_model: str = "claude-sonnet-5"
    powerful_model: str = "claude-opus-4-8"
    frontier_model: str = "claude-fable-5"

    param_multipliers = {
        "flash": 3,
        "easy": 7,
        "turbo": 10,
        "medium": 50,
        "hard": 200,
        "deep": 500,
        "extreme": 1000,
        "genius": 2500,
        "god": 5000,
        "opus": 5000,
    }

    # Frontier model comparison targets (effective param equivalents)
    frontier_targets = {
        "claude-fable-5":        5_000_000_000_000,
        "claude-opus-4-8":       3_500_000_000_000,
        "claude-sonnet-5":       2_500_000_000_000,
        "claude-haiku-4-5":        800_000_000_000,
        "gpt-4-sol":             3_000_000_000_000,
        "grok-4":                4_000_000_000_000,
    }

    max_lazy_agents: int = 12
    max_spawn_depth: int = 3
    context_budget: int = 48000
    min_confidence: float = 0.7
    acceptance_threshold: float = 0.85
    memory_db_path: str = "~/.lazy-chameleon/memory.db"
    lead_model: ModelConfig = field(default_factory=ModelConfig)
    worker_model: Optional[ModelConfig] = None

    # Cache settings
    enable_cache: bool = True
    cache_ttl_seconds: int = 3600

    # Synthesis engine settings
    adapter_rank: int = 16
    adapter_alpha: float = 1.0
    num_teachers: int = 3
    rag_top_k: int = 8
    max_refinement_passes: int = 5

    # API settings
    max_retries: int = 3
    api_timeout: float = 120.0

    def get_param_multiplier(self) -> int:
        return self.param_multipliers.get(self.mode, 10)

    def get_target_params(self) -> int:
        mult = self.get_param_multiplier()
        base = 420_000_000_000  # 420B base
        return base * mult

    @property
    def model_config(self) -> ModelConfig:
        """Alias for lead_model — backward-compat with tests."""
        return self.lead_model

    def model_for_mode(self) -> str:
        """Return the best model for the current compute mode."""
        mode = self.mode.lower()
        if mode in ("flash", "easy"):
            return self.fast_model
        if mode in ("medium", "turbo", "hard"):
            return self.balanced_model
        if mode in ("deep", "extreme"):
            return self.powerful_model
        return self.frontier_model  # genius / god / opus
