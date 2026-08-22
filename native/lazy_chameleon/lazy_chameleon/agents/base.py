"""Base LazyAgent v2.3 — structured synthetic parameter generation + stalling."""
from __future__ import annotations

from abc import ABC, abstractmethod
import time


# ── Stalling integration ─────────────────────────────────────────────────────
# Each agent can optionally wrap its prompt through the StallEngine.
# Import is lazy to avoid circular-dependency issues during early startup.
def _get_stall_engine(mode: str):
    try:
        from lazy_chameleon.synthesis.staller import StallEngine
        return StallEngine(mode=mode)
    except Exception:
        return None


# Modes that trigger stall-enrichment of the task before generation
_STALL_MODES = frozenset(("hard", "deep", "extreme", "genius", "god", "opus"))

# Param multipliers by mode — used by all agents
MODE_MULTIPLIERS: dict[str, int] = {
    "flash":   3,
    "easy":    7,
    "turbo":   10,
    "medium":  50,
    "hard":    200,
    "deep":    500,
    "extreme": 1000,
    "genius":  2500,
    "god":     5000,
    "opus":    5000,
}

# Base param density per token — agents scale from here
BASE_PARAMS_PER_TOKEN: int = 1_000_000  # 1M params per token of output


class AgentResult:
    """Typed result from a lazy agent."""
    __slots__ = ("agent", "summary", "details", "param_equivalent",
                 "confidence", "tokens", "time", "mode")

    def __init__(
        self,
        agent: str,
        summary: str,
        details: str,
        param_equivalent: int,
        confidence: float,
        tokens: int,
        time_taken: float = 0.0,
        mode: str = "auto",
    ) -> None:
        self.agent = agent
        self.summary = summary
        self.details = details
        self.param_equivalent = param_equivalent
        self.confidence = confidence
        self.tokens = tokens
        self.time = round(time_taken, 2)
        self.mode = mode

    def as_dict(self) -> dict:
        return {
            "agent": self.agent,
            "summary": self.summary,
            "details": self.details,
            "param_equivalent": self.param_equivalent,
            "confidence": self.confidence,
            "tokens": self.tokens,
            "time": self.time,
            "params": self.param_equivalent,  # alias for orchestrator
        }


