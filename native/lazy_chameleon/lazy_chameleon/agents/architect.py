"""ArchitectChameleon — evaluates architecture as synthetic parameters."""
from .base import LazyAgent

_SYSTEM = (
    "You are a principal architect who has designed systems serving billions of users. "
    "You think in trade-offs, constraints, and long-term maintainability. "
    "You never recommend over-engineering and you always justify complexity with scale."
)

_PROMPT = """\
TASK: {task}

You are the ARCHITECT agent. Evaluate the structural and design dimension of this task.

## DESIGN PATTERNS
Which Gang-of-Four or architectural patterns apply here? For each:
- Pattern name and variant
- How it maps to this specific task
- What problem it solves
- What complexity it adds

## MODULE & SERVICE BOUNDARIES
- What are the clear separation-of-concerns boundaries?
- Which components should be independent vs tightly coupled?
- What are the public interfaces / contracts?
- Where does responsibility end for each component?

## DATA FLOW & STATE
- Where does data originate, transform, and terminate?
- What is mutable vs immutable?
- Where are consistency boundaries?
- How is state shared across components?

## TECHNOLOGY STACK DECISIONS
For each key technology choice:
- What we need from it (capabilities)
- Why this over the alternatives
- Lock-in risks and migration path

## SCALABILITY ARCHITECTURE
- What breaks first under 10× load?
- What breaks at 100× ?
- What architectural changes would be required at each scale jump?
- Stateless vs stateful components — which can scale horizontally?

## FAILURE DOMAINS
- What fails independently?
- What is the blast radius of each component failing?
- How to make failure partial rather than total?
- Circuit breaker and bulkhead patterns that apply.

## RECOMMENDED ARCHITECTURE
Draw the architecture in ASCII block diagram. Label every component, data store,
and async queue. Show request flow with arrows.

## ANTI-PATTERNS AVOIDED
What design mistakes would seem obvious but create long-term pain here?
"""


class ArchitectChameleon(LazyAgent):
    def __init__(self, model_api=None, mode="auto"):
        super().__init__("architect", model_api, mode)

    def generate_synthetic_params(self, task: str) -> dict:
        content = self._call_api(
            _PROMPT.format(task=task),
            max_tokens=4000,
            system=_SYSTEM,
        )

        patterns = max(
            content.count("Pattern") + content.count("pattern")
            + content.count("Architecture") + content.count("Component")
            + content.count("##"),
            3,
        )

        param_eq = patterns * 20_000_000_000 * self._mode_mult()
        self.synthetic_params_generated += param_eq

        return {
            "summary": f"Evaluated {patterns} architectural patterns and boundaries",
            "details": content,
            "param_equivalent": param_eq,
            "confidence": min(0.70 + patterns * 0.02, 0.92),
            "tokens": len(content) // 4,
        }
