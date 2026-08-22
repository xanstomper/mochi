"""Meta — System prompts library."""
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

# meta/meta-ai.md
meta_ai: str = _read_prompt("meta-ai.md")


ALL_PROMPTS: Dict[str, str] = {
    "meta_ai": meta_ai,
}

__all__ = ["meta_ai", "ALL_PROMPTS", "_read_prompt"]