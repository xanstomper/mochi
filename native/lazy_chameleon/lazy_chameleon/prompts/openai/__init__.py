"""Openai — System prompts library."""
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

# openai/4o-2025-09-03-new-personality.md
model_4o_2025_09_03_new_personality: str = _read_prompt("4o-2025-09-03-new-personality.md")

# openai/API/README.md
api_readme: str = _read_prompt("API/README.md")

# openai/API/gpt-5-reasoning-effort-high-api.md
api_gpt_5_reasoning_effort_high_api: str = _read_prompt("API/gpt-5-reasoning-effort-high-api.md")

# openai/API/o3-high-api.md
api_o3_high_api: str = _read_prompt("API/o3-high-api.md")

# openai/API/o3-low-api.md
api_o3_low_api: str = _read_prompt("API/o3-low-api.md")

# openai/API/o3-medium-api.md
api_o3_medium_api: str = _read_prompt("API/o3-medium-api.md")

# openai/API/o4-mini-high.md
api_o4_mini_high: str = _read_prompt("API/o4-mini-high.md")

# openai/API/o4-mini-low-api.md
api_o4_mini_low_api: str = _read_prompt("API/o4-mini-low-api.md")

# openai/API/o4-mini-medium-api.md
api_o4_mini_medium_api: str = _read_prompt("API/o4-mini-medium-api.md")

# openai/Codex/codex-auto-review.md
codex_codex_auto_review: str = _read_prompt("Codex/codex-auto-review.md")

# openai/Codex/codex-full.md
codex_codex_full: str = _read_prompt("Codex/codex-full.md")

# openai/Codex/computer-use.md
codex_computer_use: str = _read_prompt("Codex/computer-use.md")

# openai/Codex/control-chrome.md
codex_control_chrome: str = _read_prompt("Codex/control-chrome.md")

# openai/Codex/control-in-app-browser.md
codex_control_in_app_browser: str = _read_prompt("Codex/control-in-app-browser.md")

# openai/Codex/gpt-5.3-codex-spark.md
codex_gpt_5_3_codex_spark: str = _read_prompt("Codex/gpt-5.3-codex-spark.md")

# openai/Codex/gpt-5.4-mini.md
codex_gpt_5_4_mini: str = _read_prompt("Codex/gpt-5.4-mini.md")

# openai/Codex/gpt-5.4.md
codex_gpt_5_4: str = _read_prompt("Codex/gpt-5.4.md")

# openai/Codex/gpt-5.5.md
codex_gpt_5_5: str = _read_prompt("Codex/gpt-5.5.md")

# openai/Codex/gpt-5.6.md
codex_gpt_5_6: str = _read_prompt("Codex/gpt-5.6.md")

# openai/Codex/old/gpt-5-codex-mini.md
codex_old_gpt_5_codex_mini: str = _read_prompt("Codex/old/gpt-5-codex-mini.md")

# openai/Codex/old/gpt-5-codex.md
codex_old_gpt_5_codex: str = _read_prompt("Codex/old/gpt-5-codex.md")

# openai/Codex/old/gpt-5.1-codex-max.md
codex_old_gpt_5_1_codex_max: str = _read_prompt("Codex/old/gpt-5.1-codex-max.md")

# openai/Codex/old/gpt-5.1-codex-mini.md
codex_old_gpt_5_1_codex_mini: str = _read_prompt("Codex/old/gpt-5.1-codex-mini.md")

# openai/Codex/old/gpt-5.1-codex.md
codex_old_gpt_5_1_codex: str = _read_prompt("Codex/old/gpt-5.1-codex.md")

# openai/Codex/old/gpt-5.1.md
codex_old_gpt_5_1: str = _read_prompt("Codex/old/gpt-5.1.md")

# openai/Codex/old/gpt-5.2-codex.md
codex_old_gpt_5_2_codex: str = _read_prompt("Codex/old/gpt-5.2-codex.md")

# openai/Codex/old/gpt-5.2.md
codex_old_gpt_5_2: str = _read_prompt("Codex/old/gpt-5.2.md")

# openai/Codex/old/gpt-5.3-codex.md
codex_old_gpt_5_3_codex: str = _read_prompt("Codex/old/gpt-5.3-codex.md")

