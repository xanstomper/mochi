"""Mixture-of-Experts Router.

Implements learned gating to route tasks to the right expert agents.
The router learns which expert combinations produce the best output
for each task type, and adapts its routing over time.

Architecture:
  Task → Gate Network → Expert Selection → Parallel Execution → Merge

The gate is a lightweight scoring function that routes based on:
  - Task keywords and type
  - Historical expert performance
  - Current expert load
  - Mode/compute budget
"""
import math
import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ExpertRoute:
    """A route decision: which experts to activate."""
    expert_names: list[str]
    gate_scores: dict[str, float]
    compute_budget: float  # fraction of total budget allocated
    reason: str = ""

    @property
    def num_experts(self) -> int:
        return len(self.expert_names)


@dataclass
class ExpertStats:
    """Performance stats for one expert."""
    name: str
    total_runs: int = 0
    total_time: float = 0.0
    total_quality: float = 0.0
    total_params: int = 0
    last_run: float = 0.0

    @property
    def avg_quality(self) -> float:
        return self.total_quality / max(self.total_runs, 1)

    @property
    def avg_time(self) -> float:
        return self.total_time / max(self.total_runs, 1)

    @property
    def params_per_second(self) -> float:
        if self.total_time == 0:
            return 0
        return self.total_params / self.total_time


