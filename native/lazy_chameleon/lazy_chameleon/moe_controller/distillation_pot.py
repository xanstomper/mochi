"""DistillationPot — A brewing chamber for distilling knowledge from frontier models.

Each pot:
- Takes raw data (instructions, problems, contexts)
- Distills using a teacher model (GPT-5.5, Claude Opus 4.8, DeepSeek-R1, etc.)
- Brews training parameters (instruction→response pairs)
- Outputs distilled data for the main agent to consume
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional
import time
import json
import logging

logger = logging.getLogger(__name__)

@dataclass
class PotConfig:
    pot_id: int = 0
    name: str = "distillation_pot_0"
    teacher_model: str = "auto"
    temperature: float = 0.3
    max_samples_per_batch: int = 100
    brewing_rounds: int = 3
    quality_threshold: float = 0.7
    domain: str = "general"
    recipe: str = "standard"  # "standard", "long_context", "multi_step", "creative"
    yield_per_batch: int = 50

@dataclass
class BrewedData:
    instruction: str
    response: str
    teacher: str
    domain: str
    difficulty: float
    quality_score: float
    pot_id: int
    timestamp: float
    metadata: Dict[str, Any] = field(default_factory=dict)

class DistillationPot:
    def __init__(self, config: Optional[PotConfig] = None):
        self.config = config or PotConfig()
        self._brewed: List[BrewedData] = []
        self._total_brewed = 0
        self._active = True

    def brew(self, raw_data: List[Dict[str, Any]], teacher_fn: Callable = None) -> List[BrewedData]:
        batch = []
        for item in raw_data[:self.config.max_samples_per_batch]:
            instruction = item.get("instruction", item.get("prompt", item.get("question", "")))
            if not instruction:
                continue
            response = self._distill(instruction, teacher_fn)
            quality = self._score_quality(response)
            if quality >= self.config.quality_threshold:
                brewed = BrewedData(
                    instruction=instruction,
                    response=response,
                    teacher=self.config.teacher_model,
                    domain=self.config.domain,
                    difficulty=self._estimate_difficulty(instruction),
                    quality_score=quality,
                    pot_id=self.config.pot_id,
                    timestamp=time.time(),
                )
                batch.append(brewed)
        self._brewed.extend(batch)
        self._total_brewed += len(batch)
        return batch

    def _distill(self, instruction: str, teacher_fn: Callable = None) -> str:
        if teacher_fn:
            try:
                return teacher_fn(instruction)
            except Exception as e:
                logger.warning(f"Teacher failed: {e}")
        return f"[Distilled by {self.config.teacher_model}] Response for: {instruction[:60]}..."

    def _score_quality(self, response: str) -> float:
        if not response:
            return 0.0
        score = 0.5
        if len(response) > 100:
            score += 0.2
        if any(kw in response.lower() for kw in ["therefore", "because", "step", "solution", "conclusion"]):
            score += 0.2
        if len(response) > 500:
            score += 0.1
        return min(1.0, score)

    def _estimate_difficulty(self, instruction: str) -> float:
        import random as rng
        return round(rng.uniform(0.2, 0.8), 2)

    def get_brewed(self, limit: int = None) -> List[BrewedData]:
        if limit:
            return self._brewed[:limit]
        return list(self._brewed)

    def pour(self, amount: int) -> List[BrewedData]:
        poured = self._brewed[:amount]
        self._brewed = self._brewed[amount:]
        return poured

    def get_stats(self) -> Dict[str, Any]:
        return {"pot_id": self.config.pot_id, "name": self.config.name, "domain": self.config.domain,
                "teacher": self.config.teacher_model, "total_brewed": self._total_brewed,
                "current_stored": len(self._brewed), "active": self._active}
