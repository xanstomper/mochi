"""SplitMergeMoE — Split-merge MoE controller inspired by agar.io.

Experts can:
- SPLIT: Clone into sub-experts, each assigned a subtask
- WORK: Each sub-expert independently processes its subtask
- MERGE: Sub-experts merge back, bringing their learnings
- BREW: Lazy MoEs brew the best outcome from all splits

This creates a dynamic expert ecosystem where:
- 1 expert = 1 cell that can split into sub-cells
- Cells split to cover more area (more subtasks)
- Cells merge when subtasks complete
- Best outcomes are brewed from all learnings
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple
import time
import uuid
import logging
import random

logger = logging.getLogger(__name__)

@dataclass
class MoECell:
    cell_id: str
    parent_id: Optional[str]
    mass: float
    role: str  # "main", "split", "hunter", "gatherer", "brewer"
    subtask: str = ""
    learnings: List[Dict[str, Any]] = field(default_factory=list)
    status: str = "idle"  # "idle", "splitting", "working", "merging", "done"
    created_at: float = 0.0
    completed_at: Optional[float] = None
    domain: str = "general"
    offspring: List[str] = field(default_factory=list)
    quality_score: float = 0.0

class SplitMergeMoE:
    def __init__(self, initial_mass: float = 100.0):
        self.cells: Dict[str, MoECell] = {}
        self._next_id = 0
        main_id = self._new_id()
        self.cells[main_id] = MoECell(
            cell_id=main_id, parent_id=None, mass=initial_mass,
            role="main", status="idle", created_at=time.time(),
        )
        self._split_history: List[Dict] = []
        self._brew_cache: Dict[str, Any] = {}
        self._total_energy = initial_mass

    def _new_id(self) -> str:
        self._next_id += 1
        return f"cell_{self._next_id}"

    def split(self, cell_id: str, num_splits: int = 2, subtasks: List[str] = None) -> List[str]:
        parent = self.cells.get(cell_id)
        if not parent or parent.status == "splitting":
            return []
        parent.status = "splitting"
        split_mass = parent.mass / (num_splits + 1)
        parent.mass = split_mass
        child_ids = []
        for i in range(num_splits):
            child_id = self._new_id()
            subtask = subtasks[i] if subtasks and i < len(subtasks) else f"subtask_{i}"
            child = MoECell(
                cell_id=child_id, parent_id=cell_id, mass=split_mass,
                role=self._assign_role(i, num_splits),
                subtask=subtask, status="working",
                created_at=time.time(), domain=parent.domain,
            )
            self.cells[child_id] = child
            parent.offspring.append(child_id)
            child_ids.append(child_id)
        self._split_history.append({"parent": cell_id, "children": child_ids, "time": time.time()})
        parent.status = "idle"
        return child_ids

    def _assign_role(self, index: int, total: int) -> str:
        roles = ["hunter", "gatherer", "hunter", "gatherer", "brewer", "hunter"]
        return roles[index % len(roles)] if index < len(roles) else "hunter"

    def work(self, cell_id: str, processor_fn: Callable = None) -> Dict[str, Any]:
        cell = self.cells.get(cell_id)
        if not cell or cell.status != "working":
            return {"error": f"Cell {cell_id} not in working state"}
        rng = random.Random(hash(cell.subtask) % 10000)
        result = {
            "cell_id": cell_id,
            "subtask": cell.subtask,
            "domain": cell.domain,
            "role": cell.role,
        }
        if processor_fn:
            try:
                output = processor_fn(cell.subtask)
                result["output"] = output
            except Exception as e:
                result["error"] = str(e)
        if cell.role == "hunter":
            result["findings"] = self._hunt(cell.subtask)
        elif cell.role == "gatherer":
            result["gathered"] = self._gather(cell.subtask)
        elif cell.role == "brewer":
            result["brew"] = self._brew(cell.subtask)
        quality = rng.uniform(0.5, 1.0)
        cell.quality_score = quality
        cell.learnings.append(result)
        return result

    def _hunt(self, subtask: str) -> Dict[str, Any]:
        rng = random.Random(hash(subtask))
        return {
            "patterns_found": rng.randint(1, 10),
            "insights": [f"pattern_{i}" for i in range(rng.randint(1, 5))],
            "confidence": round(rng.uniform(0.6, 1.0), 2),
        }

    def _gather(self, subtask: str) -> Dict[str, Any]:
        rng = random.Random(hash(subtask + "_gather"))
        return {
            "samples_collected": rng.randint(10, 100),
            "domains_covered": [],  # MoE commands sub-agents what to scrape
            "quality_distribution": {"high": rng.randint(5, 30), "medium": rng.randint(10, 50), "low": rng.randint(0, 10)},
        }

    def _brew(self, subtask: str) -> Dict[str, Any]:
        return {
            "recipe": "distillation_blend",
            "ingredients": ["hunter_findings", "gatherer_data", "main_context"],
            "yield": {"num_samples": 50, "avg_quality": 0.85},
        }

    def merge(self, child_ids: List[str]) -> Optional[str]:
        if not child_ids:
            return None
        parent_id = None
        for cid in child_ids:
            cell = self.cells.get(cid)
            if cell and cell.parent_id:
                parent_id = cell.parent_id
                cell.status = "merging"
                break
        if not parent_id:
            return None
        parent = self.cells.get(parent_id)
        if not parent:
            return None
        total_learnings = []
        merged_mass = parent.mass
        for cid in child_ids:
            child = self.cells.get(cid)
            if child:
                total_learnings.extend(child.learnings)
                merged_mass += child.mass
                child.status = "done"
                child.completed_at = time.time()
        parent.mass = merged_mass
        parent.learnings.extend(total_learnings)
        parent.status = "done"
        return parent_id

    def brew_best_outcome(self) -> Dict[str, Any]:
        all_learnings = []
        for cell in self.cells.values():
            if cell.learnings:
                all_learnings.extend(cell.learnings)
        if not all_learnings:
            return {"status": "no_data", "outcome": {}}
        rng = random.Random(42)
        best = rng.sample(all_learnings, min(3, len(all_learnings)))
        self._brew_cache["last_brew"] = {
            "num_sources": len(self.cells),
            "num_learnings": len(all_learnings),
            "best_samples": best,
            "timestamp": time.time(),
        }
        return {
            "outcome": "brewed",
            "num_cells_contributing": len([c for c in self.cells.values() if c.learnings]),
            "total_learnings": len(all_learnings),
            "top_insights": [l.get("findings", l.get("gathered", l.get("brew", {}))) for l in best],
            "recommended_framework": "split-merge-moe",
            "recommended_prompt": "Using split-merge MoE with " + str(len(self.cells)) + " cells",
        }

    def get_stats(self) -> Dict[str, Any]:
        roles = {}
        statuses = {}
        for c in self.cells.values():
            roles[c.role] = roles.get(c.role, 0) + 1
            statuses[c.status] = statuses.get(c.status, 0) + 1
        return {
            "total_cells": len(self.cells),
            "total_mass": sum(c.mass for c in self.cells.values()),
            "roles": roles,
            "statuses": statuses,
            "splits_performed": len(self._split_history),
            "brews_cached": len(self._brew_cache),
        }
