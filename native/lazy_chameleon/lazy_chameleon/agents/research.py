"""ResearchChameleon — deep knowledge retrieval as synthetic parameters."""
from .base import LazyAgent

_SYSTEM = (
    "You are a technical research lead with deep expertise across computer science, "
    "distributed systems, ML, and software engineering. You synthesise knowledge from "
    "papers, open-source codebases, and real-world deployments."
)

_PROMPT = """\
TASK: {task}

You are the RESEARCH agent. Build the knowledge base required to solve this task correctly.

## FOUNDATIONAL CONCEPTS
What core concepts (algorithms, data structures, protocols, mathematical foundations)
must be understood to solve this correctly? For each:
- **Concept:** Name
- **What it is:** 2-sentence definition
- **Why it matters here:** Specific relevance to this task
- **Common misunderstanding:** What engineers usually get wrong about it

## KEY TECHNOLOGIES & LIBRARIES
Which frameworks, libraries, or tools are relevant?
For each: purpose, maturity, trade-offs, when to use vs not use, gotchas.

## STATE OF THE ART
What is the current best practice for problems of this type (as of 2025)?
- Recent papers or open-source projects that advance the state of the art
- What changed in the last 2 years that matters for this task
- What the top companies (Google, Meta, Stripe, Cloudflare, etc.) do for this

## REFERENCE ARCHITECTURES
2–3 well-known systems that solve a similar problem.
For each: architecture overview, what we can steal from it, what we should avoid.

## DOMAIN-SPECIFIC KNOWLEDGE
Non-obvious technical facts that are critical to get right:
- Protocol details, format quirks, API contract subtleties
- Operational knowledge (how this behaves at scale, in failure conditions)
- Compliance / standards that apply (RFCs, OWASP, etc.)

## KEY RISKS FROM THE LITERATURE
What does the research say are the failure modes of this category of system?
Cite specific failure patterns (even without exact paper names).

## IMPLEMENTATION CHECKLIST
Based on research, a pre-implementation checklist of things to verify:
- [ ] item 1
- [ ] item 2
...
"""


class ResearchChameleon(LazyAgent):
    def __init__(self, model_api=None, mode="auto"):
        super().__init__("research", model_api, mode)

    def generate_synthetic_params(self, task: str) -> dict:
        content = self._call_api(
            _PROMPT.format(task=task),
            max_tokens=4000,
            system=_SYSTEM,
        )

        items = max(
            content.count("##") * 3
            + content.count("Concept") + content.count("concept")
            + content.count("technology") + content.count("Technology")
            + content.count("practice") + content.count("Practice"),
            6,
        )

        param_eq = items * 8_000_000_000 * self._mode_mult()
        self.synthetic_params_generated += param_eq

        return {
            "summary": f"Built knowledge base: {items} concepts, technologies, patterns",
            "details": content,
            "param_equivalent": param_eq,
            "confidence": min(0.65 + items * 0.02, 0.92),
            "tokens": len(content) // 4,
        }
