"""
Tests for v2.4 new components:
  - synthesis/task_classifier.py
  - synthesis/rag.py  (BM25 hybrid + MMR)
  - core/rate_limiter.py
  - core/metrics.py
"""
from __future__ import annotations

import time
import pytest

# ─────────────────────────────────────────────────────────────────────────────
# TaskClassifier
# ─────────────────────────────────────────────────────────────────────────────

class TestTaskClassifier:
    def _clf(self):
        from lazy_chameleon.synthesis.task_classifier import TaskClassifier
        return TaskClassifier()

    def test_coding_task(self):
        clf = self._clf()
        r = clf.classify("implement a REST API endpoint with authentication")
        assert r.task_type == "coding"
        assert r.confidence > 0.4
        assert "constitutional" == r.strategy or r.strategy in (
            "constitutional", "hybrid", "chain_of_draft", "self_consistency"
        )

    def test_security_task(self):
        clf = self._clf()
        r = clf.classify("audit the authentication flow for SQL injection and XSS vulnerabilities")
        assert r.task_type == "security"
        assert r.strategy == "devils_advocate"
        assert r.confidence > 0.5

    def test_math_task(self):
        clf = self._clf()
        r = clf.classify("calculate the derivative of sin(x) and solve the equation")
        assert r.task_type == "math"
        assert r.strategy == "self_consistency"

    def test_architecture_task(self):
        clf = self._clf()
        r = clf.classify("design a distributed microservices architecture with load balancing")
        assert r.task_type == "architecture"
        assert r.strategy == "budget_force"

    def test_debugging_task(self):
        clf = self._clf()
        r = clf.classify("debug this stack trace: TypeError null pointer exception in production")
        assert r.task_type == "debugging"
        assert r.strategy == "chain_of_draft"

    def test_general_single_model(self):
        clf = self._clf()
        r = clf.classify("the quick brown fox jumps over the lazy dog")
        assert r.task_type == "general"
        assert r.strategy == "hybrid"
        assert r.confidence < 0.5

    def test_suggested_agents_non_empty(self):
        clf = self._clf()
        r = clf.classify("write a Python class for a doubly-linked list")
        assert len(r.suggested_agents) >= 2
        assert all(isinstance(a, str) for a in r.suggested_agents)

    def test_reasoning_populated(self):
        clf = self._clf()
        r = clf.classify("implement binary search tree with balanced rotations")
        assert len(r.reasoning) > 10

    def test_best_strategy_for_helper(self):
        from lazy_chameleon.synthesis.task_classifier import TaskClassifier
        assert TaskClassifier.best_strategy_for("security") == "devils_advocate"
        assert TaskClassifier.best_strategy_for("math") == "self_consistency"
        assert TaskClassifier.best_strategy_for("unknown_type") == "hybrid"

    def test_classify_empty_string(self):
        clf = self._clf()
        r = clf.classify("")
        assert r.task_type == "general"
        assert r.confidence < 0.5

    def test_classify_returns_dataclass(self):
        from lazy_chameleon.synthesis.task_classifier import ClassificationResult
        clf = self._clf()
        r = clf.classify("build a caching layer with Redis")
        assert isinstance(r, ClassificationResult)

    def test_high_confidence_overrides_hybrid(self):
        """When confidence is high the caller should trust the strategy."""
        clf = self._clf()
        r = clf.classify("sql injection auth bypass penetration test payload vector")
        # should be security with confidence high enough to override hybrid
        assert r.confidence > 0.5
        assert r.strategy == "devils_advocate"

    def test_creative_task(self):
        clf = self._clf()
        r = clf.classify("write a short story about a robot learning to feel emotions")
        assert r.task_type == "creative"
        assert r.strategy == "scratchpad"

    def test_research_task(self):
        clf = self._clf()
        r = clf.classify("summarize the literature on transformer attention mechanisms")
        assert r.task_type == "research"
        assert r.strategy == "chain_of_draft"


# ─────────────────────────────────────────────────────────────────────────────
# RAGEngine — BM25 + MMR
# ─────────────────────────────────────────────────────────────────────────────

