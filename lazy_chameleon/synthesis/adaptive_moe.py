"""AdaptiveMoE — Dynamic expert expansion. Like Agar.io: split to conquer, merge to aggregate."""
from __future__ import annotations
import asyncio, uuid
from dataclasses import dataclass, field
from typing import Callable, Optional

SCALE_MAP = {"easy": 4, "medium": 8, "hard": 16, "extreme": 32, "research": 64}

ROLE_TEMPLATES = {
    "planner":    "You plan approaches and decompose problems.",
    "researcher": "You gather and synthesise information.",
    "coder":      "You write and debug code.",
    "critic":     "You find flaws and challenge assumptions.",
    "verifier":   "You check correctness and validate outputs.",
    "optimizer":  "You improve performance and efficiency.",
    "explainer":  "You make complex things clear and simple.",
    "security":   "You identify vulnerabilities and risks.",
}


@dataclass
class MicroExpert:
    id: str
    role: str
    goal: str
    specialization: str
    memory: list[str] = field(default_factory=list)
    scratchpad: str = ""
    confidence: float = 0.5
    budget_remaining: int = 50
    parent_id: Optional[str] = None
    children_ids: list[str] = field(default_factory=list)
    alive: bool = True
    result: str = ""


@dataclass
class MoEConfig:
    base_experts: int = 4
    max_experts: int = 32
    split_threshold: float = 0.7
    merge_threshold: float = 0.3
    expert_budget: int = 50


class AdaptiveMoE:
    def __init__(self, config: MoEConfig | None = None):
        self.cfg = config or MoEConfig()
        self._experts: dict[str, MicroExpert] = {}

    def spawn_expert(self, role: str, goal: str, specialization: str = "",
                     parent_id: Optional[str] = None, budget: int = 50) -> MicroExpert:
        eid = str(uuid.uuid4())[:8]
        exp = MicroExpert(id=eid, role=role, goal=goal,
                          specialization=specialization or ROLE_TEMPLATES.get(role, ""),
                          budget_remaining=budget, parent_id=parent_id)
        self._experts[eid] = exp
        if parent_id and parent_id in self._experts:
            self._experts[parent_id].children_ids.append(eid)
        return exp

    def split_expert(self, expert: MicroExpert, n_children: int = 2) -> list[MicroExpert]:
        sub_goals = self._decompose_goal(expert.goal, n_children)
        children  = []
        child_budget = expert.budget_remaining // n_children
        for goal in sub_goals:
            child = self.spawn_expert(
                role=expert.role, goal=goal,
                specialization=expert.specialization,
                parent_id=expert.id, budget=child_budget,
            )
            children.append(child)
        expert.alive = False   # parent consumed by split
        return children

    def merge_experts(self, experts: list[MicroExpert]) -> MicroExpert:
        results = [e.result for e in experts if e.result]
        merged_result = "\n\n---\n\n".join(results)
        avg_conf = sum(e.confidence for e in experts) / max(len(experts), 1)
        merged = self.spawn_expert(
            role="merger", goal="Aggregate results from sub-experts",
            budget=20,
        )
        merged.result = merged_result
        merged.confidence = avg_conf
        for e in experts:
            e.alive = False
        return merged

    def scale_to_task(self, task: str, difficulty: str = "medium") -> list[MicroExpert]:
        n = min(SCALE_MAP.get(difficulty, 8), self.cfg.max_experts)
        roles = list(ROLE_TEMPLATES.keys())
        experts = []
        for i in range(n):
            role = roles[i % len(roles)]
            exp  = self.spawn_expert(
                role=role,
                goal=f"[{role}] {task[:100]}",
                budget=self.cfg.expert_budget,
            )
            experts.append(exp)
        return experts

    async def run_expert(self, expert: MicroExpert, task: str,
                         api_fn: Callable) -> str:
        if not expert.alive or expert.budget_remaining <= 0:
            return ""
        system = (f"You are a {expert.role} expert. {expert.specialization}\n"
                  f"Your specific goal: {expert.goal}\n"
                  f"Be concise and focused. Budget: {expert.budget_remaining} tokens.")
        try:
            result = await api_fn(system, task, expert.role)
            expert.result = result
            expert.confidence = 0.7
            expert.budget_remaining = 0
            return result
        except Exception as e:
            expert.result = f"ERROR: {e}"
            expert.alive  = False
            return ""

    def kill_expert(self, expert_id: str):
        if expert_id in self._experts:
            self._experts[expert_id].alive = False

    def get_alive_experts(self) -> list[MicroExpert]:
        return [e for e in self._experts.values() if e.alive]

    def aggregate_results(self, experts: list[MicroExpert]) -> dict:
        alive    = [e for e in experts if e.result]
        if not alive:
            return {"merged": "", "confidence": 0.0, "n_experts": 0}
        by_role: dict[str, list[str]] = {}
        for e in alive:
            by_role.setdefault(e.role, []).append(e.result)
        sections = []
        for role, results in by_role.items():
            sections.append(f"=== {role.upper()} ===\n" + "\n".join(results[:2]))
        merged = "\n\n".join(sections)
        avg_conf = sum(e.confidence for e in alive) / len(alive)
        return {"merged": merged, "confidence": avg_conf, "n_experts": len(alive)}

    def get_expansion_stats(self) -> dict:
        all_exp = list(self._experts.values())
        return {
            "total_spawned": len(all_exp),
            "alive": len([e for e in all_exp if e.alive]),
            "completed": len([e for e in all_exp if e.result]),
            "by_role": {r: len([e for e in all_exp if e.role == r])
                        for r in ROLE_TEMPLATES},
        }

    def _decompose_goal(self, goal: str, n: int) -> list[str]:
        aspects = [
            f"Core implementation: {goal[:60]}",
            f"Edge cases and validation: {goal[:60]}",
            f"Performance and optimisation: {goal[:60]}",
            f"Error handling: {goal[:60]}",
            f"Testing strategy: {goal[:60]}",
            f"Documentation: {goal[:60]}",
        ]
        return aspects[:n]
