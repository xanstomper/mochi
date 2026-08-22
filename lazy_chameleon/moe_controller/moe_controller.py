"""MoEController — Master controller for the entire MoE system.

Manages:
- Expert splitting and role assignment
- Distillation pot orchestration
- Data brewing pipeline
- Main agent reasoning
- Dynamic rebalancing
"""
from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional
import logging

logger = logging.getLogger(__name__)

class MoEController:
    def __init__(self, num_experts: int = 64):
        from .expert_splitter import ExpertSplitter, SplitConfig
        from .data_brewer import DataBrewer, BrewingConfig
        from .agent_orchestrator import AgentOrchestrator
        self.splitter = ExpertSplitter(SplitConfig(num_experts=num_experts))
        self.brewer = DataBrewer()
        self.orchestrator = AgentOrchestrator(brewer=self.brewer)
        self._running = False

    def start(self):
        self._running = True
        logger.info(f"MoE Controller started with {self.splitter.config.num_experts} experts")
        summary = self.splitter.get_summary()
        logger.info(f"  Roles: {summary['role_counts']}")
        return summary

    def stop(self):
        self._running = False

    def brew_and_feed(self, raw_data: Dict[str, List[Dict[str, Any]]], teacher_fn: Callable = None):
        brewed = self.brewer.brew_all(raw_data, teacher_fn)
        logger.info(f"Brewed {len(brewed)} samples across {len(self.brewer._pots)} pots")
        return brewed

    def assign_and_process(self, task_description: str, domains: List[str] = None):
        from .agent_orchestrator import AgentTask
        import uuid
        task = AgentTask(
            task_id=str(uuid.uuid4())[:8],
            instruction=task_description,
            context="",
            required_domains=domains or ["general"],
            complexity=0.5,
        )
        result = self.orchestrator.assign_task(task)
        self.splitter.rebalance(task.complexity)
        return result

    def rebalance(self, complexity: float = 0.5):
        self.splitter.rebalance(complexity)

    def get_full_report(self) -> Dict[str, Any]:
        return {
            "controller": {"running": self._running, "total_experts": len(self.splitter._assignments)},
            "expert_split": self.splitter.get_summary(),
            "brewing": self.brewer.get_stats(),
            "agent": self.orchestrator.get_stats(),
        }