# openai/Codex/old/gpt-5.md
codex_old_gpt_5: str = _read_prompt("Codex/old/gpt-5.md")

# openai/Codex/old/personality_friendly_gpt-5.2-codex.md
codex_old_personality_friendly_gpt_5_2_codex: str = _read_prompt("Codex/old/personality_friendly_gpt-5.2-codex.md")

# openai/Codex/old/personality_pragmatic_gpt-5.2-codex.md
codex_old_personality_pragmatic_gpt_5_2_codex: str = _read_prompt("Codex/old/personality_pragmatic_gpt-5.2-codex.md")

# openai/Codex/personality_friendly.md
codex_personality_friendly: str = _read_prompt("Codex/personality_friendly.md")

# openai/Codex/personality_friendly_gpt-5.5.md
codex_personality_friendly_gpt_5_5: str = _read_prompt("Codex/personality_friendly_gpt-5.5.md")

# openai/Codex/personality_pragmatic.md
codex_personality_pragmatic: str = _read_prompt("Codex/personality_pragmatic.md")

# openai/Codex/personality_pragmatic_gpt-5.5.md
codex_personality_pragmatic_gpt_5_5: str = _read_prompt("Codex/personality_pragmatic_gpt-5.5.md")

# openai/Codex/plan_mode.md
codex_plan_mode: str = _read_prompt("Codex/plan_mode.md")

# openai/Old/chatgpt.com-o4-mini.md
old_chatgpt_com_o4_mini: str = _read_prompt("Old/chatgpt.com-o4-mini.md")

# openai/chatgpt-4.5.md
chatgpt_4_5: str = _read_prompt("chatgpt-4.5.md")

# openai/chatgpt-atlas.md
chatgpt_atlas: str = _read_prompt("chatgpt-atlas.md")

# openai/chatgpt-gpt-5-agent-mode.md
chatgpt_gpt_5_agent_mode: str = _read_prompt("chatgpt-gpt-5-agent-mode.md")

# openai/gpt-4.1-mini.md
gpt_4_1_mini: str = _read_prompt("gpt-4.1-mini.md")

# openai/gpt-4.1.md
gpt_4_1: str = _read_prompt("gpt-4.1.md")

# openai/gpt-4.5.md
gpt_4_5: str = _read_prompt("gpt-4.5.md")

# openai/gpt-4o-advanced-voice-mode.md
gpt_4o_advanced_voice_mode: str = _read_prompt("gpt-4o-advanced-voice-mode.md")

# openai/gpt-4o-legacy-voice-mode.md
gpt_4o_legacy_voice_mode: str = _read_prompt("gpt-4o-legacy-voice-mode.md")

# openai/gpt-4o-whatsapp.md
gpt_4o_whatsapp: str = _read_prompt("gpt-4o-whatsapp.md")

# openai/gpt-4o.md
gpt_4o: str = _read_prompt("gpt-4o.md")

# openai/gpt-5-cynic-personality.md
gpt_5_cynic_personality: str = _read_prompt("gpt-5-cynic-personality.md")

# openai/gpt-5-listener-personality.md
gpt_5_listener_personality: str = _read_prompt("gpt-5-listener-personality.md")

# openai/gpt-5-nerdy-personality.md
gpt_5_nerdy_personality: str = _read_prompt("gpt-5-nerdy-personality.md")

# openai/gpt-5-robot-personality.md
gpt_5_robot_personality: str = _read_prompt("gpt-5-robot-personality.md")

# openai/gpt-5-thinking.md
gpt_5_thinking: str = _read_prompt("gpt-5-thinking.md")

# openai/gpt-5.1-candid.md
gpt_5_1_candid: str = _read_prompt("gpt-5.1-candid.md")

# openai/gpt-5.1-cynical.md
gpt_5_1_cynical: str = _read_prompt("gpt-5.1-cynical.md")

# openai/gpt-5.1-default.md
gpt_5_1_default: str = _read_prompt("gpt-5.1-default.md")

# openai/gpt-5.1-efficient.md
gpt_5_1_efficient: str = _read_prompt("gpt-5.1-efficient.md")

# openai/gpt-5.1-friendly.md
gpt_5_1_friendly: str = _read_prompt("gpt-5.1-friendly.md")

# openai/gpt-5.1-nerdy.md
gpt_5_1_nerdy: str = _read_prompt("gpt-5.1-nerdy.md")

