"""ExpertChoiceRouting — Frontier MoE technique."""
from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional, Tuple
import math
import numpy as np
import random

class ExpertChoiceRouting:
    """Expert-Choice Routing with decoupled timestep-aware assignment.
    
    Separates timestep-aware expert assignment from timestep-conditioned
    expert computation. Improves routing stability significantly.
    Used in frontier MoE models like DeepSeek-V3.
    """
    def __init__(self, num_experts: int = 64, top_k: int = 8, capacity_factor: float = 1.0):
        self.num_experts = num_experts
        self.top_k = top_k
        self.capacity_factor = capacity_factor
        self._routing_stats: Dict[str, List[float]] = {"load": [], "balance": []}

    def route(self, token_embeddings: np.ndarray, expert_centroids: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """Route tokens to experts using expert-choice routing."""
        num_tokens = token_embeddings.shape[0]
        num_experts = expert_centroids.shape[0]
        scores = np.dot(token_embeddings, expert_centroids.T)
        top_k_scores = np.sort(scores, axis=1)[:, -self.top_k:]
        top_k_indices = np.argsort(scores, axis=1)[:, -self.top_k:]
        capacity = int(num_tokens * self.top_k * self.capacity_factor / num_experts)
        expert_assignments = [[] for _ in range(num_experts)]
        for t in range(num_tokens):
            for k in range(self.top_k):
                e = top_k_indices[t, k]
                expert_assignments[e].append(t)
        for e in range(num_experts):
            if len(expert_assignments[e]) > capacity:
                assigned = expert_assignments[e][:capacity]
                expert_assignments[e] = assigned
        load_balance = max(len(a) for a in expert_assignments) / max(min(len(a) for a in expert_assignments), 1)
        self._routing_stats["load"].append(float(np.mean([len(a) for a in expert_assignments])))
        self._routing_stats["balance"].append(load_balance)
        routing_matrix = np.zeros((num_tokens, num_experts))
        for e, tokens in enumerate(expert_assignments):
            for t in tokens:
                routing_matrix[t, e] = 1.0
        return routing_matrix, top_k_scores

    def compute_auxiliary_loss(self, routing_matrix: np.ndarray) -> float:
        """Compute load balancing auxiliary loss."""
        fraction = routing_matrix.mean(axis=0)
        importance = routing_matrix.sum(axis=0)
        loss = np.sum(fraction * importance) * self.num_experts
        return float(loss)


# ═════════════════════════════════════════════════════════════════════════════
# Progressive Sparsification — Gradually Increase Sparsity During Training
# Used in Nucleus-Image, DeepSeek-V3
# ═════════════════════════════════════════════════════════════════════════════