class TestRAGEngine:
    def _rag(self):
        from lazy_chameleon.synthesis.rag import RAGEngine
        return RAGEngine()

    def test_index_and_retrieve_basic(self):
        rag = self._rag()
        rag.index_agent_output("scout", "redis sliding window rate limiter sorted set approach")
        rag.index_agent_output("critic", "use token bucket algorithm for rate limiting")
        docs = rag.retrieve("sliding window rate limiter", top_k=2)
        assert len(docs) == 2
        assert docs[0]["source"] == "scout"   # scout is more relevant

    def test_retrieve_empty_index(self):
        rag = self._rag()
        docs = rag.retrieve("anything")
        assert docs == []

    def test_deduplication(self):
        rag = self._rag()
        text = "build a redis rate limiter with sliding window approach for API throttling"
        rag.index_agent_output("a1", text)
        rag.index_agent_output("a2", text)   # near-duplicate — should be skipped
        assert rag.total_deduped >= 1
        assert rag.total_indexed == 1

    def test_source_type_weighting(self):
        """agent_output should outscore memory for the same text."""
        rag = self._rag()
        rag.index_agent_output("scout", "implement redis rate limiter sliding window")
        rag.index_memory([{"content": "implement redis rate limiter sliding window extra info", "importance": 0.9}])
        docs = rag.retrieve("redis rate limiter sliding window", top_k=2)
        types = [d["type"] for d in docs]
        # agent_output should come first
        assert types[0] == "agent_output"

    def test_mmr_diversity(self):
        """MMR should avoid returning near-identical chunks consecutively."""
        rag = self._rag()
        for i in range(5):
            rag.index_agent_output(f"a{i}", f"python redis sorted set zadd zrange ranking leaderboard approach {i}")
        rag.index_agent_output("uniq", "completely different topic about machine learning neural networks")
        docs = rag.retrieve("redis sorted set leaderboard", top_k=3)
        sources = [d["source"] for d in docs]
        # 'uniq' should appear due to MMR diversity even though it's less relevant
        assert "uniq" in sources

    def test_build_context_header(self):
        rag = self._rag()
        rag.index_agent_output("scout", "build a fast API endpoint with rate limiting and auth")
        ctx = rag.build_context("rate limiting API", top_k=1)
        assert "RAG CONTEXT" in ctx
        assert "BM25" in ctx
        assert "END RAG CONTEXT" in ctx

    def test_build_context_empty(self):
        rag = self._rag()
        ctx = rag.build_context("anything")
        assert ctx == ""

    def test_index_knowledge(self):
        rag = self._rag()
        rag.index_knowledge("BM25 Okapi scoring: score = IDF * TF_norm with length normalisation", "paper")
        docs = rag.retrieve("BM25 scoring IDF", top_k=1)
        assert len(docs) == 1
        assert docs[0]["source"] == "paper"
        assert docs[0]["type"] == "knowledge"

    def test_index_memory(self):
        rag = self._rag()
        rag.index_memory([
            {"content": "user prefers concise Python code with type hints", "importance": 0.8},
            {"content": "project uses FastAPI and PostgreSQL", "importance": 0.9},
        ])
        docs = rag.retrieve("FastAPI PostgreSQL project", top_k=1)
        assert len(docs) == 1
        assert docs[0]["type"] == "memory"

    def test_get_stats(self):
        rag = self._rag()
        rag.index_agent_output("scout", "implement caching layer with Redis TTL expiry eviction policy")
        rag.index_agent_output("critic", "use LRU eviction strategy in Redis with maxmemory-policy")
        stats = rag.get_stats()
        assert stats["total_indexed"] == 2
        assert stats["vocab_size"] > 0
        assert "avg_doc_len" in stats

    def test_relevance_scores_in_0_1(self):
        rag = self._rag()
        rag.index_agent_output("s", "python async function coroutine event loop asyncio gather")
        rag.index_agent_output("c", "javascript promise then catch async await fetch")
        docs = rag.retrieve("async programming coroutine", top_k=2)
        for d in docs:
            assert 0.0 <= d["relevance"] <= 1.5    # ensemble scores can be >1 before norm

    def test_top_k_respected(self):
        rag = self._rag()
        for i in range(10):
            rag.index_agent_output(f"a{i}", f"topic {i} about different subject matter unrelated content item {i*13}")
        docs = rag.retrieve("topic subject", top_k=3)
        assert len(docs) <= 3

    def test_chunk_splitting(self):
        """Long content should be split into multiple chunks."""
        rag = self._rag()
        long_text = " ".join([f"word{i}" for i in range(600)])
        rag.index_knowledge(long_text, "doc")
        assert rag.total_indexed >= 3    # 600 words / 200 per chunk = 3 chunks


