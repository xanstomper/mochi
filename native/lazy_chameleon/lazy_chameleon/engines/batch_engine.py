"""BatchEngine — Efficient batch processing for large-scale inference."""
from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional, Tuple
from dataclasses import dataclass
import time
import logging

logger = logging.getLogger(__name__)

@dataclass
class BatchResult:
    results: List[Any]
    batch_size: int
    total_time_ms: float
    throughput: float
    errors: int = 0

class BatchProcessor:
    def __init__(self, batch_size: int = 32, max_workers: int = 4):
        self.batch_size = batch_size
        self.max_workers = max_workers

    def process(self, items: List[Any], processor_fn: Callable) -> BatchResult:
        t0 = time.time()
        results = []
        errors = 0
        for i in range(0, len(items), self.batch_size):
            batch = items[i:i+self.batch_size]
            try:
                batch_results = processor_fn(batch)
                results.extend(batch_results if isinstance(batch_results, list) else [batch_results])
            except Exception as e:
                logger.error(f"Batch failed at offset {i}: {e}")
                errors += 1
        elapsed = (time.time() - t0) * 1000
        return BatchResult(results=results, batch_size=self.batch_size, total_time_ms=elapsed,
                          throughput=len(items)/(elapsed/1000) if elapsed > 0 else 0, errors=errors)

class BatchEngine:
    def __init__(self, engine, batch_size: int = 16):
        from lazy_chameleon.engines.inference_engine import InferenceEngine
        self.engine = engine
        self.processor = BatchProcessor(batch_size=batch_size)

    def generate_batch(self, prompts: List[str]) -> BatchResult:
        def _batch_generate(batch):
            return [self.engine.generate(p) for p in batch]
        return self.processor.process(prompts, _batch_generate)
