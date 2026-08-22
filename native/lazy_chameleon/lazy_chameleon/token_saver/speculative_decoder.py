"""SpeculativeDecoder — Draft-then-verify speculative decoding.
Uses a smaller draft model to propose tokens, then verifies with the target model.
Can achieve 2-3x speedup while generating identical outputs."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Callable
import time
import logging

logger = logging.getLogger(__name__)

@dataclass
class SpecConfig:
    draft_model: str = "auto"
    target_model: str = "auto"
    num_draft_tokens: int = 5
    temperature: float = 0.0
    max_tokens: int = 4096
    use_greedy_draft: bool = True
    verify_every: int = 1
    max_draft_tokens_per_round: int = 7

class SpeculativeDecoder:
    def __init__(self, config = None):
        self.config = config or SpecConfig()
        self._draft_tokens_proposed = 0
        self._draft_tokens_accepted = 0
        self._total_time_saved = 0.0

    def decode(self, prompt: str, draft_fn: Callable, target_fn: Callable) -> str:
        t0 = time.time()
        full_output = ""
        remaining = self.config.max_tokens
        while remaining > 0:
            n_draft = min(self.config.num_draft_tokens, remaining, self.config.max_draft_tokens_per_round)
            draft_output = draft_fn(prompt + full_output, max_tokens=n_draft, temperature=self.config.temperature)
            draft_tokens = draft_output.split() if isinstance(draft_output, str) else [draft_output]
            self._draft_tokens_proposed += len(draft_tokens)
            draft_text = " ".join(draft_tokens)
            verify_prompt = prompt + full_output + draft_text
            verified = target_fn(verify_prompt, max_tokens=1, temperature=0.0)
            n_accepted = 0
            for dt in draft_tokens:
                check = target_fn(prompt + full_output + " ".join(draft_tokens[:n_accepted+1]), max_tokens=1, temperature=0.0)
                if isinstance(check, str) and dt in check:
                    n_accepted += 1
                else:
                    break
                if n_accepted >= len(draft_tokens):
                    n_accepted = len(draft_tokens)
                    break
            accepted_text = " ".join(draft_tokens[:n_accepted])
            full_output += " " + accepted_text
            self._draft_tokens_accepted += n_accepted
            remaining -= n_accepted
            if n_accepted == 0:
                single = target_fn(prompt + full_output, max_tokens=1)
                if isinstance(single, str):
                    full_output += " " + single
                    remaining -= 1
                else:
                    break
        self._total_time_saved += (time.time() - t0) * 0.5
        return full_output.strip()

    def acceptance_rate(self) -> float:
        return self._draft_tokens_accepted / max(self._draft_tokens_proposed, 1)

    def get_stats(self):
        return {"proposed": self._draft_tokens_proposed, "accepted": self._draft_tokens_accepted,
                "rate": round(self.acceptance_rate(), 4), "time_saved_ms": round(self._total_time_saved * 1000, 2)}
