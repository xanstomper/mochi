"""Google — System prompts library."""
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

# google/ai-studio-build.md
ai_studio_build: str = _read_prompt("ai-studio-build.md")

# google/antigravity-cli.md
antigravity_cli: str = _read_prompt("antigravity-cli.md")

# google/gemini-2.0-flash-webapp.md
gemini_2_0_flash_webapp: str = _read_prompt("gemini-2.0-flash-webapp.md")

# google/gemini-2.5-flash-image-preview.md
gemini_2_5_flash_image_preview: str = _read_prompt("gemini-2.5-flash-image-preview.md")

# google/gemini-2.5-pro-api.md
gemini_2_5_pro_api: str = _read_prompt("gemini-2.5-pro-api.md")

# google/gemini-2.5-pro-guided-learning.md
gemini_2_5_pro_guided_learning: str = _read_prompt("gemini-2.5-pro-guided-learning.md")

# google/gemini-2.5-pro-webapp.md
gemini_2_5_pro_webapp: str = _read_prompt("gemini-2.5-pro-webapp.md")

# google/gemini-3-flash.md
gemini_3_flash: str = _read_prompt("gemini-3-flash.md")

# google/gemini-3-pro.md
gemini_3_pro: str = _read_prompt("gemini-3-pro.md")

# google/gemini-3.1-pro-api.md
gemini_3_1_pro_api: str = _read_prompt("gemini-3.1-pro-api.md")

# google/gemini-3.1-pro.md
gemini_3_1_pro: str = _read_prompt("gemini-3.1-pro.md")

# google/gemini-3.5-flash-ai-studio.md
gemini_3_5_flash_ai_studio: str = _read_prompt("gemini-3.5-flash-ai-studio.md")

# google/gemini-3.5-flash.md
gemini_3_5_flash: str = _read_prompt("gemini-3.5-flash.md")

# google/gemini-cli.md
gemini_cli: str = _read_prompt("gemini-cli.md")

# google/gemini-diffusion.md
gemini_diffusion: str = _read_prompt("gemini-diffusion.md")

# google/gemini-in-chrome.md
gemini_in_chrome: str = _read_prompt("gemini-in-chrome.md")

# google/gemini-workspace.md
gemini_workspace: str = _read_prompt("gemini-workspace.md")

# google/gemini-youtube.md
gemini_youtube: str = _read_prompt("gemini-youtube.md")

# google/google-search-ai-mode.md
google_search_ai_mode: str = _read_prompt("google-search-ai-mode.md")

# google/jules.md
jules: str = _read_prompt("jules.md")

# google/nano-banana-2-api.md
nano_banana_2_api: str = _read_prompt("nano-banana-2-api.md")

# google/notebooklm-chat.md
notebooklm_chat: str = _read_prompt("notebooklm-chat.md")


ALL_PROMPTS: Dict[str, str] = {
    "ai_studio_build": ai_studio_build,
    "antigravity_cli": antigravity_cli,
    "gemini_2_0_flash_webapp": gemini_2_0_flash_webapp,
    "gemini_2_5_flash_image_preview": gemini_2_5_flash_image_preview,
    "gemini_2_5_pro_api": gemini_2_5_pro_api,
    "gemini_2_5_pro_guided_learning": gemini_2_5_pro_guided_learning,
    "gemini_2_5_pro_webapp": gemini_2_5_pro_webapp,
    "gemini_3_flash": gemini_3_flash,
    "gemini_3_pro": gemini_3_pro,
    "gemini_3_1_pro_api": gemini_3_1_pro_api,
    "gemini_3_1_pro": gemini_3_1_pro,
    "gemini_3_5_flash_ai_studio": gemini_3_5_flash_ai_studio,
    "gemini_3_5_flash": gemini_3_5_flash,
    "gemini_cli": gemini_cli,
    "gemini_diffusion": gemini_diffusion,
    "gemini_in_chrome": gemini_in_chrome,
    "gemini_workspace": gemini_workspace,
    "gemini_youtube": gemini_youtube,
    "google_search_ai_mode": google_search_ai_mode,
    "jules": jules,
    "nano_banana_2_api": nano_banana_2_api,
    "notebooklm_chat": notebooklm_chat,
}

__all__ = ["ai_studio_build", "antigravity_cli", "gemini_2_0_flash_webapp", "gemini_2_5_flash_image_preview", "gemini_2_5_pro_api", "gemini_2_5_pro_guided_learning", "gemini_2_5_pro_webapp", "gemini_3_flash", "gemini_3_pro", "gemini_3_1_pro_api", "gemini_3_1_pro", "gemini_3_5_flash_ai_studio", "gemini_3_5_flash", "gemini_cli", "gemini_diffusion", "gemini_in_chrome", "gemini_workspace", "gemini_youtube", "google_search_ai_mode", "jules", "nano_banana_2_api", "notebooklm_chat", "ALL_PROMPTS", "_read_prompt"]