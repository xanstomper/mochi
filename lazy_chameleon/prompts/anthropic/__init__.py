"""Anthropic — System prompts library."""
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

# anthropic/Claude Code/bundled-skills/artifact-design.md
claude_code_bundled_skills_artifact_design: str = _read_prompt("Claude Code/bundled-skills/artifact-design.md")

# anthropic/Claude Code/bundled-skills/batch.md
claude_code_bundled_skills_batch: str = _read_prompt("Claude Code/bundled-skills/batch.md")

# anthropic/Claude Code/bundled-skills/claude-api.md
claude_code_bundled_skills_claude_api: str = _read_prompt("Claude Code/bundled-skills/claude-api.md")

# anthropic/Claude Code/bundled-skills/code-review.md
claude_code_bundled_skills_code_review: str = _read_prompt("Claude Code/bundled-skills/code-review.md")

# anthropic/Claude Code/bundled-skills/code-review/README.md
claude_code_bundled_skills_code_review_readme: str = _read_prompt("Claude Code/bundled-skills/code-review/README.md")

# anthropic/Claude Code/bundled-skills/code-review/high.md
claude_code_bundled_skills_code_review_high: str = _read_prompt("Claude Code/bundled-skills/code-review/high.md")

# anthropic/Claude Code/bundled-skills/code-review/low.md
claude_code_bundled_skills_code_review_low: str = _read_prompt("Claude Code/bundled-skills/code-review/low.md")

# anthropic/Claude Code/bundled-skills/code-review/max.md
claude_code_bundled_skills_code_review_max: str = _read_prompt("Claude Code/bundled-skills/code-review/max.md")

# anthropic/Claude Code/bundled-skills/code-review/medium.md
claude_code_bundled_skills_code_review_medium: str = _read_prompt("Claude Code/bundled-skills/code-review/medium.md")

# anthropic/Claude Code/bundled-skills/code-review/report-findings-tool.md
claude_code_bundled_skills_code_review_report_findings_tool: str = _read_prompt("Claude Code/bundled-skills/code-review/report-findings-tool.md")

# anthropic/Claude Code/bundled-skills/code-review/xhigh.md
claude_code_bundled_skills_code_review_xhigh: str = _read_prompt("Claude Code/bundled-skills/code-review/xhigh.md")

# anthropic/Claude Code/bundled-skills/compact.md
claude_code_bundled_skills_compact: str = _read_prompt("Claude Code/bundled-skills/compact.md")

# anthropic/Claude Code/bundled-skills/dataviz/SKILL.md
claude_code_bundled_skills_dataviz_skill: str = _read_prompt("Claude Code/bundled-skills/dataviz/SKILL.md")

# anthropic/Claude Code/bundled-skills/dataviz/references/anti-patterns.md
claude_code_bundled_skills_dataviz_references_anti_patterns: str = _read_prompt("Claude Code/bundled-skills/dataviz/references/anti-patterns.md")

# anthropic/Claude Code/bundled-skills/dataviz/references/choosing-a-form.md
claude_code_bundled_skills_dataviz_references_choosing_a_form: str = _read_prompt("Claude Code/bundled-skills/dataviz/references/choosing-a-form.md")

# anthropic/Claude Code/bundled-skills/dataviz/references/color-formula.md
claude_code_bundled_skills_dataviz_references_color_formula: str = _read_prompt("Claude Code/bundled-skills/dataviz/references/color-formula.md")

# anthropic/Claude Code/bundled-skills/dataviz/references/components.md
claude_code_bundled_skills_dataviz_references_components: str = _read_prompt("Claude Code/bundled-skills/dataviz/references/components.md")

# anthropic/Claude Code/bundled-skills/dataviz/references/interaction.md
claude_code_bundled_skills_dataviz_references_interaction: str = _read_prompt("Claude Code/bundled-skills/dataviz/references/interaction.md")

# anthropic/Claude Code/bundled-skills/dataviz/references/marks-and-anatomy.md
claude_code_bundled_skills_dataviz_references_marks_and_anatomy: str = _read_prompt("Claude Code/bundled-skills/dataviz/references/marks-and-anatomy.md")

# anthropic/Claude Code/bundled-skills/dataviz/references/palette.md
claude_code_bundled_skills_dataviz_references_palette: str = _read_prompt("Claude Code/bundled-skills/dataviz/references/palette.md")

# anthropic/Claude Code/bundled-skills/debug.md
claude_code_bundled_skills_debug: str = _read_prompt("Claude Code/bundled-skills/debug.md")

# anthropic/Claude Code/bundled-skills/deep-research/SKILL.md
claude_code_bundled_skills_deep_research_skill: str = _read_prompt("Claude Code/bundled-skills/deep-research/SKILL.md")

# anthropic/Claude Code/bundled-skills/doctor/SKILL.md
claude_code_bundled_skills_doctor_skill: str = _read_prompt("Claude Code/bundled-skills/doctor/SKILL.md")

