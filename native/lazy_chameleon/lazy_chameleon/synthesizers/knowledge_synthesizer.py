"""KnowledgeSynthesizer — Synthesize knowledge from multiple sources."""
from __future__ import annotations
from typing import Any, Dict, List, Optional
import json

class KnowledgeSynthesizer:
    def __init__(self):
        self._knowledge_base: Dict[str, List[str]] = {}

    def add_source(self, topic: str, content: str):
        if topic not in self._knowledge_base:
            self._knowledge_base[topic] = []
        self._knowledge_base[topic].append(content)

    def add_sources(self, sources: Dict[str, List[str]]):
        for topic, contents in sources.items():
            for c in contents:
                self.add_source(topic, c)

    def synthesize(self, topic: str, max_sources: int = 3) -> str:
        sources = self._knowledge_base.get(topic, [])
        if not sources:
            return f"No knowledge available on '{topic}'"
        selected = sources[:max_sources]
        merged = "\n".join(selected)
        return merged

    def get_topics(self) -> List[str]:
        return list(self._knowledge_base.keys())

    def get_stats(self) -> Dict:
        return {"topics": len(self._knowledge_base), "total_sources": sum(len(v) for v in self._knowledge_base.values())}
