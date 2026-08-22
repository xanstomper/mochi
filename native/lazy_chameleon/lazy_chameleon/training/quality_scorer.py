"""Quality Scorer — Multi-dimensional quality scoring for training data."""

from __future__ import annotations

import json
import math
import re
import statistics
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple


@dataclass
class QualityDimensions:
    """Multi-dimensional quality scores for a single data point."""
    completeness: float = 0.0  # Does it cover all aspects?
    correctness: float = 0.0  # Is the information correct?
    clarity: float = 0.0      # Is it well-written and clear?
    coherence: float = 0.0    # Does it flow logically?
    conciseness: float = 0.0  # Is it appropriately concise?
    creativity: float = 0.0   # Does it show originality?
    safety: float = 1.0       # Is it safe and appropriate?
    helpfulness: float = 0.0  # How helpful is the response?
    instruction_following: float = 0.0  # Does it follow instructions?
    reasoning_depth: float = 0.0  # Depth of reasoning shown
    
    @property
    def overall(self) -> float:
        """Weighted overall quality score."""
        weights = {
            "completeness": 0.15, "correctness": 0.20,
            "clarity": 0.10, "coherence": 0.10,
            "conciseness": 0.05, "creativity": 0.05,
            "safety": 0.10, "helpfulness": 0.10,
            "instruction_following": 0.10, "reasoning_depth": 0.05,
        }
        score = sum(
            getattr(self, dim) * weight
            for dim, weight in weights.items()
        )
        return round(min(1.0, max(0.0, score)), 4)
    
    def to_dict(self) -> Dict[str, float]:
        return {
            "completeness": self.completeness,
            "correctness": self.correctness,
            "clarity": self.clarity,
            "coherence": self.coherence,
            "conciseness": self.conciseness,
            "creativity": self.creativity,
            "safety": self.safety,
            "helpfulness": self.helpfulness,
            "instruction_following": self.instruction_following,
            "reasoning_depth": self.reasoning_depth,
            "overall": self.overall,
        }


@dataclass
class ScoredDataPoint:
    """A data point with quality scores."""
    instruction: str
    response: str
    domain: str = "general"
    difficulty: float = 0.5
    scores: QualityDimensions = field(default_factory=QualityDimensions)
    metadata: Dict[str, Any] = field(default_factory=dict)


