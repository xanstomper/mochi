"""QualityControl — Score and filter brewed data batches."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

@dataclass
class BatchScore:
    overall: float
    instruction_quality: float
    response_quality: float
    diversity: float
    difficulty_distribution: float

class QualityControl:
    def __init__(self, threshold: float = 0.6):
        self.threshold = threshold

    def score_batch(self, samples: List[Dict]) -> BatchScore:
        if not samples:
            return BatchScore(0, 0, 0, 0, 0)
        inst_scores = []
        resp_scores = []
        for s in samples:
            inst = s.get("instruction", "")
            resp = s.get("response", "")
            inst_scores.append(min(1.0, len(inst) / 200))
            resp_scores.append(min(1.0, len(resp) / 500))
        unique_domains = len(set(s.get("domain", "") for s in samples))
        difficulty_spread = len(set(s.get("difficulty", 0) for s in samples))
        avg_i = sum(inst_scores) / len(inst_scores) if inst_scores else 0
        avg_r = sum(resp_scores) / len(resp_scores) if resp_scores else 0
        diversity = min(1.0, unique_domains / 5)
        difficulty_dist = min(1.0, difficulty_spread / 3)
        overall = (avg_i * 0.25 + avg_r * 0.35 + diversity * 0.2 + difficulty_dist * 0.2)
        return BatchScore(overall, avg_i, avg_r, diversity, difficulty_dist)

    def filter(self, samples: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [s for s in samples if len(s.get("response", "")) > 50 and len(s.get("instruction", "")) > 10]
