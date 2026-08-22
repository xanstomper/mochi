"""ExpertSplitter — Splits MoE experts into roles.

Splitting strategies:
- 1:main_agent, N-1:synthesizers
- Priorities: main agent gets highest compute, synthesizers share remainder
- Dynamic reallocation based on task complexity
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
from enum import Enum

class ExpertRole(Enum):
    MAIN_AGENT = "main_agent"
    DATA_SYNTHESIZER = "data_synthesizer"
    DISTILLATION_POT = "distillation_pot"
    VALIDATOR = "validator"
    ROUTER = "router"
    MEMORY = "memory"
    IDLE = "idle"

@dataclass
class ExpertAssignment:
    expert_id: int
    role: ExpertRole
    compute_budget: float
    active: bool = True
    specialization: str = "general"

@dataclass
class SplitConfig:
    num_experts: int = 64
    main_agent_experts: int = 1
    synthesizer_experts: int = 48
    distillation_pots: int = 8
    validators: int = 3
    routers: int = 2
    memory_experts: int = 2
    min_synthesizers: int = 8
    dynamic_rebalancing: bool = True
    rebalance_interval: int = 100

class ExpertSplitter:
    def __init__(self, config: Optional[SplitConfig] = None):
        self.config = config or SplitConfig()
        self._assignments: Dict[int, ExpertAssignment] = {}
        self._validate_counts()
        self._split()

    def _validate_counts(self):
        total = (self.config.main_agent_experts + self.config.synthesizer_experts +
                 self.config.distillation_pots + self.config.validators +
                 self.config.routers + self.config.memory_experts)
        if total > self.config.num_experts:
            excess = total - self.config.num_experts
            self.config.synthesizer_experts = max(self.config.min_synthesizers,
                                                   self.config.synthesizer_experts - excess)

    def _split(self):
        eid = 0
        for i in range(self.config.main_agent_experts):
            self._assignments[eid] = ExpertAssignment(eid, ExpertRole.MAIN_AGENT, compute_budget=0.3, specialization="reasoning")
            eid += 1
        for i in range(self.config.synthesizer_experts):
            specializations = ["math", "code", "science", "reasoning", "creative", "analysis", "search", "planning"]
            spec = specializations[i % len(specializations)]
            self._assignments[eid] = ExpertAssignment(eid, ExpertRole.DATA_SYNTHESIZER, compute_budget=0.4 / self.config.synthesizer_experts, specialization=spec)
            eid += 1
        for i in range(self.config.distillation_pots):
            self._assignments[eid] = ExpertAssignment(eid, ExpertRole.DISTILLATION_POT, compute_budget=0.1, specialization=f"pot_{i}")
            eid += 1
        for i in range(self.config.validators):
            self._assignments[eid] = ExpertAssignment(eid, ExpertRole.VALIDATOR, compute_budget=0.05, specialization=f"validator_{i}")
            eid += 1
        for i in range(self.config.routers):
            self._assignments[eid] = ExpertAssignment(eid, ExpertRole.ROUTER, compute_budget=0.05)
            eid += 1
        for i in range(self.config.memory_experts):
            self._assignments[eid] = ExpertAssignment(eid, ExpertRole.MEMORY, compute_budget=0.05)
            eid += 1
        while eid < self.config.num_experts:
            self._assignments[eid] = ExpertAssignment(eid, ExpertRole.IDLE, compute_budget=0.0)
            eid += 1

    def get_by_role(self, role: ExpertRole) -> List[ExpertAssignment]:
        return [a for a in self._assignments.values() if a.role == role]

    def get_main_agent(self) -> Optional[ExpertAssignment]:
        agents = self.get_by_role(ExpertRole.MAIN_AGENT)
        return agents[0] if agents else None

    def get_synthesizers(self) -> List[ExpertAssignment]:
        return self.get_by_role(ExpertRole.DATA_SYNTHESIZER)

    def get_pots(self) -> List[ExpertAssignment]:
        return self.get_by_role(ExpertRole.DISTILLATION_POT)

    def reassign(self, expert_id: int, new_role: ExpertRole):
        if expert_id in self._assignments:
            self._assignments[expert_id].role = new_role

    def rebalance(self, task_complexity: float = 0.5):
        if not self.config.dynamic_rebalancing:
            return
        if task_complexity > 0.7:
            idle = self.get_by_role(ExpertRole.IDLE)
            if idle:
                self.reassign(idle[0].expert_id, ExpertRole.DATA_SYNTHESIZER)
        elif task_complexity < 0.3:
            synths = self.get_synthesizers()
            if len(synths) > self.config.min_synthesizers:
                self.reassign(synths[-1].expert_id, ExpertRole.IDLE)

    def get_summary(self) -> Dict[str, Any]:
        counts = {}
        for a in self._assignments.values():
            role_name = a.role.value
            counts[role_name] = counts.get(role_name, 0) + 1
        return {"total_experts": len(self._assignments), "role_counts": counts,
                "active": sum(1 for a in self._assignments.values() if a.active)}