# anthropic/Claude Code/bundled-skills/fewer-permission-prompts.md
claude_code_bundled_skills_fewer_permission_prompts: str = _read_prompt("Claude Code/bundled-skills/fewer-permission-prompts.md")

# anthropic/Claude Code/bundled-skills/init-new.md
claude_code_bundled_skills_init_new: str = _read_prompt("Claude Code/bundled-skills/init-new.md")

# anthropic/Claude Code/bundled-skills/init.md
claude_code_bundled_skills_init: str = _read_prompt("Claude Code/bundled-skills/init.md")

# anthropic/Claude Code/bundled-skills/keybindings-help.md
claude_code_bundled_skills_keybindings_help: str = _read_prompt("Claude Code/bundled-skills/keybindings-help.md")

# anthropic/Claude Code/bundled-skills/loop.md
claude_code_bundled_skills_loop: str = _read_prompt("Claude Code/bundled-skills/loop.md")

# anthropic/Claude Code/bundled-skills/review.md
claude_code_bundled_skills_review: str = _read_prompt("Claude Code/bundled-skills/review.md")

# anthropic/Claude Code/bundled-skills/run-skill-generator/SKILL.md
claude_code_bundled_skills_run_skill_generator_skill: str = _read_prompt("Claude Code/bundled-skills/run-skill-generator/SKILL.md")

# anthropic/Claude Code/bundled-skills/run-skill-generator/examples/cli.md
claude_code_bundled_skills_run_skill_generator_examples_cli: str = _read_prompt("Claude Code/bundled-skills/run-skill-generator/examples/cli.md")

# anthropic/Claude Code/bundled-skills/run-skill-generator/examples/electron.md
claude_code_bundled_skills_run_skill_generator_examples_electron: str = _read_prompt("Claude Code/bundled-skills/run-skill-generator/examples/electron.md")

# anthropic/Claude Code/bundled-skills/run-skill-generator/examples/library.md
claude_code_bundled_skills_run_skill_generator_examples_library: str = _read_prompt("Claude Code/bundled-skills/run-skill-generator/examples/library.md")

# anthropic/Claude Code/bundled-skills/run-skill-generator/examples/playwright.md
claude_code_bundled_skills_run_skill_generator_examples_playwright: str = _read_prompt("Claude Code/bundled-skills/run-skill-generator/examples/playwright.md")

# anthropic/Claude Code/bundled-skills/run-skill-generator/examples/server.md
claude_code_bundled_skills_run_skill_generator_examples_server: str = _read_prompt("Claude Code/bundled-skills/run-skill-generator/examples/server.md")

# anthropic/Claude Code/bundled-skills/run-skill-generator/examples/tui.md
claude_code_bundled_skills_run_skill_generator_examples_tui: str = _read_prompt("Claude Code/bundled-skills/run-skill-generator/examples/tui.md")

# anthropic/Claude Code/bundled-skills/run-skill-generator/template.md
claude_code_bundled_skills_run_skill_generator_template: str = _read_prompt("Claude Code/bundled-skills/run-skill-generator/template.md")

# anthropic/Claude Code/bundled-skills/run.md
claude_code_bundled_skills_run: str = _read_prompt("Claude Code/bundled-skills/run.md")

# anthropic/Claude Code/bundled-skills/schedule.md
claude_code_bundled_skills_schedule: str = _read_prompt("Claude Code/bundled-skills/schedule.md")

# anthropic/Claude Code/bundled-skills/security-review.md
claude_code_bundled_skills_security_review: str = _read_prompt("Claude Code/bundled-skills/security-review.md")

# anthropic/Claude Code/bundled-skills/simplify.md
claude_code_bundled_skills_simplify: str = _read_prompt("Claude Code/bundled-skills/simplify.md")

# anthropic/Claude Code/bundled-skills/update-config.md
claude_code_bundled_skills_update_config: str = _read_prompt("Claude Code/bundled-skills/update-config.md")

# anthropic/Claude Code/bundled-skills/verify.md
claude_code_bundled_skills_verify: str = _read_prompt("Claude Code/bundled-skills/verify.md")

# anthropic/Claude Code/claude-code-2.1.172-fable-5.md
claude_code_claude_code_2_1_172_fable_5: str = _read_prompt("Claude Code/claude-code-2.1.172-fable-5.md")

# anthropic/Claude Code/claude-code-2.1.172-opus-4.6.md
claude_code_claude_code_2_1_172_opus_4_6: str = _read_prompt("Claude Code/claude-code-2.1.172-opus-4.6.md")

# anthropic/Claude Code/claude-code-2.1.172-opus-4.8.md
claude_code_claude_code_2_1_172_opus_4_8: str = _read_prompt("Claude Code/claude-code-2.1.172-opus-4.8.md")

# anthropic/Claude Code/claude-code-docs-assistant.md
claude_code_claude_code_docs_assistant: str = _read_prompt("Claude Code/claude-code-docs-assistant.md")