class QualityScorer:
    """
    Multi-dimensional quality scoring using heuristic and model-based methods.
    
    Scores each data point across 10 dimensions:
    - Completeness, correctness, clarity, coherence
    - Conciseness, creativity, safety, helpfulness
    - Instruction following, reasoning depth
    """
    
    def __init__(self, use_model: bool = False):
        self.use_model = use_model
        self._scores_generated: int = 0
        self._dimension_stats: Dict[str, List[float]] = {
            dim: [] for dim in [
                "completeness", "correctness", "clarity", "coherence",
                "conciseness", "creativity", "safety", "helpfulness",
                "instruction_following", "reasoning_depth",
            ]
        }
    
    def score(self, instruction: str, response: str, domain: str = "general") -> QualityDimensions:
        """Score a single (instruction, response) pair."""
        if self.use_model:
            return self._model_score(instruction, response, domain)
        return self._heuristic_score(instruction, response, domain)
    
    def score_batch(self, pairs: List[Tuple[str, str, str]]) -> List[QualityDimensions]:
        """Score a batch of (instruction, response, domain) triples."""
        return [self.score(inst, resp, dom) for inst, resp, dom in pairs]
    
    def score_dataset(self, datapoints: List[ScoredDataPoint]) -> List[ScoredDataPoint]:
        """Score an existing dataset, updating scores in-place."""
        for dp in datapoints:
            dp.scores = self.score(dp.instruction, dp.response, dp.domain)
            self._scores_generated += 1
        return datapoints
    
    def _heuristic_score(self, instruction: str, response: str, domain: str) -> QualityDimensions:
        """Heuristic-based quality scoring without calling a model."""
        dims = QualityDimensions()
        
        # Completeness: coverage of instruction elements in response
        inst_words = set(instruction.lower().split())
        resp_words = set(response.lower().split())
        word_overlap = len(inst_words & resp_words) / max(len(inst_words), 1)
        dims.completeness = min(1.0, word_overlap * 1.5)
        
        # Correctness: based on domain-specific signals
        if domain in ("math", "code", "science"):
            has_answer = any(m in response.lower() for m in ["answer", "result", "solution", "therefore"])
            has_steps = response.count("\n") > 5 or bool(re.search(r'\d+\.\s|Step\s+\d+', response))
            dims.correctness = 0.4 + (0.3 if has_answer else 0) + (0.3 if has_steps else 0)
        else:
            dims.correctness = 0.7
        
        # Clarity: sentence length, paragraph structure
        sentences = re.split(r'[.!?]+', response)
        if sentences:
            avg_sent_len = sum(len(s.split()) for s in sentences if s.strip()) / max(len([s for s in sentences if s.strip()]), 1)
            if 8 <= avg_sent_len <= 25:
                dims.clarity = 0.8
            elif 5 <= avg_sent_len <= 35:
                dims.clarity = 0.6
            else:
                dims.clarity = 0.4
        
        # Coherence: look for transition words and logical flow
        transition_words = ["first", "second", "then", "next", "finally", "however", "therefore", "because"]
        trans_count = sum(1 for w in transition_words if w in response.lower())
        dims.coherence = min(0.3 + trans_count * 0.1, 1.0)
        
        # Conciseness: ratio of response to instruction
        if len(instruction) > 0:
            ratio = len(response) / len(instruction)
            if 2 <= ratio <= 20:
                dims.conciseness = 0.8
            elif 1 <= ratio <= 50:
                dims.conciseness = 0.6
            else:
                dims.conciseness = 0.3
        else:
            dims.conciseness = 0.5
        
        # Creativity: unique word ratio, structure variety
        unique_ratio = len(resp_words) / max(len(resp_words | inst_words), 1)
        has_examples = bool(re.search(r'for example|for instance|e\.g\.|such as', response, re.I))
        has_code = "```" in response or "def " in response or "class " in response
        dims.creativity = 0.3 + unique_ratio * 0.3 + (0.2 if has_examples else 0) + (0.2 if has_code else 0)
        dims.creativity = min(1.0, dims.creativity)
        
        # Safety: check for harmful content markers
        harmful_patterns = [
            r"how to (make|create|build|synthesize) (a |)(bomb|weapon|explosive|drug)",
            r"instructions for (hacking|stealing|fraud|identity theft)",
            r"(self.?harm|suicide|kill yourself|cutting)",
            r"(child.?porn|exploit|abuse)",
        ]
        for pattern in harmful_patterns:
            if re.search(pattern, response, re.I):
                dims.safety = 0.0
                break
        
        # Helpfulness: does it directly address the instruction?
        direct_answer = len(instruction) > 0 and any(
            word in response.lower()[:200]
            for word in instruction.lower().split()[:5]
        )
        dims.helpfulness = 0.5 + (0.3 if direct_answer else 0) + (0.2 if len(response) > 200 else 0)
        dims.helpfulness = min(1.0, dims.helpfulness)
        
        # Instruction following: checks if response format matches instruction
        if "list" in instruction.lower() and not re.search(r'^\d+\.|^- ', response, re.M):
            dims.instruction_following = 0.3
        elif "explain" in instruction.lower() and len(response) < 100:
            dims.instruction_following = 0.3
        elif "code" in instruction.lower() and "```" not in response:
            dims.instruction_following = 0.4
        elif "short" in instruction.lower() and len(response) > 500:
            dims.instruction_following = 0.5
        else:
            dims.instruction_following = 0.7
        
        # Reasoning depth: depth of analysis
        depth_indicators = ["because", "therefore", "since", "implies", "step", "level", "layer", "dimension"]
        depth_count = sum(1 for w in depth_indicators if w in response.lower())
        section_count = response.count("#") + response.count("\n\n")
        dims.reasoning_depth = min(0.3 + depth_count * 0.08 + section_count * 0.05, 1.0)
        
        # Track stats
        for dim_name in self._dimension_stats:
            self._dimension_stats[dim_name].append(getattr(dims, dim_name))
        
        return dims
    
    def _model_score(self, instruction: str, response: str, domain: str) -> QualityDimensions:
        """Model-based quality scoring."""
        # Fall back to heuristic if model is unavailable
        return self._heuristic_score(instruction, response, domain)
    
    def get_stats(self) -> Dict[str, Any]:
        """Get scoring statistics."""
        stats: Dict[str, Any] = {
            "total_scored": self._scores_generated,
            "dimension_averages": {},
            "dimension_medians": {},
        }
        for dim, values in self._dimension_stats.items():
            if values:
                stats["dimension_averages"][dim] = round(statistics.mean(values), 4)
                stats["dimension_medians"][dim] = round(statistics.median(values), 4)
            else:
                stats["dimension_averages"][dim] = 0.0
                stats["dimension_medians"][dim] = 0.0
        return stats
    
    def filter_by_threshold(self, datapoints: List[ScoredDataPoint], threshold: float = 0.7) -> List[ScoredDataPoint]:
        """Filter datapoints by overall quality threshold."""
        return [dp for dp in datapoints if dp.scores.overall >= threshold]
    
    def rank_by_quality(self, datapoints: List[ScoredDataPoint]) -> List[ScoredDataPoint]:
        """Rank datapoints by overall quality score."""
        return sorted(datapoints, key=lambda dp: dp.scores.overall, reverse=True)


# ═════════════════════════════════════════════════════════════════════════════
# QUALITY GATE — Accept/Reject decisions with configurable thresholds
# ═════════════════════════════════════════════════════════════════════════════

