"""System prompt library -- lazy-loaded to avoid circular imports."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
import os
import glob


@dataclass
class SystemPrompt:
    provider: str
    model: str
    title: str = ""
    content: str = ""
    file_path: str = ""
    tags: List[str] = field(default_factory=list)
    size: int = 0


class SystemPromptLibrary:
    def __init__(self):
        self._prompts: List[SystemPrompt] = []
        self._by_provider: Dict[str, List[SystemPrompt]] = {}
        self._loaded = False

    def _load(self):
        if self._loaded:
            return
        base = os.path.dirname(os.path.abspath(__file__))
        for md_file in glob.glob(os.path.join(base, "**", "*.md"), recursive=True):
            rel = os.path.relpath(md_file, base)
            parts = rel.split(os.sep)
            provider = parts[0] if len(parts) > 0 else "unknown"
            model = os.path.splitext(os.path.basename(md_file))[0]
            with open(md_file, "r", encoding="utf-8") as f:
                content_str = f.read()
            sp = SystemPrompt(
                provider=provider, model=model,
                title=model.replace("-", " ").title(),
                content=content_str, file_path=rel,
                tags=[provider], size=len(content_str),
            )
            self._prompts.append(sp)
            if provider not in self._by_provider:
                self._by_provider[provider] = []
            self._by_provider[provider].append(sp)
        self._loaded = True

    def browse(self, provider=None, model=None, tag=None):
        self._load()
        results = self._prompts
        if provider:
            results = [p for p in results if p.provider == provider]
        if model:
            results = [p for p in results if model.lower() in p.model.lower()]
        if tag:
            results = [p for p in results if tag in p.tags]
        return results

    def search(self, query, max_results=10):
        self._load()
        q = query.lower()
        scored = []
        for p in self._prompts:
            s = 0
            if q in p.model.lower():
                s += 10
            if q in p.provider.lower():
                s += 5
            if q in p.content.lower():
                s += p.content.lower().count(q) * 0.5
            if s > 0:
                scored.append((s, p))
        scored.sort(key=lambda x: -x[0])
        return [p for _, p in scored[:max_results]]

    def get(self, path):
        self._load()
        for p in self._prompts:
            if p.file_path == path or p.model == path:
                return p
        return None

    def list_providers(self):
        self._load()
        return sorted(self._by_provider.keys())

    def list_models(self, provider=None):
        self._load()
        if provider:
            return sorted([p.model for p in self._by_provider.get(provider, [])])
        return sorted([p.model for p in self._prompts])

    def get_stats(self):
        self._load()
        return {
            "total": len(self._prompts),
            "providers": len(self._by_provider),
            "per_provider": {p: len(v) for p, v in sorted(self._by_provider.items())},
        }


_library = None


def get_library():
    global _library
    if _library is None:
        lib = SystemPromptLibrary()
        lib._load()
        _library = lib
    return _library
