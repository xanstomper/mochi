"""DebugChameleon — thorough edge-case and bug analysis as synthetic parameters."""
from .base import LazyAgent

_SYSTEM = (
    "You are an expert debugger and QA engineer with deep knowledge of compiler "
    "behaviour, runtime internals, and systems programming. You find the bugs that "
    "only appear in production. You are exhaustive and concrete."
)

_PROMPT = """\
TASK: {task}

You are the DEBUG agent. Perform a comprehensive pre-implementation bug analysis.

## EDGE CASES
For each input dimension, enumerate boundary conditions:
- Empty / zero / null / None / undefined
- Maximum values (integer overflow, buffer overflow, stack overflow)
- Unicode, emoji, right-to-left text, NUL bytes, very long strings
- Concurrent / parallel access to shared state
- Partial data (truncated inputs, streaming where you get half a message)

## LOGIC BUGS
Walk through the algorithm step by step and find:
- Off-by-one errors (≤ vs <, range ends, slice bounds)
- State mutation that breaks subsequent iterations
- Incorrect short-circuit evaluation
- Assumptions that will be false in practice (e.g., "this will always be sorted")
- Missing base cases in recursive logic

## ERROR HANDLING GAPS
- Which errors are caught but silently swallowed?
- Which errors propagate but with the wrong type/message?
- Where does cleanup fail to happen on error paths (resource leaks)?
- Where are errors turned into incorrect "success" responses?

## CONCURRENCY BUGS
- Race conditions: two threads reading then writing without a lock
- Deadlocks: lock ordering violations
- ABA problems in lock-free code
- Event loop blocking (sync calls inside async code)
- Missing memory barriers / visibility guarantees

## DEPENDENCY FAILURES
- What if a network call times out? (partial write, retry storms)
- What if a database is temporarily unavailable?
- What if an external service returns an unexpected schema?
- What if the filesystem is full?

## SPECIFIC TEST CASES
List 5–10 specific unit test scenarios (input → expected output / behaviour)
that MUST pass to consider this correct.

## GOTCHAS
Language/runtime-specific traps that will bite this exact implementation.
"""


class DebugChameleon(LazyAgent):
    def __init__(self, model_api=None, mode="auto"):
        super().__init__("debug", model_api, mode)

    @staticmethod
    def extract_bugs(content: str) -> list[dict]:
        """Parse structured bug entries from *content*.

        Looks for section headings (``## SECTION``) and the items beneath them.
        Returns a list of ``{"section": str, "item": str}`` dicts in document
        order.  Useful for programmatic post-processing of the agent output.
        """
        import re

        bugs: list[dict] = []
        current_section = "GENERAL"
        for line in content.splitlines():
            heading = re.match(r"^##\s+(.+)", line)
            if heading:
                current_section = heading.group(1).strip().upper()
                continue
            item = re.match(r"^\s*[-*•]\s+(.+)", line)
            if item:
                bugs.append({"section": current_section, "item": item.group(1).strip()})
        return bugs

    def triage(self, task: str, threshold: int = 10) -> dict:
        """Run a full debug pass and auto-classify bugs by urgency.

        *threshold* is the raw bug-count above which the result is escalated to
        ``"high"`` urgency; below it the result is ``"normal"``.  The method
        wraps :meth:`generate_synthetic_params` and augments its output.
        """
        result = self.generate_synthetic_params(task)
        bugs = self.extract_bugs(result.get("details", ""))
        urgency = "high" if len(bugs) >= threshold else "normal"
        result["triage"] = {
            "urgency": urgency,
            "bug_count": len(bugs),
            "threshold": threshold,
            "bugs": bugs,
        }
        return result

    def generate_synthetic_params(self, task: str) -> dict:
        content = self._call_api(
            _PROMPT.format(task=task),
            max_tokens=4000,
            system=_SYSTEM,
        )

        bugs = max(
            content.count("##") * 2
            + content.count("bug") + content.count("Bug")
            + content.count("error") + content.count("Error")
            + content.count("edge case") + content.count("Edge case"),
            5,
        )

        param_eq = bugs * 18_000_000_000 * self._mode_mult()
        self.synthetic_params_generated += param_eq

        return {
            "summary": f"Analysed {bugs} potential bugs, edge cases and failure points",
            "details": content,
            "param_equivalent": param_eq,
            "confidence": min(0.60 + bugs * 0.015, 0.92),
            "tokens": len(content) // 4,
        }
