"""Zhipu GLM bidirectional prefix LM."""
from __future__ import annotations
from typing import Any, Dict
import numpy as np


class GLMBidirectionalPrefix:
    """GLM-style bidirectional prefix LM architecture.
    
    Key innovation: bidirectional attention on prefix tokens,
    unidirectional (causal) attention on generation tokens.
    
    This allows the model to understand context better (bidirectional)
    while generating coherently (causal).
    """
    def __init__(self, prefix_length: int = 512, hidden_dim: int = 7168):
        self.prefix_length = prefix_length
        self.hidden_dim = hidden_dim

    def create_attention_mask(self, seq_len: int) -> np.ndarray:
        """Create bidirectional + causal attention mask."""
        mask = np.ones((seq_len, seq_len))
        for i in range(self.prefix_length):
            mask[i, :] = 1.0  # Bidirectional for prefix
        for i in range(self.prefix_length, seq_len):
            mask[i, :i+1] = 1.0  # Causal for generation
            mask[i, i+1:] = 0.0
        return mask

    def compute_attention(self, query: np.ndarray, key: np.ndarray, value: np.ndarray, mask: np.ndarray) -> np.ndarray:
        scores = (query @ key.T) / np.sqrt(self.hidden_dim)
        scores = scores * mask + (1 - mask) * -1e10  # Mask out
        weights = np.exp(scores - scores.max(axis=-1, keepdims=True))
        weights = weights / weights.sum(axis=-1, keepdims=True)
        return weights @ value

