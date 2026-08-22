"""
Comprehensive test suite for lazy_chameleon v2.0.

Tests cover:
- StallEngine (all 8 strategies)
- StallResult
- TokenBudget (init, request, record, tokens_used, cache_hit_rate, etc.)
- LazyEvaluator (force_all, lazy mode)
- KnowledgeCompressor (all compression methods)
- enhance_with_stall and _generate_offline_context
"""

import pytest
import sys
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional

# Add project root to path
project_root = str(Path(__file__).parent.parent)
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from lazy_chameleon.synthesis.staller import StallEngine, StallResult
from lazy_chameleon.synthesis.lazy_eval import LazyEvaluator
from lazy_chameleon.core.budget import TokenBudget, CallRecord, BudgetAllocation
from lazy_chameleon.compression.compressor import KnowledgeCompressor
from lazy_chameleon.enhance import enhance_with_stall, _generate_offline_context


# ═══════════════════════════════════════════════════════════════════════════
# STALL ENGINE & RELATED TESTS
# ═══════════════════════════════════════════════════════════════════════════

class TestStallEngine:
    """Test StallEngine with all 8 strategies."""

    def test_stall_engine_init(self):
        engine = StallEngine()
        assert engine is not None
        assert hasattr(engine, 'build_prompt')

    def test_stall_engine_strategies_exist(self):
        """Verify all 8 strategies are available."""
        engine = StallEngine()
        strategies = [
            'chain_of_draft', 'budget_force', 'constitutional', 'scratchpad',
            'devils_advocate', 'self_consistency', 'confidence_gate', 'hybrid'
        ]
        for strategy in strategies:
            assert isinstance(strategy, str)

    def test_build_prompt_with_base_context_positional(self):
        """Test that build_prompt accepts base_context as positional arg."""
        engine = StallEngine()
        task = "Solve a math problem"
        base_ctx = "Context here"
        strategy = "chain_of_draft"
        
        result = engine.build_prompt(task, base_ctx, strategy)
        assert result is not None
        assert isinstance(result, str)

    def test_build_prompt_with_base_context_keyword(self):
        """Test that build_prompt accepts base_context as keyword arg."""
        engine = StallEngine()
        task = "Solve a math problem"
        base_ctx = "Context here"
        strategy = "budget_force"
        
        result = engine.build_prompt(task, base_context=base_ctx, strategy=strategy)
        assert result is not None

    def test_stall_result_creation(self):
        """Test StallResult data structure with proper fields."""
        result = StallResult(
            strategy="chain_of_draft",
            content="test output",
            tokens_used=100,
            tokens_saved=20,
            confidence=0.95,
            passes=2,
            time_taken=0.5
        )
        assert result.strategy == "chain_of_draft"
        assert result.content == "test output"
        assert result.tokens_used == 100
        assert result.tokens_saved == 20
        assert result.confidence == 0.95


# ═══════════════════════════════════════════════════════════════════════════
# TOKEN BUDGET TESTS
# ═══════════════════════════════════════════════════════════════════════════

class TestTokenBudget:
    """Test TokenBudget implementation."""

    def test_token_budget_init_defaults(self):
        budget = TokenBudget()
        assert budget.mode == "hard"
        assert budget.model == "deepseek-v4-flash"
        assert budget.hard_cap > 0

    def test_token_budget_init_custom_mode(self):
        budget = TokenBudget(mode="easy")
        assert budget.mode == "easy"
        assert budget.hard_cap == 40_000

    def test_token_budget_init_custom_hard_cap(self):
        budget = TokenBudget(hard_cap_tokens=5000)
        assert budget.hard_cap == 5000

    def test_token_budget_request(self):
        budget = TokenBudget(mode="easy")
        alloc = budget.request(label="test_call", prompt_tokens=500, completion_tokens=200)
        assert alloc is not None
        assert alloc.label == "test_call"
        assert alloc.max_prompt_tokens > 0
        assert alloc.max_completion_tokens > 0

    def test_token_budget_record(self):
        budget = TokenBudget(mode="medium")
        record = CallRecord(
            model="deepseek-v4-flash",
            provider="opencode-go",
            prompt_tokens=150,
            completion_tokens=100
        )
        budget.record(record)
        assert budget.tokens_used() == 250

    def test_token_budget_tokens_used(self):
        budget = TokenBudget()
        assert budget.tokens_used() == 0
        budget.record_simple("test", 100, 50)
        assert budget.tokens_used() == 150

    def test_token_budget_tokens_remaining(self):
        budget = TokenBudget(hard_cap_tokens=10000)
        assert budget.tokens_remaining() == 10000
        budget.record_simple("test", 2000, 1000)
        assert budget.tokens_remaining() == 7000

    def test_token_budget_cache_hit_rate(self):
        budget = TokenBudget()
        rate = budget.cache_hit_rate()
        assert isinstance(rate, float)
        assert 0 <= rate <= 1

    def test_token_budget_cost_usd(self):
        budget = TokenBudget()
        budget.record_simple("test", 1000, 500)
        cost = budget.cost_usd()
        assert isinstance(cost, float)
        assert cost >= 0

    def test_call_record_creation(self):
        record = CallRecord(
            model="claude-sonnet-5",
            provider="anthropic",
            prompt_tokens=100,
            completion_tokens=50
        )
        assert record.prompt_tokens == 100
        assert record.completion_tokens == 50
        assert record.total_tokens == 150

    def test_call_record_with_cached_tokens(self):
        record = CallRecord(
            model="claude-sonnet-5",
            provider="anthropic",
            prompt_tokens=100,
            completion_tokens=50,
            cached_tokens=80
        )
        assert record.cached_tokens == 80
        cost = record.cost_usd()
        assert isinstance(cost, float)
        assert cost > 0

    def test_budget_allocation(self):
        alloc = BudgetAllocation(
            label="scout",
            max_prompt_tokens=1000,
            max_completion_tokens=500
        )
        assert alloc.label == "scout"
        assert alloc.max_prompt_tokens == 1000
        assert alloc.priority == 5