# anthropic/Claude Code/claude-code-opus-4.6.md
claude_code_claude_code_opus_4_6: str = _read_prompt("Claude Code/claude-code-opus-4.6.md")

# anthropic/Claude Code/claude-code-opus-4.8.md
claude_code_claude_code_opus_4_8: str = _read_prompt("Claude Code/claude-code-opus-4.8.md")

# anthropic/Claude Code/deferred-tools.md
claude_code_deferred_tools: str = _read_prompt("Claude Code/deferred-tools.md")

# anthropic/Claude Code/glob-tool.md
claude_code_glob_tool: str = _read_prompt("Claude Code/glob-tool.md")

# anthropic/Claude Code/grep-tool.md
claude_code_grep_tool: str = _read_prompt("Claude Code/grep-tool.md")

# anthropic/Official/2024-07-12-claude-haiku-3.md
official_2024_07_12_claude_haiku_3: str = _read_prompt("Official/2024-07-12-claude-haiku-3.md")

# anthropic/Official/2024-07-12-claude-opus-3.md
official_2024_07_12_claude_opus_3: str = _read_prompt("Official/2024-07-12-claude-opus-3.md")

# anthropic/Official/2024-07-12-claude-sonnet-3.5-text-and-images.md
official_2024_07_12_claude_sonnet_3_5_text_and_images: str = _read_prompt("Official/2024-07-12-claude-sonnet-3.5-text-and-images.md")

# anthropic/Official/2024-09-09-claude-sonnet-3.5-text-and-images.md
official_2024_09_09_claude_sonnet_3_5_text_and_images: str = _read_prompt("Official/2024-09-09-claude-sonnet-3.5-text-and-images.md")

# anthropic/Official/2024-09-09-claude-sonnet-3.5-text-only.md
official_2024_09_09_claude_sonnet_3_5_text_only: str = _read_prompt("Official/2024-09-09-claude-sonnet-3.5-text-only.md")

# anthropic/Official/2024-10-22-claude-haiku-3.5-text-only.md
official_2024_10_22_claude_haiku_3_5_text_only: str = _read_prompt("Official/2024-10-22-claude-haiku-3.5-text-only.md")

# anthropic/Official/2024-10-22-claude-sonnet-3.5-text-and-images.md
official_2024_10_22_claude_sonnet_3_5_text_and_images: str = _read_prompt("Official/2024-10-22-claude-sonnet-3.5-text-and-images.md")

# anthropic/Official/2024-10-22-claude-sonnet-3.5-text-only.md
official_2024_10_22_claude_sonnet_3_5_text_only: str = _read_prompt("Official/2024-10-22-claude-sonnet-3.5-text-only.md")

# anthropic/Official/2024-11-22-claude-sonnet-3.5-text-and-images.md
official_2024_11_22_claude_sonnet_3_5_text_and_images: str = _read_prompt("Official/2024-11-22-claude-sonnet-3.5-text-and-images.md")

# anthropic/Official/2024-11-22-claude-sonnet-3.5-text-only.md
official_2024_11_22_claude_sonnet_3_5_text_only: str = _read_prompt("Official/2024-11-22-claude-sonnet-3.5-text-only.md")

# anthropic/Official/2025-02-24-claude-haiku-3.5-text-and-images.md
official_2025_02_24_claude_haiku_3_5_text_and_images: str = _read_prompt("Official/2025-02-24-claude-haiku-3.5-text-and-images.md")

# anthropic/Official/2025-02-24-claude-sonnet-3.7.md
official_2025_02_24_claude_sonnet_3_7: str = _read_prompt("Official/2025-02-24-claude-sonnet-3.7.md")

# anthropic/Official/2025-05-22-claude-opus-4.md
official_2025_05_22_claude_opus_4: str = _read_prompt("Official/2025-05-22-claude-opus-4.md")

# anthropic/Official/2025-05-22-claude-sonnet-4.md
official_2025_05_22_claude_sonnet_4: str = _read_prompt("Official/2025-05-22-claude-sonnet-4.md")

# anthropic/Official/2025-07-31-claude-opus-4.md
official_2025_07_31_claude_opus_4: str = _read_prompt("Official/2025-07-31-claude-opus-4.md")

# anthropic/Official/2025-07-31-claude-sonnet-4.md
official_2025_07_31_claude_sonnet_4: str = _read_prompt("Official/2025-07-31-claude-sonnet-4.md")

# anthropic/Official/2025-08-05-claude-opus-4.1.md
official_2025_08_05_claude_opus_4_1: str = _read_prompt("Official/2025-08-05-claude-opus-4.1.md")

# anthropic/Official/2025-08-05-claude-opus-4.md
official_2025_08_05_claude_opus_4: str = _read_prompt("Official/2025-08-05-claude-opus-4.md")

# anthropic/Official/2025-08-05-claude-sonnet-4.md
official_2025_08_05_claude_sonnet_4: str = _read_prompt("Official/2025-08-05-claude-sonnet-4.md")

