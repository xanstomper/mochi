"""AgentOrchestrator — Controls the main agent and feeds it brewed data.

The main agent:
- Receives distilled/brewed data from all pots
- Reasons with it using its assigned experts
- Makes decisions based on the synthesized parameters
- Coordinates with other agents
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional
import time
import logging

logger = logging.getLogger(__name__)

@dataclass
class AgentTask:
    task_id: str
    instruction: str
    context: str
    required_domains: List[str]
    complexity: float
    brewed_data: List[Any] = field(default_factory=list)

class AgentOrchestrator:
    def __init__(self, brewer=None):
        self._brewer = brewer
        self._tasks_completed = 0
        self._brewed_consumed = 0
        self._decisions: List[Dict] = []

    def assign_task(self, task: AgentTask) -> Dict[str, Any]:
        t0 = time.time()
        if self._brewer:
            brewed = self._brewer.feed_agent(amount=50)
            task.brewed_data = brewed
            self._brewed_consumed += len(brewed)
        result = self._process(task)
        self._tasks_completed += 1
        elapsed = (time.time() - t0) * 1000
        self._decisions.append({"task_id": task.task_id, "latency_ms": round(elapsed, 2), "brewed_used": len(task.brewed_data)})
        return result

    def _process(self, task: AgentTask) -> Dict[str, Any]:
        synthesized = []
        for bd in task.brewed_data:
            synthesized.append({"domain": bd.domain, "teacher": bd.teacher, "insight": bd.response[:80]})
        return {
            "task_id": task.task_id,
            "instruction_summary": task.instruction[:60],
            "synthesized_parameters": synthesized[:5],
            "reasoning": "Synthesized from {} distillation pots across {} domains".format(
                len(set(b.pot_id for b in task.brewed_data)) if task.brewed_data else 0,
                len(set(b.domain for b in task.brewed_data)) if task.brewed_data else 0,
            ),
            "status": "completed",
        }

    def get_stats(self) -> Dict[str, Any]:
        return {"tasks_completed": self._tasks_completed, "brewed_data_consumed": self._brewed_consumed,
                "avg_latency_ms": round(sum(d["latency_ms"] for d in self._decisions) / max(len(self._decisions), 1), 2)}