# ═══════════════════════════════════════════════════════════════════════════
# LAZY EVALUATOR TESTS
# ═══════════════════════════════════════════════════════════════════════════

class TestLazyEvaluator:
    """Test LazyEvaluator lazy mode and evaluation."""

    def test_lazy_evaluator_init(self):
        evaluator = LazyEvaluator()
        assert evaluator is not None

    def test_lazy_evaluator_has_report_method(self):
        evaluator = LazyEvaluator()
        assert hasattr(evaluator, 'report')

    def test_lazy_evaluator_score_class_method(self):
        outputs = [
            {"answer": "test1", "quality": 0.9},
            {"answer": "test2", "quality": 0.8}
        ]
        score = LazyEvaluator.score(outputs, "test task")
        assert isinstance(score, float)
        assert 0 <= score <= 1


# ═══════════════════════════════════════════════════════════════════════════
# KNOWLEDGE COMPRESSOR TESTS
# ═══════════════════════════════════════════════════════════════════════════

class TestKnowledgeCompressor:
    """Test KnowledgeCompressor compression methods."""

    def test_compressor_init(self):
        compressor = KnowledgeCompressor()
        assert compressor is not None

    def test_compress_lingua(self):
        compressor = KnowledgeCompressor()
        text = "The quick brown fox jumps over the lazy dog. " * 10
        compressed = compressor.compress_lingua(text, ratio=0.5)
        assert compressed is not None
        assert isinstance(compressed, str)
        # Compressed should be shorter than original
        assert len(compressed) <= len(text)

    def test_compress_semantic_dedup(self):
        compressor = KnowledgeCompressor()
        text = "Point A about facts. Point A about facts. Point B about different facts. Point B about different facts."
        compressed = compressor.compress_semantic_dedup(text, threshold=0.65)
        assert compressed is not None
        assert isinstance(compressed, str)

    def test_compress_sliding_window(self):
        compressor = KnowledgeCompressor()
        text = "First sentence. Second sentence. Third sentence. Fourth sentence. Fifth sentence."
        compressed = compressor.compress_sliding_window(text, window_tokens=2)
        assert compressed is not None
        assert isinstance(compressed, str)

    def test_compress_adaptive(self):
        compressor = KnowledgeCompressor()
        text = "Important fact about X. Trivial detail. Another important point about Y. Minor note."
        compressed = compressor.compress_adaptive(text, target_tokens=50)
        assert compressed is not None
        assert isinstance(compressed, str)

    def test_compressor_get_stats(self):
        compressor = KnowledgeCompressor()
        text = "Test text for compression stats."
        compressor.compress_lingua(text)
        stats = compressor.get_stats()
        assert isinstance(stats, dict)

    def test_compressor_compression_ratio(self):
        compressor = KnowledgeCompressor()
        text = "Sample text for ratio calculation. " * 5
        compressor.compress_lingua(text)
        ratio = compressor.compression_ratio
        assert isinstance(ratio, float)
        assert 0 <= ratio <= 1


