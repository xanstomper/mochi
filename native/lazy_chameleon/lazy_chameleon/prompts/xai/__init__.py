"""Xai — System prompts library."""
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

# xai/grok-3.md
grok_3: str = _read_prompt("grok-3.md")

# xai/grok-4.1-beta.md
grok_4_1_beta: str = _read_prompt("grok-4.1-beta.md")

# xai/grok-4.2.md
grok_4_2: str = _read_prompt("grok-4.2.md")

# xai/grok-4.3-beta.md
grok_4_3_beta: str = _read_prompt("grok-4.3-beta.md")

# xai/grok-4.md
grok_4: str = _read_prompt("grok-4.md")

# xai/grok-account.md
grok_account: str = _read_prompt("grok-account.md")

# xai/grok-api.md
grok_api: str = _read_prompt("grok-api.md")

# xai/grok-build.md
grok_build: str = _read_prompt("grok-build.md")

# xai/grok-expert.md
grok_expert: str = _read_prompt("grok-expert.md")

# xai/grok-personas.md
grok_personas: str = _read_prompt("grok-personas.md")

# xai/grok.com-post-new-safety-instructions.md
grok_com_post_new_safety_instructions: str = _read_prompt("grok.com-post-new-safety-instructions.md")


ALL_PROMPTS: Dict[str, str] = {
    "grok_3": grok_3,
    "grok_4_1_beta": grok_4_1_beta,
    "grok_4_2": grok_4_2,
    "grok_4_3_beta": grok_4_3_beta,
    "grok_4": grok_4,
    "grok_account": grok_account,
    "grok_api": grok_api,
    "grok_build": grok_build,
    "grok_expert": grok_expert,
    "grok_personas": grok_personas,
    "grok_com_post_new_safety_instructions": grok_com_post_new_safety_instructions,
}

__all__ = ["grok_3", "grok_4_1_beta", "grok_4_2", "grok_4_3_beta", "grok_4", "grok_account", "grok_api", "grok_build", "grok_expert", "grok_personas", "grok_com_post_new_safety_instructions", "ALL_PROMPTS", "_read_prompt"]