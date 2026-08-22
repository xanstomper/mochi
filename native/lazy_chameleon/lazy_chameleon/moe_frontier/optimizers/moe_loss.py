"""MoELoss — Frontier MoE technique."""
from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional, Tuple
import math
import numpy as np
import random

class MoELoss:
    """Z-Loss + Auxiliary Loss for load-balanced MoE training.
    
    Z-Loss: Prevents logit explosion by penalizing extreme router values
    Auxiliary Loss: Encourages balanced expert utilization
    Combined loss stabilizes training of frontier MoE models.
    """
    def __init__(self, z_loss_coeff: float = 0.001, aux_loss_coeff: float = 0.01):
        self.z_coeff = z_loss_coeff
        self.aux_coeff = aux_loss_coeff

    def z_loss(self, router_logits: np.ndarray) -> float:
        logits_sq = router_logits ** 2
        loss = np.mean(logits_sq)
        return float(loss)

    def auxiliary_load_balancing_loss(self, routing_weights: np.ndarray) -> float:
        fraction = routing_weights.mean(axis=0)
        importance = routing_weights.sum(axis=0)
        loss = np.sum(fraction * importance) * routing_weights.shape[1]
        return float(loss)

    def compute(self, router_logits: np.ndarray, routing_weights: np.ndarray, 
                main_loss: float) -> Tuple[float, Dict[str, float]]:
        z = self.z_loss(router_logits)
        aux = self.auxiliary_load_balancing_loss(routing_weights)
        total = main_loss + self.z_coeff * z + self.aux_coeff * aux
        return total, {"main_loss": main_loss, "z_loss": round(z, 6),
                       "aux_loss": round(aux, 6),
                       "z_coeff": self.z_coeff, "aux_coeff": self.aux_coeff,
                       "total_loss": round(total, 6)}


# ═════════════════════════════════════════════════════════════════════════════
# MoE Game Theory — Understanding Expert Specialization Dynamics
# arXiv:2604.26340
# ═════════════════════════════════════════════════════════════════════════════
