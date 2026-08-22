"""DistributionAlignedDistillation — Distribution-matched distillation."""
from __future__ import annotations
from typing import Any, Dict, List, Optional
import math

class DistributionAlignedDistillation:
    def __init__(self, temperature: float = 1.0):
        self.temperature = temperature
        self._alignments: List[float] = []

    def align_distributions(self, teacher_probs: List[float], student_logits: List[float]) -> float:
        import math
        soft_teacher = [math.exp(p / self.temperature) for p in teacher_probs]
        sum_t = sum(soft_teacher)
        soft_teacher = [p / sum_t for p in soft_teacher]
        soft_student = [math.exp(p / self.temperature) for p in student_logits]
        sum_s = sum(soft_student)
        soft_student = [p / sum_s for p in soft_student]
        divergence = sum(t * math.log(t / max(s, 1e-10)) for t, s in zip(soft_teacher, soft_student))
        self._alignments.append(divergence)
        return divergence

    def average_alignment(self) -> float:
        if not self._alignments:
            return 0.0
        return sum(self._alignments) / len(self._alignments)
