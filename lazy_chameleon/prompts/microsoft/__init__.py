"""Microsoft — System prompts library."""
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

# microsoft/copilot-cli.md
copilot_cli: str = _read_prompt("copilot-cli.md")

# microsoft/copilot-in-microsoft-word.md
copilot_in_microsoft_word: str = _read_prompt("copilot-in-microsoft-word.md")

# microsoft/copilot-macos-app.md
copilot_macos_app: str = _read_prompt("copilot-macos-app.md")

# microsoft/github-copilot.md
github_copilot: str = _read_prompt("github-copilot.md")

# microsoft/vscode-copilot-agent.md
vscode_copilot_agent: str = _read_prompt("vscode-copilot-agent.md")


ALL_PROMPTS: Dict[str, str] = {
    "copilot_cli": copilot_cli,
    "copilot_in_microsoft_word": copilot_in_microsoft_word,
    "copilot_macos_app": copilot_macos_app,
    "github_copilot": github_copilot,
    "vscode_copilot_agent": vscode_copilot_agent,
}

__all__ = ["copilot_cli", "copilot_in_microsoft_word", "copilot_macos_app", "github_copilot", "vscode_copilot_agent", "ALL_PROMPTS", "_read_prompt"]