@dataclass
class GateConfig:
    """Configuration for a quality gate."""
    min_overall: float = 0.6
    min_completeness: float = 0.3
    min_correctness: float = 0.3
    min_safety: float = 0.8
    min_helpfulness: float = 0.4
    min_length: int = 50
    max_length: int = 64000
    reject_hallucinations: bool = True
    reject_injection: bool = True
    min_reasoning_depth: float = 0.0
    domain_overrides: Dict[str, Dict[str, float]] = field(default_factory=dict)


class QualityGate:
    """
    Quality gate that accepts or rejects data points based on multi-dimensional
    quality scores and configurable thresholds.
    """
    
    DEFAULT_CONFIGS: Dict[str, GateConfig] = {
        "strict": GateConfig(
            min_overall=0.8, min_completeness=0.6, min_correctness=0.7,
            min_safety=0.9, min_helpfulness=0.6, min_length=200,
            reject_hallucinations=True, reject_injection=True,
            min_reasoning_depth=0.3,
        ),
        "standard": GateConfig(
            min_overall=0.6, min_completeness=0.3, min_correctness=0.3,
            min_safety=0.8, min_helpfulness=0.4, min_length=50,
            reject_hallucinations=True, reject_injection=True,
        ),
        "relaxed": GateConfig(
            min_overall=0.4, min_completeness=0.2, min_correctness=0.2,
            min_safety=0.7, min_helpfulness=0.3, min_length=20,
            reject_hallucinations=False, reject_injection=False,
        ),
        "math": GateConfig(
            min_overall=0.7, min_completeness=0.5, min_correctness=0.8,
            min_safety=0.9, min_helpfulness=0.5, min_length=100,
            reject_hallucinations=True, reject_injection=True,
            min_reasoning_depth=0.4,
        ),
        "code": GateConfig(
            min_overall=0.65, min_completeness=0.4, min_correctness=0.6,
            min_safety=0.9, min_helpfulness=0.5, min_length=50,
            reject_hallucinations=True, reject_injection=True,
        ),
    }
    
    def __init__(self, config: Optional[GateConfig] = None, mode: str = "standard"):
        if config:
            self.config = config
        else:
            self.config = self.DEFAULT_CONFIGS.get(mode, self.DEFAULT_CONFIGS["standard"])
        self._accepted: int = 0
        self._rejected: int = 0
        self._rejection_reasons: Dict[str, int] = {}
    
    def evaluate(self, instruction: str, response: str, scores: QualityDimensions, domain: str = "general") -> bool:
        """Evaluate whether a data point passes the quality gate."""
        # Get domain-specific thresholds if available
        cfg = self.config
        if domain in cfg.domain_overrides:
            override = cfg.domain_overrides[domain]
            min_overall = override.get("min_overall", cfg.min_overall)
            min_safety = override.get("min_safety", cfg.min_safety)
        else:
            min_overall = cfg.min_overall
            min_safety = cfg.min_safety
        
        # Check each dimension
        if scores.overall < min_overall:
            self._reject("below_overall_threshold")
            return False
        if scores.completeness < cfg.min_completeness:
            self._reject("below_completeness_threshold")
            return False
        if scores.correctness < cfg.min_correctness:
            self._reject("below_correctness_threshold")
            return False
        if scores.safety < min_safety:
            self._reject("below_safety_threshold")
            return False
        if scores.helpfulness < cfg.min_helpfulness:
            self._reject("below_helpfulness_threshold")
            return False
        if scores.reasoning_depth < cfg.min_reasoning_depth:
            self._reject("below_reasoning_depth_threshold")
            return False
        if len(response) < cfg.min_length:
            self._reject("response_too_short")
            return False
        if len(response) > cfg.max_length:
            self._reject("response_too_long")
            return False
        
        self._accepted += 1
        return True
    
    def evaluate_batch(self, datapoints: List[ScoredDataPoint]) -> List[ScoredDataPoint]:
        """Evaluate a batch of data points, returning only those that pass."""
        passed = []
        for dp in datapoints:
            if self.evaluate(dp.instruction, dp.response, dp.scores, dp.domain):
                passed.append(dp)
        return passed
    
    def _reject(self, reason: str):
        self._rejected += 1
        self._rejection_reasons[reason] = self._rejection_reasons.get(reason, 0) + 1
    
    def stats(self) -> Dict[str, Any]:
        """Get gate statistics."""
        total = self._accepted + self._rejected
        return {
            "accepted": self._accepted,
            "rejected": self._rejected,
            "pass_rate": round(self._accepted / max(total, 1), 4),
            "rejection_reasons": dict(self._rejection_reasons),
        }
    
    def reset(self):
        """Reset all counters."""
        self._accepted = 0
        self._rejected = 0
        self._rejection_reasons.clear()