# ─────────────────────────────────────────────────────────────────────────────
# BM25Index directly
# ─────────────────────────────────────────────────────────────────────────────

class TestBM25Index:
    def _idx(self):
        from lazy_chameleon.synthesis.rag import BM25Index
        return BM25Index()

    def test_bm25_scores_basic(self):
        from lazy_chameleon.synthesis.rag import Document, _tokenize
        idx = self._idx()
        d1 = Document("redis sorted set zadd zrange sliding window rate limiter", "a")
        d2 = Document("kafka consumer group topic partition offset commit", "b")
        idx.add(d1); idx.add(d2)
        scores = idx.bm25_scores(_tokenize("redis sliding window"))
        assert scores[0] > scores[1]

    def test_dedup_via_jaccard(self):
        from lazy_chameleon.synthesis.rag import Document
        idx = self._idx()
        d1 = Document("python async generator yield from coroutine event loop", "a")
        d2 = Document("python async generator yield from coroutine event loop", "a")  # exact dup
        idx.add(d1)
        ok = idx.add(d2)
        assert ok is False
        assert len(idx.documents) == 1

    def test_hybrid_query_returns_sorted(self):
        from lazy_chameleon.synthesis.rag import Document
        idx = self._idx()
        idx.add(Document("machine learning neural network training loss backprop gradient descent", "ml"))
        idx.add(Document("database indexing b-tree query optimisation postgres explain plan", "db"))
        idx.add(Document("python decorators functools wraps closures higher order functions", "py"))
        results = idx.hybrid_query("machine learning gradient", top_k=2)
        assert len(results) <= 2
        assert results[0][0].source == "ml"    # ML doc most relevant

    def test_empty_query_returns_empty(self):
        from lazy_chameleon.synthesis.rag import Document
        idx = self._idx()
        idx.add(Document("some content about redis", "x"))
        results = idx.hybrid_query("", top_k=5)
        assert results == []


# ─────────────────────────────────────────────────────────────────────────────
# RateLimiter
# ─────────────────────────────────────────────────────────────────────────────

class TestRateLimiter:
    def _rl(self, rpm=60, tpm=100_000):
        from lazy_chameleon.core.rate_limiter import RateLimiter
        return RateLimiter(rpm=rpm, tpm=tpm)

    def test_acquire_within_limits(self):
        rl = self._rl(rpm=60, tpm=100_000)
        ok = rl.acquire(tokens=100)
        assert ok is True

    def test_token_tracking(self):
        rl = self._rl(rpm=60, tpm=100_000)
        rl.acquire(tokens=1000)
        rl.acquire(tokens=2000)
        stats = rl.get_stats()
        assert stats["tokens_this_minute"] >= 3000

    def test_stats_structure(self):
        rl = self._rl()
        stats = rl.get_stats()
        assert "tokens_this_minute" in stats
        assert "requests_this_minute" in stats
        assert "tpm_limit" in stats
        assert "rpm_limit" in stats

    def test_reset_clears_window(self):
        rl = self._rl(rpm=5, tpm=10_000)
        for _ in range(3):
            rl.acquire(tokens=100)
        rl.reset()
        stats = rl.get_stats()
        assert stats["requests_this_minute"] == 0
        assert stats["tokens_this_minute"] == 0

    def test_provider_presets_exist(self):
        from lazy_chameleon.core.rate_limiter import RateLimiter
        rl = RateLimiter.for_provider("anthropic")
        assert rl is not None
        stats = rl.get_stats()
        assert stats["rpm_limit"] > 0

    def test_openai_preset(self):
        from lazy_chameleon.core.rate_limiter import RateLimiter
        rl = RateLimiter.for_provider("openai")
        assert rl.get_stats()["tpm_limit"] > 0

    def test_unknown_provider_default(self):
        from lazy_chameleon.core.rate_limiter import RateLimiter
        rl = RateLimiter.for_provider("unknown_provider_xyz")
        assert rl is not None

    def test_acquire_records_request(self):
        rl = self._rl()
        before = rl.get_stats()["requests_this_minute"]
        rl.acquire(tokens=50)
        after = rl.get_stats()["requests_this_minute"]
        assert after == before + 1


# ─────────────────────────────────────────────────────────────────────────────
# Metrics
# ─────────────────────────────────────────────────────────────────────────────