class LazyAgent(ABC):
    """Base class for all lazy agents.

    Each agent drives the LLM with a rich, role-specific prompt and converts
    output volume + analytical density into a synthetic parameter count.
    """

    def __init__(self, name: str, model_api=None, mode: str = "auto") -> None:
        self.name = name
        self.model = model_api
        self.mode = mode
        self.synthetic_params_generated: int = 0
        self._call_count: int = 0
        self._total_tokens: int = 0

    # ------------------------------------------------------------------
    def run(self, task: str) -> dict:
        """Called by orchestrator. Returns a plain dict (backward compat).

        For hard/deep/extreme/genius/god/opus modes the task is pre-enriched
        with a StallEngine chain-of-draft scaffold before being handed to
        ``generate_synthetic_params``.  This gives every agent an expanded
        reasoning context without requiring each subclass to call
        ``_stalled_call`` explicitly.
        """
        t0 = time.time()

        effective_task = task
        if self.mode.lower() in _STALL_MODES:
            engine = _get_stall_engine(self.mode)
            if engine is not None:
                try:
                    effective_task = engine.build_prompt(
                        task=task,
                        base_context="",
                        strategy="chain_of_draft",
                    )
                except Exception:
                    effective_task = task  # safe fallback

        result = self.generate_synthetic_params(effective_task)
        elapsed = time.time() - t0

        params = result.get("param_equivalent", 0)
        self.synthetic_params_generated += params

        result.setdefault("agent", self.name)
        result.setdefault("time", round(elapsed, 2))
        result["params"] = params  # alias
        return result

    # ------------------------------------------------------------------
    @abstractmethod
    def generate_synthetic_params(self, task: str) -> dict:
        """Generate synthetic parameter context.

        Must return a dict with keys:
          summary          — str   one-line result headline
          details          — str   full LLM output (the synthetic context)
          param_equivalent — int   estimated parameter count produced
          confidence       — float [0, 1]
          tokens           — int   approximate output tokens
        """

    # ------------------------------------------------------------------
    def _mode_mult(self) -> int:
        return MODE_MULTIPLIERS.get(self.mode.lower(), 70)

    def _params_from_output(self, text: str, density: int = BASE_PARAMS_PER_TOKEN) -> int:
        """Convert output length → synthetic param estimate."""
        tokens = max(len(text) // 4, 1)
        self._total_tokens += tokens
        return tokens * density * self._mode_mult()

    def _call_api(
        self,
        prompt: str,
        max_tokens: int = 4000,
        system: str = "",
    ) -> str:
        if self.model is None:
            return ""
        self._call_count += 1
        try:
            return self.model.generate(prompt, system=system, max_tokens=max_tokens)
        except Exception as exc:
            return f"[API error: {exc}]"

    def _stalled_call(
        self,
        task: str,
        prompt: str,
        strategy: str = "",
        max_tokens: int = 4000,
        system: str = "",
    ) -> str:
        """
        Like _call_api but wraps the prompt in an agent-appropriate stalling scaffold.

        Stalling adds test-time reasoning compute so a flash model can answer at
        a quality level closer to a 10-100× larger model, at the cost of more
        *output* tokens (cheap) vs more *input* tokens (expensive).

        If no strategy is given, picks one based on this agent's name.
        """
        engine = _get_stall_engine(self.mode)
        if engine is None:
            return self._call_api(prompt, max_tokens=max_tokens, system=system)

        # Agent-specific strategy mapping
        strategy_map = {
            "scout":     "chain_of_draft",
            "critic":    "constitutional",
            "architect": "budget_force",
            "debug":     "devils_advocate",
            "historian": "self_consistency",
            "optimizer": "hybrid",
            "research":  "scratchpad",
            "simulator": "confidence_gate",
        }
        chosen = strategy or strategy_map.get(self.name.lower(), "hybrid")

        # Build the stalling-augmented prompt
        stalled_prompt = engine.build_prompt(
            task=task,
            base_context=prompt,
            strategy=chosen,
        )
        # Give extra tokens for the reasoning budget
        stall_tokens = max_tokens + engine.budget.total
        return self._call_api(stalled_prompt, max_tokens=stall_tokens, system=system)

    # ------------------------------------------------------------------
    def _mode_depth(self) -> str:
        """Return a depth label based on current mode."""
        m = self.mode.lower()
        if m in ("flash", "easy"):
            return "quick"
        if m in ("hard", "extreme", "genius", "god", "opus"):
            return "thorough"
        return "moderate"

    def _estimate_quality(self, content: str, task: str) -> float:
        """Score output quality 0-1 based on length, structure signals, examples."""
        if not content:
            return 0.0
        score = 0.0
        # Length: up to 0.35
        score += min(len(content) / 2000, 0.35)
        # Concrete example signals: up to 0.25
        example_words = ("for example", "concretely", "specifically", "instance",
                         "e.g.", "i.e.", "such as", "like this")
        hits = sum(1 for w in example_words if w in content.lower())
        score += min(hits * 0.05, 0.25)
        # Numbered/bulleted list structure: up to 0.20
        import re
        list_items = len(re.findall(r'^\s*[\d\-\*\•]+[\.\)]\s', content, re.MULTILINE))
        score += min(list_items * 0.02, 0.20)
        # Task keyword overlap: up to 0.20
        task_words = set(task.lower().split())
        content_words = set(content.lower().split())
        overlap = len(task_words & content_words) / max(len(task_words), 1)
        score += overlap * 0.20
        return round(min(score, 1.0), 3)

    # ------------------------------------------------------------------
    def get_param_count(self) -> int:
        return self.synthetic_params_generated

    def reset(self) -> None:
        """Reset agent runtime state (call count, token total, param count).

        Does NOT reset the name, model, or mode — those are immutable after
        construction.  Useful when re-using an agent instance across test runs.
        """
        self.synthetic_params_generated = 0
        self._call_count = 0
        self._total_tokens = 0

    def get_config(self) -> dict:
        """Return the agent's initialisation configuration as a plain dict."""
        return {
            "name": self.name,
            "mode": self.mode,
            "model": getattr(self.model, "provider_name", None) if self.model else None,
            "class": self.__class__.__name__,
        }

    def supports_mode(self, mode: str) -> bool:
        """Return True if *mode* is a valid stalling mode for this agent."""
        return mode.lower() in _STALL_MODES

    def stats(self) -> dict:
        return {
            "agent": self.name,
            "mode": self.mode,
            "calls": self._call_count,
            "tokens": self._total_tokens,
            "total_params": self.synthetic_params_generated,
        }

    def __repr__(self) -> str:
        return (
            f"{self.__class__.__name__}(name={self.name!r}, "
            f"mode={self.mode!r}, params={self.synthetic_params_generated:,})"
        )
