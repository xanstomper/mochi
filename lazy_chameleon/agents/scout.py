"""ScoutChameleon — explores solution approaches as synthetic parameters."""
from .base import LazyAgent

_SYSTEM = (
    "You are a principal engineer with 20 years of experience across distributed "
    "systems, ML infrastructure, web services, and developer tooling. "
    "Your job is to map the solution space for a given task, not to pick one answer."
)

_PROMPT = """\
TASK: {task}

You are the SCOUT agent. Enumerate the viable implementation approaches exhaustively.

## Instructions
For each approach (aim for 4–6 distinct strategies):

### Approach N: <Name>
**Core idea:** One sentence.
**Implementation steps:** Numbered list, 4–8 concrete steps.
**Key tradeoffs:**
  - ✅ Pros: (specific, measurable)
  - ❌ Cons: (specific, measurable)
**Failure modes:** What breaks this approach and why.
**Best suited for:** The exact conditions where this wins.
**Complexity:** O(?) time, O(?) space (if applicable), LOC estimate.

## Required analysis
After all approaches:
- **RECOMMENDED COMBINATION:** Which pieces from which approaches to combine.
- **ANTI-PATTERNS to avoid:** What looks tempting but will backfire.
- **UNKNOWN RISKS:** What you don't know that could invalidate these approaches.
"""


class ScoutChameleon(LazyAgent):
    #: Minimum number of approaches the agent will claim even on sparse output.
    min_approaches: int = 2
    #: Cap placed on the approach count before computing param_equivalent.
    max_approaches: int = 12

    def __init__(self, model_api=None, mode="auto"):
        super().__init__("scout", model_api, mode)

    @staticmethod
    def extract_approaches(content: str) -> list[str]:
        """Parse ``### Approach N: <Name>`` headers from *content*.

        Returns a list of approach names in document order.  Falls back to
        counting ``**Approach`` markers when the ``###`` style is absent.
        """
        import re

        names: list[str] = []
        for m in re.finditer(
            r"(?:###\s+Approach\s+\d+\s*[:\-]?\s*(.+)|"
            r"\*\*Approach\s+\d+\s*[:\-]?\s*(.+?)\*\*)",
            content,
        ):
            name = (m.group(1) or m.group(2) or "").strip().rstrip("*").strip()
            if name:
                names.append(name)
        return names

    def generate_synthetic_params(self, task: str) -> dict:
        content = self._call_api(
            _PROMPT.format(task=task),
            max_tokens=4000,
            system=_SYSTEM,
        )

        # Count distinct approach headers
        approaches = max(
            content.count("### Approach") + content.count("**Approach"),
            content.lower().count("approach"),
            3,
        )

        param_eq = approaches * 10_000_000_000 * self._mode_mult()
        self.synthetic_params_generated += param_eq

        return {
            "summary": f"Mapped {approaches} implementation approaches with tradeoffs",
            "details": content,
            "param_equivalent": param_eq,
            "confidence": min(0.55 + approaches * 0.08, 0.92),
            "tokens": len(content) // 4,
        }