# anthropic/Official/2025-09-29-claude-sonnet-4.5.md
official_2025_09_29_claude_sonnet_4_5: str = _read_prompt("Official/2025-09-29-claude-sonnet-4.5.md")

# anthropic/Official/2025-10-15-claude-haiku-4.5.md
official_2025_10_15_claude_haiku_4_5: str = _read_prompt("Official/2025-10-15-claude-haiku-4.5.md")

# anthropic/Official/2025-11-19-claude-haiku-4.5.md
official_2025_11_19_claude_haiku_4_5: str = _read_prompt("Official/2025-11-19-claude-haiku-4.5.md")

# anthropic/Official/2025-11-19-claude-sonnet-4.5.md
official_2025_11_19_claude_sonnet_4_5: str = _read_prompt("Official/2025-11-19-claude-sonnet-4.5.md")

# anthropic/Official/2025-11-24-claude-opus-4.5.md
official_2025_11_24_claude_opus_4_5: str = _read_prompt("Official/2025-11-24-claude-opus-4.5.md")

# anthropic/Official/2026-01-18-claude-haiku-4.5.md
official_2026_01_18_claude_haiku_4_5: str = _read_prompt("Official/2026-01-18-claude-haiku-4.5.md")

# anthropic/Official/2026-01-18-claude-opus-4.5.md
official_2026_01_18_claude_opus_4_5: str = _read_prompt("Official/2026-01-18-claude-opus-4.5.md")

# anthropic/Official/2026-01-18-claude-sonnet-4.5.md
official_2026_01_18_claude_sonnet_4_5: str = _read_prompt("Official/2026-01-18-claude-sonnet-4.5.md")

# anthropic/Official/2026-02-05-claude-opus-4.6.md
official_2026_02_05_claude_opus_4_6: str = _read_prompt("Official/2026-02-05-claude-opus-4.6.md")

# anthropic/Official/2026-02-17-claude-sonnet-4.6.md
official_2026_02_17_claude_sonnet_4_6: str = _read_prompt("Official/2026-02-17-claude-sonnet-4.6.md")

# anthropic/Official/2026-04-16-claude-opus-4.7.md
official_2026_04_16_claude_opus_4_7: str = _read_prompt("Official/2026-04-16-claude-opus-4.7.md")

# anthropic/Official/2026-05-28-claude-opus-4.8.md
official_2026_05_28_claude_opus_4_8: str = _read_prompt("Official/2026-05-28-claude-opus-4.8.md")

# anthropic/Official/README.md
official_readme: str = _read_prompt("Official/README.md")

# anthropic/Official/all.md
official_all: str = _read_prompt("Official/all.md")

# anthropic/anthropic_reminders.md
anthropic_reminders: str = _read_prompt("anthropic_reminders.md")

# anthropic/claude-cowork-dispatch.md
claude_cowork_dispatch: str = _read_prompt("claude-cowork-dispatch.md")

# anthropic/claude-cowork.md
claude_cowork: str = _read_prompt("claude-cowork.md")

# anthropic/claude-design.md
claude_design: str = _read_prompt("claude-design.md")

# anthropic/claude-desktop-code.md
claude_desktop_code: str = _read_prompt("claude-desktop-code.md")

# anthropic/claude-fable-5.md
claude_fable_5: str = _read_prompt("claude-fable-5.md")

# anthropic/claude-for-excel.md
claude_for_excel: str = _read_prompt("claude-for-excel.md")

# anthropic/claude-for-word.md
claude_for_word: str = _read_prompt("claude-for-word.md")

# anthropic/claude-in-chrome.md
claude_in_chrome: str = _read_prompt("claude-in-chrome.md")

# anthropic/claude-in-powerpoint.md
claude_in_powerpoint: str = _read_prompt("claude-in-powerpoint.md")

# anthropic/claude-mobile-ios.md
claude_mobile_ios: str = _read_prompt("claude-mobile-ios.md")

# anthropic/claude-opus-4.6-no-tools.md
claude_opus_4_6_no_tools: str = _read_prompt("claude-opus-4.6-no-tools.md")

# anthropic/claude-opus-4.6.md
claude_opus_4_6: str = _read_prompt("claude-opus-4.6.md")

# anthropic/claude-opus-4.7.md
claude_opus_4_7: str = _read_prompt("claude-opus-4.7.md")

# anthropic/claude-opus-4.8.md
claude_opus_4_8: str = _read_prompt("claude-opus-4.8.md")

# anthropic/claude-sonnet-4.6-no-tools.md
claude_sonnet_4_6_no_tools: str = _read_prompt("claude-sonnet-4.6-no-tools.md")

# anthropic/claude-sonnet-4.6.md
claude_sonnet_4_6: str = _read_prompt("claude-sonnet-4.6.md")

# anthropic/claude-sonnet-5.md
claude_sonnet_5: str = _read_prompt("claude-sonnet-5.md")

