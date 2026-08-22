"""
ThoughtMarket — Adaptive compute auction for reasoning paths.

Flow:
  Task → generate N candidate thoughts → score each →
  auction: best K win full compute, rest die.

Prevents wasting tokens on bad reasoning paths.
"""
from __future__ import annotations
import hashlib
import re
from dataclasses import dataclass, field
from typing import Callable


REASONING_STRATEGIES = [
    ("direct_answer",         "Answer directly from knowledge without intermediate steps."),
    ("break_into_steps",      "Decompose the problem into numbered sub-steps and solve each."),
    ("analogy",               "Find a similar known problem and map the solution across."),
    ("first_principles",      "Strip away assumptions; reason from fundamental truths."),
    ("counterexample",        "Try to disprove the answer; if you can't, it's likely correct."),
    ("simulation",            "Mentally simulate the system/process step by step."),
    ("proof_by_contradiction","Assume the opposite is true and derive a contradiction."),
    ("induction",             "Solve the base case, then generalise to the full problem."),
    ("divide_and_conquer",    "Split into independent sub-problems, solve, then merge."),
    ("pattern_matching",      "Recognise the problem class and apply the canonical solution."),
    ("constraint_propagation","List all constraints and eliminate impossible states."),
    ("backwards_chaining",    "Start from the goal and work backwards to what is needed."),
    ("case_analysis",         "Enumerate distinct cases and solve each separately."),
    ("abstraction",           "Raise the level of abstraction to reveal the core structure."),
    ("concrete_example",      "Solve a tiny concrete instance first, then generalise."),
    ("worst_case_analysis",   "Identify the hardest input and ensure the solution handles it."),
    ("best_case_simplification", "Solve the easiest version first as a sanity check."),
    ("socratic_questioning",  "Ask clarifying questions to expose hidden assumptions."),
    ("outside_in",            "Define the desired output format first, then build towards it."),
    ("rubber_duck",           "Explain the problem aloud step by step to expose the flaw."),
]


@dataclass
class ThoughtCandidate:
    id: str
    strategy: str
    content: str          # short description of approach
    score: float = 0.0
    compute_allocated: int = 0
    confidence: float = 0.0
    alive: bool = True
    reasoning_path: list[str] = field(default_factory=list)


class ThoughtMarket:
    """Auction compute to the best reasoning strategies."""

    def __init__(self, n_candidates: int = 20, survivors: int = 5,
                 budget_per_survivor: int = 200):
        self.n_candidates = min(n_candidates, len(REASONING_STRATEGIES))
        self.survivors = survivors
        self.budget_per_survivor = budget_per_survivor
        self._history: list[dict] = []

    # ------------------------------------------------------------------
    def generate_candidates(self, task: str, context: str = "") -> list[ThoughtCandidate]:
        candidates: list[ThoughtCandidate] = []
        task_lower = task.lower()
        for i, (name, desc) in enumerate(REASONING_STRATEGIES[:self.n_candidates]):
            c_id = hashlib.md5(f"{name}:{task[:32]}".encode()).hexdigest()[:8]
            approach = f"[{name}] {desc} Applied to: {task[:120]}"
            candidates.append(ThoughtCandidate(
                id=c_id,
                strategy=name,
                content=approach,
                reasoning_path=[approach],
            ))
        return candidates

    # ------------------------------------------------------------------
    def score_candidate(self, c: ThoughtCandidate, task: str,
                        all_candidates: list[ThoughtCandidate]) -> float:
        task_lower = task.lower()
        score = 0.0

        # Relevance — keyword overlap between strategy name/desc and task
        strat_tokens = set(c.strategy.replace("_", " ").split())
        task_tokens  = set(re.sub(r"[^\w\s]", "", task_lower).split())
        overlap = len(strat_tokens & task_tokens)
        score += min(overlap * 0.15, 0.3)

        # Task-type bonuses
        if any(k in task_lower for k in ("debug", "error", "fix", "bug", "crash")):
            if c.strategy in ("simulation", "counterexample", "rubber_duck", "worst_case_analysis"):
                score += 0.25
        if any(k in task_lower for k in ("design", "architecture", "system", "build")):
            if c.strategy in ("first_principles", "abstraction", "divide_and_conquer", "outside_in"):
                score += 0.25
        if any(k in task_lower for k in ("math", "calculate", "proof", "equation", "solve")):
            if c.strategy in ("proof_by_contradiction", "induction", "first_principles", "case_analysis"):
                score += 0.25
        if any(k in task_lower for k in ("plan", "steps", "how to", "process")):
            if c.strategy in ("break_into_steps", "divide_and_conquer", "backwards_chaining"):
                score += 0.25
        if any(k in task_lower for k in ("explain", "understand", "what is", "why")):
            if c.strategy in ("analogy", "concrete_example", "socratic_questioning", "abstraction"):
                score += 0.25

        # Novelty — prefer strategies not already in top survivors
        alive_strategies = {x.strategy for x in all_candidates if x.alive and x.id != c.id}
        if c.strategy not in alive_strategies:
            score += 0.05

        # Specificity bonus for strategies with longer names (more specialised)
        score += len(c.strategy) * 0.003

        return min(score, 1.0)

    # ------------------------------------------------------------------
    def auction(self, task: str, context: str = "") -> list[ThoughtCandidate]:
        candidates = self.generate_candidates(task, context)

        # Score all
        for c in candidates:
            c.score = self.score_candidate(c, task, candidates)

        # Sort by score descending
        candidates.sort(key=lambda x: x.score, reverse=True)

        # Kill losers
        for c in candidates[self.survivors:]:
            c.alive = False

        # Allocate compute proportionally to survivors
        survivors = candidates[:self.survivors]
        total_score = sum(c.score for c in survivors) or 1.0
        for c in survivors:
            c.compute_allocated = int((c.score / total_score) * self.budget_per_survivor * self.survivors)
            c.confidence = c.score

        self._history.append({
            "task": task[:80],
            "total": len(candidates),
            "survivors": self.survivors,
            "top_strategy": survivors[0].strategy if survivors else None,
        })
        return survivors

    # ------------------------------------------------------------------
    def get_market_summary(self) -> dict:
        return {
            "auctions_run": len(self._history),
            "config": {
                "n_candidates": self.n_candidates,
                "survivors": self.survivors,
                "budget_per_survivor": self.budget_per_survivor,
            },
            "recent": self._history[-5:],
        }
