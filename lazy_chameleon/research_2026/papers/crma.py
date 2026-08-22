"""CRMA — Research 2026 paper implementation."""
from __future__ import annotations
from typing import Any, Dict, List, Optional, Tuple
import math
import numpy as np

class CRMA:
    """CRMA: Spectrally-Bounded Backbone for Modular Continual Fine-Tuning.
    
    Uses spectral bounds to prevent catastrophic forgetting during continual
    fine-tuning. Enables modular addition of new capabilities without
    degrading existing ones.
    """
    def __init__(self, spectral_bound: float = 1.0):
        self.spectral_bound = spectral_bound
        self._original_weights: Dict[str, np.ndarray] = {}
        self._modules: Dict[str, Dict[str, np.ndarray]] = {}

    def register_backbone(self, weights: Dict[str, np.ndarray]):
        self._original_weights = {k: v.copy() for k, v in weights.items()}

    def compute_spectral_norm(self, w: np.ndarray) -> float:
        U, S, Vt = np.linalg.svd(w.reshape(w.shape[0], -1), full_matrices=False)
        return float(S[0])

    def bound_update(self, name: str, update: np.ndarray) -> np.ndarray:
        current_norm = self.compute_spectral_norm(update)
        if current_norm > self.spectral_bound:
            update = update * (self.spectral_bound / current_norm)
        return update

    def add_module(self, module_name: str, weights: Dict[str, np.ndarray]):
        bounded = {}
        for k, w in weights.items():
            if k in self._original_weights:
                w = self.bound_update(k, w)
            bounded[k] = w
        self._modules[module_name] = bounded
        return bounded

    def get_combined_weights(self) -> Dict[str, np.ndarray]:
        combined = {k: v.copy() for k, v in self._original_weights.items()}
        for module_name, module_weights in self._modules.items():
            for k, w in module_weights.items():
                if k in combined:
                    combined[k] = combined[k] + w
                else:
                    combined[k] = w
        return combined
