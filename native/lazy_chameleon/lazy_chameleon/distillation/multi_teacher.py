"""MultiTeacherDistiller — Knowledge distillation from multiple teacher models."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional
import logging

logger = logging.getLogger(__name__)

@dataclass
class TeacherWeight:
    teacher: str
    weight: float = 1.0
    domain: str = "general"

@dataclass
class TeacherEnsemble:
    teachers: List[Dict[str, Any]] = field(default_factory=list)

class MultiTeacherDistiller:
    def __init__(self, ensemble: Optional[TeacherEnsemble] = None):
        self.ensemble = ensemble or TeacherEnsemble([
            {"model": "claude-opus-4-8", "provider": "anthropic", "weight": 0.3},
            {"model": "gpt-5.5", "provider": "openai", "weight": 0.3},
            {"model": "deepseek-r1", "provider": "deepseek", "weight": 0.2},
            {"model": "grok-4.4", "provider": "xai", "weight": 0.1},
            {"model": "gemini-3.1-pro", "provider": "google", "weight": 0.1},
        ])
        self._distilled: List[Dict] = []

    def distill(self, prompt: str, n_responses: int = 3) -> List[Dict]:
        results = []
        for teacher in self.ensemble.teachers:
            for i in range(max(1, int(n_responses * teacher["weight"]))):
                try:
                    from lazy_chameleon.engines import InferenceEngine
                    engine = InferenceEngine()
                    resp = engine.generate(prompt)
                    results.append({
                        "teacher": teacher["model"],
                        "response": resp.text,
                        "weight": teacher["weight"],
                    })
                except Exception as e:
                    logger.error(f"Teacher {teacher['model']} failed: {e}")
        self._distilled.extend(results)
        return results

    def aggregate(self, results: List[Dict]) -> str:
        weighted = sorted(results, key=lambda x: -x["weight"])
        return weighted[0]["response"] if weighted else ""

    def get_stats(self) -> Dict:
        return {"total_distilled": len(self._distilled), "num_teachers": len(self.ensemble.teachers)}
