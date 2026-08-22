"""SimulationEngine — Simulate possible futures before answering."""
from __future__ import annotations
import re
from dataclasses import dataclass, field
from typing import Optional

SCENARIO_TEMPLATES = {
    "optimistic": (
        "Best case: all assumptions hold, no blockers, ideal execution. "
        "What would the best possible outcome look like and why?"
    ),
    "pessimistic": (
        "Worst case: key assumptions fail, blockers appear, edge cases trigger. "
        "What could go wrong and how bad would it be?"
    ),
    "likely": (
        "Most probable case: some friction, typical constraints, partial success. "
        "What realistically happens and why?"
    ),
    "edge_case": (
        "Edge case: unusual inputs, boundary conditions, concurrent load, adversarial usage. "
        "What breaks and under what conditions?"
    ),
    "adversarial": (
        "Adversarial: a hostile user, an attacker, or a stress test. "
        "What can be exploited, misused, or broken on purpose?"
    ),
}

RISK_KEYWORDS = {
    "critical": ["crash", "data loss", "security breach", "corrupt", "attack", "exploit"],
    "high":     ["fail", "error", "timeout", "race condition", "deadlock", "overflow"],
    "medium":   ["slow", "inconsistent", "degraded", "partial", "retry"],
    "low":      ["minor", "cosmetic", "edge case", "rare", "unlikely"],
}


@dataclass
class SimulatedFuture:
    id: str
    scenario_type: str
    description: str
    outcome: str
    confidence: float
    risks: list[str] = field(default_factory=list)
    opportunities: list[str] = field(default_factory=list)
    recommended_actions: list[str] = field(default_factory=list)


@dataclass
class SimulationResult:
    futures: list[SimulatedFuture]
    recommended_future: str         # scenario_type of best choice
    consensus_action: str
    risk_level: str
    confidence: float


class SimulationEngine:
    def __init__(self, n_futures: int = 4):
        self.n_futures = min(n_futures, len(SCENARIO_TEMPLATES))

    def simulate(self, task: str, context: str = "",
                 proposed_action: str = "") -> SimulationResult:
        scenario_types = list(SCENARIO_TEMPLATES.keys())[:self.n_futures]
        futures = [self._generate_future(task, st, context, proposed_action)
                   for st in scenario_types]
        risk_level = self._assess_risk(futures)
        consensus  = self._find_consensus(futures)
        best       = max(futures, key=self._score_future)
        return SimulationResult(
            futures=futures,
            recommended_future=best.scenario_type,
            consensus_action=consensus,
            risk_level=risk_level,
            confidence=best.confidence,
        )

    def _generate_future(self, task: str, scenario_type: str, context: str,
                          action: str) -> SimulatedFuture:
        template = SCENARIO_TEMPLATES[scenario_type]
        task_low = task.lower()

        risks: list[str] = []
        opps:  list[str] = []
        actions: list[str] = []

        if scenario_type == "optimistic":
            opps    = [f"Task completed successfully: {task[:60]}",
                       "Users/stakeholders satisfied", "Efficient execution"]
            actions = ["Proceed with standard implementation",
                       "Document the success pattern for reuse"]
        elif scenario_type == "pessimistic":
            risks   = self._detect_risks(task)
            actions = ["Add error handling for each identified risk",
                       "Create fallback strategies", "Test edge cases explicitly"]
        elif scenario_type == "likely":
            risks   = self._detect_risks(task)[:2]
            opps    = ["Partial success with minor issues"]
            actions = ["Implement incrementally", "Monitor and adjust"]
        elif scenario_type == "edge_case":
            risks   = [f"Edge case: empty/null input to {task[:40]}",
                       f"Edge case: maximum load on {task[:40]}",
                       "Concurrent access conflicts"]
            actions = ["Add input validation", "Add rate limiting",
                       "Use locks or atomic operations where needed"]
        elif scenario_type == "adversarial":
            risks   = ["SQL injection via untrusted input", "Buffer overflow",
                       "Privilege escalation", "Denial of service"]
            actions = ["Validate and sanitise all input", "Use parameterised queries",
                       "Enforce rate limits", "Implement auth checks"]

        conf_map = {"optimistic": 0.6, "pessimistic": 0.55, "likely": 0.75,
                    "edge_case": 0.5, "adversarial": 0.45}
        return SimulatedFuture(
            id=scenario_type,
            scenario_type=scenario_type,
            description=f"{template} [Task: {task[:80]}]",
            outcome=f"{scenario_type.replace('_', ' ').title()} outcome for: {task[:80]}",
            confidence=conf_map.get(scenario_type, 0.6),
            risks=risks, opportunities=opps, recommended_actions=actions,
        )

    def _detect_risks(self, task: str) -> list[str]:
        task_low = task.lower()
        found = []
        risk_hints = [
            (["database", "sql", "query"], "Database failure or data inconsistency"),
            (["network", "api", "http", "request"], "Network timeout or API unavailability"),
            (["file", "disk", "storage"], "File system error or permission denied"),
            (["concurrent", "thread", "async", "parallel"], "Race condition or deadlock"),
            (["user", "input", "form", "upload"], "Invalid or malicious user input"),
            (["memory", "cache", "buffer"], "Memory overflow or cache invalidation"),
            (["auth", "login", "permission", "token"], "Authentication / authorisation failure"),
        ]
        for keywords, risk in risk_hints:
            if any(k in task_low for k in keywords):
                found.append(risk)
        return found[:4] if found else ["Unexpected edge case", "Integration failure"]

    def _score_future(self, f: SimulatedFuture) -> float:
        opp_score  = len(f.opportunities) * 0.1
        risk_score = -len(f.risks) * 0.05
        return f.confidence + opp_score + risk_score

    def _find_consensus(self, futures: list[SimulatedFuture]) -> str:
        action_counts: dict[str, int] = {}
        for f in futures:
            for a in f.recommended_actions:
                key = a[:50]
                action_counts[key] = action_counts.get(key, 0) + 1
        if not action_counts:
            return "Proceed carefully with validation and monitoring."
        return max(action_counts, key=action_counts.__getitem__)

    def _assess_risk(self, futures: list[SimulatedFuture]) -> str:
        all_risks = [r.lower() for f in futures for r in f.risks]
        for level, keywords in RISK_KEYWORDS.items():
            if any(any(k in r for k in keywords) for r in all_risks):
                return level
        return "low"

    def format_as_context(self, result: SimulationResult) -> str:
        lines = [f"=== SIMULATION ({len(result.futures)} futures) ===",
                 f"Risk Level: {result.risk_level.upper()}",
                 f"Consensus Action: {result.consensus_action}",
                 f"Recommended Approach: {result.recommended_future}"]
        for f in result.futures:
            lines.append(f"\n[{f.scenario_type.upper()}] conf={f.confidence:.0%}")
            if f.risks:
                lines.append(f"  Risks: {'; '.join(f.risks[:2])}")
            if f.opportunities:
                lines.append(f"  Opportunities: {'; '.join(f.opportunities[:2])}")
        return "\n".join(lines)
