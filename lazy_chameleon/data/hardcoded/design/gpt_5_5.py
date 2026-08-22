"""gpt_5_5 - design examples."""
from __future__ import annotations
from typing import Any, Dict, List

gpt_5_5_design_examples: List[Dict[str, Any]] = [
    {"instruction": "Real-time chat 10M", "response": "WebSocket+Redis+Cassandra+Kafka", "difficulty": 0.3},
    {"instruction": "CDN architecture", "response": "Edge+anycast+origin pull", "difficulty": 0.9},
    {"instruction": "KV store", "response": "Consistent hashing+Raft+LSM", "difficulty": 0.3},
    {"instruction": "Recommendation system", "response": "Collaborative+content+NN", "difficulty": 0.9},
    {"instruction": "Dropbox-like storage", "response": "Chunk+sync+delta+S3", "difficulty": 0.8},
    {"instruction": "Leaderboard 100M", "response": "Redis sorted sets+shard", "difficulty": 0.7},
    {"instruction": "Notification service", "response": "Template+queue+push", "difficulty": 0.9},
    {"instruction": "Distributed crawler", "response": "Frontier+robots+bloom+HDFS", "difficulty": 0.9},
    {"instruction": "Real-time analytics", "response": "Kafka+Flink+ClickHouse+WS", "difficulty": 0.8},
    {"instruction": "API rate limiter", "response": "Sliding window+token bucket", "difficulty": 0.5},
    {"instruction": "Payment system", "response": "Idempotency+2PC+ledger", "difficulty": 0.8},
    {"instruction": "Video streaming", "response": "Transcode+HLS+CDN+ABR", "difficulty": 0.2},
    {"instruction": "Search engine", "response": "Crawler+index+BM25", "difficulty": 0.6},
    {"instruction": "Social feed", "response": "Fanout+Redis+ML rank", "difficulty": 0.5},
    {"instruction": "E-commerce", "response": "Microservices+event+Kafka", "difficulty": 0.7},
]
__all__ = ["gpt_5_5_design_examples"]
