"""FailurePredictor — Before solving, predict if we can succeed."""
from __future__ import annotations
import re
from dataclasses import dataclass, field

IMPOSSIBLE_PATTERNS = [
    (r"\b(real.?time|live|current|today|now|latest)\b.*\b(price|weather|score|news|stock)\b",
     "requires real-time data"),
    (r"\b(click|press|open app|navigate to|log.?in to)\b",
     "requires physical/GUI action"),
    (r"\b(call|phone|email|contact)\b.*\b(person|company|support)\b",
     "requires external human interaction"),
    (r"\bpredict\b.*\b(future|tomorrow|next week|next month)\b",
     "requires prediction of unknown future"),
]

TOOL_HINTS = {
    "web_search": [r"\b(search|find|look up|latest|current|news)\b"],
    "code_execution": [r"\b(run|execute|test|compute|calculate|simulate)\b.*\b(code|script|program)\b"],
    "file_access": [r"\b(read|open|load|write|save|file|document)\b"],
    "calculator": [r"\b(\d+[\+\-\*/]\d+|calculate|compute|sum|multiply|divide)\b"],
}

@dataclass
class FailurePrediction:
    can_solve: bool
    confidence: float          # 0-1, confidence we CAN solve
    reason: str
    required_tools: list[str] = field(default_factory=list)
    required_expertise: list[str] = field(default_factory=list)
    estimated_difficulty: str = "medium"
    suggested_strategy: str = ""


class FailurePredictor:
    def __init__(self):
        self._history: list[dict] = []

    def predict(self, task: str, context: str = "",
                available_tools: list[str] | None = None,
                available_agents: list[str] | None = None) -> FailurePrediction:
        available_tools = available_tools or []
        available_agents = available_agents or []
        task_lower = task.lower()

        # Check impossibility
        impossibility = self._classify_impossibility(task)
        if impossibility:
            return FailurePrediction(
                can_solve=False, confidence=0.1,
                reason=impossibility,
                suggested_strategy="request_tools_or_clarification",
            )

        # Detect required tools
        req_tools = self._detect_required_tools(task)
        missing = [t for t in req_tools if t not in available_tools]

        # Estimate knowledge gap
        gap = self._estimate_knowledge_gap(task, available_agents)

        # Estimate difficulty
        difficulty = self._estimate_difficulty(task)

        can_solve = len(missing) == 0 and gap < 0.6
        confidence = max(0.1, 1.0 - gap - len(missing) * 0.15)

        reason = "Solvable with available resources."
        if missing:
            reason = f"Missing tools: {', '.join(missing)}."
        elif gap > 0.4:
            reason = f"High knowledge gap ({gap:.0%}) for available agents."

        pred = FailurePrediction(
            can_solve=can_solve, confidence=confidence,
            reason=reason, required_tools=req_tools,
            estimated_difficulty=difficulty,
        )
        pred.suggested_strategy = self._suggest_strategy(pred)
        return pred

    def _detect_required_tools(self, task: str) -> list[str]:
        found = []
        for tool, patterns in TOOL_HINTS.items():
            if any(re.search(p, task, re.I) for p in patterns):
                found.append(tool)
        return found

    def _estimate_knowledge_gap(self, task: str, agents: list[str]) -> float:
        specialized = ["math", "code", "security", "medical", "legal", "finance"]
        task_lower = task.lower()
        needed = [d for d in specialized if d in task_lower]
        if not needed:
            return 0.1
        available_lower = " ".join(agents).lower()
        covered = sum(1 for d in needed if d in available_lower)
        return max(0.0, (len(needed) - covered) / len(needed)) * 0.5

    def _estimate_difficulty(self, task: str) -> str:
        task_lower = task.lower()
        if any(k in task_lower for k in ("hello", "what is", "define", "simple", "easy")):
            return "easy"
        if any(k in task_lower for k in ("implement", "design", "optimize", "analyze", "research")):
            return "hard"
        if any(k in task_lower for k in ("prove", "derive", "formal", "theorem", "comprehensive")):
            return "extreme"
        return "medium"

    def _classify_impossibility(self, task: str) -> str | None:
        for pattern, reason in IMPOSSIBLE_PATTERNS:
            if re.search(pattern, task, re.I):
                return reason
        return None

    def _suggest_strategy(self, pred: FailurePrediction) -> str:
        if not pred.can_solve:
            return "escalate_with_tools"
        if pred.estimated_difficulty == "easy":
            return "direct_answer"
        if pred.estimated_difficulty == "hard":
            return "mcts_with_debate"
        if pred.estimated_difficulty == "extreme":
            return "full_pipeline_with_evolution"
        return "standard_pipeline"
