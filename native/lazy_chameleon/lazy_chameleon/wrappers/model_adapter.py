"""ModelAdapter — Adapters for different model formats and APIs."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Callable

@dataclass
class AdapterMapping:
    source_format: str
    target_format: str
    mapping: Dict[str, str]

class ModelAdapter:
    def __init__(self):
        self._adapters: Dict[str, Callable] = {}
        self._register_defaults()

    def _register_defaults(self):
        self._adapters["openai_to_anthropic"] = self._openai_to_anthropic
        self._adapters["anthropic_to_openai"] = self._anthropic_to_openai
        self._adapters["openai_to_google"] = self._openai_to_google

    def adapt(self, messages: List[Dict], source: str, target: str) -> List[Dict]:
        key = f"{source}_to_{target}"
        if key in self._adapters:
            return self._adapters[key](messages)
        return messages

    def _openai_to_anthropic(self, messages: List[Dict]) -> List[Dict]:
        result = []
        for msg in messages:
            role = "assistant" if msg["role"] == "assistant" else "user"
            result.append({"role": role, "content": msg.get("content", "")})
        return result

    def _anthropic_to_openai(self, messages: List[Dict]) -> List[Dict]:
        result = []
        for msg in messages:
            result.append({"role": msg["role"], "content": msg.get("content", "")})
        return result

    def _openai_to_google(self, messages: List[Dict]) -> List[Dict]:
        result = []
        for msg in messages:
            result.append({"role": "user", "parts": [{"text": msg.get("content", "")}]})
        return result