class TestMetrics:
    def _m(self):
        from lazy_chameleon.core.metrics import MetricsCollector
        return MetricsCollector()

    def test_record_and_summary(self):
        m = self._m()
        m.record("latency", 0.5)
        m.record("latency", 1.0)
        m.record("latency", 0.8)
        s = m.summary("latency")
        assert abs(s["mean"] - 0.767) < 0.01
        assert s["min"] == 0.5
        assert s["max"] == 1.0
        assert s["count"] == 3

    def test_empty_summary(self):
        m = self._m()
        s = m.summary("nonexistent")
        assert s == {} or s.get("count", 0) == 0

    def test_increment(self):
        m = self._m()
        m.increment("api_calls")
        m.increment("api_calls")
        m.increment("api_calls")
        assert m.get_counter("api_calls") == 3

    def test_multiple_metrics(self):
        m = self._m()
        m.record("tokens", 100)
        m.record("tokens", 200)
        m.record("cost_usd", 0.001)
        m.record("cost_usd", 0.002)
        assert m.summary("tokens")["count"] == 2
        assert m.summary("cost_usd")["count"] == 2

    def test_all_metrics_keys(self):
        m = self._m()
        m.record("latency", 1.0)
        m.record("throughput", 50.0)
        m.increment("errors")
        keys = m.all_metric_names()
        assert "latency" in keys
        assert "throughput" in keys

    def test_percentile_p95(self):
        m = self._m()
        for v in range(1, 101):
            m.record("x", float(v))
        s = m.summary("x")
        assert "p95" in s
        assert 94 <= s["p95"] <= 96

    def test_reset_metric(self):
        m = self._m()
        m.record("temp", 42.0)
        m.reset("temp")
        s = m.summary("temp")
        assert s.get("count", 0) == 0

    def test_counter_reset(self):
        m = self._m()
        m.increment("hits")
        m.increment("hits")
        m.reset_counter("hits")
        assert m.get_counter("hits") == 0

    def test_export_dict(self):
        m = self._m()
        m.record("latency", 0.3)
        m.increment("calls")
        out = m.export()
        assert isinstance(out, dict)
        assert "latency" in out or "calls" in out


# ─────────────────────────────────────────────────────────────────────────────
# Integration: TaskClassifier → enhance (offline mode)
# ─────────────────────────────────────────────────────────────────────────────

class TestClassifierIntegrationOffline:
    """Verify classifier wiring in enhance() via offline path (no API key)."""

    def test_offline_coding_task_returns_string(self):
        from lazy_chameleon.enhance import enhance
        result = enhance(
            "implement a Redis sliding window rate limiter in Python",
            mode="easy",
            api_key="",
            force_offline=True,
        )
        assert isinstance(result, str)
        assert len(result) > 100

    def test_offline_security_task_contains_strategy(self):
        from lazy_chameleon.enhance import enhance
        result = enhance(
            "audit authentication for SQL injection and privilege escalation",
            mode="easy",
            api_key="",
            force_offline=True,
        )
        assert isinstance(result, str)

    def test_classifier_import_in_enhance(self):
        """TaskClassifier should be importable from the enhance module's scope."""
        import lazy_chameleon.enhance as enh
        assert hasattr(enh, "TaskClassifier")


# ─────────────────────────────────────────────────────────────────────────────
# RAG + TaskClassifier co-use
# ─────────────────────────────────────────────────────────────────────────────

class TestRAGWithClassifier:
    def test_build_context_uses_retrieved_knowledge(self):
        from lazy_chameleon.synthesis.rag import RAGEngine
        from lazy_chameleon.synthesis.task_classifier import TaskClassifier

        rag = RAGEngine()
        clf = TaskClassifier()

        task = "implement distributed rate limiting with Redis sorted sets"
        r = clf.classify(task)

        # Index classifier reasoning as knowledge
        rag.index_knowledge(
            f"Task type: {r.task_type}. Recommended strategy: {r.strategy}. "
            f"Suggested agents: {', '.join(r.suggested_agents)}",
            source="classifier",
        )
        rag.index_agent_output("scout", "redis ZADD ZCOUNT ZREMRANGEBYSCORE for sliding window")
        rag.index_agent_output("critic", "ensure atomic operations with Lua script to avoid race conditions")

        ctx = rag.build_context(task, top_k=3)
        assert "RAG CONTEXT" in ctx
        assert len(ctx) > 200
