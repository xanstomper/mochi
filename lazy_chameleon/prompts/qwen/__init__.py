"""Qwen — System prompts library."""
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

# qwen/qwen-3.6-plus.md
qwen_3_6_plus: str = _read_prompt("qwen-3.6-plus.md")


ALL_PROMPTS: Dict[str, str] = {
    "qwen_3_6_plus": qwen_3_6_plus,
}

__all__ = ["qwen_3_6_plus", "ALL_PROMPTS", "_read_prompt"]