# anthropic/default-styles.md
default_styles: str = _read_prompt("default-styles.md")

# anthropic/old/claude-3.7-full-system-message-with-all-tools.md
old_claude_3_7_full_system_message_with_all_tools: str = _read_prompt("old/claude-3.7-full-system-message-with-all-tools.md")

# anthropic/old/claude-3.7-sonnet-full-system-message-humanreadable.md
old_claude_3_7_sonnet_full_system_message_humanreadable: str = _read_prompt("old/claude-3.7-sonnet-full-system-message-humanreadable.md")

# anthropic/old/claude-3.7-sonnet-w-tools.md
old_claude_3_7_sonnet_w_tools: str = _read_prompt("old/claude-3.7-sonnet-w-tools.md")

# anthropic/old/claude-3.7-sonnet.md
old_claude_3_7_sonnet: str = _read_prompt("old/claude-3.7-sonnet.md")

# anthropic/old/claude-4.1-opus-thinking.md
old_claude_4_1_opus_thinking: str = _read_prompt("old/claude-4.1-opus-thinking.md")

# anthropic/old/claude-4.5-sonnet.md
old_claude_4_5_sonnet: str = _read_prompt("old/claude-4.5-sonnet.md")

# anthropic/old/claude-opus-4.5.md
old_claude_opus_4_5: str = _read_prompt("old/claude-opus-4.5.md")

# anthropic/old/claude-sonnet-4.md
old_claude_sonnet_4: str = _read_prompt("old/claude-sonnet-4.md")

# anthropic/raw/claude-opus-4.6-no-tools-raw.md
raw_claude_opus_4_6_no_tools_raw: str = _read_prompt("raw/claude-opus-4.6-no-tools-raw.md")

# anthropic/raw/claude-opus-4.6-raw.md
raw_claude_opus_4_6_raw: str = _read_prompt("raw/claude-opus-4.6-raw.md")

# anthropic/raw/claude-sonnet-4.6-no-tools-raw.md
raw_claude_sonnet_4_6_no_tools_raw: str = _read_prompt("raw/claude-sonnet-4.6-no-tools-raw.md")

# anthropic/raw/claude-sonnet-4.6-raw.md
raw_claude_sonnet_4_6_raw: str = _read_prompt("raw/claude-sonnet-4.6-raw.md")

# anthropic/research_instructions.md
research_instructions: str = _read_prompt("research_instructions.md")

# anthropic/sonnet-4.6-reminders.md
sonnet_4_6_reminders: str = _read_prompt("sonnet-4.6-reminders.md")

# anthropic/visualize.md
visualize: str = _read_prompt("visualize.md")


