"""
DebateEngine — Experts argue, then majority vote.

Pipeline: Proposer → Opponent → Judge → Verifier → Final Answer

Catches reasoning mistakes that single-pass misses.
"""
from __future__ import annotations
import re
from dataclasses import dataclass, field
from typing import Callable, Awaitable


@dataclass
class DebateRound:
    round_num: int
    proposer_answer: str
    opponent_critique: str
    judge_ruling: str
    confidence: float
    tokens_used: int = 0


@dataclass
class DebateResult:
    final_answer: str
    rounds: list[DebateRound] = field(default_factory=list)
    consensus_reached: bool = False
    confidence: float = 0.0
    dissenting_views: list[str] = field(default_factory=list)
    winning_argument: str = ""


class DebateEngine:
    """Multi-agent debate with convergence detection."""

    PROPOSER_SYSTEM = """You are the PROPOSER. Your job is to give the best possible answer to the task.
Think carefully, be specific, and justify your reasoning.
End your response with: CONFIDENCE: [0.0-1.0]"""

    OPPONENT_SYSTEM = """You are the OPPONENT. Rigorously critique the proposed answer.
Find flaws, missing cases, incorrect assumptions, and logical errors.
Be specific about what is wrong and why.
If the answer is actually correct, say "NO VALID OBJECTION" and explain why it stands.
End your response with: CONFIDENCE_IN_CRITIQUE: [0.0-1.0]"""

    JUDGE_SYSTEM = """You are the JUDGE. Weigh the proposal and the critique objectively.
Determine: Is the critique valid? Does it require changing the answer?
Produce a refined final ruling that incorporates valid objections.
End your response with: FINAL_CONFIDENCE: [0.0-1.0]"""

    VERIFIER_SYSTEM = """You are the VERIFIER. Check the judge's ruling for:
1. Logical consistency
2. Completeness  
3. Correctness
4. No remaining objections

If everything checks out, confirm it. If not, flag the remaining issues.
End your response with: VERIFIED: [YES/NO] CONFIDENCE: [0.0-1.0]"""

    def __init__(self, max_rounds: int = 2, consensus_threshold: float = 0.85):
        self.max_rounds = max_rounds
        self.consensus_threshold = consensus_threshold

    # ------------------------------------------------------------------
    def build_proposer_prompt(self, task: str, context: str) -> str:
        ctx = f"\n\nCONTEXT:\n{context}" if context else ""
        return f"TASK: {task}{ctx}\n\nProvide your best answer:"

    def build_opponent_prompt(self, task: str, proposal: str, context: str) -> str:
        return (f"TASK: {task}\n\n"
                f"PROPOSED ANSWER:\n{proposal}\n\n"
                f"Find every flaw, gap, or mistake in this answer:")

    def build_judge_prompt(self, task: str, proposal: str, critique: str) -> str:
        return (f"TASK: {task}\n\n"
                f"PROPOSED ANSWER:\n{proposal}\n\n"
                f"CRITIQUE:\n{critique}\n\n"
                f"Weigh both sides and produce the best possible ruling:")

    def build_verifier_prompt(self, task: str, ruling: str) -> str:
        return (f"TASK: {task}\n\n"
                f"JUDGE'S RULING:\n{ruling}\n\n"
                f"Verify this answer is complete, correct, and consistent:")

    # ------------------------------------------------------------------
    def _extract_confidence(self, text: str) -> float:
        patterns = [
            r"FINAL_CONFIDENCE:\s*([\d.]+)",
            r"CONFIDENCE:\s*([\d.]+)",
            r"confidence[:\s]+([\d.]+)",
        ]
        for p in patterns:
            m = re.search(p, text, re.IGNORECASE)
            if m:
                try:
                    v = float(m.group(1))
                    return max(0.0, min(1.0, v))
                except ValueError:
                    continue
        # fallback: count positive vs negative signals
        pos = len(re.findall(r"\b(correct|right|valid|good|strong|accurate)\b", text, re.I))
        neg = len(re.findall(r"\b(wrong|incorrect|flawed|error|mistake|missing)\b", text, re.I))
        total = pos + neg
        if total == 0:
            return 0.7
        return min(0.95, max(0.1, pos / total))

    def _check_consensus(self, rounds: list[DebateRound]) -> bool:
        if not rounds:
            return False
        recent = rounds[-1]
        if recent.confidence >= self.consensus_threshold:
            return True
        # Check if opponent agreed
        if "NO VALID OBJECTION" in recent.opponent_critique.upper():
            return True
        return False

    # ------------------------------------------------------------------
    async def run_debate(self, task: str, context: str,
                         api_fn: Callable[[str, str, str], Awaitable[str]]) -> DebateResult:
        """
        api_fn(system_prompt, user_prompt, label) -> str
        """
        rounds: list[DebateRound] = []
        dissenting: list[str] = []
        best_answer = ""

        for r in range(self.max_rounds):
            # 1. Proposer
            if r == 0:
                proposal = await api_fn(
                    self.PROPOSER_SYSTEM,
                    self.build_proposer_prompt(task, context),
                    "proposer",
                )
            else:
                # Proposer incorporates judge's ruling from last round
                proposal = rounds[-1].judge_ruling

            # 2. Opponent
            critique = await api_fn(
                self.OPPONENT_SYSTEM,
                self.build_opponent_prompt(task, proposal, context),
                "opponent",
            )

            # 3. Judge
            ruling = await api_fn(
                self.JUDGE_SYSTEM,
                self.build_judge_prompt(task, proposal, critique),
                "judge",
            )

            conf = self._extract_confidence(ruling)
            rnd = DebateRound(
                round_num=r + 1,
                proposer_answer=proposal,
                opponent_critique=critique,
                judge_ruling=ruling,
                confidence=conf,
            )
            rounds.append(rnd)
            best_answer = ruling

            # Track dissent
            if "NO VALID OBJECTION" not in critique.upper():
                dissenting.append(critique[:200])

            if self._check_consensus(rounds):
                break

        # 4. Verifier on final ruling
        verified_text = await api_fn(
            self.VERIFIER_SYSTEM,
            self.build_verifier_prompt(task, best_answer),
            "verifier",
        )
        final_conf = self._extract_confidence(verified_text)
        consensus = "VERIFIED: YES" in verified_text.upper() or final_conf >= self.consensus_threshold

        return DebateResult(
            final_answer=best_answer,
            rounds=rounds,
            consensus_reached=consensus,
            confidence=final_conf,
            dissenting_views=dissenting,
            winning_argument=rounds[-1].judge_ruling if rounds else "",
        )

    def run_debate_sync(self, task: str, context: str,
                        api_fn: Callable[[str, str, str], str]) -> DebateResult:
        """Synchronous version — api_fn is blocking."""
        rounds: list[DebateRound] = []
        dissenting: list[str] = []
        best_answer = ""

        for r in range(self.max_rounds):
            proposal = rounds[-1].judge_ruling if r > 0 else api_fn(
                self.PROPOSER_SYSTEM,
                self.build_proposer_prompt(task, context),
                "proposer",
            )
            critique = api_fn(
                self.OPPONENT_SYSTEM,
                self.build_opponent_prompt(task, proposal, context),
                "opponent",
            )
            ruling = api_fn(
                self.JUDGE_SYSTEM,
                self.build_judge_prompt(task, proposal, critique),
                "judge",
            )
            conf = self._extract_confidence(ruling)
            rnd = DebateRound(r + 1, proposal, critique, ruling, conf)
            rounds.append(rnd)
            best_answer = ruling
            if "NO VALID OBJECTION" not in critique.upper():
                dissenting.append(critique[:200])
            if self._check_consensus(rounds):
                break

        verified = api_fn(
            self.VERIFIER_SYSTEM,
            self.build_verifier_prompt(task, best_answer),
            "verifier",
        )
        final_conf = self._extract_confidence(verified)
        consensus = "VERIFIED: YES" in verified.upper() or final_conf >= self.consensus_threshold

        return DebateResult(
            final_answer=best_answer,
            rounds=rounds,
            consensus_reached=consensus,
            confidence=final_conf,
            dissenting_views=dissenting,
            winning_argument=best_answer,
        )
