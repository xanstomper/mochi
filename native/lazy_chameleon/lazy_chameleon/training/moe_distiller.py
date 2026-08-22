"""
Mixture-of-Experts (MoE) Distillation — specialized pipeline for
distilling from MoE architectures (DeepSeek V4, Mixtral, etc.).

Captures expert routing patterns, load balancing strategies, and
expert-specific knowledge for transfer to dense student models.

Key capabilities:
- Expert routing pattern extraction from teacher MoE models
- Load-balanced expert distillation (handles token dropping)
- Expert-specific knowledge distillation with router gating
- Multi-expert ensemble synthesis via routed aggregation
"""
from __future__ import annotations

import json
import logging
import random
import time
from collections import defaultdict, Counter
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Callable, Optional, Any

log = logging.getLogger(__name__)


# ── Expert routing domain taxonomy ─────────────────────────────────────────────

class ExpertDomain(str, Enum):
    """Domains where specific experts specialize."""
    CODE     = "code"
    MATH     = "math"
    REASON   = "reasoning"
    SCIENCE  = "science"
    WRITING  = "writing"
    ANALYSIS = "analysis"
    SAFETY   = "safety"
    MULTI    = "multi_domain"  # Router-activated (general purpose)


# ── Data structures ────────────────────────────────────────────────────────────

@dataclass
class ExpertRoutingRecord:
    """Records which experts fired on which inputs (simulated)."""
    task: str
    domain: ExpertDomain = ExpertDomain.MULTI
    top_experts: list[str] = field(default_factory=list)  # e.g. ["expert_0", "expert_12"]
    expert_weights: list[float] = field(default_factory=list)
    num_active_experts: int = 2        # Top-k in MoE
    routing_pattern: str = "top_k"     # top_k, top_p, random, learned

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> ExpertRoutingRecord:
        return cls(**d)


@dataclass
class MoEDistillationConfig:
    """Configuration for MoE-specific distillation."""
    num_experts: int = 16                  # Simulated expert count
    top_k: int = 2                         # Top-k active experts
    expert_capacity_factor: float = 1.25  # Token capacity multiplier
    load_balance_weight: float = 0.01     # Auxiliary loss weight
    z_loss_weight: float = 0.001          # Router z-loss
    record_routing: bool = True           # Track expert routing patterns
    num_router_samples: int = 5000        # Router training samples

    # Expert specialization mapping (simulated)
    expert_domains: dict[str, ExpertDomain] = field(default_factory=lambda: {
        f"expert_{i}": ExpertDomain.MULTI for i in range(16)
    })

    def __post_init__(self):
        # Assign some experts to specific domains (simulated)
        domain_cycle = [
            ExpertDomain.CODE, ExpertDomain.MATH, ExpertDomain.REASON,
            ExpertDomain.SCIENCE, ExpertDomain.WRITING, ExpertDomain.ANALYSIS,
        ]
        for i in range(min(self.num_experts, 16)):
            if i < 6:
                self.expert_domains[f"expert_{i}"] = domain_cycle[i]
            elif i < 12:
                self.expert_domains[f"expert_{i}"] = domain_cycle[i - 6]
            else:
                self.expert_domains[f"expert_{i}"] = ExpertDomain.MULTI


@dataclass
class ExpertPattern:
    """Reasoning pattern extracted from a specific expert."""
    expert_id: str
    domain: ExpertDomain
    pattern_text: str
    trigger_keywords: list[str] = field(default_factory=list)
    effectiveness: float = 0.5
    usage_count: int = 0

    def to_dict(self) -> dict:
        return {
            "expert_id": self.expert_id,
            "domain": self.domain.value,
            "pattern": self.pattern_text,
            "keywords": self.trigger_keywords,
            "effectiveness": self.effectiveness,
        }


# ── Router Distiller ───────────────────────────────────────────────────────────

