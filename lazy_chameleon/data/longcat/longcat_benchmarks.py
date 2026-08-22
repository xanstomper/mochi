"""LongCatBenchmark — Run evaluation against LongCat benchmark suites."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional

@dataclass
class BenchmarkScore:
    benchmark: str
    score: float
    num_samples: int
    details: Dict[str, Any]

class LongCatBenchmark:
    BENCHMARKS: Dict[str, Dict[str, Any]] = {
        "LARYBench": {"domain": "reasoning", "type": "long_context", "num_samples": 1000},
        "WBench": {"domain": "video", "type": "multi_turn", "num_samples": 500},
        "OIBench": {"domain": "instruction", "type": "following", "num_samples": 5000},
        "CoreCodeBench": {"domain": "code", "type": "generation", "num_samples": 3000},
        "AMO-Bench": {"domain": "agent", "type": "multi_operation", "num_samples": 800},
        "UNO-Bench": {"domain": "agent", "type": "unified", "num_samples": 600},
        "CEdit-Bench": {"domain": "code", "type": "editing", "num_samples": 2000},
        "ViC-Bench": {"domain": "vision", "type": "instruction", "num_samples": 1000},
    }
    
    def run_benchmark(self, name: str, eval_fn: Callable) -> BenchmarkScore:
        bench = self.BENCHMARKS.get(name)
        if not bench:
            raise ValueError(f"Unknown benchmark: {name}")
        result = eval_fn(name)
        score = result if isinstance(result, (int, float)) else 0.0
        return BenchmarkScore(benchmark=name, score=score, num_samples=bench["num_samples"], details={"domain": bench["domain"], "type": bench["type"]})
    
    def run_all(self, eval_fn: Callable) -> Dict[str, BenchmarkScore]:
        results = {}
        for name in self.BENCHMARKS:
            try:
                results[name] = self.run_benchmark(name, eval_fn)
            except:
                pass
        return results
    
    def average_score(self, results: Dict[str, BenchmarkScore], domain: str = None) -> float:
        filtered = [r for r in results.values() if not domain or r.details.get("domain") == domain]
        if not filtered:
            return 0.0
        return sum(r.score for r in filtered) / len(filtered)