class MoERouter:
    """Mixture-of-Experts routing engine.

    Decides which lazy agents to activate for each task, how much
    compute to allocate to each, and when to stop.
    """

    # Expert profiles
    EXPERT_PROFILES = {
        "scout": {
            "keywords": ["approach", "alternative", "option", "solution",
                         "design", "strategy", "plan", "method"],
            "strength": 0.9,
            "speed": 0.8,
        },
        "critic": {
            "keywords": ["risk", "bug", "issue", "problem", "flaw",
                         "weakness", "vulnerability", "danger"],
            "strength": 0.85,
            "speed": 0.9,
        },
        "research": {
            "keywords": ["knowledge", "concept", "technology", "practice",
                         "reference", "documentation", "example"],
            "strength": 0.8,
            "speed": 0.7,
        },
        "simulator": {
            "keywords": ["simulate", "scenario", "what-if", "predict",
                         "scale", "load", "failure", "edge case"],
            "strength": 0.8,
            "speed": 0.75,
        },
        "architect": {
            "keywords": ["architecture", "system", "pattern", "module",
                         "service", "component", "framework", "structure"],
            "strength": 0.85,
            "speed": 0.7,
        },
        "debug": {
            "keywords": ["debug", "error", "crash", "exception", "security",
                         "injection", "overflow", "leak", "race condition"],
            "strength": 0.8,
            "speed": 0.85,
        },
        "optimizer": {
            "keywords": ["optimize", "improve", "performance", "scale",
                         "efficiency", "faster", "better", "cost"],
            "strength": 0.75,
            "speed": 0.8,
        },
        "historian": {
            "keywords": ["history", "past", "mistake", "lesson",
                         "pattern", "experience", "evolution", "pitfall"],
            "strength": 0.7,
            "speed": 0.9,
        },
    }

    # Mode → expert count limits
    MODE_EXPERT_LIMITS = {
        "easy": 2,
        "medium": 3,
        "hard": 5,
        "extreme": 8,
        "turbo": 3,
        "deep": 6,
        "genius": 8,
        "god": 8,
        "opus": 8,
    }

    def __init__(self, available_experts: list[str] = None):
        self.available_experts = available_experts or list(self.EXPERT_PROFILES.keys())
        self.expert_stats: dict[str, ExpertStats] = {
            name: ExpertStats(name=name) for name in self.available_experts
        }
        self.routing_history: list[ExpertRoute] = []
        self.total_routes = 0

    def route(self, task: str, mode: str = "hard",
              compute_budget: float = 1.0) -> ExpertRoute:
        """Route a task to the optimal expert combination.

        Args:
            task: The task description
            mode: Compute mode (easy/medium/hard/extreme/etc)
            compute_budget: Total compute budget (0.0 - 1.0)

        Returns:
            ExpertRoute with selected experts and their allocations
        """
        max_experts = self.MODE_EXPERT_LIMITS.get(mode, 5)
        task_lower = task.lower()

        # Score each expert for this task
        gate_scores = {}
        for expert_name in self.available_experts:
            profile = self.EXPERT_PROFILES.get(expert_name, {})
            keywords = profile.get("keywords", [])

            # Keyword match score
            keyword_score = sum(2 for kw in keywords if kw in task_lower)

            # Historical quality score
            stats = self.expert_stats.get(expert_name)
            quality_score = stats.avg_quality * 5 if stats else 2.5

            # Speed bonus (prefer fast experts under tight budget)
            speed_bonus = profile.get("speed", 0.5) * 2

            # Combined gate score
            gate_scores[expert_name] = keyword_score + quality_score + speed_bonus

        # Select top experts
        sorted_experts = sorted(gate_scores, key=gate_scores.get, reverse=True)
        selected = sorted_experts[:max_experts]

        # Always include critic for adversarial checking
        if "critic" not in selected and len(selected) < max_experts:
            selected.append("critic")

        # Allocate compute budget
        total_score = sum(gate_scores[e] for e in selected)
        budget_per_expert = {
            e: (gate_scores[e] / max(total_score, 0.1)) * compute_budget
            for e in selected
        }

        # Build reason
        reason_parts = []
        top_expert = selected[0] if selected else "none"
        reason_parts.append(f"Top match: {top_expert}")
        if len(selected) >= 3:
            reason_parts.append(f"{len(selected)} experts activated")

        route = ExpertRoute(
            expert_names=selected,
            gate_scores=gate_scores,
            compute_budget=compute_budget,
            reason="; ".join(reason_parts),
        )

        self.routing_history.append(route)
        self.total_routes += 1

        return route

    def update_stats(self, expert_name: str, time_taken: float,
                     quality: float, params_generated: int):
        """Update expert stats after a run."""
        if expert_name in self.expert_stats:
            stats = self.expert_stats[expert_name]
            stats.total_runs += 1
            stats.total_time += time_taken
            stats.total_quality += quality
            stats.total_params += params_generated
            stats.last_run = time.time()

    def get_adaptive_limits(self, task: str, mode: str) -> dict:
        """Get adaptive limits based on expert performance."""
        route = self.route(task, mode)
        return {
            "experts": route.expert_names,
            "num_experts": route.num_experts,
            "compute_budget": route.compute_budget,
            "expected_time": sum(
                self.expert_stats[e].avg_time
                for e in route.expert_names
                if self.expert_stats[e].total_runs > 0
            ),
        }

    def reset_stats(self) -> None:
        """Reset all routing statistics and history."""
        for stats in self.expert_stats.values():
            stats.total_runs = 0
            stats.total_time = 0.0
            stats.total_quality = 0.0
            stats.total_params = 0
            stats.last_run = 0.0
        self.routing_history.clear()
        self.total_routes = 0

    def top_experts(self, n: int = 3) -> list[str]:
        """Return top-n expert names by average quality (descending).

        Only experts that have been run at least once are considered.
        """
        eligible = [
            (name, s.avg_quality)
            for name, s in self.expert_stats.items()
            if s.total_runs > 0
        ]
        eligible.sort(key=lambda x: x[1], reverse=True)
        return [name for name, _ in eligible[:n]]

    def get_stats(self) -> dict:
        return {
            "total_routes": self.total_routes,
            "expert_performance": {
                name: {
                    "runs": s.total_runs,
                    "avg_quality": round(s.avg_quality, 3),
                    "avg_time": round(s.avg_time, 1),
                    "total_params": s.total_params,
                }
                for name, s in self.expert_stats.items()
                if s.total_runs > 0
            },
        }
