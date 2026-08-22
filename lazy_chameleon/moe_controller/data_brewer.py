"""DataBrewer — Orchestrates multiple distillation pots to brew training data.

Coordinates:
- Multiple pots running in parallel
- Domain-specific brewing recipes
- Quality filtering and deduplication
- Batch delivery to the main agent
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional
import time
import logging

logger = logging.getLogger(__name__)

@dataclass
class BrewingConfig:
    num_pots: int = 8
    domains: List[str] = field(default_factory=list)  # MoEs point sub-agents to domains
    teachers: List[str] = field(default_factory=lambda: ["gpt-5.5", "claude-opus-4.8", "deepseek-r1", "grok-4.4"])
    samples_per_batch: int = 500
    quality_threshold: float = 0.7
    deduplicate: bool = True
    auto_feed_agent: bool = True

class DataBrewer:
    def __init__(self, config: Optional[BrewingConfig] = None):
        self.config = config or BrewingConfig()
        self._pots: Dict[int, DistillationPot] = {}
        self._init_pots()
        self._total_brewed = 0
        self._brewing_history: List[Dict] = []

    def _init_pots(self):
        from lazy_chameleon.moe_controller.distillation_pot import DistillationPot, PotConfig
        for i in range(self.config.num_pots):
            domain = self.config.domains[i % len(self.config.domains)]
            teacher = self.config.teachers[i % len(self.config.teachers)]
            pot = DistillationPot(PotConfig(
                pot_id=i, name=f"pot_{i}_{domain}",
                teacher_model=teacher, domain=domain,
                quality_threshold=self.config.quality_threshold,
            ))
            self._pots[i] = pot

    def brew_all(self, raw_data: Dict[str, List[Dict[str, Any]]], teacher_fn: Callable = None) -> List[Any]:
        all_brewed = []
        for pot_id, pot in self._pots.items():
            domain_data = raw_data.get(pot.config.domain, [])
            if domain_data:
                brewed = pot.brew(domain_data, teacher_fn)
                all_brewed.extend(brewed)
        if self.config.deduplicate:
            all_brewed = self._deduplicate(all_brewed)
        self._total_brewed += len(all_brewed)
        self._brewing_history.append({"timestamp": time.time(), "count": len(all_brewed), "total": self._total_brewed})
        return all_brewed

    def _deduplicate(self, items: List[Any]) -> List[Any]:
        seen = set()
        result = []
        for item in items:
            key = item.instruction[:100].lower() + item.response[:100].lower()
            if key not in seen:
                seen.add(key)
                result.append(item)
        return result

    def feed_agent(self, amount: int = None) -> List[Any]:
        all_data = []
        for pot in self._pots.values():
            batch = pot.pour(amount or pot.config.yield_per_batch)
            all_data.extend(batch)
        return all_data

    def get_pot(self, pot_id: int) -> Optional[Any]:
        return self._pots.get(pot_id)

    def get_stats(self) -> Dict[str, Any]:
        pot_stats = {}
        for pid, pot in self._pots.items():
            pot_stats[pid] = pot.get_stats()
        return {"total_brewed": self._total_brewed, "num_pots": len(self._pots),
                "pots": pot_stats, "batches_brewed": len(self._brewing_history)}
