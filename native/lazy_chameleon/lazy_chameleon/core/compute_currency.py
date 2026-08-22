"""ComputeCurrency — Credit-based compute economy. Prevents runaway loops."""
from __future__ import annotations
import uuid
from dataclasses import dataclass, field
from typing import Optional

BUDGETS = {"easy": 50, "medium": 200, "hard": 800, "research": 3000, "extreme": 10000}

OPERATION_COSTS: dict[str, int] = {
    "agent_call": 5, "debate_round": 20, "mcts_iteration": 3,
    "memory_retrieval": 1, "skill_lookup": 1, "simulation": 12,
    "thought_generation": 8, "world_state_update": 2, "compression": 3,
    "expert_spawn": 4, "expert_merge": 3, "evolution_step": 10,
    "reflection_store": 1, "neural_cache_put": 1, "plan_step": 2,
}


@dataclass
class CreditLedger:
    task_id: str
    task: str
    difficulty: str
    initial_budget: int
    remaining: int
    spent: dict[str, int] = field(default_factory=dict)
    history: list[dict] = field(default_factory=list)


class ComputeCurrency:
    def __init__(self):
        self._ledgers: dict[str, CreditLedger] = {}

    def allocate(self, task: str, difficulty: str = "medium") -> CreditLedger:
        budget = BUDGETS.get(difficulty, BUDGETS["medium"])
        tid    = str(uuid.uuid4())[:8]
        ledger = CreditLedger(tid, task[:80], difficulty, budget, budget)
        self._ledgers[tid] = ledger
        return ledger

    def spend(self, ledger: CreditLedger, operation: str, multiplier: float = 1.0) -> bool:
        cost = int(OPERATION_COSTS.get(operation, 5) * multiplier)
        if ledger.remaining < cost:
            return False
        ledger.remaining -= cost
        ledger.spent[operation] = ledger.spent.get(operation, 0) + cost
        ledger.history.append({"op": operation, "cost": cost, "remaining": ledger.remaining})
        return True

    def can_afford(self, ledger: CreditLedger, operation: str, n: int = 1) -> bool:
        cost = OPERATION_COSTS.get(operation, 5) * n
        return ledger.remaining >= cost

    def remaining_ratio(self, ledger: CreditLedger) -> float:
        return ledger.remaining / max(ledger.initial_budget, 1)

    def suggest_cutback(self, ledger: CreditLedger) -> str:
        ratio = self.remaining_ratio(ledger)
        if ratio > 0.5: return "full_pipeline"
        if ratio > 0.25: return "skip_debate"
        if ratio > 0.1: return "skip_mcts_debate"
        return "direct_answer_only"

    def get_spending_report(self, ledger: CreditLedger) -> dict:
        return {
            "task_id": ledger.task_id, "difficulty": ledger.difficulty,
            "budget": ledger.initial_budget, "spent": ledger.initial_budget - ledger.remaining,
            "remaining": ledger.remaining, "ratio": round(self.remaining_ratio(ledger), 3),
            "by_operation": ledger.spent,
        }

    def adaptive_budget(self, ledger: CreditLedger, current_quality: float) -> bool:
        """Expand budget if quality still improving and we're out."""
        if ledger.remaining > 0:
            return False
        if current_quality < 0.9 and ledger.initial_budget < BUDGETS["extreme"]:
            bonus = int(ledger.initial_budget * 0.25)
            ledger.remaining  += bonus
            ledger.initial_budget += bonus
            return True
        return False
