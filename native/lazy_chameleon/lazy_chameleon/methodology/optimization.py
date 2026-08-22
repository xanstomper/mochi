"""Optimization — Hyperparameter optimization and tuning."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional
import random
import math

@dataclass
class HyperOptConfig:
    method: str = "grid"  # grid, random, bayesian
    max_trials: int = 20
    seed: int = 42

class HyperOpt:
    def __init__(self, config: Optional[HyperOptConfig] = None):
        self.config = config or HyperOptConfig()
        self.rng = random.Random(self.config.seed)
        self._trials: List[Dict] = []

    def grid_search(self, param_grid: Dict[str, List]) -> List[Dict]:
        keys = list(param_grid.keys())
        values = list(param_grid.values())
        results = []
        def _product(idx, current):
            if idx == len(keys):
                results.append(dict(current))
                return
            for v in values[idx]:
                current[keys[idx]] = v
                _product(idx + 1, current)
        _product(0, {})
        return results

    def random_search(self, param_ranges: Dict[str, tuple], n: int = 10) -> List[Dict]:
        results = []
        for _ in range(n):
            point = {}
            for param, (lo, hi) in param_ranges.items():
                point[param] = self.rng.uniform(lo, hi)
            results.append(point)
        return results

    def optimize(self, objective_fn: Callable, param_grid: Dict[str, List]) -> Dict:
        best = None
        best_score = float('-inf')
        for params in self.grid_search(param_grid):
            score = objective_fn(params)
            self._trials.append({"params": params, "score": score})
            if score > best_score:
                best_score = score
                best = params
        return {"best_params": best, "best_score": best_score, "trials": len(self._trials)}

class OptimizationMethod:
    METHODS = ["grid_search", "random_search", "bayesian_opt", "evolutionary", "hyperband"]

    def __init__(self):
        self.opt = HyperOpt()
