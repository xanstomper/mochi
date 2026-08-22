"""DynamicPromptCompiler — Compile the optimal prompt for every request."""
from __future__ import annotations
from dataclasses import dataclass, field

REASONING_SCAFFOLDS = {
    "chain_of_thought":  "Think step by step. Show your reasoning before the answer.",
    "tree_of_thought":   "Consider multiple approaches. Explore at least 3 paths before choosing the best.",
    "step_back":         "First, step back and think about the general principle. Then apply it to this specific case.",
    "least_to_most":     "Break into the simplest sub-problem first. Solve that, then build up to the full problem.",
    "self_consistency":  "Solve this problem 3 different ways independently, then take the majority answer.",
    "constitutional":    "Answer, then critique your answer against correctness/completeness/safety, then revise.",
    "debate":            "Argue FOR the answer, then argue AGAINST it, then synthesise the strongest position.",
    "scratchpad":        "Use a scratchpad: jot notes, work through ideas, THEN give the final answer.",
}

ROLE_PROMPTS = {
    "coding":       "You are an expert software engineer with 15 years of experience across distributed systems, ML infrastructure, and web services.",
    "math":         "You are a mathematician with expertise in formal proofs, applied mathematics, and algorithmic thinking.",
    "research":     "You are a research analyst skilled at synthesising information, identifying key insights, and citing sources.",
    "debug":        "You are a debugging specialist who methodically isolates root causes using binary search, logging, and hypothesis testing.",
    "architecture": "You are a principal architect with expertise in system design, scalability, and long-term maintainability.",
    "security":     "You are a security researcher skilled at identifying vulnerabilities, threat modelling, and secure coding practices.",
    "general":      "You are a world-class expert who thinks carefully, considers edge cases, and gives precise, well-reasoned answers.",
    "writing":      "You are a skilled technical writer who makes complex topics clear, structured, and actionable.",
}

OUTPUT_FORMATS = {
    "coding":       "Respond with: (1) Brief explanation, (2) Complete working code, (3) Example usage, (4) Edge cases to watch for.",
    "math":         "Respond with: (1) Problem setup, (2) Step-by-step solution, (3) Final answer clearly marked, (4) Verification.",
    "research":     "Respond with: (1) Summary, (2) Key findings, (3) Supporting details, (4) Caveats and limitations.",
    "debug":        "Respond with: (1) Root cause, (2) Why it happens, (3) Fix with code, (4) How to prevent recurrence.",
    "architecture": "Respond with: (1) Architecture overview, (2) Key components, (3) Trade-offs, (4) Implementation notes.",
    "general":      "Respond with a clear, structured answer. Use headers if the response is long.",
}

FAILURE_GUARDS = {
    "coding":    "Do NOT write pseudocode. Do NOT leave placeholders. Only complete, runnable code.",
    "math":      "Do NOT skip steps. Show all work. Double-check arithmetic.",
    "research":  "Do NOT make up facts. If uncertain, say so explicitly.",
    "security":  "Do NOT suggest security through obscurity. Always recommend defence in depth.",
    "general":   "Do NOT hallucinate. If you don't know something, say so clearly.",
}

CONFIDENCE_CALIBRATION = (
    "Calibrate your confidence: "
    "Only claim certainty when you are certain. "
    "Use 'likely', 'probably', 'I believe' for things you're not 100% sure about. "
    "Say 'I don't know' rather than guessing."
)


@dataclass
class PromptComponent:
    name: str
    content: str
    priority: float   # 0-1, higher = more important to include
    token_estimate: int
    required: bool = False


@dataclass
class CompiledPrompt:
    system_prompt: str
    user_prompt: str
    components_used: list[str]
    estimated_tokens: int
    reasoning_strategy: str
    confidence_target: float = 0.85


