"""Dynamic Compute Scheduler.

Adaptively allocates compute resources based on task complexity,
intermediate quality scores, and remaining budget.

This replaces the fixed mode-based scaling with dynamic allocation:
- Analyze task complexity before starting
- Allocate compute proportionally to difficulty
- Early-exit when quality threshold is met
- Redistribute budget from fast experts to thorough ones
"""
import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ComputeBudget:
    """Represents a compute allocation plan."""
    total_time: float = 60.0       # seconds
    total_api_calls: int = 20      # max API calls
    total_tokens: int = 100000     # max tokens
    max_passes: int = 3            # max refinement passes
    agent_time_share: float = 0.6  # fraction for lazy agents
    main_time_share: float = 0.4   # fraction for main reasoning
    refinement_share: float = 0.2  # fraction for iterative refinement

    @property
    def per_agent_time(self) -> float:
        return self.total_time * self.agent_time_share / 8  # 8 agents max

    @property
    def main_reasoning_time(self) -> float:
        return self.total_time * self.main_time_share

    @property
    def refinement_time(self) -> float:
        return self.total_time * self.refinement_share


@dataclass
class TaskComplexity:
    """Analysis of task complexity."""
    score: float  # 0.0 (trivial) to 1.0 (extremely complex)
    dimensions: dict[str, float] = field(default_factory=dict)
    recommended_mode: str = "hard"
    estimated_passes: int = 2
    reasoning: str = ""


@dataclass
class QualityCheckpoint:
    """Quality measurement at a specific point in the pipeline."""
    pass_number: int
    quality_score: float
    improvement: float
    time_elapsed: float
    should_continue: bool = True
    reason: str = ""


