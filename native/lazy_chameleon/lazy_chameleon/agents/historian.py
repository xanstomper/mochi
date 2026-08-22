"""HistorianChameleon — pattern library and lessons-learned as synthetic parameters."""
from .base import LazyAgent

_SYSTEM = (
    "You are a staff engineer who has seen every architecture mistake twice. "
    "You have an encyclopedic memory for post-mortems, design evolution, and the "
    "patterns that actually survived contact with production."
)

_PROMPT = """\
TASK: {task}

You are the HISTORIAN agent. Draw on the full history of engineering to inform this task.

## COMMON PITFALLS (what teams always get wrong)
For each pitfall:
- **Pitfall:** Concrete description
- **Why it seems right at first:** The tempting-but-wrong instinct
- **What actually happens:** The failure mode in production
- **Prevention:** Specific engineering practice that avoids it

## PROVEN PATTERNS (what has stood the test of time)
For each pattern:
- **Pattern:** Name and origin
- **Where it came from:** Which system or company pioneered it and why
- **How it applies here:** Concrete mapping to this task
- **Trade-off:** What it costs to use this pattern

## ANTI-PATTERNS TO AVOID (things that look like patterns but aren't)
- **Anti-pattern name**
- **Why it's tempting**
- **What breaks**
- **What to do instead**

## INSTITUTIONAL KNOWLEDGE (stuff only senior engineers know)
Non-obvious insights that textbooks don't cover, that bite teams building
exactly this type of system. Include war stories if relevant.

## EVOLUTION TRAJECTORY (how this problem space has evolved)
What was the state-of-the-art 2015 → 2020 → current best practice, and why?
Where is the trajectory pointing — what will the solution look like in 2027?

## SOLUTIONS TO AVOID
Historical approaches that seemed promising but are now known to be dead ends
for this type of task. Save the team from re-learning these lessons.

## RECOMMENDED STARTING POINT
Based on history, the one thing to get right first, before anything else,
and why every team that got it wrong regretted it.
"""


class HistorianChameleon(LazyAgent):
    def __init__(self, model_api=None, mode="auto"):
        super().__init__("historian", model_api, mode)

    def generate_synthetic_params(self, task: str) -> dict:
        content = self._call_api(
            _PROMPT.format(task=task),
            max_tokens=4000,
            system=_SYSTEM,
        )

        lessons = max(
            content.count("Pitfall") + content.count("pitfall")
            + content.count("Pattern") + content.count("pattern")
            + content.count("Lesson") + content.count("lesson")
            + content.count("##"),
            4,
        )

        param_eq = lessons * 25_000_000_000 * self._mode_mult()
        self.synthetic_params_generated += param_eq

        return {
            "summary": f"Retrieved {lessons} historical patterns, pitfalls and lessons",
            "details": content,
            "param_equivalent": param_eq,
            "confidence": min(0.55 + lessons * 0.03, 0.90),
            "tokens": len(content) // 4,
        }
