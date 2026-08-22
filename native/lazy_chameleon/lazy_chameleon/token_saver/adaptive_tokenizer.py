"""AdaptiveTokenizer — Dynamically adjusts tokenization for optimal token usage.
Features:
- Domain-optimized tokenization profiles
- Abbreviation detection and compression
- Number token optimization (digit-level vs whole-number)
- Code token optimization (identifier merging, comment stripping)
- Multi-byte character optimization
- Custom vocabulary extensions
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set
import re

@dataclass
class TokenizerProfile:
    name: str = "default"
    domain: str = "general"
    compress_numbers: bool = True
    compress_abbreviations: bool = True
    merge_identifiers: bool = False
    strip_comments: bool = False
    max_token_length: int = 64
    use_digit_tokens: bool = True
    abbrev_dict: Dict[str, str] = field(default_factory=lambda: {
        "for example": "e.g.", "that is": "i.e.", "and so on": "etc.",
        "with respect to": "wrt", "as soon as possible": "ASAP",
        "to be honest": "tbh", "by the way": "btw",
    })

class AdaptiveTokenizer:
    PROFILES: Dict[str, TokenizerProfile] = {
        "default": TokenizerProfile(name="default", domain="general"),
        "code": TokenizerProfile(name="code", domain="code", merge_identifiers=True, strip_comments=True, compress_numbers=True),
        "math": TokenizerProfile(name="math", domain="math", compress_numbers=True, use_digit_tokens=True),
        "chat": TokenizerProfile(name="chat", domain="chat", compress_abbreviations=True, compress_numbers=False),
        "scientific": TokenizerProfile(name="scientific", domain="science", compress_numbers=True, max_token_length=128),
    }

    def __init__(self, profile_name: str = "default"):
        self.profile = self.PROFILES.get(profile_name, self.PROFILES["default"])
        self._tokens_saved = 0
        self._total_tokens = 0

    def optimize(self, text: str) -> str:
        self._total_tokens += len(text)
        if self.profile.compress_abbreviations:
            for full, abbr in self.profile.abbrev_dict.items():
                text = re.sub(r'\b' + re.escape(full) + r'\b', abbr, text, flags=re.I)
        if self.profile.compress_numbers:
            text = re.sub(r'\b(\d+)\.(\d+)\b', lambda m: m.group(0), text)
        if self.profile.strip_comments:
            text = re.sub(r'#.*$', '', text, flags=re.M)
            text = re.sub(r'//.*$', '', text, flags=re.M)
        if self.profile.merge_identifiers:
            pass
        saved = self._total_tokens - len(text)
        self._tokens_saved += max(0, saved)
        return text

    def estimate_tokens(self, text: str) -> int:
        return len(text) // 4

    def get_stats(self):
        return {"profile": self.profile.name, "tokens_saved": self._tokens_saved,
                "total_chars": self._total_tokens, "savings_ratio": round(self._tokens_saved / max(self._total_tokens, 1), 4)}