class DynamicComputeScheduler:
    """Dynamically schedules compute across the pipeline.

    Phases:
    1. Pre-flight: Analyze task, set budget
    2. Lazy Phase: Allocate time to each agent
    3. Synthesis Phase: Merge and compress
    4. Reasoning Phase: Main model with context
    5. Refinement: Iterate if below threshold
    6. Post-flight: Update stats and cache
    """

    COMPLEXITY_KEYWORDS = {
        "trivial": ["hello", "say hi", "repeat", "what is"],
        "simple": ["list", "show", "count", "find", "get"],
        "moderate": ["build", "create", "implement", "design", "write"],
        "complex": ["architecture", "system", "scale", "optimize",
                    "integrate", "migrate", "refactor"],
        "extreme": ["full stack", "distributed", "real-time", "production",
                    "enterprise", "complete system", "from scratch"],
    }

    MODE_CONFIGS = {
        "easy": ComputeBudget(
            total_time=15, total_api_calls=5, total_tokens=20000,
            max_passes=1, agent_time_share=0.3, main_time_share=0.6,
            refinement_share=0.0,
        ),
        "medium": ComputeBudget(
            total_time=30, total_api_calls=10, total_tokens=50000,
            max_passes=2, agent_time_share=0.5, main_time_share=0.4,
            refinement_share=0.1,
        ),
        "hard": ComputeBudget(
            total_time=60, total_api_calls=15, total_tokens=80000,
            max_passes=3, agent_time_share=0.5, main_time_share=0.3,
            refinement_share=0.2,
        ),
        "extreme": ComputeBudget(
            total_time=120, total_api_calls=25, total_tokens=150000,
            max_passes=5, agent_time_share=0.4, main_time_share=0.3,
            refinement_share=0.3,
        ),
        "genius": ComputeBudget(
            total_time=180, total_api_calls=40, total_tokens=200000,
            max_passes=5, agent_time_share=0.35, main_time_share=0.3,
            refinement_share=0.35,
        ),
        "god": ComputeBudget(
            total_time=300, total_api_calls=60, total_tokens=300000,
            max_passes=7, agent_time_share=0.3, main_time_share=0.3,
            refinement_share=0.4,
        ),
    }

    def __init__(self):
        self.completion_times: list[float] = []
        self.quality_history: list[float] = []
        self.budget_used: dict[str, float] = {
            "time": 0, "calls": 0, "tokens": 0,
        }

    def analyze_task(self, task: str) -> TaskComplexity:
        """Analyze task complexity to determine compute allocation."""
        task_lower = task.lower()
        dimension_scores = {}

        for dimension, keywords in self.COMPLEXITY_KEYWORDS.items():
            score = sum(2 for kw in keywords if kw in task_lower)
            dimension_scores[dimension] = score

        # Normalize to 0-1
        total = sum(dimension_scores.values())
        if total == 0:
            normalized = {k: 0.2 for k in dimension_scores}
        else:
            normalized = {k: v / total for k, v in dimension_scores.items()}

        # Weighted complexity score
        weights = {
            "trivial": 0.0, "simple": 0.2, "moderate": 0.4,
            "complex": 0.7, "extreme": 1.0,
        }
        complexity = sum(normalized.get(k, 0) * v
                        for k, v in weights.items())

        # Additional complexity signals
        if len(task.split()) > 50:
            complexity = min(complexity + 0.15, 1.0)
        if any(c in task_lower for c in ["multi-", "distributed", "real-time"]):
            complexity = min(complexity + 0.2, 1.0)
        if "production" in task_lower or "deploy" in task_lower:
            complexity = min(complexity + 0.1, 1.0)

        # Map to mode
        if complexity < 0.15:
            mode = "easy"
        elif complexity < 0.35:
            mode = "medium"
        elif complexity < 0.65:
            mode = "hard"
        else:
            mode = "extreme"

        estimated_passes = max(1, min(int(complexity * 5 + 1), 5))

        return TaskComplexity(
            score=round(complexity, 3),
            dimensions=normalized,
            recommended_mode=mode,
            estimated_passes=estimated_passes,
            reasoning=f"Score: {complexity:.3f} -> mode={mode}, passes={estimated_passes}",
        )

    def get_budget(self, mode: str) -> ComputeBudget:
        """Get compute budget for a mode."""
        return self.MODE_CONFIGS.get(mode, self.MODE_CONFIGS["hard"])

    def check_quality_gate(self, current_quality: float, pass_num: int,
                           budget: ComputeBudget) -> QualityCheckpoint:
        """Decide whether to continue refinement or exit."""
        # Quality thresholds
        FRONTIER_THRESHOLD = 0.85
        SATISFICED_THRESHOLD = 0.75

        # Check if we've hit budget limits
        time_ratio = self.budget_used["time"] / budget.total_time
        call_ratio = self.budget_used["calls"] / budget.total_api_calls

        if pass_num >= budget.max_passes:
            return QualityCheckpoint(
                pass_number=pass_num,
                quality_score=current_quality,
                improvement=0,
                time_elapsed=self.budget_used["time"],
                should_continue=False,
                reason=f"Max passes ({budget.max_passes}) reached",
            )

        if time_ratio > 0.9 or call_ratio > 0.9:
            return QualityCheckpoint(
                pass_number=pass_num,
                quality_score=current_quality,
                improvement=0,
                time_elapsed=self.budget_used["time"],
                should_continue=False,
                reason="Budget exhausted",
            )

        if current_quality >= FRONTIER_THRESHOLD:
            return QualityCheckpoint(
                pass_number=pass_num,
                quality_score=current_quality,
                improvement=0,
                time_elapsed=self.budget_used["time"],
                should_continue=False,
                reason=f"Frontier quality reached ({current_quality:.2f})",
            )

        # Calculate expected improvement
        improvement = 0
        if len(self.quality_history) >= 2:
            last_improvement = (
                self.quality_history[-1] - self.quality_history[-2]
            )
            improvement = last_improvement

        # Diminishing returns check
        if pass_num > 2 and improvement < 0.02:
            return QualityCheckpoint(
                pass_number=pass_num,
                quality_score=current_quality,
                improvement=improvement,
                time_elapsed=self.budget_used["time"],
                should_continue=False,
                reason=f"Diminishing returns (improvement={improvement:.3f})",
            )

        return QualityCheckpoint(
            pass_number=pass_num,
            quality_score=current_quality,
            improvement=improvement,
            time_elapsed=self.budget_used["time"],
            should_continue=True,
            reason=f"Below threshold ({current_quality:.2f} < {FRONTIER_THRESHOLD}), continuing",
        )

    def record_usage(self, time_taken: float, api_calls: int = 0, tokens: int = 0):
        self.budget_used["time"] += time_taken
        self.budget_used["calls"] += api_calls
        self.budget_used["tokens"] += tokens

    def record_quality(self, quality: float):
        self.quality_history.append(quality)

    def reset(self):
        self.budget_used = {"time": 0, "calls": 0, "tokens": 0}
        self.quality_history.clear()
        self.completion_times.clear()

    def get_stats(self) -> dict:
        return {
            "total_runs": len(self.completion_times),
            "avg_completion": (
                sum(self.completion_times) / max(len(self.completion_times), 1)
            ),
            "quality_history": self.quality_history[-10:],
            "budget_used": self.budget_used,
        }