# openai/gpt-5.1-professional.md
gpt_5_1_professional: str = _read_prompt("gpt-5.1-professional.md")

# openai/gpt-5.1-quirky.md
gpt_5_1_quirky: str = _read_prompt("gpt-5.1-quirky.md")

# openai/gpt-5.2-mini-free-account.md
gpt_5_2_mini_free_account: str = _read_prompt("gpt-5.2-mini-free-account.md")

# openai/gpt-5.2-thinking.md
gpt_5_2_thinking: str = _read_prompt("gpt-5.2-thinking.md")

# openai/gpt-5.3-chat-api.md
gpt_5_3_chat_api: str = _read_prompt("gpt-5.3-chat-api.md")

# openai/gpt-5.3-codex-api.md
gpt_5_3_codex_api: str = _read_prompt("gpt-5.3-codex-api.md")

# openai/gpt-5.3-instant.md
gpt_5_3_instant: str = _read_prompt("gpt-5.3-instant.md")

# openai/gpt-5.4-api.md
gpt_5_4_api: str = _read_prompt("gpt-5.4-api.md")

# openai/gpt-5.4-thinking.md
gpt_5_4_thinking: str = _read_prompt("gpt-5.4-thinking.md")

# openai/gpt-5.5-api.md
gpt_5_5_api: str = _read_prompt("gpt-5.5-api.md")

# openai/gpt-5.5-instant.md
gpt_5_5_instant: str = _read_prompt("gpt-5.5-instant.md")

# openai/gpt-5.5-pro-api.md
gpt_5_5_pro_api: str = _read_prompt("gpt-5.5-pro-api.md")

# openai/gpt-5.5-thinking.md
gpt_5_5_thinking: str = _read_prompt("gpt-5.5-thinking.md")

# openai/gpt-5.6-sol-extra-high.md
gpt_5_6_sol_extra_high: str = _read_prompt("gpt-5.6-sol-extra-high.md")

# openai/image-safety-policies.md
image_safety_policies: str = _read_prompt("image-safety-policies.md")

# openai/monday-gpt.md
monday_gpt: str = _read_prompt("monday-gpt.md")

# openai/o3.md
o3: str = _read_prompt("o3.md")

# openai/o4-mini-high.md
o4_mini_high: str = _read_prompt("o4-mini-high.md")

# openai/o4-mini.md
o4_mini: str = _read_prompt("o4-mini.md")

# openai/prompt-automation-context.md
prompt_automation_context: str = _read_prompt("prompt-automation-context.md")

# openai/prompt-image-safety-policies.md
prompt_image_safety_policies: str = _read_prompt("prompt-image-safety-policies.md")

# openai/study-and-learn.md
study_and_learn: str = _read_prompt("study-and-learn.md")

# openai/tool-advanced-memory.md
tool_advanced_memory: str = _read_prompt("tool-advanced-memory.md")

# openai/tool-canvas-canmore.md
tool_canvas_canmore: str = _read_prompt("tool-canvas-canmore.md")

# openai/tool-create-image-image_gen.md
tool_create_image_image_gen: str = _read_prompt("tool-create-image-image_gen.md")

# openai/tool-deep-research.md
tool_deep_research: str = _read_prompt("tool-deep-research.md")

# openai/tool-file_search.md
tool_file_search: str = _read_prompt("tool-file_search.md")

# openai/tool-memory-bio.md
tool_memory_bio: str = _read_prompt("tool-memory-bio.md")

# openai/tool-python-code.md
tool_python_code: str = _read_prompt("tool-python-code.md")

# openai/tool-python.md
tool_python: str = _read_prompt("tool-python.md")

# openai/tool-web-search.md
tool_web_search: str = _read_prompt("tool-web-search.md")