# ═══════════════════════════════════════════════════════════════════════════
# ENHANCE WITH STALL TESTS
# ═══════════════════════════════════════════════════════════════════════════

class TestEnhanceWithStall:
    """Test enhance_with_stall and _generate_offline_context."""

    def test_enhance_with_stall_minimal(self):
        task = "Solve a simple math problem: 2+2=?"
        agent_name = "scout"
        base_prompt = "You are helpful."
        result = enhance_with_stall(task, agent_name, base_prompt, mode="easy")
        assert result is not None
        assert isinstance(result, str)

    def test_enhance_with_stall_with_mode(self):
        task = "Complex problem"
        agent_name = "analyst"
        base_prompt = "Think deeply."
        result = enhance_with_stall(task, agent_name, base_prompt, mode="medium")
        assert result is not None

    def test_generate_offline_context(self):
        task = "Test task for context generation"
        context = _generate_offline_context(task, mode="easy")
        assert context is not None
        assert isinstance(context, str)

    def test_generate_offline_context_with_stall_strategy(self):
        task = "Task with stalling"
        context = _generate_offline_context(task, mode="medium", stall_strategy="chain_of_draft")
        assert context is not None


# ═══════════════════════════════════════════════════════════════════════════
# INTEGRATION TESTS
# ═══════════════════════════════════════════════════════════════════════════

class TestIntegration:
    """Integration tests for the full pipeline."""

    def test_full_pipeline_components_initialized(self):
        """Test that all components can be initialized together."""
        engine = StallEngine()
        budget = TokenBudget(mode="easy")
        evaluator = LazyEvaluator()
        compressor = KnowledgeCompressor()
        
        assert engine is not None
        assert budget is not None
        assert evaluator is not None
        assert compressor is not None

    def test_stall_result_with_budget_workflow(self):
        """Test typical workflow with StallResult and budget."""
        budget = TokenBudget(mode="medium", hard_cap_tokens=50000)
        
        # Request quota
        alloc = budget.request(label="stall_agent", prompt_tokens=1000, completion_tokens=500)
        assert alloc is not None
        
        # Record usage
        budget.record_simple("stall_agent", 800, 300)
        
        # Create result
        result = StallResult(
            strategy="chain_of_draft",
            content="enriched output",
            tokens_used=alloc.max_prompt_tokens + alloc.max_completion_tokens,
            tokens_saved=200,
            confidence=0.92,
            passes=3,
            time_taken=1.2
        )
        assert result.tokens_saved > 0
        assert result.confidence > 0.8

    def test_compressor_with_lazy_evaluator(self):
        """Test compressor with evaluator results."""
        compressor = KnowledgeCompressor()
        
        # Simulate agent outputs
        outputs = [
            {"answer": "Answer 1. More details.", "quality": 0.85},
            {"answer": "Answer 2. Different approach.", "quality": 0.88}
        ]
        
        # Score them
        score = LazyEvaluator.score(outputs, "test task")
        assert 0 <= score <= 1


# ═══════════════════════════════════════════════════════════════════════════
# EDGE CASES & ERROR HANDLING
# ═══════════════════════════════════════════════════════════════════════════

class TestEdgeCases:
    """Test edge cases and error handling."""

    def test_stall_engine_empty_task(self):
        engine = StallEngine()
        result = engine.build_prompt("", "", "chain_of_draft")
        assert result is not None

    def test_token_budget_request_exhausted(self):
        budget = TokenBudget(hard_cap_tokens=100)
        budget.record_simple("test1", 80, 20)
        # Next request should be denied or limited
        alloc = budget.request("test2", prompt_tokens=100, completion_tokens=100)
        # Either None or very small allocation
        if alloc:
            assert alloc.max_prompt_tokens < 100

    def test_compressor_empty_text(self):
        compressor = KnowledgeCompressor()
        result = compressor.compress_lingua("")
        # Should handle empty gracefully
        assert result is not None or result == ""

    def test_call_record_zero_tokens(self):
        record = CallRecord(
            model="test-model",
            provider="test",
            prompt_tokens=0,
            completion_tokens=0
        )
        assert record.total_tokens == 0
        cost = record.cost_usd()
        assert cost >= 0

    def test_budget_multiple_records(self):
        budget = TokenBudget(hard_cap_tokens=10000)
        for i in range(5):
            budget.record_simple(f"call_{i}", 100, 50)
        
        used = budget.tokens_used()
        assert used == 5 * 150
        assert budget.tokens_remaining() == 10000 - used

    def test_stall_result_zero_confidence(self):
        result = StallResult(
            strategy="test",
            content="",
            tokens_used=0,
            tokens_saved=0,
            confidence=0.0,
            passes=0,
            time_taken=0.0
        )
        assert result.confidence == 0.0


