"""PromptCompressor — Multi-strategy prompt compression engine."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional
from enum import Enum
import re
import math

class CompressionMethod(Enum):
    LLMLINGUA = "llmlingua"
    SELECTIVE_CONTEXT = "selective_context"
    CONCISE = "concise"
    BUDGET_AWARE = "budget_aware"
    HYBRID = "hybrid"
    MINIMAL = "minimal"

@dataclass
class CompressorConfig:
    method: CompressionMethod = CompressionMethod.HYBRID
    target_ratio: float = 0.3
    min_tokens: int = 10
    max_tokens: int = 4096
    preserve_code_blocks: bool = True
    preserve_json: bool = True
    remove_stopwords: bool = True
    remove_redundant: bool = True
    aggressive_mode: bool = False

class PromptCompressor:
    def __init__(self, config=None):
        self.config = config or CompressorConfig()
        self._total_saved = 0
        self._total_original = 0

    def compress(self, prompt: str, method=None) -> str:
        m = method or self.config.method
        self._total_original += len(prompt)
        if m == CompressionMethod.MINIMAL:
            compressed = self._minimal_compress(prompt)
        elif m == CompressionMethod.LLMLINGUA:
            compressed = self._llmlingua_compress(prompt)
        elif m == CompressionMethod.CONCISE:
            compressed = self._concise_compress(prompt)
        elif m == CompressionMethod.SELECTIVE_CONTEXT:
            compressed = self._selective_compress(prompt)
        else:
            compressed = self._hybrid_compress(prompt)
        saved = len(prompt) - len(compressed)
        self._total_saved += max(0, saved)
        return compressed

    def _minimal_compress(self, prompt: str) -> str:
        lines = prompt.split("\n")
        kept = []
        for l in lines:
            stripped = l.strip()
            if not stripped:
                continue
            if stripped.startswith("#") or stripped.startswith("//"):
                continue
            if len(stripped) < 3:
                continue
            kept.append(stripped)
        text = " ".join(kept)
        if self.config.aggressive_mode:
            words = text.split()
            min_len = max(3, int(len(words) * 0.3))
            text = " ".join(w for w in words if len(w) > 2)[:min_len * 10]
        return text[:max(50, int(len(text) * self.config.target_ratio))]

    def _llmlingua_compress(self, prompt: str) -> str:
        words = prompt.split()
        stopwords = {"the", "a", "an", "in", "of", "to", "is", "for", "on", "at", "by", "with", "and", "or", "but"}
        filtered = [w for w in words if w.lower() not in stopwords or len(w) > 3]
        target = max(self.config.min_tokens, int(len(filtered) * self.config.target_ratio))
        return " ".join(filtered[:target])

    def _concise_compress(self, prompt: str) -> str:
        sentences = re.split(r"(?<=[.!?])\s+", prompt)
        scored = []
        for s in sentences:
            score = 0
            for kw in ["conclusion", "therefore", "result", "answer", "summary"]:
                if kw in s.lower():
                    score += 3
            for kw in ["question", "task", "instruction", "goal"]:
                if kw in s.lower():
                    score += 2
            if len(s) < 15:
                score -= 1
            scored.append((score, s))
        scored.sort(key=lambda x: -x[0])
        n = max(1, int(len(sentences) * (1 - self.config.target_ratio)))
        top = [s for _, s in scored[:len(sentences) - n]]
        return " ".join(top)

    def _selective_compress(self, prompt: str) -> str:
        sections = re.split(r"(?=\n#|\n##|\n###)", prompt)
        result = []
        for sec in sections:
            if "```" in sec or "{" in sec or "important" in sec.lower():
                result.append(sec)
            else:
                lines = sec.split("\n")
                kept = [l for l in lines if len(l) > 30 or any(k in l.lower() for k in ["therefore","conclusion","summary","result","answer"])]
                if kept:
                    result.append("\n".join(kept))
        return "\n".join(result) if result else prompt[:int(len(prompt) * self.config.target_ratio)]

    def _hybrid_compress(self, prompt: str) -> str:
        s1 = self._selective_compress(prompt)
        target = int(len(prompt) * self.config.target_ratio)
        if len(s1) > target:
            s1 = self._concise_compress(s1)
        return s1[:max(target, self.config.min_tokens)]

    def get_stats(self):
        return {"total_original_chars": self._total_original, "total_saved_chars": self._total_saved,
                "compression_ratio": round(self._total_saved / max(self._total_original, 1), 4)}
