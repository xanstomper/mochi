"""TokenMinimizer — Ultra-aggressive token minimization pipeline.

Designed to minimize tokens while preserving semantic meaning.
Combines: aggressive pruning, stopword removal, abbreviation, code minification,
JSON compression, and context distillation.

Target: 70-90% token reduction with <10% quality loss.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
import re
import math

@dataclass
class MinimizerConfig:
    target_ratio: float = 0.15
    aggressive: bool = True
    min_output_tokens: int = 20
    preserve_code: bool = True
    preserve_numbers: bool = True
    abbreviate: bool = True
    remove_stopwords: bool = True
    remove_comments: bool = True
    collapse_whitespace: bool = True
    compress_json: bool = True
    shorten_identifiers: bool = False

@dataclass
class MinimizeResult:
    original_tokens: int
    minimized_tokens: int
    saved_tokens: int
    saving_ratio: float
    original_text: str
    minimized_text: str
    techniques: List[str]

class TokenMinimizer:
    def __init__(self, config=None):
        self.config = config or MinimizerConfig()
        self._total_saved = 0
        self._total_processed = 0

    def minimize(self, text: str) -> MinimizeResult:
        orig_tokens = self._count_tokens(text)
        techniques = []
        t = text
        if self.config.collapse_whitespace:
            t = re.sub(r"\s+", " ", t)
            t = re.sub(r"\n{3,}", "\n\n", t)
            techniques.append("collapse_whitespace")
        if self.config.remove_comments:
            t = re.sub(r"#.*$", "", t, flags=re.M)
            techniques.append("remove_comments")
        if self.config.remove_stopwords:
            stopwords = {"the","a","an","in","of","to","is","for","on","at","by","with","and","or","but","so","if","as","it","be","do","no","just","that","this","was","are","were","been","being","have","has","had","can","will","would","could","should","may","might"}
            words = t.split()
            filtered = [w for w in words if w.lower() not in stopwords or len(w) > 4]
            t = " ".join(filtered)
            techniques.append("remove_stopwords")
        if self.config.abbreviate:
            abbrevs = {
                "for example": "e.g.", "that is": "i.e.", "and so on": "etc.",
                "with respect to": "wrt", "as soon as possible": "ASAP",
                "because": "bc", "please": "pls", "about": "abt",
                "information": "info", "application": "app",
                "configuration": "config", "implementation": "impl",
                "documentation": "docs", "development": "dev",
                "environment": "env", "parameter": "param",
                "function": "fn", "variable": "var",
            }
            for full, abbr in abbrevs.items():
                t = re.sub(r"\b" + re.escape(full) + r"\b", abbr, t, flags=re.I)
            techniques.append("abbreviate")
        if self.config.compress_json:
            def _compact_json(m):
                try:
                    import json
                    return json.dumps(json.loads(m.group()), separators=(",", ":"))
                except:
                    return m.group()
            t = re.sub(r"\{.*?\}", _compact_json, t, flags=re.DOTALL)
            techniques.append("compress_json")
        target_length = max(self.config.min_output_tokens, int(len(t) * self.config.target_ratio))
        if len(t) > target_length:
            lines = t.split("\n")
            if self.config.preserve_code:
                code_lines = [l for l in lines if "def " in l or "class " in l or "import " in l or "return " in l]
                non_code = [l for l in lines if l not in code_lines]
                non_code.sort(key=len, reverse=True)
                kept = code_lines + non_code[:max(5, target_length // 10)]
                t = "\n".join(kept)
            else:
                t = t[:target_length]
        min_tokens = self._count_tokens(t)
        saved = orig_tokens - min_tokens
        self._total_saved += saved
        self._total_processed += orig_tokens
        return MinimizeResult(
            original_tokens=orig_tokens, minimized_tokens=min_tokens,
            saved_tokens=saved, saving_ratio=round(saved / max(orig_tokens, 1), 4),
            original_text=text[:200], minimized_text=t[:200],
            techniques=techniques,
        )

    def _count_tokens(self, text: str) -> int:
        return max(1, len(text) // 4)

    def minimize_batch(self, texts: List[str]) -> List[MinimizeResult]:
        return [self.minimize(t) for t in texts]

    def get_stats(self):
        return {"total_tokens_saved": self._total_saved, "total_processed": self._total_processed,
                "avg_savings": round(self._total_saved / max(self._total_processed, 1), 4)}
