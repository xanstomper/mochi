"""claude_opus_4_8 - design examples."""
from __future__ import annotations
from typing import Any, Dict, List

claude_opus_4_8_design_examples: List[Dict[str, Any]] = [
    {"instruction": "Real-time chat 10M", "response": "WebSocket+Redis+Cassandra+Kafka", "difficulty": 0.7},
    {"instruction": "CDN architecture", "response": "Edge+anycast+origin pull", "difficulty": 0.6},
    {"instruction": "KV store", "response": "Consistent hashing+Raft+LSM", "difficulty": 0.8},
    {"instruction": "Recommendation system", "response": "Collaborative+content+NN", "difficulty": 0.9},
    {"instruction": "Dropbox-like storage", "response": "Chunk+sync+delta+S3", "difficulty": 0.3},
    {"instruction": "Leaderboard 100M", "response": "Redis sorted sets+shard", "difficulty": 0.4},
    {"instruction": "Notification service", "response": "Template+queue+push", "difficulty": 0.2},
    {"instruction": "Distributed crawler", "response": "Frontier+robots+bloom+HDFS", "difficulty": 0.8},
    {"instruction": "Real-time analytics", "response": "Kafka+Flink+ClickHouse+WS", "difficulty": 0.6},
    {"instruction": "API rate limiter", "response": "Sliding window+token bucket", "difficulty": 0.8},
    {"instruction": "Payment system", "response": "Idempotency+2PC+ledger", "difficulty": 0.4},
    {"instruction": "Video streaming", "response": "Transcode+HLS+CDN+ABR", "difficulty": 0.2},
    {"instruction": "Search engine", "response": "Crawler+index+BM25", "difficulty": 0.8},
    {"instruction": "Social feed", "response": "Fanout+Redis+ML rank", "difficulty": 0.8},
    {"instruction": "E-commerce", "response": "Microservices+event+Kafka", "difficulty": 0.4},
]
__all__ = ["claude_opus_4_8_design_examples"]