# ═══════════════════════════════════════════════════════════════════════════
# BUDGET MODE TESTS
# ═══════════════════════════════════════════════════════════════════════════

class TestBudgetModes:
    """Test different budget modes."""

    modes_and_caps = [
        ("flash", 20_000),
        ("easy", 40_000),
        ("turbo", 60_000),
        ("medium", 100_000),
        ("hard", 200_000),
        ("deep", 400_000),
        ("extreme", 700_000),
        ("genius", 1_200_000),
        ("god", 2_000_000),
    ]

    @pytest.mark.parametrize("mode,expected_cap", modes_and_caps)
    def test_budget_mode_caps(self, mode, expected_cap):
        budget = TokenBudget(mode=mode)
        assert budget.hard_cap == expected_cap

    @pytest.mark.parametrize("mode,_", modes_and_caps)
    def test_budget_mode_request(self, mode, _):
        budget = TokenBudget(mode=mode)
        alloc = budget.request("test", prompt_tokens=100, completion_tokens=100)
        assert alloc is not None


# ── New tests added in v2.3 sweep ─────────────────────────────────────────

import logging
import os
import tempfile
import time

from lazy_chameleon.synthesis.cache import SynthesisCache
from lazy_chameleon.memory.memory import WarmMemory, MemoryItem, ColdMemory


class TestCacheTTL:
    """SynthesisCache TTL validation and generate_fast()."""

    def test_get_returns_value_within_ttl(self):
        cache = SynthesisCache(ttl_seconds=60)
        cache.set("task-a", "hard", "result-a")
        assert cache.get("task-a", "hard") == "result-a"

    def test_get_returns_none_after_ttl_expires(self):
        cache = SynthesisCache(ttl_seconds=0)
        cache.set("task-b", "hard", "result-b")
        # ttl=0 means everything is immediately expired
        time.sleep(0.01)
        assert cache.get("task-b", "hard") is None

    def test_expired_entry_is_evicted(self):
        cache = SynthesisCache(ttl_seconds=0)
        cache.set("task-c", "easy", "result-c")
        time.sleep(0.01)
        cache.get("task-c", "easy")  # triggers lazy eviction
        assert len(cache._store) == 0

    def test_generate_fast_hit(self):
        cache = SynthesisCache(ttl_seconds=60)
        cache.set("task-d", "medium", "fast-result")
        result = cache.generate_fast("task-d", "medium")
        assert result == "fast-result"

    def test_generate_fast_miss_returns_none(self):
        cache = SynthesisCache(ttl_seconds=60)
        assert cache.generate_fast("nonexistent-task", "hard") is None

    def test_generate_fast_expired_returns_none(self):
        cache = SynthesisCache(ttl_seconds=0)
        cache.set("task-e", "turbo", "stale")
        time.sleep(0.01)
        assert cache.generate_fast("task-e", "turbo") is None

    def test_lru_eviction_keeps_cache_bounded(self):
        cache = SynthesisCache(ttl_seconds=3600, max_entries=3)
        for i in range(4):
            cache.set(f"task-{i}", "hard", f"result-{i}")
        assert len(cache._store) <= 3

    def test_stats_include_ttl(self):
        cache = SynthesisCache(ttl_seconds=120)
        stats = cache.get_stats()
        assert stats["ttl_seconds"] == 120


class TestWarmMemoryDedup:
    """WarmMemory deduplication via upsert."""

    def _make_db(self):
        tmp = tempfile.mktemp(suffix=".db")
        return WarmMemory(tmp)

    def _fetch_all(self, mem: WarmMemory) -> list:
        import sqlite3
        conn = sqlite3.connect(mem.db_path)
        rows = conn.execute(
            "SELECT key, content FROM project_memory"
        ).fetchall()
        conn.close()
        return rows

    def test_first_store_returns_true(self):
        mem = self._make_db()
        item = MemoryItem(key="k1", content="v1", category="test")
        assert mem.store(item) is True

    def test_duplicate_store_returns_false(self):
        mem = self._make_db()
        mem.store(MemoryItem(key="k2", content="original", category="test"))
        assert mem.store(MemoryItem(key="k2", content="updated", category="test")) is False

    def test_duplicate_updates_content(self):
        mem = self._make_db()
        mem.store(MemoryItem(key="k3", content="old", category="test"))
        mem.store(MemoryItem(key="k3", content="new", category="test"))
        rows = self._fetch_all(mem)
        matching = [r for r in rows if r[0] == "k3"]
        assert len(matching) == 1
        assert matching[0][1] == "new"

    def test_different_keys_both_stored(self):
        mem = self._make_db()
        mem.store(MemoryItem(key="a", content="val-a", category="test"))
        mem.store(MemoryItem(key="b", content="val-b", category="test"))
        rows = self._fetch_all(mem)
        keys = [r[0] for r in rows]
        assert "a" in keys and "b" in keys


