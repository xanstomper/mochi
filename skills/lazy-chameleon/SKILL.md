---
name: lazy-chameleon
description: Lazy Chameleon v2.4 Parameter Synthesis Engine & Test-Time Compute Stalling — Transforms standard flash-class models into frontier-grade reasoners via in-harness test-time compute expansion (Chain-of-Draft, Budget Forcing, Constitutional loops, Devil's Advocate, Self-Consistency, Confidence Gating), zero-latency deterministic heuristic synthesis, and LLMLingua-style context compression without external API keys.
---

# Lazy Chameleon v2.4 (Mochi Harness Integrated)

The complete Lazy Chameleon Parameter Synthesis Engine baked directly into Mochi.

## Core Capabilities
- **In-Harness Execution**: Runs entirely over Mochi's active connected model router. Requires ZERO external API keys.
- **Zero-Latency Flash Mode**: Synthesizes dense domain heuristics, OWL invariants, DOX contracts, and SISPIS entropy gates deterministically in 0ms without extra API calls.
- **Test-Time Compute Stalling**:
  - `chain_of_draft`: Draft -> Critique -> Revision loop
  - `budget_force`: Multi-angle problem decomposition
  - `constitutional`: Strict safety, idempotency, and data-loss guards
  - `devils_advocate`: Adversarial red-teaming to uncover subtle race conditions
  - `self_consistency`: Multi-perspective generation with consensus voting
  - `confidence_gate`: Calibrated epistemic classification
- **Frontier Mimicry**: Emulates Claude 3.7 Sonnet, OpenAI o3, Gemini 2.5 Pro, and DeepSeek-R1 reasoning architectures.
- **Context Compression**: LLMLingua-style token minimization and prefix-anchored KV-cache alignment.

## Usage in Mochi
```bash
# In Mochi interactive TUI or CLI:
mochi
> /chameleon task="Design a distributed consensus protocol" mode="hard" strategy="chain_of_draft"
```
Or use the agent tool:
```json
{
  "name": "chameleon",
  "arguments": {
    "task": "Refactor the authentication middleware to support JWT refresh rotation",
    "mode": "deep",
    "strategy": "hybrid"
  }
}
```