class DynamicPromptCompiler:
    def __init__(self, max_tokens: int = 3000):
        self._max_tokens = max_tokens

    def compile(self, task: str, context: str = "", task_type: str = "general",
                difficulty: str = "medium",
                inject_components: dict | None = None) -> CompiledPrompt:
        inject = inject_components or {}
        strategy = self._select_reasoning_strategy(task_type, difficulty)

        # Build all components
        components: list[PromptComponent] = [
            self._build_role_component(task_type),
            self._build_reasoning_scaffold(difficulty, task_type, strategy),
            self._build_failure_guards(task_type),
            self._build_confidence_calibration(),
            self._build_output_format(task_type),
        ]
        if context:
            components.append(self._build_context_injection(context))
        if inject.get("skills"):
            components.append(self._build_skill_injection(inject["skills"]))
        if inject.get("reflections"):
            components.append(self._build_reflection_injection(inject["reflections"]))
        if inject.get("world_state"):
            components.append(PromptComponent(
                "world_state", inject["world_state"], 0.7,
                self.estimate_tokens(inject["world_state"]),
            ))
        if inject.get("workspace"):
            components.append(PromptComponent(
                "workspace", inject["workspace"], 0.65,
                self.estimate_tokens(inject["workspace"]),
            ))

        selected = self._prioritize_components(components, self._max_tokens)
        system   = "\n\n".join(c.content for c in selected)
        used     = [c.name for c in selected]

        return CompiledPrompt(
            system_prompt=system,
            user_prompt=task,
            components_used=used,
            estimated_tokens=sum(c.token_estimate for c in selected),
            reasoning_strategy=strategy,
        )

    # ---- component builders --------------------------------------------
    def _build_role_component(self, task_type: str) -> PromptComponent:
        role = ROLE_PROMPTS.get(task_type, ROLE_PROMPTS["general"])
        return PromptComponent("role", role, priority=1.0,
                               token_estimate=self.estimate_tokens(role), required=True)

    def _build_reasoning_scaffold(self, difficulty: str, task_type: str,
                                   strategy: str) -> PromptComponent:
        scaffold = REASONING_SCAFFOLDS.get(strategy, REASONING_SCAFFOLDS["chain_of_thought"])
        # Add extra depth for hard problems
        if difficulty in ("hard", "extreme", "research"):
            scaffold += "\n\nFor this difficult problem: enumerate at least 3 approaches before committing to one."
        return PromptComponent("reasoning_scaffold", scaffold, priority=0.9,
                               token_estimate=self.estimate_tokens(scaffold), required=True)

    def _build_output_format(self, task_type: str) -> PromptComponent:
        fmt = OUTPUT_FORMATS.get(task_type, OUTPUT_FORMATS["general"])
        return PromptComponent("output_format", fmt, priority=0.8,
                               token_estimate=self.estimate_tokens(fmt))

    def _build_confidence_calibration(self) -> PromptComponent:
        return PromptComponent("confidence_calibration", CONFIDENCE_CALIBRATION,
                               priority=0.75, token_estimate=self.estimate_tokens(CONFIDENCE_CALIBRATION))

    def _build_failure_guards(self, task_type: str) -> PromptComponent:
        guard = FAILURE_GUARDS.get(task_type, FAILURE_GUARDS["general"])
        return PromptComponent("failure_guards", guard, priority=0.85,
                               token_estimate=self.estimate_tokens(guard), required=True)

    def _build_context_injection(self, context: str) -> PromptComponent:
        content = f"=== CONTEXT ===\n{context[:2000]}"
        return PromptComponent("context", content, priority=0.95,
                               token_estimate=self.estimate_tokens(content), required=True)

    def _build_skill_injection(self, skills: list[str]) -> PromptComponent:
        content = "=== RELEVANT SKILLS ===\n" + "\n".join(f"• {s}" for s in skills[:5])
        return PromptComponent("skills", content, priority=0.6,
                               token_estimate=self.estimate_tokens(content))

    def _build_reflection_injection(self, reflections: list[str]) -> PromptComponent:
        content = "=== LESSONS FROM EXPERIENCE ===\n" + "\n".join(f"• {r}" for r in reflections[:5])
        return PromptComponent("reflections", content, priority=0.65,
                               token_estimate=self.estimate_tokens(content))

    # ---- utilities -----------------------------------------------------
    def _select_reasoning_strategy(self, task_type: str, difficulty: str) -> str:
        if difficulty in ("hard", "extreme"):
            if task_type == "math":      return "step_back"
            if task_type == "coding":    return "chain_of_thought"
            return "tree_of_thought"
        if difficulty == "research":     return "least_to_most"
        if task_type in ("coding", "debug"): return "chain_of_thought"
        if task_type == "math":          return "scratchpad"
        return "chain_of_thought"

    def estimate_tokens(self, text: str) -> int:
        return max(1, len(text) // 4)

    def _prioritize_components(self, components: list[PromptComponent],
                                budget: int) -> list[PromptComponent]:
        # Required components first
        required  = [c for c in components if c.required]
        optional  = sorted([c for c in components if not c.required],
                           key=lambda c: c.priority, reverse=True)
        selected  = list(required)
        used_tok  = sum(c.token_estimate for c in selected)
        for c in optional:
            if used_tok + c.token_estimate <= budget:
                selected.append(c)
                used_tok += c.token_estimate
        return selected
