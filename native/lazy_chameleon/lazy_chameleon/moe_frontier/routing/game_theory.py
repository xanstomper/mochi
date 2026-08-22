"""MoEGameTheory — Frontier MoE technique."""
from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional, Tuple
import math
import numpy as np
import random

class MoEGameTheory:
    """MoE Training as a Congestion Game.
    
    Training dynamics follow three phases:
    1. Specialization phase (steps 0-100K): Experts differentiate
    2. Balance phase (steps 100K-400K): Experts specialize under steady balance
    3. Relaxation phase (steps 400K-1.2M): Router trades balance for quality
    
    Understanding these phases enables optimal training schedules.
    """
    def __init__(self, num_experts: int = 64):
        self.num_experts = num_experts

    def compute_expert_utilization(self, routing_log: List[List[int]]) -> Dict[str, float]:
        counts = {i: 0 for i in range(self.num_experts)}
        for token_experts in routing_log:
            for e in token_experts:
                if e in counts:
                    counts[e] += 1
        total = max(sum(counts.values()), 1)
        utilization = {str(e): c / total for e, c in counts.items()}
        gini = self._gini_coefficient(list(counts.values()))
        return {"utilization": utilization, "gini_coefficient": round(gini, 4)}

    def _gini_coefficient(self, values: List[int]) -> float:
        sorted_v = sorted(values)
        n = len(sorted_v)
        cumulative = np.cumsum(sorted_v)
        return float((2 * np.sum(cumulative) / max(np.sum(sorted_v), 1) - (n + 1)) / n)

    def get_training_phase(self, step: int) -> Dict[str, Any]:
        if step < 100000:
            phase = "specialization"
            desc = "Experts are differentiating and finding their niches"
        elif step < 400000:
            phase = "balance"
            desc = "Experts specialize under steady load balance"
        else:
            phase = "relaxation"
            desc = "Router trades balance for quality as experts differentiate"
        return {"phase": phase, "step": step, "description": desc}

    def suggest_temperature(self, step: int) -> float:
        if step < 100000:
            return 1.0  # High temperature for exploration
        elif step < 400000:
            return 0.7  # Medium temperature for balance
        else:
            return 0.3  # Low temperature for quality


# ═════════════════════════════════════════════════════════════════════════════
# WINA — Weight Informed Neuron Activation
# arXiv:2502.10748
# ═════════════════════════════════════════════════════════════════════════════
