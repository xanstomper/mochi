"""OnlineDistiller — Real-time online knowledge distillation."""
from __future__ import annotations
from typing import Any, Dict, List, Optional
import time

class OnlineDistiller:
    def __init__(self):
        self._buffer: List[Dict] = []
        self._max_buffer = 1000

    def add_sample(self, teacher_output: Dict, student_output: Dict = None):
        self._buffer.append({"teacher": teacher_output, "student": student_output, "timestamp": time.time()})
        if len(self._buffer) > self._max_buffer:
            self._buffer.pop(0)

    def compute_loss(self) -> float:
        if not self._buffer:
            return 0.0
        total_divergence = 0.0
        count = 0
        for item in self._buffer:
            t = item["teacher"].get("logits", [])
            s = item["student"].get("logits", []) if item["student"] else []
            if t and s:
                import math
                divergence = sum(abs(a-b) for a,b in zip(t,s)) / max(len(t), 1)
                total_divergence += divergence
                count += 1
        return total_divergence / max(count, 1)

    def flush(self) -> List[Dict]:
        items = list(self._buffer)
        self._buffer.clear()
        return items
