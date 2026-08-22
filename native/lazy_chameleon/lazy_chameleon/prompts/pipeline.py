"""
Prompt pipeline — chain, inject, and read system prompts.

Components
----------
* **PromptPipeline** — chain multiple system prompts into a single context.
* **AgentPromptReader** — agent-friendly interface for reading prompts.
* **PromptInjector** — inject prompt content into agent configurations.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Union

from lazy_chameleon.prompts._library_init import SystemPrompt, SystemPromptLibrary, get_library


# ──────────────────────────────────────────────────────────────────────────────
# PromptPipeline
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class PipelineStep:
    """A single step in a prompt pipeline.

    Attributes
    ----------
    prompt_path : Path to the prompt file (absolute or library-relative).
    role        : Optional role label (e.g. ``"system"``, ``"user"``, ``"assistant"``).
    label       : Optional human-readable label for debugging.
    enabled     : When *False*, this step is skipped during assembly.
    """
    prompt_path: str
    role: str = "system"
    label: str = ""
    enabled: bool = True


class PromptPipeline:
    """Chain multiple system prompts together.

    A pipeline is an ordered list of :class:`PipelineStep` s that get
    assembled into a single context string.  Each step can be independently
    enabled/disabled, and the pipeline supports header/footer framing.
    """

    def __init__(self, library: Optional[SystemPromptLibrary] = None):
        self._steps: List[PipelineStep] = []
        self._library = library or get_library()
        self._header: str = ""
        self._footer: str = ""

    # ── Builder API ─────────────────────────────────────────────────────────

    def add_step(
        self,
        prompt_path: str,
        role: str = "system",
        label: str = "",
    ) -> "PromptPipeline":
        self._steps.append(PipelineStep(
            prompt_path=prompt_path,
            role=role,
            label=label or prompt_path,
        ))
        return self

    def insert_step(
        self,
        index: int,
        prompt_path: str,
        role: str = "system",
        label: str = "",
    ) -> "PromptPipeline":
        self._steps.insert(index, PipelineStep(
            prompt_path=prompt_path,
            role=role,
            label=label or prompt_path,
        ))
        return self

    def remove_step(self, index: int) -> "PromptPipeline":
        if 0 <= index < len(self._steps):
            del self._steps[index]
        return self

    def set_header(self, text: str) -> "PromptPipeline":
        self._header = text
        return self

    def set_footer(self, text: str) -> "PromptPipeline":
        self._footer = text
        return self

    def enable_step(self, index: int, enabled: bool = True) -> "PromptPipeline":
        if 0 <= index < len(self._steps):
            self._steps[index].enabled = enabled
        return self

    def clear(self) -> "PromptPipeline":
        self._steps.clear()
        return self

    @property
    def steps(self) -> List[PipelineStep]:
        return list(self._steps)
    # ── Assembly ────────────────────────────────────────────────────────────

    def assemble(
        self,
        separator: str = "\n\n",
        include_disabled: bool = False,
        include_meta: bool = False,
    ) -> str:
        """Assemble all enabled steps into a single context string."""
        parts: List[str] = []

        if self._header:
            parts.append(self._header)

        for step in self._steps:
            if not step.enabled:
                if include_disabled:
                    parts.append(f"<!-- DISABLED: {step.label} -->")
                continue

            prompt = self._library.get(step.prompt_path)
            if prompt is None:
                parts.append(f"<!-- MISSING: {step.prompt_path} -->")
                continue

            content = prompt.load()
            if not content:
                continue

            if include_meta:
                meta = f"<!-- step: {step.label} | role: {step.role} | source: {step.prompt_path} -->"
                piece = f"{meta}\n{content}"
            else:
                piece = content

            parts.append(piece)

        if self._footer:
            parts.append(self._footer)

        return separator.join(parts)

    def assemble_batch(self, separator: str = "\n\n") -> List[Dict[str, str]]:
        """Assemble into a list of per-role dicts for API calls."""
        messages: List[Dict[str, str]] = []

        if self._header:
            messages.append({"role": "system", "content": self._header})

        for step in self._steps:
            if not step.enabled:
                continue
            prompt = self._library.get(step.prompt_path)
            if prompt is None:
                continue
            content = prompt.load()
            if content:
                messages.append({"role": step.role, "content": content})

        if self._footer:
            messages.append({"role": "system", "content": self._footer})

        return messages

    def count_tokens(self, approx: bool = True) -> int:
        text = self.assemble()
        return len(text) // 4 if approx else len(text)

    def __len__(self) -> int:
        return len(self._steps)

    def __bool__(self) -> bool:
        return len(self._steps) > 0


# ──────────────────────────────────────────────────────────────────────────────
# AgentPromptReader
# ──────────────────────────────────────────────────────────────────────────────

class AgentPromptReader:
    """Agent-friendly interface for reading prompts.

    Agents use this to fetch specific system prompts, load them into memory,
    and access them by name or tag.
    """

    def __init__(self, library: Optional[SystemPromptLibrary] = None):
        self._library = library or get_library()
        self._cache: Dict[str, SystemPrompt] = {}

    def read(
        self,
        provider: str,
        model: str,
    ) -> Optional[SystemPrompt]:
        """Read a prompt by *provider* and *model* name."""
        cache_key = f"{provider}:{model}"
        if cache_key in self._cache:
            return self._cache[cache_key]

        for p in self._library.browse(provider=provider):
            if p.model == model or p.stem == model:
                p.load()
                self._cache[cache_key] = p
                return p

        # Substring fallback
        for p in self._library.browse(provider=provider):
            if model.lower() in p.stem.lower() or model.lower() in p.model.lower():
                p.load()
                self._cache[cache_key] = p
                return p

        return None

    def read_by_path(self, path: str) -> Optional[SystemPrompt]:
        """Read a prompt by its library path."""
        prompt = self._library.get(path)
        if prompt is not None:
            prompt.load()
            self._cache[path] = prompt
        return prompt

    def read_by_tag(self, tag: str) -> List[SystemPrompt]:
        """Read all prompts with a specific tag."""
        prompts = self._library.browse(tag=tag)
        for p in prompts:
            p.load()
        return prompts

    def clear_cache(self) -> None:
        self._cache.clear()

    def preload(self, provider: str) -> int:
        """Preload all prompts for a *provider* into cache."""
        prompts = self._library.browse(provider=provider)
        for p in prompts:
            p.load()
            self._cache[f"{p.provider}:{p.stem}"] = p
        return len(prompts)


# ──────────────────────────────────────────────────────────────────────────────
# PromptInjector
# ──────────────────────────────────────────────────────────────────────────────

class PromptInjector:
    """Inject system prompts into agent configurations.

    Walks a config dict and replaces ``{{prompt:<path>}}`` placeholders
    with loaded prompt content.
    """

    def __init__(self, library: Optional[SystemPromptLibrary] = None):
        self._library = library or get_library()

    def inject(
        self,
        config: Dict[str, Any],
        in_place: bool = True,
    ) -> Dict[str, Any]:
        """Walk *config* and replace ``{{prompt:...}}`` placeholders."""
        return self._walk_and_inject(config, in_place=in_place)

    def inject_string(self, text: str) -> str:
        """Replace ``{{prompt:...}}`` placeholders in a plain string."""
        import re

        def _replacer(match: re.Match) -> str:
            path = match.group(1).strip()
            prompt = self._library.get(path)
            if prompt is not None:
                return prompt.load()
            return f"<!-- PROMPT NOT FOUND: {path} -->"

        return re.sub(r"\{\{prompt:([^}]+)\}\}", _replacer, text)

    # ── Internal ────────────────────────────────────────────────────────────

    def _walk_and_inject(
        self,
        obj: Any,
        in_place: bool = True,
    ) -> Any:
        if isinstance(obj, dict):
            result = obj if in_place else {}
            for key, value in obj.items():
                resolved = self._walk_and_inject(value, in_place=in_place)
                if in_place:
                    obj[key] = resolved
                else:
                    result[key] = resolved
            return obj if in_place else result

        elif isinstance(obj, list):
            result = obj if in_place else []
            for i, item in enumerate(obj):
                resolved = self._walk_and_inject(item, in_place=in_place)
                if in_place:
                    obj[i] = resolved
                else:
                    result.append(resolved)
            return obj if in_place else result

        elif isinstance(obj, str):
            return self.inject_string(obj)

        return obj


__all__ = [
    "PipelineStep",
    "PromptPipeline",
    "AgentPromptReader",
    "PromptInjector",
]

