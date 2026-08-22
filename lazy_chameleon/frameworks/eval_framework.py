"""EvaluationFramework — Comprehensive model evaluation."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional
import json
import time

@dataclass
class EvalResult:
    metric: str
    score: float
    details: Dict[str, Any] = field(default_factory=dict)

@dataclass
class EvalSuite:
    name: str
    metrics: List[str]
    test_cases: List[Dict[str, Any]]

class EvaluationFramework:
    def __init__(self):
        self._suites: Dict[str, EvalSuite] = {}
        self._results: Dict[str, List[EvalResult]] = {}

    def register_suite(self, suite: EvalSuite):
        self._suites[suite.name] = suite

    def run(self, suite_name: str, evaluator_fn: Callable) -> List[EvalResult]:
        suite = self._suites.get(suite_name)
        if not suite:
            raise ValueError(f"Unknown suite: {suite_name}")
        results = []
        for test in suite.test_cases:
            t0 = time.time()
            score = evaluator_fn(test)
            elapsed = (time.time() - t0) * 1000
            results.append(EvalResult(metric="accuracy", score=score, details={"latency_ms": elapsed}))
        self._results[suite_name] = results
        return results

    def summary(self) -> Dict:
        summaries = {}
        for name, results in self._results.items():
            if results:
                avg = sum(r.score for r in results) / len(results)
                summaries[name] = {"avg_score": round(avg, 4), "num_tests": len(results)}
        return summaries
