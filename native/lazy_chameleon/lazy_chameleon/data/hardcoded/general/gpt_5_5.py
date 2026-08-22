"""gpt_5_5 - general examples."""
from __future__ import annotations
from typing import Any, Dict, List

gpt_5_5_general_examples: List[Dict[str, Any]] = [
    {"instruction": "SaaS business plan", "response": "Exec summary, market, model, forecast", "difficulty": 0.5},
    {"instruction": "REST API design", "response": "Nouns, verbs, version, pagination", "difficulty": 0.4},
    {"instruction": "Agile vs Waterfall", "response": "Iterative vs sequential", "difficulty": 0.4},
    {"instruction": "Microservices vs monolith", "response": "Independent deploy vs simpler", "difficulty": 0.5},
    {"instruction": "SQL vs NoSQL", "response": "ACID+joins vs flex schema+scale", "difficulty": 0.5},
    {"instruction": "Time complexity guide", "response": "O(1)/O(log n)/O(n)/O(n^2)", "difficulty": 0.3},
    {"instruction": "Caching strategies", "response": "Aside+through+behind+TTL", "difficulty": 0.5},
    {"instruction": "Testing pyramid", "response": "Unit 70%-Integration 20%-E2E 10%", "difficulty": 0.7},
    {"instruction": "Git workflow", "response": "Feature branches+PRs+semantic", "difficulty": 0.5},
    {"instruction": "Incident response", "response": "Detect-respond-mitigate-learn", "difficulty": 0.3},
    {"instruction": "CI/CD pipeline", "response": "Lint-build-test-stage-deploy", "difficulty": 0.8},
    {"instruction": "Code review best", "response": "<400 lines+checklist", "difficulty": 0.2},
    {"instruction": "Software estimation", "response": "Three-point+planning poker+buffer", "difficulty": 0.8},
    {"instruction": "Database indexing", "response": "B-tree+hash+covering index", "difficulty": 0.3},
    {"instruction": "Docker vs VMs", "response": "Shared OS vs full isolation", "difficulty": 0.3},
    {"instruction": "Monitoring RED", "response": "Rate+Errors+Duration", "difficulty": 0.7},
    {"instruction": "System design interview", "response": "Clarify-estimate-model-API", "difficulty": 0.8},
    {"instruction": "API design principles", "response": "Consistent+versioned+secure", "difficulty": 0.6},
    {"instruction": "Error handling", "response": "Specific exceptions+log+context", "difficulty": 0.6},
    {"instruction": "Data structures guide", "response": "Array+hash+tree+graph by use", "difficulty": 0.6},
]
__all__ = ["gpt_5_5_general_examples"]
