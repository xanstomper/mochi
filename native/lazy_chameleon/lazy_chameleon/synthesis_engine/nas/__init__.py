"""Neural Architecture Search sub-package exports."""
from __future__ import annotations

from .neural_arch_search import (
    LayerConfig,
    AttentionConfig,
    RoutingNetworkConfig,
    ArchitectureSpec,
    ArchitectureGenerator,
    generate_layer,
    generate_attention_block,
    generate_routing_network,
    mutate_architecture,
    crossover_architectures,
    estimate_latency,
    estimate_memory,
)

__all__ = [
    "LayerConfig",
    "AttentionConfig",
    "RoutingNetworkConfig",
    "ArchitectureSpec",
    "ArchitectureGenerator",
    "generate_layer",
    "generate_attention_block",
    "generate_routing_network",
    "mutate_architecture",
    "crossover_architectures",
    "estimate_latency",
    "estimate_memory",
]
