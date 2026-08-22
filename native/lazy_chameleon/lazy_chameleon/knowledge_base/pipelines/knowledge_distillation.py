"""Knowledge distillation pipelines for MoE."""
from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional
import numpy as np


class KnowledgeDistillationPipeline:
    """Complete knowledge distillation pipeline for MoE models.
    
    Methods:
    1. Logit distillation (KL divergence)
    2. Hidden state distillation (MSE)
    3. Attention transfer
    4. Feature distillation
    5. Progressive distillation (increasing difficulty)
    6. Multi-teacher distillation
    7. Self-distillation
    """
    def __init__(self, temperature: float = 2.0, alpha: float = 0.5):
        self.temperature = temperature
        self.alpha = alpha

    def logit_distillation_loss(self, student_logits: np.ndarray, teacher_logits: np.ndarray) -> float:
        s = np.exp(student_logits / self.temperature) / np.sum(np.exp(student_logits / self.temperature), axis=-1, keepdims=True)
        t = np.exp(teacher_logits / self.temperature) / np.sum(np.exp(teacher_logits / self.temperature), axis=-1, keepdims=True)
        kl = np.sum(t * np.log(t / (s + 1e-10)), axis=-1)
        return float(np.mean(kl))

    def hidden_state_distillation(self, student_hidden: np.ndarray, teacher_hidden: np.ndarray) -> float:
        return float(np.mean((student_hidden - teacher_hidden) ** 2))

    def attention_transfer(self, student_attn: np.ndarray, teacher_attn: np.ndarray) -> float:
        s_norm = student_attn / (student_attn.sum(axis=-1, keepdims=True) + 1e-10)
        t_norm = teacher_attn / (teacher_attn.sum(axis=-1, keepdims=True) + 1e-10)
        return float(np.mean((s_norm - t_norm) ** 2))

    def multi_teacher_distill(self, student_logits: np.ndarray, teacher_logits_list: List[np.ndarray], 
                               weights: Optional[List[float]] = None) -> float:
        if weights is None:
            weights = [1.0 / len(teacher_logits_list)] * len(teacher_logits_list)
        total_loss = 0.0
        for tl, w in zip(teacher_logits_list, weights):
            total_loss += w * self.logit_distillation_loss(student_logits, tl)
        return total_loss

    def self_distillation(self, model_logits: np.ndarray, past_logits: np.ndarray) -> float:
        return self.logit_distillation_loss(model_logits, past_logits)

    def progressive_distill(self, student_fn: Callable, teacher_fn: Callable, 
                             curriculum: List[float], epochs: int = 3) -> List[float]:
        losses = []
        for epoch in range(epochs):
            difficulty = curriculum[min(epoch, len(curriculum) - 1)]
            s_out = student_fn(difficulty)
            t_out = teacher_fn(difficulty)
            loss = self.logit_distillation_loss(s_out, t_out)
            losses.append(float(loss))
        return losses