ALL_PROMPTS: Dict[str, str] = {
    "claude_code_bundled_skills_artifact_design": claude_code_bundled_skills_artifact_design,
    "claude_code_bundled_skills_batch": claude_code_bundled_skills_batch,
    "claude_code_bundled_skills_claude_api": claude_code_bundled_skills_claude_api,
    "claude_code_bundled_skills_code_review": claude_code_bundled_skills_code_review,
    "claude_code_bundled_skills_code_review_readme": claude_code_bundled_skills_code_review_readme,
    "claude_code_bundled_skills_code_review_high": claude_code_bundled_skills_code_review_high,
    "claude_code_bundled_skills_code_review_low": claude_code_bundled_skills_code_review_low,
    "claude_code_bundled_skills_code_review_max": claude_code_bundled_skills_code_review_max,
    "claude_code_bundled_skills_code_review_medium": claude_code_bundled_skills_code_review_medium,
    "claude_code_bundled_skills_code_review_report_findings_tool": claude_code_bundled_skills_code_review_report_findings_tool,
    "claude_code_bundled_skills_code_review_xhigh": claude_code_bundled_skills_code_review_xhigh,
    "claude_code_bundled_skills_compact": claude_code_bundled_skills_compact,
    "claude_code_bundled_skills_dataviz_skill": claude_code_bundled_skills_dataviz_skill,
    "claude_code_bundled_skills_dataviz_references_anti_patterns": claude_code_bundled_skills_dataviz_references_anti_patterns,
    "claude_code_bundled_skills_dataviz_references_choosing_a_form": claude_code_bundled_skills_dataviz_references_choosing_a_form,
    "claude_code_bundled_skills_dataviz_references_color_formula": claude_code_bundled_skills_dataviz_references_color_formula,
    "claude_code_bundled_skills_dataviz_references_components": claude_code_bundled_skills_dataviz_references_components,
    "claude_code_bundled_skills_dataviz_references_interaction": claude_code_bundled_skills_dataviz_references_interaction,
    "claude_code_bundled_skills_dataviz_references_marks_and_anatomy": claude_code_bundled_skills_dataviz_references_marks_and_anatomy,
    "claude_code_bundled_skills_dataviz_references_palette": claude_code_bundled_skills_dataviz_references_palette,
    "claude_code_bundled_skills_debug": claude_code_bundled_skills_debug,
    "claude_code_bundled_skills_deep_research_skill": claude_code_bundled_skills_deep_research_skill,
    "claude_code_bundled_skills_doctor_skill": claude_code_bundled_skills_doctor_skill,
    "claude_code_bundled_skills_fewer_permission_prompts": claude_code_bundled_skills_fewer_permission_prompts,
    "claude_code_bundled_skills_init_new": claude_code_bundled_skills_init_new,
    "claude_code_bundled_skills_init": claude_code_bundled_skills_init,
    "claude_code_bundled_skills_keybindings_help": claude_code_bundled_skills_keybindings_help,
    "claude_code_bundled_skills_loop": claude_code_bundled_skills_loop,
    "claude_code_bundled_skills_review": claude_code_bundled_skills_review,
    "claude_code_bundled_skills_run_skill_generator_skill": claude_code_bundled_skills_run_skill_generator_skill,
    "claude_code_bundled_skills_run_skill_generator_examples_cli": claude_code_bundled_skills_run_skill_generator_examples_cli,
    "claude_code_bundled_skills_run_skill_generator_examples_electron": claude_code_bundled_skills_run_skill_generator_examples_electron,
    "claude_code_bundled_skills_run_skill_generator_examples_library": claude_code_bundled_skills_run_skill_generator_examples_library,
    "claude_code_bundled_skills_run_skill_generator_examples_playwright": claude_code_bundled_skills_run_skill_generator_examples_playwright,
    "claude_code_bundled_skills_run_skill_generator_examples_server": claude_code_bundled_skills_run_skill_generator_examples_server,
    "claude_code_bundled_skills_run_skill_generator_examples_tui": claude_code_bundled_skills_run_skill_generator_examples_tui,
    "claude_code_bundled_skills_run_skill_generator_template": claude_code_bundled_skills_run_skill_generator_template,
    "claude_code_bundled_skills_run": claude_code_bundled_skills_run,
    "claude_code_bundled_skills_schedule": claude_code_bundled_skills_schedule,
    "claude_code_bundled_skills_security_review": claude_code_bundled_skills_security_review,
    "claude_code_bundled_skills_simplify": claude_code_bundled_skills_simplify,
    "claude_code_bundled_skills_update_config": claude_code_bundled_skills_update_config,
    "claude_code_bundled_skills_verify": claude_code_bundled_skills_verify,
    "claude_code_claude_code_2_1_172_fable_5": claude_code_claude_code_2_1_172_fable_5,
    "claude_code_claude_code_2_1_172_opus_4_6": claude_code_claude_code_2_1_172_opus_4_6,
    "claude_code_claude_code_2_1_172_opus_4_8": claude_code_claude_code_2_1_172_opus_4_8,
    "claude_code_claude_code_docs_assistant": claude_code_claude_code_docs_assistant,
    "claude_code_claude_code_opus_4_6": claude_code_claude_code_opus_4_6,
    "claude_code_claude_code_opus_4_8": claude_code_claude_code_opus_4_8,
    "claude_code_deferred_tools": claude_code_deferred_tools,
    "claude_code_glob_tool": claude_code_glob_tool,
    "claude_code_grep_tool": claude_code_grep_tool,
    "official_2024_07_12_claude_haiku_3": official_2024_07_12_claude_haiku_3,
    "official_2024_07_12_claude_opus_3": official_2024_07_12_claude_opus_3,
    "official_2024_07_12_claude_sonnet_3_5_text_and_images": official_2024_07_12_claude_sonnet_3_5_text_and_images,
    "official_2024_09_09_claude_sonnet_3_5_text_and_images": official_2024_09_09_claude_sonnet_3_5_text_and_images,
    "official_2024_09_09_claude_sonnet_3_5_text_only": official_2024_09_09_claude_sonnet_3_5_text_only,
    "official_2024_10_22_claude_haiku_3_5_text_only": official_2024_10_22_claude_haiku_3_5_text_only,
    "official_2024_10_22_claude_sonnet_3_5_text_and_images": official_2024_10_22_claude_sonnet_3_5_text_and_images,
    "official_2024_10_22_claude_sonnet_3_5_text_only": official_2024_10_22_claude_sonnet_3_5_text_only,
    "official_2024_11_22_claude_sonnet_3_5_text_and_images": official_2024_11_22_claude_sonnet_3_5_text_and_images,
    "official_2024_11_22_claude_sonnet_3_5_text_only": official_2024_11_22_claude_sonnet_3_5_text_only,
    "official_2025_02_24_claude_haiku_3_5_text_and_images": official_2025_02_24_claude_haiku_3_5_text_and_images,
    "official_2025_02_24_claude_sonnet_3_7": official_2025_02_24_claude_sonnet_3_7,
    "official_2025_05_22_claude_opus_4": official_2025_05_22_claude_opus_4,
    "official_2025_05_22_claude_sonnet_4": official_2025_05_22_claude_sonnet_4,
    "official_2025_07_31_claude_opus_4": official_2025_07_31_claude_opus_4,
    "official_2025_07_31_claude_sonnet_4": official_2025_07_31_claude_sonnet_4,
    "official_2025_08_05_claude_opus_4_1": official_2025_08_05_claude_opus_4_1,
    "official_2025_08_05_claude_opus_4": official_2025_08_05_claude_opus_4,
    "official_2025_08_05_claude_sonnet_4": official_2025_08_05_claude_sonnet_4,
    "official_2025_09_29_claude_sonnet_4_5": official_2025_09_29_claude_sonnet_4_5,
    "official_2025_10_15_claude_haiku_4_5": official_2025_10_15_claude_haiku_4_5,
    "official_2025_11_19_claude_haiku_4_5": official_2025_11_19_claude_haiku_4_5,
    "official_2025_11_19_claude_sonnet_4_5": official_2025_11_19_claude_sonnet_4_5,
    "official_2025_11_24_claude_opus_4_5": official_2025_11_24_claude_opus_4_5,
    "official_2026_01_18_claude_haiku_4_5": official_2026_01_18_claude_haiku_4_5,
    "official_2026_01_18_claude_opus_4_5": official_2026_01_18_claude_opus_4_5,
    "official_2026_01_18_claude_sonnet_4_5": official_2026_01_18_claude_sonnet_4_5,
    "official_2026_02_05_claude_opus_4_6": official_2026_02_05_claude_opus_4_6,
    "official_2026_02_17_claude_sonnet_4_6": official_2026_02_17_claude_sonnet_4_6,
    "official_2026_04_16_claude_opus_4_7": official_2026_04_16_claude_opus_4_7,
    "official_2026_05_28_claude_opus_4_8": official_2026_05_28_claude_opus_4_8,
    "official_readme": official_readme,
    "official_all": official_all,
    "anthropic_reminders": anthropic_reminders,
    "claude_cowork_dispatch": claude_cowork_dispatch,
    "claude_cowork": claude_cowork,
    "claude_design": claude_design,
    "claude_desktop_code": claude_desktop_code,
    "claude_fable_5": claude_fable_5,
    "claude_for_excel": claude_for_excel,
    "claude_for_word": claude_for_word,
    "claude_in_chrome": claude_in_chrome,
    "claude_in_powerpoint": claude_in_powerpoint,
    "claude_mobile_ios": claude_mobile_ios,
    "claude_opus_4_6_no_tools": claude_opus_4_6_no_tools,
    "claude_opus_4_6": claude_opus_4_6,
    "claude_opus_4_7": claude_opus_4_7,
    "claude_opus_4_8": claude_opus_4_8,
    "claude_sonnet_4_6_no_tools": claude_sonnet_4_6_no_tools,
    "claude_sonnet_4_6": claude_sonnet_4_6,
    "claude_sonnet_5": claude_sonnet_5,
    "default_styles": default_styles,
    "old_claude_3_7_full_system_message_with_all_tools": old_claude_3_7_full_system_message_with_all_tools,
    "old_claude_3_7_sonnet_full_system_message_humanreadable": old_claude_3_7_sonnet_full_system_message_humanreadable,
    "old_claude_3_7_sonnet_w_tools": old_claude_3_7_sonnet_w_tools,
    "old_claude_3_7_sonnet": old_claude_3_7_sonnet,
    "old_claude_4_1_opus_thinking": old_claude_4_1_opus_thinking,
    "old_claude_4_5_sonnet": old_claude_4_5_sonnet,
    "old_claude_opus_4_5": old_claude_opus_4_5,
    "old_claude_sonnet_4": old_claude_sonnet_4,
    "raw_claude_opus_4_6_no_tools_raw": raw_claude_opus_4_6_no_tools_raw,
    "raw_claude_opus_4_6_raw": raw_claude_opus_4_6_raw,
    "raw_claude_sonnet_4_6_no_tools_raw": raw_claude_sonnet_4_6_no_tools_raw,
    "raw_claude_sonnet_4_6_raw": raw_claude_sonnet_4_6_raw,
    "research_instructions": research_instructions,
    "sonnet_4_6_reminders": sonnet_4_6_reminders,
    "visualize": visualize,
}

