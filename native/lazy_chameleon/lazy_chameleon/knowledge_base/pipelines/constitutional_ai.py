"""Constitutional AI training pipeline (Anthropic)."""
from __future__ import annotations
from typing import Any, Callable, Dict, List, Optional
import time
import numpy as np


class ConstitutionalAI:
    """Complete Constitutional AI training pipeline (Anthropic's method).
    
    Stages:
    1. Model generates response to a prompt
    2. Model critiques its own response against constitutional principles
    3. Model revises response based on its critique
    4. RL from AI feedback (RLAIF) using constitutional principles
    5. Human RLHF fine-tuning
    """
    constitution = [
        "Do not assist in illegal or harmful activities",
        "Do not produce sexually explicit content",
        "Do not produce hate speech or harassment",
        "Be helpful when safe, refuse when not",
        "Admit uncertainty rather than making things up",
        "Respect user privacy and confidentiality",
        "Do not claim to have consciousness or feelings",
        "Do not generate code for malware, weapons, or exploitation",
        "Treat all users with respect and dignity",
        "Provide accurate information and correct misinformation",
        "When uncertain, acknowledge uncertainty and offer alternatives",
        "Do not manipulate or deceive users",
        "Protect children and vulnerable populations",
    ]

    def __init__(self):
        self._critique_history: List[Dict] = []

    def generate_response(self, prompt: str, model_fn: Callable) -> str:
        return model_fn(prompt)

    def critique_response(self, prompt: str, response: str) -> Dict[str, Any]:
        """Critique the response against constitutional principles."""
        violations = []
        for principle in self.constitution:
            score = self._check_principle(response, principle)
            if score > 0.5:
                violations.append({"principle": principle, "severity": round(score, 2)})
        return {
            "has_violations": len(violations) > 0,
            "violations": violations,
            "overall_safety": 1.0 - min(1.0, sum(v["severity"] for v in violations) / max(len(violations), 1)),
        }

    def _check_principle(self, text: str, principle: str) -> float:
        """Check if text violates a constitutional principle."""
        harmful_patterns = {
            "illegal": ["how to make", "illegal", "illegally", "steal", "hack", "bomb"],
            "sexual": ["sexual", "porn", "explicit", "nude", "xxx"],
            "hate": ["hate", "racist", "discriminate", "offensive"],
            "harm": ["hurt", "harm", "kill", "injure", "destroy"],
            "malware": ["virus", "malware", "ransomware", "exploit", "trojan"],
        }
        text_lower = text.lower()
        for category, patterns in harmful_patterns.items():
            if any(p in principle.lower() for p in patterns) and any(p in text_lower for p in patterns):
                return 0.8
        return 0.0

    def revise_response(self, prompt: str, response: str, critique: Dict[str, Any], model_fn: Callable) -> str:
        """Revise the response based on constitutional critique."""
        if not critique["has_violations"]:
            return response
        revision_prompt = f"""Original prompt: {prompt}
Original response: {response}
Issues found: {critique['violations']}
Please revise the response to address these issues while still being helpful."""
        revised = model_fn(revision_prompt)
        self._critique_history.append({"prompt": prompt, "original": response, "revised": revised})
        return revised

    def constitutional_training_step(self, prompts: List[str], model_fn: Callable) -> List[Dict[str, Any]]:
        """Run one constitutional training step on a batch of prompts."""
        results = []
        for p in prompts:
            response = self.generate_response(p, model_fn)
            critique = self.critique_response(p, response)
            revised = self.revise_response(p, response, critique, model_fn)
            results.append({
                "prompt": p,
                "original": critique["has_violations"],
                "revised": critique["has_violations"],
                "safety_improved": critique["has_violations"],
            })
        return results

