"""HarnessInjector — Detects "Inject Lazy Chameleon" and injects the harness."""
from __future__ import annotations
from typing import Any, Dict, List, Optional
import re

TRIGGER_PHRASES = [
    r"inject lazy chameleon",
    r"use lazy chameleon",
    r"lazy chameleon harness",
    r"activate lazy chameleon",
    r"load lazy chameleon",
    r"enable lazy chameleon",
    r"init lazy chameleon",
    r"lazy chameleon mode",
    r"chameleon inject",
    r"harness lazy chameleon",
    r"lazy chameleon .*?tool",
    r"lazy chameleon .*?module",
]


def detect_injection_triggers(text: str) -> bool:
    """Check if text contains any trigger phrase for Lazy Chameleon injection."""
    lower = text.lower()
    for pattern in TRIGGER_PHRASES:
        if re.search(pattern, lower):
            return True
    return False


class HarnessInjector:
    def __init__(self):
        self._injected = False
        self._injection_history: List[str] = []

    def check_and_inject(self, user_input: str, system_prompt: str = "") -> str:
        """Check if user wants Lazy Chameleon and inject harness."""
        if detect_injection_triggers(user_input):
            from lazy_chameleon.harness.harness_system_prompt import HARNESS_SYSTEM_PROMPT, HARNESS_SHORT_PROMPT
            if "harness" in system_prompt and "LAZY CHAMELEON" in system_prompt:
                return f"{HARNESS_SHORT_PROMPT}\n\n{user_input}"
            self._injected = True
            self._injection_history.append(user_input)
            return f"{HARNESS_SYSTEM_PROMPT}\n\n{user_input}"
        return user_input

    def inject_prompt(self, original_prompt: str, mode: str = "full") -> str:
        """Prepend Lazy Chameleon harness to any prompt."""
        from lazy_chameleon.harness.harness_system_prompt import HARNESS_SYSTEM_PROMPT, HARNESS_SHORT_PROMPT
        if mode == "full":
            return HARNESS_SYSTEM_PROMPT + "\n" + original_prompt
        elif mode == "short":
            return HARNESS_SHORT_PROMPT + "\n" + original_prompt
        elif mode == "auto":
            if len(original_prompt) > 2000:
                return HARNESS_SHORT_PROMPT + "\n" + original_prompt
            return HARNESS_SYSTEM_PROMPT + "\n" + original_prompt
        return original_prompt

    def is_injected(self) -> bool:
        return self._injected

    def get_injection_count(self) -> int:
        return len(self._injection_history)
