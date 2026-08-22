"""DataSynthesizer — Generate synthetic training data from any source."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Iterator
import json
import random

@dataclass
class SynthConfig:
    num_samples: int = 100
    domains: List[str] = field(default_factory=lambda: ["math", "code", "reasoning"])
    difficulty_range: tuple = (0.3, 0.8)
    seed: int = 42
    output_format: str = "instruction_response"
    source_model: str = "synthetic"

class DataSynthesizer:
    def __init__(self, config: Optional[SynthConfig] = None):
        self.config = config or SynthConfig()
        self.rng = random.Random(self.config.seed)
        self._generated = 0

    def generate(self, domain: str = None) -> List[Dict[str, Any]]:
        domain = domain or self.config.domains[0]
        num = self.config.num_samples
        results = []
        for _ in range(num):
            if domain == "math":
                results.append(self._gen_math())
            elif domain == "code":
                results.append(self._gen_code())
            elif domain == "reasoning":
                results.append(self._gen_reasoning())
            else:
                results.append(self._gen_general())
        self._generated += len(results)
        return results

    def _gen_math(self) -> Dict:
        a, b = self.rng.randint(1, 10), self.rng.randint(1, 20)
        return {"instruction": f"Solve: {a}x + {b} = {a*b}", "response": f"x = {b}",
                "domain": "math", "difficulty": round(self.rng.uniform(*self.config.difficulty_range), 2)}

    def _gen_code(self) -> Dict:
        topics = ["binary search", "merge sort", "depth-first search", "linked list"]
        t = self.rng.choice(topics)
        return {"instruction": f"Implement {t} in Python.", "response": f"Implementation of {t} with O(n log n) complexity.",
                "domain": "code", "difficulty": round(self.rng.uniform(*self.config.difficulty_range), 2)}

    def _gen_reasoning(self) -> Dict:
        return {"instruction": "A bat and ball cost $1.10. Bat costs $1 more. What does the ball cost?",
                "response": "Let b = ball cost. Then bat = b + 1. Total: b + (b+1) = 1.10, so 2b = 0.10, ball = $0.05.",
                "domain": "reasoning", "difficulty": round(self.rng.uniform(*self.config.difficulty_range), 2)}

    def _gen_general(self) -> Dict:
        return {"instruction": f"Write a short explanation of {self.rng.choice(['REST APIs', 'SQL', 'caching', 'Git'])}.",
                "response": "A comprehensive explanation with examples.",
                "domain": "general", "difficulty": round(self.rng.uniform(*self.config.difficulty_range), 2)}

    def to_jsonl(self, data: List[Dict], path: str):
        with open(path, 'w') as f:
            for item in data:
                f.write(json.dumps(item) + '\n')

    def get_stats(self) -> Dict:
        return {"total_generated": self._generated, "config": self.config.__dict__}
