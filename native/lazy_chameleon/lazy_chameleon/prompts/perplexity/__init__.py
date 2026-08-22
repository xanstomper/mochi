"""Perplexity — System prompts library."""
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

# perplexity/comet-browser-assistant.md
comet_browser_assistant: str = _read_prompt("comet-browser-assistant.md")

# perplexity/perplexity-computer.md
perplexity_computer: str = _read_prompt("perplexity-computer.md")

# perplexity/voice-assistant.md
voice_assistant: str = _read_prompt("voice-assistant.md")


ALL_PROMPTS: Dict[str, str] = {
    "comet_browser_assistant": comet_browser_assistant,
    "perplexity_computer": perplexity_computer,
    "voice_assistant": voice_assistant,
}

__all__ = ["comet_browser_assistant", "perplexity_computer", "voice_assistant", "ALL_PROMPTS", "_read_prompt"]