ALL_PROMPTS: Dict[str, str] = {
    "4o_2025_09_03_new_personality": model_4o_2025_09_03_new_personality,
    "api_readme": api_readme,
    "api_gpt_5_reasoning_effort_high_api": api_gpt_5_reasoning_effort_high_api,
    "api_o3_high_api": api_o3_high_api,
    "api_o3_low_api": api_o3_low_api,
    "api_o3_medium_api": api_o3_medium_api,
    "api_o4_mini_high": api_o4_mini_high,
    "api_o4_mini_low_api": api_o4_mini_low_api,
    "api_o4_mini_medium_api": api_o4_mini_medium_api,
    "codex_codex_auto_review": codex_codex_auto_review,
    "codex_codex_full": codex_codex_full,
    "codex_computer_use": codex_computer_use,
    "codex_control_chrome": codex_control_chrome,
    "codex_control_in_app_browser": codex_control_in_app_browser,
    "codex_gpt_5_3_codex_spark": codex_gpt_5_3_codex_spark,
    "codex_gpt_5_4_mini": codex_gpt_5_4_mini,
    "codex_gpt_5_4": codex_gpt_5_4,
    "codex_gpt_5_5": codex_gpt_5_5,
    "codex_gpt_5_6": codex_gpt_5_6,
    "codex_old_gpt_5_codex_mini": codex_old_gpt_5_codex_mini,
    "codex_old_gpt_5_codex": codex_old_gpt_5_codex,
    "codex_old_gpt_5_1_codex_max": codex_old_gpt_5_1_codex_max,
    "codex_old_gpt_5_1_codex_mini": codex_old_gpt_5_1_codex_mini,
    "codex_old_gpt_5_1_codex": codex_old_gpt_5_1_codex,
    "codex_old_gpt_5_1": codex_old_gpt_5_1,
    "codex_old_gpt_5_2_codex": codex_old_gpt_5_2_codex,
    "codex_old_gpt_5_2": codex_old_gpt_5_2,
    "codex_old_gpt_5_3_codex": codex_old_gpt_5_3_codex,
    "codex_old_gpt_5": codex_old_gpt_5,
    "codex_old_personality_friendly_gpt_5_2_codex": codex_old_personality_friendly_gpt_5_2_codex,
    "codex_old_personality_pragmatic_gpt_5_2_codex": codex_old_personality_pragmatic_gpt_5_2_codex,
    "codex_personality_friendly": codex_personality_friendly,
    "codex_personality_friendly_gpt_5_5": codex_personality_friendly_gpt_5_5,
    "codex_personality_pragmatic": codex_personality_pragmatic,
    "codex_personality_pragmatic_gpt_5_5": codex_personality_pragmatic_gpt_5_5,
    "codex_plan_mode": codex_plan_mode,
    "old_chatgpt_com_o4_mini": old_chatgpt_com_o4_mini,
    "chatgpt_4_5": chatgpt_4_5,
    "chatgpt_atlas": chatgpt_atlas,
    "chatgpt_gpt_5_agent_mode": chatgpt_gpt_5_agent_mode,
    "gpt_4_1_mini": gpt_4_1_mini,
    "gpt_4_1": gpt_4_1,
    "gpt_4_5": gpt_4_5,
    "gpt_4o_advanced_voice_mode": gpt_4o_advanced_voice_mode,
    "gpt_4o_legacy_voice_mode": gpt_4o_legacy_voice_mode,
    "gpt_4o_whatsapp": gpt_4o_whatsapp,
    "gpt_4o": gpt_4o,
    "gpt_5_cynic_personality": gpt_5_cynic_personality,
    "gpt_5_listener_personality": gpt_5_listener_personality,
    "gpt_5_nerdy_personality": gpt_5_nerdy_personality,
    "gpt_5_robot_personality": gpt_5_robot_personality,
    "gpt_5_thinking": gpt_5_thinking,
    "gpt_5_1_candid": gpt_5_1_candid,
    "gpt_5_1_cynical": gpt_5_1_cynical,
    "gpt_5_1_default": gpt_5_1_default,
    "gpt_5_1_efficient": gpt_5_1_efficient,
    "gpt_5_1_friendly": gpt_5_1_friendly,
    "gpt_5_1_nerdy": gpt_5_1_nerdy,
    "gpt_5_1_professional": gpt_5_1_professional,
    "gpt_5_1_quirky": gpt_5_1_quirky,
    "gpt_5_2_mini_free_account": gpt_5_2_mini_free_account,
    "gpt_5_2_thinking": gpt_5_2_thinking,
    "gpt_5_3_chat_api": gpt_5_3_chat_api,
    "gpt_5_3_codex_api": gpt_5_3_codex_api,
    "gpt_5_3_instant": gpt_5_3_instant,
    "gpt_5_4_api": gpt_5_4_api,
    "gpt_5_4_thinking": gpt_5_4_thinking,
    "gpt_5_5_api": gpt_5_5_api,
    "gpt_5_5_instant": gpt_5_5_instant,
    "gpt_5_5_pro_api": gpt_5_5_pro_api,
    "gpt_5_5_thinking": gpt_5_5_thinking,
    "gpt_5_6_sol_extra_high": gpt_5_6_sol_extra_high,
    "image_safety_policies": image_safety_policies,
    "monday_gpt": monday_gpt,
    "o3": o3,
    "o4_mini_high": o4_mini_high,
    "o4_mini": o4_mini,
    "prompt_automation_context": prompt_automation_context,
    "prompt_image_safety_policies": prompt_image_safety_policies,
    "study_and_learn": study_and_learn,
    "tool_advanced_memory": tool_advanced_memory,
    "tool_canvas_canmore": tool_canvas_canmore,
    "tool_create_image_image_gen": tool_create_image_image_gen,
    "tool_deep_research": tool_deep_research,
    "tool_file_search": tool_file_search,
    "tool_memory_bio": tool_memory_bio,
    "tool_python_code": tool_python_code,
    "tool_python": tool_python,
    "tool_web_search": tool_web_search,
}

