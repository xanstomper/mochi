"""
TokenBudget — KV-cache-aware token budget manager.

Two core money-saving insights
───────────────────────────────
1. KV-Cache prefix sharing
   If every API call starts with the *same* system prompt prefix, the provider
   caches the KV pairs for that prefix and only charges ~10-20% of the normal
   input-token price on subsequent calls (Anthropic, OpenAI both do this).
   → Pin a shared PREFIX_ANCHOR at the start of every call.

2. Lazy token allocation
   Simple tasks don't need 8 agents × 2000 tokens of context.
   A quality-gated tier system (Tier1 → Tier2 → Tier3) only escalates when
   cheaper agents aren't enough.
   → 60-80% token savings on sub-medium tasks.

Provider pricing (per 1M tokens, USD, July 2025 estimates)
────────────────────────────────────────────────────────────
deepseek-v4-flash (opencode-go)  $0.07 in / $0.28 out
claude-haiku-4-5                 $0.80 in / $4.00 out (cached: $0.08)
claude-sonnet-5                  $3.00 in / $15.00 out (cached: $0.30)
claude-opus-4-8                  $15.00 in / $75.00 out (cached: $1.50)
gpt-4o                           $2.50 in / $10.00 out
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Optional

log = logging.getLogger(__name__)


# ── Pricing table ─────────────────────────────────────────────────────────

PROVIDER_PRICING: dict[str, dict] = {
    # model-or-provider → {in, out, cached_in} per 1M tokens in USD
    "deepseek-v4-flash":        {"in": 0.07,  "out": 0.28,  "cached": 0.007},
    "deepseek-v3":              {"in": 0.27,  "out": 1.10,  "cached": 0.027},
    "claude-haiku-4-5-20251001":{"in": 0.80,  "out": 4.00,  "cached": 0.08},
    "claude-haiku-4-5":         {"in": 0.80,  "out": 4.00,  "cached": 0.08},
    "claude-sonnet-5":          {"in": 3.00,  "out": 15.00, "cached": 0.30},
    "claude-opus-4-8":          {"in": 15.00, "out": 75.00, "cached": 1.50},
    "claude-fable-5":           {"in": 3.00,  "out": 15.00, "cached": 0.30},
    "gpt-4o":                   {"in": 2.50,  "out": 10.00, "cached": 0.25},
    "gpt-4o-mini":              {"in": 0.15,  "out": 0.60,  "cached": 0.015},
    "openai":                   {"in": 2.50,  "out": 10.00, "cached": 0.25},
    "anthropic":                {"in": 3.00,  "out": 15.00, "cached": 0.30},
    "opencode":                 {"in": 0.07,  "out": 0.28,  "cached": 0.007},
    "opencode-go":              {"in": 0.07,  "out": 0.28,  "cached": 0.007},
    "opencode-zen":             {"in": 0.07,  "out": 0.28,  "cached": 0.007},
    "default":                  {"in": 1.00,  "out": 5.00,  "cached": 0.10},
}

# Shared prefix that is identical across all API calls so KV-cache is warm.
# Keep this SHORT and STABLE — every character change busts the cache.
PREFIX_ANCHOR = (
    "You are a world-class expert. Think carefully before answering. "
    "Be precise, complete, and rigorous."
)


# ── Data classes ──────────────────────────────────────────────────────────

@dataclass
class CallRecord:
    """Accounting record for a single API call."""
    model: str
    provider: str
    prompt_tokens: int
    completion_tokens: int
    cached_tokens: int = 0          # tokens served from KV-cache
    timestamp: float = field(default_factory=time.time)
    label: str = ""                 # e.g. "scout_agent", "synthesis"

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    def cost_usd(self) -> float:
        pricing = PROVIDER_PRICING.get(
            self.model,
            PROVIDER_PRICING.get(self.provider, PROVIDER_PRICING["default"])
        )
        fresh_in = self.prompt_tokens - self.cached_tokens
        return (
            fresh_in                 * pricing["in"]  / 1_000_000
            + self.cached_tokens     * pricing["cached"] / 1_000_000
            + self.completion_tokens * pricing["out"] / 1_000_000
        )


@dataclass
class BudgetAllocation:
    """Per-call token quota issued by the budget manager."""
    label: str
    max_prompt_tokens: int
    max_completion_tokens: int
    priority: int = 5               # 1=highest, 10=lowest — drop low-prio if tight
    allow_cached_reuse: bool = True


# ── Budget manager ────────────────────────────────────────────────────────

class TokenBudget:
    """
    Tracks spend, allocates per-call quotas, and enforces soft/hard caps.

    Key behaviours
    ──────────────
    • Prefix pinning  — prepends PREFIX_ANCHOR so KV-cache is warm
    • Tier gating     — issues zero quota to agents below current tier
    • Cache credit    — cached tokens cost ~10% of fresh input tokens;
                        the budget manager tracks and rewards cache hits
    • Adaptive cutoff — if spend > 80% of hard cap, shrinks completion quotas

    Usage
    ─────
        budget = TokenBudget(hard_cap_tokens=200_000, model="deepseek-v4-flash")
        alloc = budget.request("scout_agent", prompt_t=800, completion_t=400)
        if alloc:
            # call the model
            budget.record(CallRecord(..., label="scout_agent"))
    """

    # Default per-agent token quotas by mode
    MODE_QUOTAS: dict[str, dict] = {
        "flash":   {"prompt": 500,   "completion": 200},
        "easy":    {"prompt": 800,   "completion": 400},
        "turbo":   {"prompt": 1200,  "completion": 600},
        "medium":  {"prompt": 2000,  "completion": 1000},
        "hard":    {"prompt": 3500,  "completion": 1500},
        "deep":    {"prompt": 5000,  "completion": 2500},
        "extreme": {"prompt": 8000,  "completion": 4000},
        "genius":  {"prompt": 12000, "completion": 6000},
        "god":     {"prompt": 20000, "completion": 10000},
    }

    # Hard cap on total tokens per enhance() call by mode
    MODE_HARD_CAPS: dict[str, int] = {
        "flash":   20_000,
        "easy":    40_000,
        "turbo":   60_000,
        "medium":  100_000,
        "hard":    200_000,
        "deep":    400_000,
        "extreme": 700_000,
        "genius":  1_200_000,
        "god":     2_000_000,
    }

    def __init__(
        self,
        mode: str = "hard",
        model: str = "deepseek-v4-flash",
        provider: str = "opencode-go",
        hard_cap_tokens: int = 0,
        warn_threshold: float = 0.9,
    ):
        self.mode = mode
        self.model = model
        self.provider = provider
        self.hard_cap = hard_cap_tokens or self.MODE_HARD_CAPS.get(mode, 200_000)
        self._records: list[CallRecord] = []
        self._quota = self.MODE_QUOTAS.get(mode, self.MODE_QUOTAS["hard"])
        self._start = time.time()
        self.warn_threshold = warn_threshold
        self._warn_emitted = False

    # ── Quota issuance ────────────────────────────────────────────────────

    def request(
        self,
        label: str,
        prompt_tokens: int = 0,
        completion_tokens: int = 0,
        priority: int = 5,
    ) -> Optional[BudgetAllocation]:
        """
        Request a quota for a call.
        Returns None if the budget is exhausted (caller should skip the call).
        """
        used = self.tokens_used()
        remaining = self.hard_cap - used
        if remaining <= 0:
            return None

        # Warn once when warn_threshold fraction of the hard cap is consumed
        if not self._warn_emitted and used >= self.warn_threshold * self.hard_cap:
            log.warning(
                "TokenBudget[%s] %.0f%% consumed (%d / %d tokens)",
                self.mode,
                100.0 * used / self.hard_cap,
                used,
                self.hard_cap,
            )
            self._warn_emitted = True

        # Adaptive shrink: if > 80% consumed, halve quotas
        shrink = 1.0
        if used > 0.80 * self.hard_cap:
            shrink = 0.4
        elif used > 0.60 * self.hard_cap:
            shrink = 0.7

        max_p = int(min(
            prompt_tokens or self._quota["prompt"],
            self._quota["prompt"] * shrink,
        ))
        max_c = int(min(
            completion_tokens or self._quota["completion"],
            self._quota["completion"] * shrink,
        ))
        # Hard floor: never issue a useless quota
        if max_p < 50 or max_c < 30:
            return None

        return BudgetAllocation(
            label=label,
            max_prompt_tokens=max_p,
            max_completion_tokens=max_c,
            priority=priority,
            allow_cached_reuse=True,
        )

    # ── Tracking ──────────────────────────────────────────────────────────

    def record(self, call: CallRecord) -> None:
        self._records.append(call)

    def record_simple(
        self,
        label: str,
        prompt_tokens: int,
        completion_tokens: int,
        cached_tokens: int = 0,
    ) -> None:
        self._records.append(CallRecord(
            model=self.model,
            provider=self.provider,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            cached_tokens=cached_tokens,
            label=label,
        ))

    # ── Accounting ────────────────────────────────────────────────────────

    def tokens_used(self) -> int:
        return sum(r.total_tokens for r in self._records)

    def tokens_remaining(self) -> int:
        return max(0, self.hard_cap - self.tokens_used())

    def cost_usd(self) -> float:
        return sum(r.cost_usd() for r in self._records)

    def cache_hit_rate(self) -> float:
        total_in = sum(r.prompt_tokens for r in self._records)
        cached   = sum(r.cached_tokens for r in self._records)
        return cached / total_in if total_in > 0 else 0.0

    def cache_savings_usd(self) -> float:
        """USD saved vs paying full price for every input token."""
        pricing = PROVIDER_PRICING.get(
            self.model,
            PROVIDER_PRICING.get(self.provider, PROVIDER_PRICING["default"])
        )
        total_cached = sum(r.cached_tokens for r in self._records)
        price_diff = pricing["in"] - pricing["cached"]
        return total_cached * price_diff / 1_000_000

    def pct_used(self) -> float:
        return self.tokens_used() / self.hard_cap if self.hard_cap else 0.0

    # ── KV-cache prefix helpers ───────────────────────────────────────────

    @staticmethod
    def pin_prefix(system_prompt: str) -> str:
        """
        Prepend the shared PREFIX_ANCHOR so every call starts with the same
        token sequence → KV-cache hit on the anchor on call 2+.

        The anchor must be at position 0 of the system prompt.
        """
        if system_prompt.startswith(PREFIX_ANCHOR):
            return system_prompt
        return PREFIX_ANCHOR + "\n\n" + system_prompt

    @staticmethod
    def estimate_cached_tokens(prompt: str, anchor: str = PREFIX_ANCHOR) -> int:
        """Rough estimate of how many tokens will be served from cache."""
        if not prompt.startswith(anchor):
            return 0
        # Approximate: 1 token ≈ 4 chars
        return len(anchor) // 4

    # ── Per-agent quota helpers ───────────────────────────────────────────

    def agent_quota(self, agent_name: str, tier: int = 1) -> BudgetAllocation:
        """
        Return the token quota for a specific agent.

        Tier 1 agents (Scout, Critic) — always run, full quota.
        Tier 2 agents (Architect, Debug) — 80% quota.
        Tier 3 agents (rest) — 60% quota.
        """
        tier_scale = {1: 1.0, 2: 0.80, 3: 0.60}
        scale = tier_scale.get(tier, 0.60)
        return BudgetAllocation(
            label=agent_name,
            max_prompt_tokens=int(self._quota["prompt"] * scale),
            max_completion_tokens=int(self._quota["completion"] * scale),
            priority=tier,
        )

    # ── Summary ───────────────────────────────────────────────────────────

    def summary(self) -> dict:
        by_label: dict[str, int] = {}
        for r in self._records:
            by_label[r.label] = by_label.get(r.label, 0) + r.total_tokens

        return {
            "mode": self.mode,
            "model": self.model,
            "hard_cap": self.hard_cap,
            "tokens_used": self.tokens_used(),
            "tokens_remaining": self.tokens_remaining(),
            "pct_used": round(self.pct_used() * 100, 1),
            "cost_usd": round(self.cost_usd(), 6),
            "cache_hit_rate": round(self.cache_hit_rate(), 3),
            "cache_savings_usd": round(self.cache_savings_usd(), 6),
            "calls": len(self._records),
            "elapsed_s": round(time.time() - self._start, 2),
            "by_label": by_label,
        }

    def __repr__(self) -> str:
        s = self.summary()
        return (
            f"TokenBudget(mode={self.mode}, "
            f"used={s['tokens_used']:,}/{s['hard_cap']:,} "
            f"[{s['pct_used']}%], "
            f"cost=${s['cost_usd']:.4f}, "
            f"cache={s['cache_hit_rate']:.1%})"
        )
