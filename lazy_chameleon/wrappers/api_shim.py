"""APIShim — API compatibility shims for cross-provider usage."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

@dataclass
class ShimConfig:
    default_format: str = "openai"
    auto_convert: bool = True

class APIShim:
    def __init__(self, config: Optional[ShimConfig] = None):
        self.config = config or ShimConfig()

    def convert_request(self, request: Dict, target_format: str) -> Dict:
        if target_format == "anthropic":
            return {"messages": self._to_anthropic(request.get("messages", [])),
                    "max_tokens": request.get("max_tokens", 4096),
                    "system": request.get("system", "")}
        if target_format == "google":
            return {"contents": [{"parts": [{"text": m["content"]}]} for m in request.get("messages", [])]}
        return request

    def _to_anthropic(self, messages: List[Dict]) -> List[Dict]:
        return [{"role": m["role"], "content": m["content"]} for m in messages if m.get("role") != "system"]
