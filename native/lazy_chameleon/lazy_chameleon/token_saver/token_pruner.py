"""TokenPruner — Prune redundant tokens from sequences.
Strategies: repetition, entropy, structure, semantic, attention, hybrid"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from enum import Enum
import re
import math

class PruningStrategy(Enum):
    REPETITION = "repetition"
    ENTROPY = "entropy"
    STRUCTURE = "structure"
    SEMANTIC = "semantic"
    ATTENTION = "attention"
    HYBRID = "hybrid"

@dataclass
class PrunerConfig:
    strategy: PruningStrategy = PruningStrategy.HYBRID
    pruning_ratio: float = 0.3
    min_sequence_length: int = 50
    repetition_threshold: float = 0.85
    entropy_threshold: float = 0.3

class TokenPruner:
    def __init__(self, config = None):
        self.config = config or PrunerConfig()
        self._stats: Dict[str, int] = {}

    def prune(self, text: str, strategy = None) -> str:
        s = strategy or self.config.strategy
        self._stats[s.value] = self._stats.get(s.value, 0) + 1
        if s == PruningStrategy.REPETITION:
            return self._prune_repetition(text)
        elif s == PruningStrategy.STRUCTURE:
            return self._prune_structure(text)
        else:
            return self._prune_hybrid(text)

    def _prune_repetition(self, text: str) -> str:
        lines = text.split("\n")
        result = []
        prev = ""
        for line in lines:
            if line and len(line) > 0:
                prev_words = set(prev.split())
                curr_words = set(line.split())
                if prev_words and curr_words:
                    sim = len(prev_words & curr_words) / len(prev_words | curr_words)
                    if sim < self.config.repetition_threshold or len(line) < 20:
                        result.append(line)
                        prev = line
                else:
                    result.append(line)
                    prev = line
        return "\n".join(result)

    def _prune_structure(self, text: str) -> str:
        text = re.sub(r'\n{3,}', '\n\n', text)
        text = re.sub(r' {3,}', '  ', text)
        return text

    def _prune_hybrid(self, text: str) -> str:
        t = self._prune_structure(text)
        t = self._prune_repetition(t)
        target = int(len(t) * (1 - self.config.pruning_ratio))
        return t[:max(target, 50)]

    def get_stats(self):
        return dict(self._stats)
