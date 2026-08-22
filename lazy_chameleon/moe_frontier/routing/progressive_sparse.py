"""ProgressiveSparsification — Frontier MoE technique."""
from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional, Tuple
import math
import numpy as np
import random

class ProgressiveSparsification:
    """Progressive sparsification of expert capacity factor during training.
    
    Starts with dense experts, gradually increases sparsity.
    Used in Nucleus-Image training recipe.
    """
    def __init__(self, start_capacity: float = 2.0, end_capacity: float = 0.5, 
                 total_steps: int = 100000):
        self.start_cap = start_capacity
        self.end_cap = end_capacity
        self.total_steps = total_steps

    def get_capacity(self, step: int) -> float:
        progress = min(1.0, step / self.total_steps)
        capacity = self.start_cap - (self.start_cap - self.end_cap) * progress
        return round(capacity, 3)

    def get_sparsity(self, step: int) -> float:
        capacity = self.get_capacity(step)
        return 1.0 - 1.0 / max(capacity, 0.1)

    def should_drop_expert(self, step: int, expert_frequency: float) -> bool:
        sparsity = self.get_sparsity(step)
        return expert_frequency < sparsity * 0.1


# ═════════════════════════════════════════════════════════════════════════════
# Multi-Head Latent Attention (MLA) — Memory-Efficient Attention for MoE
# Used in DeepSeek-V3, Moonlight
# ═════════════════════════════════════════════════════════════════════════════