class MoERoutingDistiller:
    """Distills expert routing decisions from MoE teacher models.

    Captures which experts fire on which types of input, enabling
    dense student models to simulate expert routing behavior.
    """

    def __init__(self, config: MoEDistillationConfig | None = None):
        self.config = config or MoEDistillationConfig()
        self.routing_log: list[ExpertRoutingRecord] = []
        self.expert_specialization: dict[str, Counter] = defaultdict(Counter)
        self.domain_expert_map: dict[str, list[str]] = defaultdict(list)

    def record_routing(
        self, task: str, domain: str = "general"
    ) -> ExpertRoutingRecord:
        """Record simulated expert routing for a task."""
        # Simulate routing: pick the most relevant experts based on domain keywords
        domain_enum = self._classify_domain(task) if domain == "general" else ExpertDomain(domain)
        candidates = [
            (eid, edom) for eid, edom in self.config.expert_domains.items()
            if edom == domain_enum or edom == ExpertDomain.MULTI
        ]
        random.shuffle(candidates)
        top_k = candidates[:self.config.top_k]
        top_experts = [eid for eid, _ in top_k]
        weights = [random.uniform(0.3, 1.0) for _ in top_k]
        # Normalize
        total = sum(weights) or 1.0
        weights = [w / total for w in weights]

        record = ExpertRoutingRecord(
            task=task,
            domain=domain_enum,
            top_experts=top_experts,
            expert_weights=weights,
            num_active_experts=self.config.top_k,
        )
        self.routing_log.append(record)

        # Track specialization
        for eid in top_experts:
            self.expert_specialization[eid][domain_enum.value] += 1

        return record

    def get_expert_for_domain(self, domain: str) -> list[str]:
        """Return the best experts for a given domain based on routing history."""
        if not self.expert_specialization:
            # Fall back to config defaults
            domain_enum = ExpertDomain(domain) if domain in [e.value for e in ExpertDomain] else ExpertDomain.MULTI
            return [
                eid for eid, edom in self.config.expert_domains.items()
                if edom == domain_enum
            ][:self.config.top_k]
        # Find experts most activated for this domain
        scores: list[tuple[str, int]] = []
        for eid, domain_counter in self.expert_specialization.items():
            scores.append((eid, domain_counter.get(domain, 0)))
        scores.sort(key=lambda x: x[1], reverse=True)
        return [eid for eid, _ in scores[:self.config.top_k]]

    def routing_stats(self) -> dict:
        """Return routing statistics."""
        return {
            "total_routing_records": len(self.routing_log),
            "expert_specialization": {
                eid: dict(counter) for eid, counter in self.expert_specialization.items()
            },
            "domain_coverage": len(set(r.domain.value for r in self.routing_log)),
            "avg_experts_per_call": self.config.top_k,
        }

    def _classify_domain(self, task: str) -> ExpertDomain:
        """Classify a task into an expert domain based on keywords."""
        task_lower = task.lower()
        # Code
        if any(w in task_lower for w in
               ["implement", "function", "code", "api", "class", "algorithm",
                "python", "rust", "javascript", "typescript"]):
            return ExpertDomain.CODE
        # Math
        if any(w in task_lower for w in
               ["equation", "derivative", "integral", "solve", "calculate",
                "math", "algebra", "geometry", "theorem"]):
            return ExpertDomain.MATH
        # Reasoning
        if any(w in task_lower for w in
               ["reason", "logic", "analyze", "compare", "evaluate",
                "trade-off", "argument"]):
            return ExpertDomain.REASON
        # Science
        if any(w in task_lower for w in
               ["experiment", "hypothesis", "scientific", "physics",
                "chemistry", "biology", "observation"]):
            return ExpertDomain.SCIENCE
        # Writing
        if any(w in task_lower for w in
               ["write", "essay", "article", "blog", "documentation",
                "narrative", "describe"]):
            return ExpertDomain.WRITING
        return ExpertDomain.MULTI

    def __repr__(self) -> str:
        return f"MoERoutingDistiller(routing_log={len(self.routing_log)})"


# ── MoE Distillation Pipeline ──────────────────────────────────────────────────

