"""Core type definitions for Lazy Chameleon v2.0."""
from dataclasses import dataclass, field
from typing import Optional, Callable


@dataclass
class LazyOutput:
    """Output from a lazy agent - generates synthetic parameters."""
    agent_name: str
    summary: str
    details: str
    confidence: float = 0.0
    tokens: int = 0
    parameter_equivalent: int = 0
    time_taken: float = 0.0


@dataclass
class CompressedIntelligence:
    """Compressed context fed to main agent as synthetic parameters."""
    findings: list[str] = field(default_factory=list)
    risks: list[str] = field(default_factory=list)
    recommendations: list[str] = field(default_factory=list)
    confidence: float = 0.0
    source_agents: list[str] = field(default_factory=list)
    synthetic_param_count: int = 0
    raw_tokens_compressed: int = 0


@dataclass
class Solution:
    content: str
    confidence: float = 0.0
    verification_status: str = "unverified"
    parameter_context_used: int = 0
    agents_consulted: list[str] = field(default_factory=list)
    pass_number: int = 0


@dataclass
class Result:
    answer: str
    confidence: float
    param_multiplier: int
    agents_used: list[str]
    cycles_used: int
    synthetic_params_generated: int
    tokens_consumed: int
    passes: int = 1
    synthesis_log: list[str] = field(default_factory=list)
    total_effective_params: int = 0
    quality_checkpoints: list[dict] = field(default_factory=list)


@dataclass
class ProviderConfig:
    """Configuration for a model provider."""
    name: str
    base_url: str
    api_key: str = ""
    model: str = ""
    headers: dict = field(default_factory=dict)
    supports_streaming: bool = True
    max_tokens: int = 64000
    temperature: float = 0.1
    timeout: float = 120.0


@dataclass
class AgentChainConfig:
    """Configuration for chaining with external agents."""
    agent_name: str = ""
    pipe_mode: bool = False
    brief_output: bool = False
    output_format: str = "plain"  # plain, json, markdown
    stream: bool = False
    stderr_progress: bool = True
