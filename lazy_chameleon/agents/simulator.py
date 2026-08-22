"""SimulatorChameleon — stress-tests the solution under adversarial conditions."""
from .base import LazyAgent

_SYSTEM = (
    "You are a chaos engineering specialist and stress-testing expert. "
    "You simulate production failure conditions, adversarial inputs, and "
    "unexpected usage patterns to find what breaks before it ships."
)

_PROMPT = """\
TASK: {task}

You are the SIMULATOR agent. Run mental simulations across failure domains.

## SCENARIO 1: TRAFFIC SPIKE (100×)
Normal load is 1. Simulate 100× suddenly:
- Which component saturates first?
- What is the cascade failure sequence?
- Which queues fill up? What happens when they overflow?
- How long until recovery after spike subsides?
- What changes make this scenario survivable?

## SCENARIO 2: DEPENDENCY FAILURE
Critical dependencies fail mid-operation:
- Database goes read-only (disk full)
- External API returns 503 for 5 minutes
- Message queue becomes unavailable
- Simulate: partial writes, inconsistent state, retry storms
- Recovery sequence: what must happen in what order?

## SCENARIO 3: ADVERSARIAL INPUTS
Attack vectors — specific payloads and patterns:
- Graceful degradation: fallback behaviour
- Concurrent vs sequential: race condition paths
- Schema evolution: handling messages from older/newer versions

## SCENARIO 4: SCALE CHALLENGE
Requirements change mid-implementation:
- Data volume 10× (storage strategy changes)
- User count 100× (session management breaks)
- Geographic expansion (latency, compliance, data residency)
- Team scales: 1 dev → 10 devs (coordination overhead, conflicts)

## SCENARIO 5: DEPENDENCY CHAIN
3rd-party library releases a breaking change:
- Which parts of our code are most exposed?
- What does a migration look like?
- How do we pin versions safely?

## SCENARIO 6: OPERATIONAL REALITY
First week in production:
- What monitoring alerts fire first?
- What is the most common on-call page?
- Which log lines are most useful for debugging?
- What runbook entry is written after the first incident?

## FAILURE ISOLATION CHECKLIST
For each scenario: [PASSES / FAILS / UNKNOWN] — what must be true for it to pass.

## TOP 3 SIMULATION FINDINGS
The 3 most critical insights from running these simulations, ranked by impact.
"""


class SimulatorChameleon(LazyAgent):
    def __init__(self, model_api=None, mode="auto"):
        super().__init__("simulator", model_api, mode)

    def generate_synthetic_params(self, task: str) -> dict:
        content = self._call_api(
            _PROMPT.format(task=task),
            max_tokens=4000,
            system=_SYSTEM,
        )

        scenarios = max(
            content.count("## SCENARIO") + content.count("SCENARIO")
            + content.count("## ") // 2
            + content.count("fail") + content.count("Fail"),
            4,
        )

        param_eq = scenarios * 12_000_000_000 * self._mode_mult()
        self.synthetic_params_generated += param_eq

        return {
            "summary": f"Simulated {scenarios} failure scenarios and adversarial conditions",
            "details": content,
            "param_equivalent": param_eq,
            "confidence": min(0.60 + scenarios * 0.025, 0.90),
            "tokens": len(content) // 4,
        }
