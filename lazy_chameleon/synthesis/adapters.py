"""Dynamic Adapter Manager.

Manages LoRA-style adapters that are hot-swapped based on task type.
Each adapter is a set of low-rank weight deltas that modify the base
model's behavior for specific task domains.

Adapters are synthesized on-the-fly by the Hypernetwork and cached
for reuse across similar tasks.
"""
import hashlib
import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Adapter:
    """A LoRA-style adapter for a specific task domain."""
    name: str
    domain: str  # code, reasoning, creative, analysis, general
    rank: int = 8
    alpha: float = 1.0
    layers: list[str] = field(default_factory=list)
    weights: dict[str, list] = field(default_factory=dict)
    confidence: float = 0.0
    hit_count: int = 0
    created_at: float = 0.0
    last_used: float = 0.0
    total_boost: float = 0.0  # accumulated quality boost

    def apply_as_prompt(self) -> str:
        """Convert adapter to prompt instruction."""
        lines = [
            f"=== DYNAMIC ADAPTER: {self.name} ({self.domain}) ===",
            f"Rank: {self.rank} | Alpha: {self.alpha:.2f} | "
            f"Confidence: {self.confidence:.2f} | Applied: {self.hit_count}x",
        ]

        domain_instructions = {
            "code": [
                "Write production-grade code with error handling",
                "Consider edge cases, concurrency, security",
                "Use precise type annotations",
                "Include tests and documentation",
                "Follow language idioms and best practices",
            ],
            "reasoning": [
                "Decompose problems into atomic verifiable steps",
                "State all assumptions explicitly",
                "Consider edge cases and failure modes",
                "Cross-validate through multiple reasoning paths",
                "Back every claim with evidence",
            ],
            "creative": [
                "Explore unexpected combinations and perspectives",
                "Balance novelty with coherence",
                "Use vivid, precise language",
                "Build layered meaning",
            ],
            "analysis": [
                "Quantify uncertainty in all claims",
                "Identify confounding variables",
                "Distinguish correlation from causation",
                "Present multiple interpretations",
            ],
            "general": [
                "Think systematically before generating",
                "Consider multiple approaches",
                "Anticipate follow-up questions",
            ],
        }

        instructions = domain_instructions.get(
            self.domain, domain_instructions["general"]
        )
        lines.append("Behavioral directives:")
        for inst in instructions:
            lines.append(f"  \u2022 {inst}")
        lines.append("=== END ADAPTER ===")
        return "\n".join(lines)