__all__ = ["claude_code_bundled_skills_artifact_design", "claude_code_bundled_skills_batch", "claude_code_bundled_skills_claude_api", "claude_code_bundled_skills_code_review", "claude_code_bundled_skills_code_review_readme", "claude_code_bundled_skills_code_review_high", "claude_code_bundled_skills_code_review_low", "claude_code_bundled_skills_code_review_max", "claude_code_bundled_skills_code_review_medium", "claude_code_bundled_skills_code_review_report_findings_tool", "claude_code_bundled_skills_code_review_xhigh", "claude_code_bundled_skills_compact", "claude_code_bundled_skills_dataviz_skill", "claude_code_bundled_skills_dataviz_references_anti_patterns", "claude_code_bundled_skills_dataviz_references_choosing_a_form", "claude_code_bundled_skills_dataviz_references_color_formula", "claude_code_bundled_skills_dataviz_references_components", "claude_code_bundled_skills_dataviz_references_interaction", "claude_code_bundled_skills_dataviz_references_marks_and_anatomy", "claude_code_bundled_skills_dataviz_references_palette", "claude_code_bundled_skills_debug", "claude_code_bundled_skills_deep_research_skill", "claude_code_bundled_skills_doctor_skill", "claude_code_bundled_skills_fewer_permission_prompts", "claude_code_bundled_skills_init_new", "claude_code_bundled_skills_init", "claude_code_bundled_skills_keybindings_help", "claude_code_bundled_skills_loop", "claude_code_bundled_skills_review", "claude_code_bundled_skills_run_skill_generator_skill", "claude_code_bundled_skills_run_skill_generator_examples_cli", "claude_code_bundled_skills_run_skill_generator_examples_electron", "claude_code_bundled_skills_run_skill_generator_examples_library", "claude_code_bundled_skills_run_skill_generator_examples_playwright", "claude_code_bundled_skills_run_skill_generator_examples_server", "claude_code_bundled_skills_run_skill_generator_examples_tui", "claude_code_bundled_skills_run_skill_generator_template", "claude_code_bundled_skills_run", "claude_code_bundled_skills_schedule", "claude_code_bundled_skills_security_review", "claude_code_bundled_skills_simplify", "claude_code_bundled_skills_update_config", "claude_code_bundled_skills_verify", "claude_code_claude_code_2_1_172_fable_5", "claude_code_claude_code_2_1_172_opus_4_6", "claude_code_claude_code_2_1_172_opus_4_8", "claude_code_claude_code_docs_assistant", "claude_code_claude_code_opus_4_6", "claude_code_claude_code_opus_4_8", "claude_code_deferred_tools", "claude_code_glob_tool", "claude_code_grep_tool", "official_2024_07_12_claude_haiku_3", "official_2024_07_12_claude_opus_3", "official_2024_07_12_claude_sonnet_3_5_text_and_images", "official_2024_09_09_claude_sonnet_3_5_text_and_images", "official_2024_09_09_claude_sonnet_3_5_text_only", "official_2024_10_22_claude_haiku_3_5_text_only", "official_2024_10_22_claude_sonnet_3_5_text_and_images", "official_2024_10_22_claude_sonnet_3_5_text_only", "official_2024_11_22_claude_sonnet_3_5_text_and_images", "official_2024_11_22_claude_sonnet_3_5_text_only", "official_2025_02_24_claude_haiku_3_5_text_and_images", "official_2025_02_24_claude_sonnet_3_7", "official_2025_05_22_claude_opus_4", "official_2025_05_22_claude_sonnet_4", "official_2025_07_31_claude_opus_4", "official_2025_07_31_claude_sonnet_4", "official_2025_08_05_claude_opus_4_1", "official_2025_08_05_claude_opus_4", "official_2025_08_05_claude_sonnet_4", "official_2025_09_29_claude_sonnet_4_5", "official_2025_10_15_claude_haiku_4_5", "official_2025_11_19_claude_haiku_4_5", "official_2025_11_19_claude_sonnet_4_5", "official_2025_11_24_claude_opus_4_5", "official_2026_01_18_claude_haiku_4_5", "official_2026_01_18_claude_opus_4_5", "official_2026_01_18_claude_sonnet_4_5", "official_2026_02_05_claude_opus_4_6", "official_2026_02_17_claude_sonnet_4_6", "official_2026_04_16_claude_opus_4_7", "official_2026_05_28_claude_opus_4_8", "official_readme", "official_all", "anthropic_reminders", "claude_cowork_dispatch", "claude_cowork", "claude_design", "claude_desktop_code", "claude_fable_5", "claude_for_excel", "claude_for_word", "claude_in_chrome", "claude_in_powerpoint", "claude_mobile_ios", "claude_opus_4_6_no_tools", "claude_opus_4_6", "claude_opus_4_7", "claude_opus_4_8", "claude_sonnet_4_6_no_tools", "claude_sonnet_4_6", "claude_sonnet_5", "default_styles", "old_claude_3_7_full_system_message_with_all_tools", "old_claude_3_7_sonnet_full_system_message_humanreadable", "old_claude_3_7_sonnet_w_tools", "old_claude_3_7_sonnet", "old_claude_4_1_opus_thinking", "old_claude_4_5_sonnet", "old_claude_opus_4_5", "old_claude_sonnet_4", "raw_claude_opus_4_6_no_tools_raw", "raw_claude_opus_4_6_raw", "raw_claude_sonnet_4_6_no_tools_raw", "raw_claude_sonnet_4_6_raw", "research_instructions", "sonnet_4_6_reminders", "visualize", "ALL_PROMPTS", "_read_prompt"]