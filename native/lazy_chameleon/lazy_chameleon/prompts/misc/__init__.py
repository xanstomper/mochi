"""Misc — System prompts library."""
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

# misc/amp-code.md
amp_code: str = _read_prompt("amp-code.md")

# misc/brave-search.md
brave_search: str = _read_prompt("brave-search.md")

# misc/character-ai.md
character_ai: str = _read_prompt("character-ai.md")

# misc/confer.md
confer: str = _read_prompt("confer.md")

# misc/devin-cli.md
devin_cli: str = _read_prompt("devin-cli.md")

# misc/docker-gordon-ai.md
docker_gordon_ai: str = _read_prompt("docker-gordon-ai.md")

# misc/elevenlabs-voice-agent.md
elevenlabs_voice_agent: str = _read_prompt("elevenlabs-voice-agent.md")

# misc/fellou-browser.md
fellou_browser: str = _read_prompt("fellou-browser.md")

# misc/gizmo-ai.md
gizmo_ai: str = _read_prompt("gizmo-ai.md")

# misc/hermes.md
hermes: str = _read_prompt("hermes.md")

# misc/indus-ai.md
indus_ai: str = _read_prompt("indus-ai.md")

# misc/kagi-assistant.md
kagi_assistant: str = _read_prompt("kagi-assistant.md")

# misc/minimax-m2.5.md
minimax_m2_5: str = _read_prompt("minimax-m2.5.md")

# misc/opencode.md
opencode: str = _read_prompt("opencode.md")

# misc/proton-lumo-ai.md
proton_lumo_ai: str = _read_prompt("proton-lumo-ai.md")

# misc/raycast-ai.md
raycast_ai: str = _read_prompt("raycast-ai.md")

# misc/reddit-answers.md
reddit_answers: str = _read_prompt("reddit-answers.md")

# misc/sesame-ai-maya.md
sesame_ai_maya: str = _read_prompt("sesame-ai-maya.md")

# misc/stack-overflow-ai-assist.md
stack_overflow_ai_assist: str = _read_prompt("stack-overflow-ai-assist.md")

# misc/t3-code.md
t3_code: str = _read_prompt("t3-code.md")

# misc/t3.chat.md
t3_chat: str = _read_prompt("t3.chat.md")

# misc/warp-2.0-agent.md
warp_2_0_agent: str = _read_prompt("warp-2.0-agent.md")

# misc/zed.md
zed: str = _read_prompt("zed.md")


ALL_PROMPTS: Dict[str, str] = {
    "amp_code": amp_code,
    "brave_search": brave_search,
    "character_ai": character_ai,
    "confer": confer,
    "devin_cli": devin_cli,
    "docker_gordon_ai": docker_gordon_ai,
    "elevenlabs_voice_agent": elevenlabs_voice_agent,
    "fellou_browser": fellou_browser,
    "gizmo_ai": gizmo_ai,
    "hermes": hermes,
    "indus_ai": indus_ai,
    "kagi_assistant": kagi_assistant,
    "minimax_m2_5": minimax_m2_5,
    "opencode": opencode,
    "proton_lumo_ai": proton_lumo_ai,
    "raycast_ai": raycast_ai,
    "reddit_answers": reddit_answers,
    "sesame_ai_maya": sesame_ai_maya,
    "stack_overflow_ai_assist": stack_overflow_ai_assist,
    "t3_code": t3_code,
    "t3_chat": t3_chat,
    "warp_2_0_agent": warp_2_0_agent,
    "zed": zed,
}

__all__ = ["amp_code", "brave_search", "character_ai", "confer", "devin_cli", "docker_gordon_ai", "elevenlabs_voice_agent", "fellou_browser", "gizmo_ai", "hermes", "indus_ai", "kagi_assistant", "minimax_m2_5", "opencode", "proton_lumo_ai", "raycast_ai", "reddit_answers", "sesame_ai_maya", "stack_overflow_ai_assist", "t3_code", "t3_chat", "warp_2_0_agent", "zed", "ALL_PROMPTS", "_read_prompt"]