class DynamicAdapterManager:
    """Manages hot-swappable adapters for task-specific model adaptation.

    Adapter lifecycle:
    1. Task arrives → match to domain
    2. Check adapter cache for existing adapter
    3. If cached: apply immediately
    4. If not: synthesize new adapter via Hypernetwork
    5. Cache for future use
    6. Track quality metrics and confidence
    """

    DOMAIN_KEYWORDS = {
        "code": ["code", "function", "class", "implement", "debug", "refactor",
                  "api", "endpoint", "algorithm", "compile", "python", "rust",
                  "javascript", "typescript", "java", "go", "c++", "sql"],
        "reasoning": ["why", "explain", "analyze", "reason", "logic", "prove",
                       "compare", "evaluate", "deduce", "infer", "because", "reason"],
        "creative": ["write", "create", "design", "imagine", "story",
                      "poem", "art", "creative", "brainstorm", "narrative"],
        "analysis": ["analyze", "data", "metrics", "statistics", "trend",
                      "correlation", "pattern", "forecast", "measure"],
    }

    def __init__(self, max_adapters: int = 32):
        self.max_adapters = max_adapters
        self.adapters: dict[str, Adapter] = {}
        self.adapter_history: list[str] = []
        self.total_applications = 0

    def get_or_create(self, task: str, hypernet=None, intelligence: str = "") -> Adapter:
        """Get existing adapter or create new one for this task."""
        domain = self._classify_domain(task)
        adapter_key = f"{domain}_primary"

        if adapter_key in self.adapters:
            adapter = self.adapters[adapter_key]
            adapter.hit_count += 1
            adapter.last_used = time.time()
            self.total_applications += 1
            return adapter

        # Create new adapter
        adapter = self._create_adapter(domain, task, hypernet, intelligence)
        self._store_adapter(adapter_key, adapter)
        return adapter

    def apply_all(self, task: str) -> list[str]:
        """Get all applicable adapter instructions for a task."""
        domain = self._classify_domain(task)
        instructions = []

        # Domain-specific adapter
        key = f"{domain}_primary"
        if key in self.adapters:
            instructions.append(self.adapters[key].apply_as_prompt())

        # Always apply general adapter if available
        if domain != "general":
            gen_key = "general_primary"
            if gen_key in self.adapters:
                instructions.append(self.adapters[gen_key].apply_as_prompt())

        return instructions

    def promote(self, adapter_key: str, quality_score: float):
        """Promote an adapter based on quality feedback."""
        if adapter_key in self.adapters:
            adapter = self.adapters[adapter_key]
            adapter.confidence = min(adapter.confidence + 0.05, 0.99)
            adapter.total_boost += quality_score

    def demote(self, adapter_key: str):
        """Demote an adapter after poor performance."""
        if adapter_key in self.adapters:
            adapter = self.adapters[adapter_key]
            adapter.confidence = max(adapter.confidence - 0.1, 0.1)

    def _classify_domain(self, task: str) -> str:
        task_lower = task.lower()
        scores = {}
        for domain, keywords in self.DOMAIN_KEYWORDS.items():
            scores[domain] = sum(1 for kw in keywords if kw in task_lower)
        if max(scores.values()) == 0:
            return "general"
        return max(scores, key=scores.get)

    def _create_adapter(self, domain: str, task: str,
                        hypernet=None, intelligence: str = "") -> Adapter:
        rank = 8
        if hypernet:
            result = hypernet.synthesize(task, intelligence, domain)
            rank = result["adapter_config"].get("rank", rank)
            confidence = min(0.5 + len(intelligence) / 10000 * 0.3, 0.9)
        else:
            confidence = 0.5

        adapter = Adapter(
            name=f"{domain}_v1",
            domain=domain,
            rank=rank,
            alpha=1.0,
            confidence=confidence,
            created_at=time.time(),
        )
        return adapter

    def _store_adapter(self, key: str, adapter: Adapter):
        if len(self.adapters) >= self.max_adapters:
            oldest_key = min(self.adapters,
                           key=lambda k: self.adapters[k].last_used)
            del self.adapters[oldest_key]
        self.adapters[key] = adapter
        self.adapter_history.append(key)

    @property
    def adapter_count(self) -> int:
        """Number of adapters currently in memory."""
        return len(self.adapters)

    def list_adapters(self) -> list[str]:
        """Return sorted list of all adapter keys currently cached."""
        return sorted(self.adapters.keys())

    def clear_cache(self) -> int:
        """Evict all adapters and reset history.  Returns count removed."""
        count = len(self.adapters)
        self.adapters.clear()
        self.adapter_history.clear()
        return count

    def get_adapter_key(self, task: str) -> str:
        """Return the cache key that *would* be generated for *task*."""
        domain = self._classify_domain(task)
        task_sig = task.strip().lower()[:40]
        return f"{domain}:{task_sig}"

    def export_stats(self) -> dict:
        """Export full per-adapter statistics (for offline analysis)."""
        return {
            key: {
                "domain": a.domain,
                "confidence": round(a.confidence, 4),
                "style": a.style,
                "last_used": a.last_used,
            }
            for key, a in self.adapters.items()
        }

    def get_stats(self) -> dict:
        return {
            "total_adapters": len(self.adapters),
            "total_applications": self.total_applications,
            "domains": {a.domain for a in self.adapters.values()},
            "avg_confidence": (
                sum(a.confidence for a in self.adapters.values()) /
                max(len(self.adapters), 1)
            ),
        }
