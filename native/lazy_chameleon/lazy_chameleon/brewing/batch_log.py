"""BatchLog — Track brewing batches from creation to consumption."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from datetime import datetime

@dataclass
class BrewBatch:
    batch_id: str
    recipe: str
    domain: str
    teacher: str
    num_samples: int
    quality_score: float = 0.0
    created_at: str = ""
    consumed_at: str = ""

class BatchLog:
    def __init__(self):
        self._batches: List[BrewBatch] = []

    def register(self, batch: BrewBatch):
        batch.created_at = datetime.now().isoformat()
        self._batches.append(batch)

    def complete(self, batch_id: str):
        for b in self._batches:
            if b.batch_id == batch_id:
                b.consumed_at = datetime.now().isoformat()
                break

    def get_stats(self) -> Dict[str, Any]:
        return {"total_batches": len(self._batches), "total_samples": sum(b.num_samples for b in self._batches),
                "avg_quality": round(sum(b.quality_score for b in self._batches) / max(len(self._batches), 1), 4)}
