"""LoopUS — Pipeline loop technique."""
from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional, Tuple
import math
import numpy as np
import time
import logging

class LoopUS:
    """LoopUS: Recasting Pretrained LLMs into Looped Latent Refinement Models.
    
    Converts a standard pretrained LLM into a looped architecture with:
    1. Block decomposition: Split model into encoder, looped block, decoder
    2. Selective gate: Prevents hidden-state drift during looping
    3. Random deep supervision: Memory-efficient learning over long horizons
    4. Confidence head: Adaptive early exiting
    
    Improves reasoning without extending generated traces or retraining from scratch.
    """
    def __init__(self, num_loops: int = 4, encoder_ratio: float = 0.2, 
                 decoder_ratio: float = 0.2, confidence_threshold: float = 0.9):
        self.num_loops = num_loops
        self.encoder_ratio = encoder_ratio
        self.decoder_ratio = decoder_ratio
        self.confidence_threshold = confidence_threshold
        self._loop_history: List[Dict[str, Any]] = []

    def decompose(self, total_layers: int) -> Dict[str, Tuple[int, int]]:
        """Decompose model into encoder, looped block, decoder."""
        encoder_layers = max(1, int(total_layers * self.encoder_ratio))
        decoder_layers = max(1, int(total_layers * self.decoder_ratio))
        looped_layers = total_layers - encoder_layers - decoder_layers
        return {
            "encoder": (0, encoder_layers),
            "looped_block": (encoder_layers, encoder_layers + looped_layers),
            "decoder": (encoder_layers + looped_layers, total_layers),
        }

    def selective_gate(self, hidden_state: np.ndarray, prev_hidden: np.ndarray) -> np.ndarray:
        """Input-dependent selective gate to mitigate hidden-state drift."""
        gate = np.sigmoid(np.dot(hidden_state, prev_hidden.T).mean())
        return gate * hidden_state + (1 - gate) * prev_hidden

    def compute_confidence(self, logits: np.ndarray) -> float:
        """Confidence head for adaptive early exiting."""
        probs = np.exp(logits - logits.max(axis=-1, keepdims=True))
        probs = probs / probs.sum(axis=-1, keepdims=True)
        confidence = float(np.max(probs, axis=-1).mean())
        return confidence

    def loop(self, hidden_state: np.ndarray, loop_fn: Callable) -> Tuple[np.ndarray, int, List[Dict]]:
        """Run looped computation with adaptive early exiting."""
        h = hidden_state.copy()
        history = []
        for loop_idx in range(self.num_loops):
            h_prev = h.copy()
            h = loop_fn(h)
            h = self.selective_gate(h, h_prev)
            confidence = self.compute_confidence(h)
            entry = {"loop": loop_idx, "confidence": round(confidence, 4)}
            history.append(entry)
            self._loop_history.append(entry)
            if confidence >= self.confidence_threshold:
                logger.debug(f"LoopUS: Early exit at loop {loop_idx} (confidence={confidence:.3f})")
                break
        return h, loop_idx + 1, history

    def deep_supervision_loss(self, loop_outputs: List[np.ndarray], target: np.ndarray) -> float:
        """Random deep supervision for memory-efficient learning."""
        if not loop_outputs:
            return 0.0
        losses = []
        for output in loop_outputs:
            loss = np.mean((output - target) ** 2)
            losses.append(float(loss))
        return float(np.mean(losses))

    def get_stats(self) -> Dict[str, Any]:
        return {
            "num_loops": self.num_loops,
            "early_exit_rate": sum(1 for h in self._loop_history if h["confidence"] >= self.confidence_threshold) / max(len(self._loop_history), 1),
            "avg_confidence": round(np.mean([h["confidence"] for h in self._loop_history]), 4) if self._loop_history else 0,
        }


# ═════════════════════════════════════════════════════════════════════════════
# Universal YOCO — Recursive Computation with YOCO
# arXiv:2604.01220 (April 2026)
# ═════════════════════════════════════════════════════════════════════════════
