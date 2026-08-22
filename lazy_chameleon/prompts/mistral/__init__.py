"""Mistral — System prompts library."""
from __future__ import annotations
from typing import Dict, List, Optional
import os


def _read_prompt(path: str) -> str:
    """Read a prompt file from disk."""
    full = os.path.join(os.path.dirname(__file__), path)
    if os.path.exists(full):
        with open(full, "r", encoding="utf-8") as f:
            return f.read()
    return ""

# mistral/mistral-code.md
mistral_code: str = _read_prompt("mistral-code.md")

# mistral/mistral-medium-3.5.md
mistral_medium_3_5: str = _read_prompt("mistral-medium-3.5.md")


ALL_PROMPTS: Dict[str, str] = {
    "mistral_code": mistral_code,
    "mistral_medium_3_5": mistral_medium_3_5,
}

__all__ = ["mistral_code", "mistral_medium_3_5", "ALL_PROMPTS", "_read_prompt"]