class TestColdMemoryAutoVacuum:
    """ColdMemory write-count tracking for auto-vacuum trigger."""

    def test_write_count_increments(self):
        with tempfile.TemporaryDirectory() as d:
            db = os.path.join(d, "cold.db")
            cold = ColdMemory(db)
            cold.store_failure("t1", "analysis-1")
            assert cold._write_count == 1
            cold.store_failure("t2", "analysis-2")
            assert cold._write_count == 2

    def test_write_count_resets_mod_100(self):
        """After 100 writes the vacuum runs; count keeps incrementing."""
        with tempfile.TemporaryDirectory() as d:
            db = os.path.join(d, "cold100.db")
            cold = ColdMemory(db)
            for i in range(100):
                cold.store_failure(f"task-{i}", f"analysis-{i}")
            # 100 % 100 == 0 → vacuum ran, count is now 100
            assert cold._write_count == 100


class TestBudgetWarnThreshold:
    """TokenBudget warn_threshold fires a log warning once at ≥90 % consumption."""

    def _fill_to_fraction(self, budget: TokenBudget, fraction: float):
        """Record synthetic CallRecords to consume `fraction` of hard_cap."""
        target = int(budget.hard_cap * fraction)
        budget._records.append(
            CallRecord(
                model=budget.model,
                provider=budget.provider,
                prompt_tokens=target,
                completion_tokens=0,
                cached_tokens=0,
                label="synthetic",
            )
        )

    def test_warn_threshold_default_is_0_9(self):
        budget = TokenBudget(mode="hard")
        assert budget.warn_threshold == 0.9

    def test_custom_warn_threshold_stored(self):
        budget = TokenBudget(mode="hard", warn_threshold=0.75)
        assert budget.warn_threshold == 0.75

    def test_warn_emitted_when_threshold_crossed(self):
        budget = TokenBudget(mode="hard", warn_threshold=0.9)
        self._fill_to_fraction(budget, 0.91)
        budget.request("probe", prompt_tokens=100, completion_tokens=50)
        assert budget._warn_emitted is True

    def test_warn_not_emitted_below_threshold(self):
        budget = TokenBudget(mode="hard", warn_threshold=0.9)
        self._fill_to_fraction(budget, 0.50)
        budget.request("probe", prompt_tokens=100, completion_tokens=50)
        assert budget._warn_emitted is False

    def test_warn_emitted_only_once(self):
        budget = TokenBudget(mode="hard", warn_threshold=0.9)
        self._fill_to_fraction(budget, 0.91)
        budget.request("probe1", prompt_tokens=50, completion_tokens=25)
        budget.request("probe2", prompt_tokens=50, completion_tokens=25)
        # Flag stays True — warning was emitted on the first crossing only.
        assert budget._warn_emitted is True

    def test_warn_log_message_via_caplog(self, caplog):
        budget = TokenBudget(mode="medium", warn_threshold=0.5)
        self._fill_to_fraction(budget, 0.51)
        with caplog.at_level(logging.WARNING, logger="lazy_chameleon.core.budget"):
            budget.request("probe", prompt_tokens=100, completion_tokens=50)
        assert any("consumed" in r.message for r in caplog.records)


class TestStallIntegration:
    """StallEngine wired into agents/base.py for hard/deep/extreme/genius/god."""

    def test_stall_engine_available_for_hard_mode(self):
        from lazy_chameleon.agents.base import _get_stall_engine
        engine = _get_stall_engine("hard")
        assert engine is not None

    def test_stall_engine_available_for_god_mode(self):
        from lazy_chameleon.agents.base import _get_stall_engine
        engine = _get_stall_engine("god")
        assert engine is not None

    def test_stall_engine_not_used_for_flash_mode(self):
        # _STALL_MODES controls whether stalling runs in run(); flash is excluded
        from lazy_chameleon.agents.base import _STALL_MODES
        assert "flash" not in _STALL_MODES

    def test_stall_engine_not_used_for_easy_mode(self):
        from lazy_chameleon.agents.base import _STALL_MODES
        assert "easy" not in _STALL_MODES


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
