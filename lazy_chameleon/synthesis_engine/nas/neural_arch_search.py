"""Neural Architecture Search: layer generation, attention blocks, routing networks,
mutation, crossover, and cost estimation."""
from __future__ import annotations

import math
import random
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Set, Tuple

import numpy as np


class LayerType(Enum):
    MLP = "mlp"
    ATTENTION = "attention"
    CROSS_ATTENTION = "cross_attention"
    CONVOLUTION = "convolution"
    NORMALIZATION = "normalization"
    DROPOUT = "dropout"
    MOE_MLP = "moe_mlp"
    MOE_ATTENTION = "moe_attention"


@dataclass
class LayerConfig:
    """Configuration for a single neural network layer."""
    layer_type: LayerType
    input_dim: int
    output_dim: int
    hidden_dim: Optional[int] = None
    num_heads: Optional[int] = None
    head_dim: Optional[int] = None
    activation: str = "silu"
    dropout_rate: float = 0.0
    use_bias: bool = True
    normalization: Optional[str] = "layer_norm"
    num_experts: Optional[int] = None
    expert_capacity_factor: float = 1.25
    moe_top_k: int = 2
    metadata: Dict[str, Any] = field(default_factory=dict)

    def parameter_count(self) -> int:
        """Estimate number of parameters for this layer."""
        count = 0
        if self.layer_type == LayerType.MLP:
            hidden = self.hidden_dim or (4 * self.input_dim)
            count += self.input_dim * hidden + hidden  # W1 + bias
            count += hidden * self.output_dim + self.output_dim  # W2 + bias
        elif self.layer_type in (LayerType.ATTENTION, LayerType.CROSS_ATTENTION):
            n_heads = self.num_heads or 8
            h_dim = self.head_dim or (self.input_dim // n_heads)
            q_dim = n_heads * h_dim
            count += 3 * (self.input_dim * q_dim + q_dim)  # Q, K, V
            count += q_dim * self.output_dim + self.output_dim  # Output projection
        elif self.layer_type == LayerType.MOE_MLP:
            n_exp = self.num_experts or 8
            hidden = self.hidden_dim or (4 * self.input_dim)
            exp_params = self.input_dim * hidden + hidden + hidden * self.output_dim + self.output_dim
            count += n_exp * exp_params
            count += n_exp * self.input_dim + n_exp  # Router
        else:
            count += self.input_dim * self.output_dim + self.output_dim
        return count


@dataclass
class AttentionConfig:
    """Configuration for attention blocks."""
    num_heads: int = 8
    head_dim: int = 64
    query_dim: int = 512
    key_dim: Optional[int] = None
    value_dim: Optional[int] = None
    output_dim: int = 512
    dropout: float = 0.0
    use_rotary: bool = True
    use_flash: bool = True
    window_size: Optional[int] = None
    num_kv_heads: Optional[int] = None  # For GQA/MQA

    def __post_init__(self) -> None:
        if self.key_dim is None:
            self.key_dim = self.head_dim
        if self.value_dim is None:
            self.value_dim = self.head_dim
        if self.num_kv_heads is None:
            self.num_kv_heads = self.num_heads

    def total_qkv_params(self) -> int:
        q = self.query_dim * (self.num_heads * self.head_dim)
        k = self.query_dim * (self.num_kv_heads * self.key_dim)
        v = self.query_dim * (self.num_kv_heads * self.value_dim)
        return q + k + v

    def total_output_params(self) -> int:
        return (self.num_heads * self.head_dim) * self.output_dim

    def flops_per_token(self, seq_len: int = 2048) -> int:
        """Estimate FLOPs for one forward pass of this attention."""
        h = self.num_heads
        d = self.head_dim
        s = seq_len
        # QK^T: 2 * s^2 * h * d
        # PV: 2 * s^2 * h * d
        # Projections: 2 * s * (params)
        attn = 4 * s * s * h * d
        proj = 2 * s * (self.total_qkv_params() + self.total_output_params())
        return attn + proj


@dataclass
class RoutingNetworkConfig:
    """Configuration for MoE routing networks."""
    input_dim: int = 512
    num_experts: int = 8
    top_k: int = 2
    hidden_dim: Optional[int] = None
    routing_type: str = "softmax_topk"  # softmax_topk, sigmoid, noisy_topk, switch
    capacity_factor: float = 1.25
    load_balance_coef: float = 0.01
    z_loss_coef: float = 0.001
    aux_loss_coef: float = 0.01

    @property
    def effective_hidden_dim(self) -> int:
        return self.hidden_dim or max(64, self.input_dim // 4)

    def router_parameter_count(self) -> int:
        return self.input_dim * self.num_experts  # Simple linear router


@dataclass
class ArchitectureSpec:
    """Full architecture specification."""
    layers: List[LayerConfig] = field(default_factory=list)
    attention_configs: List[AttentionConfig] = field(default_factory=list)
    routing_config: Optional[RoutingNetworkConfig] = None
    hidden_size: int = 512
    num_layers: int = 12
    vocab_size: int = 32000
    max_seq_len: int = 4096

    def total_parameters(self) -> int:
        """Compute total parameter count."""
        total = 0
        for layer in self.layers:
            total += layer.parameter_count()
        # Embedding
        total += self.vocab_size * self.hidden_size
        if self.routing_config:
            total += self.routing_config.router_parameter_count()
        return total

    def to_dict(self) -> Dict[str, Any]:
        return {
            "hidden_size": self.hidden_size,
            "num_layers": self.num_layers,
            "layers": [layer.__dict__ for layer in self.layers],
            "attention_configs": [ac.__dict__ for ac in self.attention_configs],
            "routing_config": self.routing_config.__dict__ if self.routing_config else None,
        }


class ArchitectureGenerator:
    """Generates and manipulates neural architectures."""

    def __init__(self, seed: int = 42):
        self.rng = random.Random(seed)
        self.np_rng = np.random.default_rng(seed)

    def generate_layer(
        self,
        input_dim: int,
        output_dim: int,
        layer_type: Optional[LayerType] = None,
    ) -> LayerConfig:
        """Generate a random layer configuration."""
        if layer_type is None:
            layer_type = self.rng.choice([
                LayerType.MLP, LayerType.ATTENTION, LayerType.MOE_MLP,
            ])

        config = LayerConfig(
            layer_type=layer_type,
            input_dim=input_dim,
            output_dim=output_dim,
        )

        if layer_type == LayerType.MLP:
            ratio = self.rng.choice([2, 3, 4, 6, 8])
            config.hidden_dim = input_dim * ratio
            config.activation = self.rng.choice(["silu", "gelu", "relu", "swiglu"])

        elif layer_type in (LayerType.ATTENTION, LayerType.CROSS_ATTENTION):
            config.num_heads = self.rng.choice([4, 8, 12, 16, 32])
            config.head_dim = self.rng.choice([32, 64, 96, 128])

        elif layer_type == LayerType.MOE_MLP:
            config.hidden_dim = input_dim * 4
            config.num_experts = self.rng.choice([4, 8, 16, 32, 64, 128])
            config.moe_top_k = self.rng.choice([1, 2, 4])

        config.dropout_rate = self.rng.uniform(0.0, 0.2)
        return config

    def generate_attention_block(
        self,
        hidden_size: int,
        num_heads: Optional[int] = None,
    ) -> AttentionConfig:
        """Generate an attention block configuration."""
        if num_heads is None:
            num_heads = self.rng.choice([4, 8, 12, 16, 32])

        head_dim = self.rng.choice([32, 64, 96, 128])
        num_kv_heads = self.rng.choice([1, 2, 4, 8, num_heads])
        num_kv_heads = min(num_kv_heads, num_heads)

        return AttentionConfig(
            num_heads=num_heads,
            head_dim=head_dim,
            query_dim=hidden_size,
            output_dim=hidden_size,
            dropout=self.rng.uniform(0.0, 0.15),
            use_rotary=self.rng.random() < 0.8,
            use_flash=self.rng.random() < 0.7,
            window_size=self.rng.choice([None, 512, 1024, 2048]) if self.rng.random() < 0.3 else None,
            num_kv_heads=num_kv_heads,
        )

    def generate_routing_network(
        self,
        input_dim: int,
        num_experts: Optional[int] = None,
    ) -> RoutingNetworkConfig:
        """Generate a routing network configuration."""
        if num_experts is None:
            num_experts = self.rng.choice([4, 8, 16, 32, 64, 128, 256])

        return RoutingNetworkConfig(
            input_dim=input_dim,
            num_experts=num_experts,
            top_k=self.rng.choice([1, 2, 4]),
            routing_type=self.rng.choice(["softmax_topk", "sigmoid", "noisy_topk", "switch"]),
            capacity_factor=self.rng.uniform(1.0, 2.0),
        )

    def generate_full_architecture(
        self,
        num_layers: int = 12,
        hidden_size: int = 512,
        vocab_size: int = 32000,
    ) -> ArchitectureSpec:
        """Generate a complete random architecture."""
        layers: List[LayerConfig] = []
        attention_configs: List[AttentionConfig] = []

        for i in range(num_layers):
            # Alternate attention and MLP
            if i % 2 == 0:
                attn = self.generate_attention_block(hidden_size)
                attention_configs.append(attn)
                layer = LayerConfig(
                    layer_type=LayerType.ATTENTION,
                    input_dim=hidden_size,
                    output_dim=hidden_size,
                    num_heads=attn.num_heads,
                    head_dim=attn.head_dim,
                )
            else:
                if self.rng.random() < 0.3:
                    layer = self.generate_layer(hidden_size, hidden_size, LayerType.MOE_MLP)
                else:
                    layer = self.generate_layer(hidden_size, hidden_size, LayerType.MLP)
            layers.append(layer)

        routing = self.generate_routing_network(hidden_size)

        return ArchitectureSpec(
            layers=layers,
            attention_configs=attention_configs,
            routing_config=routing,
            hidden_size=hidden_size,
            num_layers=num_layers,
            vocab_size=vocab_size,
        )

    def mutate_architecture(self, arch: ArchitectureSpec, mutation_rate: float = 0.2) -> ArchitectureSpec:
        """Mutate an architecture by randomly changing layer configs."""
        new_layers: List[LayerConfig] = []

        for layer in arch.layers:
            if self.rng.random() < mutation_rate:
                # Mutate this layer
                mutated = LayerConfig(
                    layer_type=layer.layer_type,
                    input_dim=layer.input_dim,
                    output_dim=layer.output_dim,
                    hidden_dim=layer.hidden_dim,
                    num_heads=layer.num_heads,
                    head_dim=layer.head_dim,
                    activation=self.rng.choice(["silu", "gelu", "relu", "swiglu"]),
                    dropout_rate=layer.dropout_rate,
                    use_bias=self.rng.random() < 0.8 if layer.use_bias else self.rng.random() < 0.2,
                    normalization=layer.normalization,
                    num_experts=layer.num_experts,
                    moe_top_k=layer.moe_top_k,
                )
                # Tweak dimensions
                if mutated.hidden_dim is not None:
                    mutated.hidden_dim = int(mutated.hidden_dim * (1.0 + self.rng.gauss(0.0, 0.1)))
                    mutated.hidden_dim = max(16, (mutated.hidden_dim // 64) * 64)
                if mutated.num_heads is not None:
                    mutated.num_heads = max(1, mutated.num_heads + self.rng.choice([-4, -2, 2, 4, 0]))
                new_layers.append(mutated)
            else:
                new_layers.append(layer)

        return ArchitectureSpec(
            layers=new_layers,
            attention_configs=list(arch.attention_configs),
            routing_config=arch.routing_config,
            hidden_size=arch.hidden_size,
            num_layers=arch.num_layers,
        )

    def crossover_architectures(
        self, arch_a: ArchitectureSpec, arch_b: ArchitectureSpec
    ) -> Tuple[ArchitectureSpec, ArchitectureSpec]:
        """Perform crossover between two architectures."""
        min_layers = min(len(arch_a.layers), len(arch_b.layers))
        if min_layers < 2:
            return arch_a, arch_b

        crossover_point = self.rng.randint(1, min_layers - 1)

        child_a_layers = arch_a.layers[:crossover_point] + arch_b.layers[crossover_point:]
        child_b_layers = arch_b.layers[:crossover_point] + arch_a.layers[crossover_point:]

        child_a = ArchitectureSpec(
            layers=child_a_layers,
            attention_configs=list(arch_a.attention_configs),
            routing_config=arch_a.routing_config,
            hidden_size=arch_a.hidden_size,
            num_layers=len(child_a_layers),
        )
        child_b = ArchitectureSpec(
            layers=child_b_layers,
            attention_configs=list(arch_b.attention_configs),
            routing_config=arch_b.routing_config,
            hidden_size=arch_b.hidden_size,
            num_layers=len(child_b_layers),
        )
        return child_a, child_b


def estimate_latency(arch: ArchitectureSpec, batch_size: int = 1, seq_len: int = 2048) -> float:
    """Estimate forward pass latency in milliseconds (rough)."""
    total_flops = 0.0
    for i, layer in enumerate(arch.layers):
        if layer.layer_type == LayerType.ATTENTION and i < len(arch.attention_configs):
            ac = arch.attention_configs[i]
            total_flops += ac.flops_per_token(seq_len)
        elif layer.layer_type == LayerType.MLP:
            hidden = layer.hidden_dim or (4 * layer.input_dim)
            total_flops += 2 * batch_size * seq_len * layer.input_dim * hidden
            total_flops += 2 * batch_size * seq_len * hidden * layer.output_dim
        elif layer.layer_type == LayerType.MOE_MLP:
            hidden = layer.hidden_dim or (4 * layer.input_dim)
            n_exp = layer.num_experts or 8
            k = layer.moe_top_k or 2
            # Only top-k experts are activated
            total_flops += 2 * batch_size * seq_len * layer.input_dim * hidden * k
            total_flops += 2 * batch_size * seq_len * hidden * layer.output_dim * k
            # Router overhead
            total_flops += batch_size * seq_len * layer.input_dim * n_exp

    # Rough conversion: assume 1 TFLOP/s per device
    gflops_per_second = 1000.0
    latency_ms = (total_flops / 1e9) / gflops_per_second * 1000.0
    return max(0.1, latency_ms)


def estimate_memory(arch: ArchitectureSpec, dtype_bytes: int = 2) -> float:
    """Estimate memory usage in GB."""
    total_params = arch.total_parameters()
    total_bytes = total_params * dtype_bytes
    # Add activation memory overhead (~2x for typical training)
    activation_overhead = total_bytes * 2.0
    total_memory_bytes = total_bytes + activation_overhead
    return total_memory_bytes / (1024 ** 3)


def generate_layer(
    input_dim: int, output_dim: int, layer_type: Optional[LayerType] = None
) -> LayerConfig:
    """Convenience function for layer generation."""
    gen = ArchitectureGenerator()
    return gen.generate_layer(input_dim, output_dim, layer_type)


def generate_attention_block(hidden_size: int, num_heads: Optional[int] = None) -> AttentionConfig:
    """Convenience function for attention block generation."""
    gen = ArchitectureGenerator()
    return gen.generate_attention_block(hidden_size, num_heads)


def generate_routing_network(input_dim: int, num_experts: Optional[int] = None) -> RoutingNetworkConfig:
    """Convenience function for routing network generation."""
    gen = ArchitectureGenerator()
    return gen.generate_routing_network(input_dim, num_experts)


def mutate_architecture(arch: ArchitectureSpec, mutation_rate: float = 0.2) -> ArchitectureSpec:
    """Convenience function for architecture mutation."""
    gen = ArchitectureGenerator()
    return gen.mutate_architecture(arch, mutation_rate)


def crossover_architectures(
    arch_a: ArchitectureSpec, arch_b: ArchitectureSpec
) -> Tuple[ArchitectureSpec, ArchitectureSpec]:
    """Convenience function for architecture crossover."""
    gen = ArchitectureGenerator()
    return gen.crossover_architectures(arch_a, arch_b)
