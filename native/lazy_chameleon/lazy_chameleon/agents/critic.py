"""CriticChameleon — deep security, correctness, and failure-mode analysis."""
from .base import LazyAgent

_SYSTEM = (
    "You are a senior security engineer and code reviewer who has audited systems "
    "at hyperscaler scale. You find bugs and vulnerabilities that others miss. "
    "You are thorough, specific, and never wave away risks."
)

_PROMPT = """\
TASK: {task}

You are the CRITIC agent. Ruthlessly audit this task for every possible failure.

## SECURITY VULNERABILITIES
List every attack vector: injection (SQL/command/prompt), auth bypass, privilege
escalation, data leakage, SSRF, CSRF, insecure deserialization, supply chain risks.
For each: severity (CRITICAL/HIGH/MEDIUM/LOW), attack vector, proof-of-concept payload.

## CORRECTNESS BUGS
- Off-by-one errors, integer overflow/underflow
- Race conditions and TOCTOU bugs
- Null/None dereference paths
- Type confusion and implicit coercion surprises
- Incorrect error propagation (swallowed exceptions, wrong status codes)

## EDGE CASES UNHANDLED
Empty inputs, max-value inputs, unicode/encoding edge cases, locale-sensitive
operations, concurrent access, partial failures, timeout mid-operation.

## LOGIC BUGS
Incorrect operator precedence, state mutation side effects, boolean logic inversions,
missing validation, incorrect assumptions about external system behavior.

## PERFORMANCE BOTTLENECKS
- N+1 query patterns, missing indexes
- CPU-bound operations blocking event loop
- Memory allocation patterns (GC pressure, unbounded growth)
- Connection pool limits / thundering herd

## MISSING REQUIREMENTS
What was asked but not specified — implicit requirements the implementation will need
to handle. Flag ambiguities that will cause bugs at runtime.

## VERDICT
For each finding: [CRITICAL/HIGH/MEDIUM/LOW] — file/function if known — description — fix.
Top 3 must-fix issues before this ships.
"""


class CriticChameleon(LazyAgent):
    def __init__(self, model_api=None, mode="auto"):
        super().__init__("critic", model_api, mode)

    @staticmethod
    def extract_issues(content: str) -> dict[str, list[str]]:
        """Parse severity-tagged issues from *content*.

        Returns a dict with keys ``"CRITICAL"``, ``"HIGH"``, ``"MEDIUM"``,
        ``"LOW"`` each mapping to a list of description strings extracted from
        ``[SEVERITY] — …`` or ``**SEVERITY:** …`` patterns.
        """
        import re

        buckets: dict[str, list[str]] = {
            "CRITICAL": [],
            "HIGH": [],
            "MEDIUM": [],
            "LOW": [],
        }
        # Match both [CRITICAL/HIGH/…] — text and **CRITICAL:** text forms.
        for m in re.finditer(
            r"\[?(CRITICAL|HIGH|MEDIUM|LOW)\]?\s*[:\-—]\s*(.+?)(?=\n|$)",
            content,
            re.IGNORECASE,
        ):
            sev = m.group(1).upper()
            desc = m.group(2).strip()
            if sev in buckets and desc:
                buckets[sev].append(desc)
        return buckets

    def security_scan(self, task: str) -> dict:
        """Run a security-focused critique pass on *task*.

        Prepends the string ``"SECURITY AUDIT: "`` to the task prompt so the
        model naturally skews its output toward injection, auth, and data-leak
        findings.  Returns the same structure as :meth:`generate_synthetic_params`.
        """
        return self.generate_synthetic_params(f"SECURITY AUDIT: {task}")

    def generate_synthetic_params(self, task: str) -> dict:
        content = self._call_api(
            _PROMPT.format(task=task),
            max_tokens=4000,
            system=_SYSTEM,
        )

        # Count severity markers + generic issue words
        critical = content.upper().count("CRITICAL")
        high = content.upper().count("HIGH")
        medium = content.upper().count("MEDIUM")
        generic = (
            content.count("bug") + content.count("Bug")
            + content.count("issue") + content.count("Issue")
            + content.count("vulnerabilit")
        )
        issues = max(critical * 3 + high * 2 + medium + generic // 2, 3)

        param_eq = issues * 15_000_000_000 * self._mode_mult()
        self.synthetic_params_generated += param_eq

        return {
            "summary": (
                f"Found {critical} CRITICAL, {high} HIGH, {medium} MEDIUM issues "
                f"(+{generic} generic)"
            ),
            "details": content,
            "param_equivalent": param_eq,
            "confidence": min(0.65 + issues * 0.02, 0.93),
            "tokens": len(content) // 4,
        }