__all__ = ["4o_2025_09_03_new_personality", "api_readme", "api_gpt_5_reasoning_effort_high_api", "api_o3_high_api", "api_o3_low_api", "api_o3_medium_api", "api_o4_mini_high", "api_o4_mini_low_api", "api_o4_mini_medium_api", "codex_codex_auto_review", "codex_codex_full", "codex_computer_use", "codex_control_chrome", "codex_control_in_app_browser", "codex_gpt_5_3_codex_spark", "codex_gpt_5_4_mini", "codex_gpt_5_4", "codex_gpt_5_5", "codex_gpt_5_6", "codex_old_gpt_5_codex_mini", "codex_old_gpt_5_codex", "codex_old_gpt_5_1_codex_max", "codex_old_gpt_5_1_codex_mini", "codex_old_gpt_5_1_codex", "codex_old_gpt_5_1", "codex_old_gpt_5_2_codex", "codex_old_gpt_5_2", "codex_old_gpt_5_3_codex", "codex_old_gpt_5", "codex_old_personality_friendly_gpt_5_2_codex", "codex_old_personality_pragmatic_gpt_5_2_codex", "codex_personality_friendly", "codex_personality_friendly_gpt_5_5", "codex_personality_pragmatic", "codex_personality_pragmatic_gpt_5_5", "codex_plan_mode", "old_chatgpt_com_o4_mini", "chatgpt_4_5", "chatgpt_atlas", "chatgpt_gpt_5_agent_mode", "gpt_4_1_mini", "gpt_4_1", "gpt_4_5", "gpt_4o_advanced_voice_mode", "gpt_4o_legacy_voice_mode", "gpt_4o_whatsapp", "gpt_4o", "gpt_5_cynic_personality", "gpt_5_listener_personality", "gpt_5_nerdy_personality", "gpt_5_robot_personality", "gpt_5_thinking", "gpt_5_1_candid", "gpt_5_1_cynical", "gpt_5_1_default", "gpt_5_1_efficient", "gpt_5_1_friendly", "gpt_5_1_nerdy", "gpt_5_1_professional", "gpt_5_1_quirky", "gpt_5_2_mini_free_account", "gpt_5_2_thinking", "gpt_5_3_chat_api", "gpt_5_3_codex_api", "gpt_5_3_instant", "gpt_5_4_api", "gpt_5_4_thinking", "gpt_5_5_api", "gpt_5_5_instant", "gpt_5_5_pro_api", "gpt_5_5_thinking", "gpt_5_6_sol_extra_high", "image_safety_policies", "monday_gpt", "o3", "o4_mini_high", "o4_mini", "prompt_automation_context", "prompt_image_safety_policies", "study_and_learn", "tool_advanced_memory", "tool_canvas_canmore", "tool_create_image_image_gen", "tool_deep_research", "tool_file_search", "tool_memory_bio", "tool_python_code", "tool_python", "tool_web_search", "ALL_PROMPTS", "_read_prompt"]