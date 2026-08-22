"""xAI Grok real-time knowledge system."""
from __future__ import annotations
from typing import Any, Dict, List, Optional
import time
import numpy as np


class GrokRealTimeKnowledge:
    """xAI Grok-style real-time knowledge system.
    
    Features:
    - Real-time data ingestion from multiple sources
    - Temporal entity weighting
    - Trending topic detection
    - Social media signal integration
    - Web search augmentation
    """
    def __init__(self):
        self._knowledge_store: Dict[str, Dict] = {}
        self._trending_topics: List[str] = []
        self._source_weights: Dict[str, float] = {
            "web_search": 0.8,
            "social_media": 0.6,
            "news_api": 0.9,
            "knowledge_base": 1.0,
        }

    def ingest_data(self, source: str, data: List[Dict[str, Any]]):
        """Ingest real-time data from a source."""
        weight = self._source_weights.get(source, 0.5)
        for item in data:
            key = item.get("id", str(hash(str(item))))
            if key in self._knowledge_store:
                stored = self._knowledge_store[key]
                stored["relevance"] = min(1.0, stored.get("relevance", 0) + 0.1)
                stored["last_updated"] = time.time()
            else:
                self._knowledge_store[key] = {
                    "data": item,
                    "source": source,
                    "relevance": weight,
                    "timestamp": time.time(),
                    "access_count": 0,
                }

    def detect_trending(self, window_s: int = 3600) -> List[str]:
        """Detect trending topics based on recent data volume."""
        now = time.time()
        recent = [v for v in self._knowledge_store.values() if now - v["timestamp"] < window_s]
        topic_counts: Dict[str, int] = {}
        for v in recent:
            for topic in v.get("data", {}).get("topics", []):
                topic_counts[topic] = topic_counts.get(topic, 0) + 1
        sorted_topics = sorted(topic_counts.items(), key=lambda x: -x[1])
        self._trending_topics = [t for t, c in sorted_topics[:10]]
        return self._trending_topics

    def query(self, query: str, top_k: int = 10) -> List[Dict]:
        """Query knowledge store with real-time signal boost."""
        scored = []
        for key, value in self._knowledge_store.items():
            base_relevance = value["relevance"]
            recency_boost = min(1.0, (time.time() - value["timestamp"]) / 86400) * 0.2
            score = base_relevance * (1 + recency_boost)
            if query.lower() in key.lower():
                score *= 1.5
            scored.append((score, value))
        scored.sort(key=lambda x: -x[0])
        return [v for _, v in scored[:top_k]]

    def get_personality_context(self, mode: str = "fun") -> Dict[str, Any]:
        """Get Grok personality context based on mode."""
        if mode == "fun":
            return {
                "personality": "witty and humorous",
                "style": "answers with wit, sarcasm, and personality",
                "truth_priority": "high",
                "mode_note": "Fun Mode: humor enabled",
            }
        else:
            return {
                "personality": "helpful and informative",
                "style": "direct and factual",
                "truth_priority": "highest",
                "mode_note": "Regular Mode: humor disabled",
            }

