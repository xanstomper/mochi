"""Parameter-efficient fine-tuning: LoRA, QLoRA, DoRA, AdaLoRA,
VeRA, LoHa, LoKr, PrefixTuning, PromptTuning."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np


@dataclass
class AdapterConfig:
    """Configuration for adapter generation."""
    r: int = 8  # rank
    alpha: float = 16.0  # scaling
    dropout: float = 0.0
    target_modules: Optional[List[str]] = None
    use_bias: bool = False


@dataclass
class AdapterWeights:
    """Adapter weight matrices."""
    lora_A: Dict[str, np.ndarray] = field(default_factory=dict)
    lora_B: Dict[str, np.ndarray] = field(default_factory=dict)
    scaling: float = 1.0
    adapter_type: str = "lora"

    def apply_to(self, base_weights: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
        """Apply adapter to base weights: W' = W + BA * scaling."""
        result = dict(base_weights)
        for key in self.lora_A:
            if key in result:
                delta = self.lora_B[key] @ self.lora_A[key]
                if self.scaling != 1.0:
                    delta *= self.scaling
                result[key] = (result[key].astype(np.float64) + delta).astype(result[key].dtype)
        return result


class AdapterGenerator:
    """Generates adapter weights for various PEFT methods."""

    def __init__(self, seed: int = 42):
        self.rng = np.random.default_rng(seed)

    def lora(
        self,
        base_weights: Dict[str, np.ndarray],
        config: AdapterConfig,
    ) -> AdapterWeights:
        """Generate LoRA (Low-Rank Adaptation) adapters."""
        lora_A: Dict[str, np.ndarray] = {}
        lora_B: Dict[str, np.ndarray] = {}

        targets = config.target_modules or list(base_weights.keys())

        for key in targets:
            if key not in base_weights:
                continue
            W = base_weights[key]
            if W.ndim < 2:
                continue

            in_dim = W.shape[-1]
            out_dim = W.shape[-2] if W.ndim >= 2 else in_dim
            r = min(config.r, in_dim, out_dim)

            # A: [in_dim, r] with Kaiming init
            A = self.rng.normal(0.0, 0.02, (in_dim, r)).astype(np.float32)
            # B: [r, out_dim] with zeros
            B = np.zeros((r, out_dim), dtype=np.float32)

            lora_A[key] = A
            lora_B[key] = B

        scaling = config.alpha / max(1, config.r)
        return AdapterWeights(lora_A=lora_A, lora_B=lora_B, scaling=scaling, adapter_type="lora")

    def qlora(
        self,
        base_weights: Dict[str, np.ndarray],
        config: AdapterConfig,
        quantization_bits: int = 4,
    ) -> AdapterWeights:
        """Generate QLoRA adapters (quantized base + low-rank adapters)."""
        lora_A: Dict[str, np.ndarray] = {}
        lora_B: Dict[str, np.ndarray] = {}

        targets = config.target_modules or list(base_weights.keys())

        for key in targets:
            if key not in base_weights:
                continue
            W = base_weights[key]
            if W.ndim < 2:
                continue

            in_dim = W.shape[-1]
            out_dim = W.shape[-2] if W.ndim >= 2 else in_dim
            r = min(config.r, in_dim, out_dim)

            # NF4-style scaling
            scale = 2.0 ** (quantization_bits - 1) - 1.0
            A = self.rng.normal(0.0, 0.02 / scale, (in_dim, r)).astype(np.float32)
            B = np.zeros((r, out_dim), dtype=np.float32)

            lora_A[key] = A
            lora_B[key] = B

        scaling = config.alpha / max(1, config.r)
        return AdapterWeights(lora_A=lora_A, lora_B=lora_B, scaling=scaling, adapter_type="qlora")

    def dora(
        self,
        base_weights: Dict[str, np.ndarray],
        config: AdapterConfig,
    ) -> AdapterWeights:
        """Generate DoRA (Weight-Decomposed Low-Rank Adaptation).
        
        DoRA decomposes weight into magnitude and direction, applies LoRA to direction.
        """
        lora_A: Dict[str, np.ndarray] = {}
        lora_B: Dict[str, np.ndarray] = {}
        magnitude_vectors: Dict[str, np.ndarray] = {}

        targets = config.target_modules or list(base_weights.keys())

        for key in targets:
            if key not in base_weights:
                continue
            W = base_weights[key].astype(np.float64)
            if W.ndim < 2:
                continue

            # Decompose: magnitude = ||W|| along output dim, direction = W / magnitude
            if W.ndim == 2:
                norms = np.linalg.norm(W, axis=1, keepdims=True) + 1e-12
                _ = W / norms  # direction (not stored separately)
                magnitude = norms.squeeze()
            else:
                magnitude = np.ones(W.shape[0], dtype=np.float64)

            magnitude_vectors[key] = magnitude.astype(np.float32)

            in_dim = W.shape[-1]
            out_dim = W.shape[-2] if W.ndim >= 2 else in_dim
            r = min(config.r, in_dim, out_dim)

            A = self.rng.normal(0.0, 0.02, (in_dim, r)).astype(np.float32)
            B = np.zeros((r, out_dim), dtype=np.float32)

            lora_A[key] = A
            lora_B[key] = B

        scaling = config.alpha / max(1, config.r)
        adapter = AdapterWeights(lora_A=lora_A, lora_B=lora_B, scaling=scaling, adapter_type="dora")
        adapter.metadata = {"magnitude_vectors": magnitude_vectors}
        return adapter

    def adalora(
        self,
        base_weights: Dict[str, np.ndarray],
        config: AdapterConfig,
        target_rank: int = 4,
    ) -> AdapterWeights:
        """Generate AdaLoRA (Adaptive Budget Allocation) adapters.
        
        Allocates rank budget adaptively based on importance scores.
        """
        lora_A: Dict[str, np.ndarray] = {}
        lora_B: Dict[str, np.ndarray] = {}
        importance_scores: Dict[str, np.ndarray] = {}

        targets = config.target_modules or list(base_weights.keys())
        total_budget = target_rank * len(targets)

        for key in targets:
            if key not in base_weights:
                continue
            W = base_weights[key]
            if W.ndim < 2:
                continue

            in_dim = W.shape[-1]
            out_dim = W.shape[-2] if W.ndim >= 2 else in_dim

            # Compute importance from singular values
            if W.ndim == 2:
                _, s, _ = np.linalg.svd(W.astype(np.float64), full_matrices=False)
                importance = s / (s.sum() + 1e-12)
            else:
                importance = np.ones(min(in_dim, out_dim)) / min(in_dim, out_dim)

            # Allocate rank based on importance
            allocated_rank = max(1, int(config.r * len(importance) / len(targets)))
            allocated_rank = min(allocated_rank, in_dim, out_dim)

            A = self.rng.normal(0.0, 0.02, (in_dim, allocated_rank)).astype(np.float32)
            B = np.zeros((allocated_rank, out_dim), dtype=np.float32)

            lora_A[key] = A
            lora_B[key] = B
            importance_scores[key] = importance.astype(np.float32)

        scaling = config.alpha / max(1, config.r)
        adapter = AdapterWeights(lora_A=lora_A, lora_B=lora_B, scaling=scaling, adapter_type="adalora")
        adapter.metadata = {"importance_scores": importance_scores}
        return adapter

    def vera(
        self,
        base_weights: Dict[str, np.ndarray],
        config: AdapterConfig,
    ) -> AdapterWeights:
        """Generate VeRA adapters (Vector-based Random Matrix Adaptation).
        
        Uses shared random matrices with learnable scaling vectors.
        """
        lora_A = {}
        lora_B = {}

        targets = config.target_modules or list(base_weights.keys())

        # Shared random matrix for all layers
        max_in = max(base_weights[k].shape[-1] for k in targets if k in base_weights)
        max_out = max(base_weights[k].shape[-2] for k in targets if k in base_weights)
        shared_d = min(max_in, max_out, config.r)

        for key in targets:
            if key not in base_weights:
                continue
            W = base_weights[key]
            if W.ndim < 2:
                continue

            in_dim = W.shape[-1]
            out_dim = W.shape[-2] if W.ndim >= 2 else in_dim
            r = min(shared_d, in_dim, out_dim)

            # Random projection matrices (shared structure)
            A = self.rng.normal(0.0, 0.01, (in_dim, r)).astype(np.float32)
            B = self.rng.normal(0.0, 0.01, (r, out_dim)).astype(np.float32)

            lora_A[key] = A
            lora_B[key] = B

        return AdapterWeights(lora_A=lora_A, lora_B=lora_B, scaling=0.1, adapter_type="vera")

    def loha(
        self,
        base_weights: Dict[str, np.ndarray],
        config: AdapterConfig,
    ) -> AdapterWeights:
        """Generate LoHa (Low-Rank Hadamard) adapters.
        
        Uses Hadamard product of two low-rank factors.
        """
        lora_A: Dict[str, np.ndarray] = {}
        lora_B: Dict[str, np.ndarray] = {}

        targets = config.target_modules or list(base_weights.keys())

        for key in targets:
            if key not in base_weights:
                continue
            W = base_weights[key]
            if W.ndim < 2:
                continue

            in_dim = W.shape[-1]
            out_dim = W.shape[-2] if W.ndim >= 2 else in_dim
            r = min(config.r, in_dim, out_dim)

            # Two pairs of factors: (A1, B1) and (A2, B2) -> delta = (A1 @ B1) * (A2 @ B2)
            A1 = self.rng.normal(0.0, 0.02, (in_dim, r)).astype(np.float32)
            B1 = np.zeros((r, out_dim), dtype=np.float32)
            A2 = self.rng.normal(0.0, 0.02, (in_dim, r)).astype(np.float32)
            B2 = np.zeros((r, out_dim), dtype=np.float32)

            lora_A[f"{key}_a1"] = A1
            lora_B[f"{key}_b1"] = B1
            lora_A[f"{key}_a2"] = A2
            lora_B[f"{key}_b2"] = B2

        return AdapterWeights(lora_A=lora_A, lora_B=lora_B, scaling=0.5, adapter_type="loha")

    def lokr(
        self,
        base_weights: Dict[str, np.ndarray],
        config: AdapterConfig,
    ) -> AdapterWeights:
        """Generate LoKr (Low-Rank Kronecker) adapters.
        
        Uses Kronecker product of two low-rank factors.
        """
        lora_A: Dict[str, np.ndarray] = {}
        lora_B: Dict[str, np.ndarray] = {}

        targets = config.target_modules or list(base_weights.keys())

        for key in targets:
            if key not in base_weights:
                continue
            W = base_weights[key]
            if W.ndim < 2:
                continue

            in_dim = W.shape[-1]
            out_dim = W.shape[-2] if W.ndim >= 2 else in_dim

            # Factorize rank into two factors for Kronecker
            r1 = max(1, int(math.sqrt(config.r)))
            r2 = max(1, config.r // r1)

            A1 = self.rng.normal(0.0, 0.02, (in_dim // 2, r1)).astype(np.float32)
            B1 = np.zeros((r1, out_dim // 2), dtype=np.float32)
            A2 = self.rng.normal(0.0, 0.02, (in_dim - in_dim // 2, r2)).astype(np.float32)
            B2 = np.zeros((r2, out_dim - out_dim // 2), dtype=np.float32)

            lora_A[key] = (A1, A2)
            lora_B[key] = (B1, B2)

        return AdapterWeights(lora_A=lora_A, lora_B=lora_B, scaling=0.1, adapter_type="lokr")

    def prefix_tuning(
        self,
        num_prefix_tokens: int = 10,
        hidden_size: int = 512,
        num_layers: int = 12,
        reparameterization_dim: int = 128,
    ) -> Dict[str, np.ndarray]:
        """Generate Prefix Tuning parameters (learnable prefix tokens)."""
        prefixes: Dict[str, np.ndarray] = {}

        for layer in range(num_layers):
            prefix_key = f"prefix_layer_{layer}"
            # Two sets: one for key, one for value
            prefix = self.rng.normal(
                0.0, 0.02, (2, num_prefix_tokens, hidden_size)
            ).astype(np.float32)
            prefixes[prefix_key] = prefix

            # Reparameterization (MLP) - reduces memory
            reparam_W = self.rng.normal(
                0.0, 0.02, (reparameterization_dim, 2 * num_prefix_tokens * hidden_size)
            ).astype(np.float32)
            reparam_b = np.zeros(2 * num_prefix_tokens * hidden_size, dtype=np.float32)
            prefixes[f"prefix_reparam_W_{layer}"] = reparam_W
            prefixes[f"prefix_reparam_b_{layer}"] = reparam_b

        return prefixes

    def prompt_tuning(
        self,
        num_prompt_tokens: int = 5,
        embedding_dim: int = 512,
        init_from_vocab: bool = False,
        vocab_size: int = 32000,
    ) -> np.ndarray:
        """Generate soft prompt tokens for prompt tuning."""
        if init_from_vocab:
            # Initialize from random vocabulary embeddings
            indices = self.rng.integers(0, vocab_size, num_prompt_tokens)
            prompt = np.eye(vocab_size)[indices, :embedding_dim].astype(np.float32)
        else:
            prompt = self.rng.normal(0.0, 0.02, (num_prompt_tokens, embedding_dim)).astype(np.float32)

        return prompt


# Convenience functions

def combine_adapters(
    adapters: List[AdapterWeights],
    weights: Optional[List[float]] = None,
) -> AdapterWeights:
    """Combine multiple adapters via weighted sum."""
    if not adapters:
        raise ValueError("Need at least one adapter")

    if weights is None:
        weights = [1.0 / len(adapters)] * len(adapters)
    weights = np.array(weights) / sum(weights)

    combined = AdapterWeights(adapter_type="combined")
    all_keys = set()
    for adp in adapters:
        all_keys.update(adp.lora_A.keys())

    for key in all_keys:
        A_sum = None
        B_sum = None
        for i, adp in enumerate(adapters):
            if key in adp.lora_A:
                if A_sum is None:
                    A_sum = weights[i] * adp.lora_A[key]
                    B_sum = weights[i] * adp.lora_B[key]
                else:
                    A_sum += weights[i] * adp.lora_A[key]
                    B_sum += weights[i] * adp.lora_B[key]
        if A_sum is not None:
            combined.lora_A[key] = A_sum
            combined.lora_B[key] = B_sum

    return combined


def merge_adapters(
    adapters: List[AdapterWeights],
    merge_method: str = "sum",
) -> AdapterWeights:
    """Merge multiple adapters by summing or averaging."""
    if merge_method == "sum":
        weights = [1.0] * len(adapters)
    else:
        weights = [1.0 / len(adapters)] * len(adapters)
    return combine_adapters(adapters, weights)


def generate_batch_adapters(
    method: str,
    base_weights_list: List[Dict[str, np.ndarray]],
    config: AdapterConfig,
    seed: int = 42,
) -> List[AdapterWeights]:
    """Generate adapters for a batch of weight sets."""
    gen = AdapterGenerator(seed)
    method_fn = getattr(gen, method, gen.lora)
    return [method_fn(w, config) for w in base_weights_list]


# Alias class names for backwards compatibility
LoRA = AdapterGenerator().lora
QLoRA = AdapterGenerator().qlora
DoRA = AdapterGenerator().dora
AdaLoRA = AdapterGenerator().adalora
VeRA = AdapterGenerator().vera
LoHa = AdapterGenerator().loha
LoKr = AdapterGenerator().lokr
PrefixTuning = AdapterGenerator().prefix_tuning
PromptTuning = AdapterGenerator().prompt_tuning
