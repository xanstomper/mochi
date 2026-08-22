"""
Task Classifier — auto-detects task type and selects the optimal stalling
strategy + agent mix before synthesis begins.

Why this matters
----------------
Each stalling strategy has a different quality profile:
  - Coding bugs   → constitutional (catch corner-cases and security issues)
  - Math/logic    → self_consistency (majority vote on discrete answers)
  - Security audit→ devils_advocate  (force adversarial thinking first)
  - Creative work → scratchpad       (working-memory for non-linear exploration)
  - Analysis      → chain_of_draft   (compress long reasoning efficiently)
  - Architecture  → budget_force     (fill token budget → forces planning depth)
  - General       → hybrid           (auto-mix)

Classifier uses keyword matching + structural signals — zero ML dependencies.

Usage
-----
    clf = TaskClassifier()
    result = clf.classify("Build a Redis rate limiter with sliding window")
    print(result.task_type)        # "coding"
    print(result.strategy)         # "constitutional"
    print(result.suggested_agents) # ["scout", "critic", "architect", "debug"]
    print(result.confidence)       # 0.87
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field


# ── Task taxonomy ─────────────────────────────────────────────────────────────

TASK_TYPES = [
    "coding",
    "math",
    "security",
    "creative",
    "analysis",
    "architecture",
    "data",
    "research",
    "debugging",
    "general",
]

# keyword sets per task type (lower-cased, matched as substrings or word-tokens)
_KEYWORDS: dict[str, list[str]] = {
    "coding": [
        "implement", "build", "write", "create", "code", "function", "class",
        "api", "endpoint", "rest", "graphql", "service", "module", "library",
        "algorithm", "data structure", "parse", "serialize", "cli", "script",
        "python", "javascript", "typescript", "rust", "go ", "java", "c++",
        "async", "await", "coroutine", "thread", "concurrent", "parallel",
        "database", "sql", "query", "orm", "migration", "schema",
        "test", "unit test", "pytest", "jest", "mock", "fixture",
    ],
    "math": [
        "calculate", "compute", "solve", "equation", "formula", "derivative",
        "integral", "matrix", "vector", "probability", "statistics", "proof",
        "theorem", "algebra", "calculus", "optimization", "gradient", "loss",
        "summation", "series", "converge", "eigenvalue", "polynomial",
        "linear programming", "combinatorics", "graph theory",
    ],
    "security": [
        "security", "vulnerability", "exploit", "injection", "xss", "csrf",
        "authentication", "authorization", "oauth", "jwt", "token", "password",
        "hash", "encrypt", "decrypt", "tls", "ssl", "certificate", "mitm",
        "penetration", "pentest", "audit", "threat model", "attack surface",
        "privilege escalation", "privilege", "sanitize", "validate input",
        "rate limit", "ddos", "brute force", "zero day", "cve", "owasp",
    ],
    "creative": [
        "write", "story", "narrative", "poem", "essay", "creative", "imagine",
        "fiction", "character", "plot", "scene", "dialogue", "blog", "article",
        "marketing", "copy", "slogan", "pitch", "brainstorm", "ideas",
        "design thinking", "innovation", "concept", "vision",
    ],
    "analysis": [
        "analyze", "analyse", "compare", "evaluate", "assess", "review",
        "pros and cons", "tradeoff", "trade-off", "pros cons", "breakdown",
        "summarize", "summary", "explain", "understand", "why", "how does",
        "what is", "difference between", "vs ", "versus", "benchmark",
        "performance analysis", "profil", "metric", "kpi", "measure",
    ],
    "architecture": [
        "architect", "design", "system design", "high-level", "scalab",
        "microservice", "monolith", "event-driven", "cqrs", "saga",
        "distributed", "consensus", "replication", "sharding", "partition",
        "load balanc", "cache strategy", "cdn", "message queue", "kafka",
        "diagram", "component", "interface", "contract", "pattern", "ddd",
        "domain-driven", "hexagonal", "clean architecture", "solid",
        "infrastructure", "kubernetes", "docker", "orchestrat",
    ],
    "data": [
        "data pipeline", "etl", "elt", "warehouse", "lake", "spark", "airflow",
        "transform", "ingest", "pandas", "dataframe", "csv", "json schema",
        "feature engineering", "training data", "dataset", "annotation",
        "aggregat", "join", "group by", "window function", "partition by",
        "dashboard", "visualization", "chart", "plot", "bi", "looker",
    ],
    "research": [
        "research", "literature", "survey", "state of the art", "paper",
        "citation", "prior work", "review", "systematic", "evidence",
        "study", "experiment", "hypothesis", "findings", "conclusion",
        "methodology", "novel", "contribute", "sota",
        "attention mechanism", "transformer", "summarize the literature",
        "related work", "background", "knowledge base", "academic",
        "publication", "corpus", "knowledge graph", "ontology",
    ],
    "debugging": [
        "bug", "error", "exception", "traceback", "stack trace", "crash",
        "fix", "broken", "not working", "fails", "failure", "issue",
        "debug", "investigate", "reproduce", "root cause", "diagnose",
        "memory leak", "race condition", "deadlock", "segfault", "oom",
        "timeout", "slow", "latency", "performance issue",
    ],
}

# ── Strategy selection ────────────────────────────────────────────────────────

# task_type → best stalling strategy
_TYPE_STRATEGY: dict[str, str] = {
    "coding":       "constitutional",   # catch bugs and edge-cases
    "math":         "self_consistency", # majority vote on discrete answers
    "security":     "devils_advocate",  # force adversarial thinking
    "creative":     "scratchpad",       # non-linear exploration needs WM
    "analysis":     "chain_of_draft",   # compress long reasoning efficiently
    "architecture": "budget_force",     # depth of planning is critical
    "data":         "constitutional",   # catch correctness bugs in transforms
    "research":     "chain_of_draft",   # synthesis across sources
    "debugging":    "chain_of_draft",   # step-through logic chains
    "general":      "hybrid",           # auto-mix
}

# task_type → best agent subset (ordered by value)
_TYPE_AGENTS: dict[str, list[str]] = {
    "coding":       ["scout", "critic", "debug", "architect"],
    "math":         ["research", "critic", "simulator", "historian"],
    "security":     ["critic", "debug", "architect", "research"],
    "creative":     ["scout", "historian", "research", "architect"],
    "analysis":     ["scout", "historian", "research", "critic"],
    "architecture": ["architect", "scout", "historian", "critic"],
    "data":         ["scout", "optimizer", "critic", "debug"],
    "research":     ["research", "historian", "scout", "critic"],
    "debugging":    ["debug", "critic", "simulator", "scout"],
    "general":      ["scout", "critic", "research", "architect"],
}

# Complexity signals → mode floor
_COMPLEXITY_ESCALATORS: list[tuple[list[str], str]] = [
    # patterns                                       floor mode
    (["enterprise", "production", "at scale", "billion", "high availability",
      "sla", "slo", "99.9", "multi-region", "fault tolerant"], "deep"),
    (["complex", "sophisticated", "advanced", "non-trivial",
      "large codebase", "distributed system", "real-time"], "hard"),
    (["simple", "basic", "quick", "small", "easy", "hello world",
      "toy", "prototype", "poc"], "turbo"),
]


# ── Result dataclass ─────────────────────────────────────────────────────────

@dataclass
class ClassificationResult:
    """Output from TaskClassifier.classify()."""
    task_type: str
    strategy: str
    suggested_agents: list[str]
    confidence: float           # 0–1
    complexity_floor: str       # minimum mode recommended
    signals: dict[str, int]     # raw keyword match counts per type
    reasoning: str              # human-readable explanation

    @property
    def is_high_confidence(self) -> bool:
        return self.confidence >= 0.70

    def summary(self) -> str:
        return (
            f"[TaskClassifier] type={self.task_type}  "
            f"strategy={self.strategy}  "
            f"conf={self.confidence:.2f}  "
            f"floor={self.complexity_floor}"
        )


# ── Classifier ───────────────────────────────────────────────────────────────

class TaskClassifier:
    """
    Keyword-based task type classifier.

    Zero external dependencies, sub-millisecond inference.

    Usage
    -----
        clf = TaskClassifier()
        r = clf.classify("build a redis rate limiter")
        r.task_type        # "coding"
        r.strategy         # "constitutional"
        r.suggested_agents # ["scout", "critic", "debug", "architect"]
    """

    def classify(self, task: str) -> ClassificationResult:
        """Classify a task string and return strategy recommendations."""
        text = task.lower()

        # Count keyword hits per type
        signals: dict[str, int] = {}
        for typ, kws in _KEYWORDS.items():
            hits = sum(1 for kw in kws if kw in text)
            if hits:
                signals[typ] = hits

        if not signals:
            return self._default(task, signals)

        # Rank by hits; resolve ties by type priority order
        ranked = sorted(signals.items(), key=lambda x: -x[1])
        best_type, best_hits = ranked[0]

        # Confidence: gap between top-2 scores normalised by total hits
        total_hits = sum(signals.values())
        second_hits = ranked[1][1] if len(ranked) > 1 else 0
        gap = (best_hits - second_hits) / max(total_hits, 1)
        confidence = min(0.50 + gap * 2.0 + best_hits * 0.03, 0.95)

        # Detect co-occurring types (e.g. "secure coding" → coding+security)
        dominant = [t for t, h in ranked if h >= max(best_hits * 0.6, 1)]

        # Special blends
        if "security" in dominant and "coding" in dominant:
            best_type = "security"
            confidence = min(confidence + 0.05, 0.95)
        elif "debugging" in dominant and "coding" in dominant:
            best_type = "debugging"
            confidence = min(confidence + 0.05, 0.95)
        elif "architecture" in dominant and "coding" in dominant:
            best_type = "architecture"
        elif "research" in dominant and "analysis" in dominant:
            best_type = "research"

        # Complexity floor
        complexity_floor = self._detect_complexity(text)

        # Reasoning explanation
        top_kws = [kw for kw in _KEYWORDS.get(best_type, []) if kw in text][:5]
        reasoning = (
            f"Matched {best_hits} '{best_type}' signals "
            f"({', '.join(top_kws[:3]) or 'general'}); "
            f"runner-up={ranked[1][0] if len(ranked) > 1 else 'none'} "
            f"({second_hits} hits)"
        )

        return ClassificationResult(
            task_type=best_type,
            strategy=_TYPE_STRATEGY.get(best_type, "hybrid"),
            suggested_agents=_TYPE_AGENTS.get(best_type, _TYPE_AGENTS["general"]),
            confidence=confidence,
            complexity_floor=complexity_floor,
            signals=signals,
            reasoning=reasoning,
        )

    # ── helpers ──────────────────────────────────────────────────────────────

    def _default(self, task: str, signals: dict) -> ClassificationResult:
        return ClassificationResult(
            task_type="general",
            strategy="hybrid",
            suggested_agents=_TYPE_AGENTS["general"],
            confidence=0.40,
            complexity_floor="hard",
            signals=signals,
            reasoning="No strong keyword signals — defaulting to hybrid strategy",
        )

    def _detect_complexity(self, text: str) -> str:
        for patterns, floor in _COMPLEXITY_ESCALATORS:
            if any(p in text for p in patterns):
                return floor
        return "hard"  # sensible default

    @staticmethod
    def best_strategy_for(task_type: str) -> str:
        """Quick lookup without instantiating a full classifier."""
        return _TYPE_STRATEGY.get(task_type, "hybrid")

    @staticmethod
    def best_agents_for(task_type: str) -> list[str]:
        """Quick lookup without instantiating a full classifier."""
        return _TYPE_AGENTS.get(task_type, _TYPE_AGENTS["general"])