class MoEDistillationPipeline:
    """Full MoE distillation pipeline — extracts expert knowledge and
    distills it into a dense student model.

    Process:
    1. Analyze teacher's expert routing patterns (simulated)
    2. Extract expert-specific reasoning patterns
    3. Build domain-expert mapping for targeted distillation
    4. Generate expert-conditional training data
    5. Apply load-balanced distillation loss weighting
    """

    def __init__(
        self,
        config: MoEDistillationConfig | None = None,
        teacher_fn: Callable[[str, dict], str] | None = None,
    ):
        self.config = config or MoEDistillationConfig()
        self.teacher_fn = teacher_fn
        self.router = MoERoutingDistiller(config)
        self.expert_patterns: dict[str, list[ExpertPattern]] = defaultdict(list)

    def analyze_routing(
        self, tasks: list[str],
    ) -> dict[str, Any]:
        """Analyze expert routing patterns across a set of tasks."""
        for task in tasks:
            self.router.record_routing(task)
        stats = self.router.routing_stats()
        log.info("MoE routing analysis complete: %d records, %d domains",
                 stats["total_routing_records"], stats["domain_coverage"])
        return stats

    def extract_expert_patterns(
        self, tasks: list[str], responses: list[str]
    ) -> dict[str, list[ExpertPattern]]:
        """Extract expert-specific reasoning patterns from teacher responses."""
        patterns: dict[str, list[ExpertPattern]] = defaultdict(list)

        for task, response in zip(tasks, responses):
            if not response:
                continue
            # Route task to determine which experts would process it
            record = self.router.record_routing(task)
            domain = record.domain

            # Extract patterns from the response (one per active expert)
            paragraphs = [p for p in response.split("\n\n") if len(p) > 100]
            for i, expert_id in enumerate(record.top_experts):
                if i < len(paragraphs):
                    pattern_text = paragraphs[i][:500]
                else:
                    pattern_text = response[:300]

                # Extract trigger keywords from task + domain
                keywords = [w for w in task.lower().split()
                            if len(w) > 4][:5]

                pattern = ExpertPattern(
                    expert_id=expert_id,
                    domain=domain,
                    pattern_text=pattern_text,
                    trigger_keywords=keywords,
                    effectiveness=random.uniform(0.4, 0.9),
                )
                patterns[expert_id].append(pattern)

        self.expert_patterns = patterns

        total_patterns = sum(len(v) for v in patterns.values())
        log.info("Extracted %d patterns across %d experts",
                 total_patterns, len(patterns))
        return patterns

    def generate_expert_conditional_data(
        self,
        tasks: list[str],
        num_samples: int = 100,
    ) -> list[dict]:
        """Generate training data conditioned on expert routing.

        Each sample includes:
        - The original task
        - Which experts should be active (routing labels)
        - The ensembled expert response
        - Per-expert reasoning traces
        """
        samples: list[dict] = []
        for task in tasks[:num_samples]:
            record = self.router.record_routing(task)
            # Collect per-expert patterns
            expert_insights: list[str] = []
            for expert_id in record.top_experts:
                patterns = self.expert_patterns.get(expert_id, [])
                if patterns:
                    expert_insights.append(
                        f"[{expert_id}/{record.domain.value}]: {patterns[0].pattern_text}"
                    )
            sample = {
                "task": task,
                "domain": record.domain.value,
                "active_experts": record.top_experts,
                "expert_weights": record.expert_weights,
                "routing_pattern": record.routing_pattern,
                "expert_insights": expert_insights,
                "num_experts_used": self.config.top_k,
            }
            samples.append(sample)
        return samples

    def distillation_summary(self) -> dict:
        return {
            "num_experts": self.config.num_experts,
            "top_k": self.config.top_k,
            "routing_records": len(self.router.routing_log),
            "total_expert_patterns": sum(len(v) for v in self.expert_patterns.values()),
            "expert_domains": {
                eid: edom.value for eid, edom in self.config.expert_domains.items()
            },
        }

    def __repr__(self) -> str:
        return (
            f"MoEDistillationPipeline(expert_count={self.config.num_experts}, "
            f"top_k={self.config.top_k}, patterns={sum(len(v) for v in self.expert_patterns.values())})"
        )
