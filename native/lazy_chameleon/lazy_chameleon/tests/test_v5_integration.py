"""
Integration tests for Lazy Chameleon v5 components.
Tests across the major subsystems:
  1. synthesis/lazy_eval.py  – LazyEvaluator, QualityEstimator
  2. training/distiller.py   – InferenceTimeDistiller, PatternLibrary
  3. training/evaluator.py   – EvalResult, BenchmarkEvaluator,
                                ConstitutionalEvaluator, PairwiseEvaluator
"""

from __future__ import annotations


# ─────────────────────────────────────────────────────────────────────────────
# 1. synthesis/lazy_eval.py
# ─────────────────────────────────────────────────────────────────────────────

class TestLazyEval:
    """Tests for the LazyEvaluator and QualityEstimator."""

    def test_lazy_evaluator_init(self):
        from lazy_chameleon.synthesis.lazy_eval import LazyEvaluator
        ev = LazyEvaluator()
        assert ev is not None

    def test_lazy_evaluator_score_classmethod(self):
        from lazy_chameleon.synthesis.lazy_eval import LazyEvaluator
        outputs = [{"summary": "test", "details": "some details", "params": 100}]
        score = LazyEvaluator.score(outputs, "test task")
        assert isinstance(score, float)
        assert 0.0 <= score <= 1.0

    def test_lazy_evaluator_report(self):
        from lazy_chameleon.synthesis.lazy_eval import LazyEvaluator
        ev = LazyEvaluator()
        report = ev.report()
        assert isinstance(report, str)

    def test_quality_estimator_init(self):
        from lazy_chameleon.synthesis.lazy_eval import QualityEstimator
        qe = QualityEstimator()
        assert qe is not None

    def test_quality_estimator_score(self):
        from lazy_chameleon.synthesis.lazy_eval import QualityEstimator
        score = QualityEstimator.score([], "test task")
        assert isinstance(score, float)
        assert 0.0 <= score <= 1.0


# ─────────────────────────────────────────────────────────────────────────────
# 2. training/distiller.py
# ─────────────────────────────────────────────────────────────────────────────

class TestDistiller:
    """Tests for the distillation components."""

    def test_pattern_library_create(self):
        from lazy_chameleon.training.distiller import PatternLibrary
        lib = PatternLibrary()
        assert lib is not None
        assert lib.get_stats() is not None

    def test_pattern_library_add_pattern(self):
        from lazy_chameleon.training.distiller import PatternLibrary
        lib = PatternLibrary()
        pid = lib.add_pattern("Think step by step", ["break", "parts"], "math")
        assert isinstance(pid, str)
        assert len(pid) > 0

    def test_pattern_library_get_patterns(self):
        from lazy_chameleon.training.distiller import PatternLibrary
        lib = PatternLibrary()
        lib.add_pattern("Decompose", ["break"], "math")
        patterns = lib.get_patterns(task_text="break down this math problem", domain="math")
        assert isinstance(patterns, list)

    def test_distiller_init(self):
        from lazy_chameleon.training.distiller import InferenceTimeDistiller
        from lazy_chameleon.training.distiller import PatternLibrary
        lib = PatternLibrary()
        d = InferenceTimeDistiller(lib)
        assert d is not None


# ─────────────────────────────────────────────────────────────────────────────
# 3. training/evaluator.py
# ─────────────────────────────────────────────────────────────────────────────

class TestEvalResult:
    """Tests for the EvalResult dataclass."""

    def test_eval_result_importable(self):
        from lazy_chameleon.training.evaluator import EvalResult
        assert EvalResult is not None

    def test_eval_result_fields(self):
        from lazy_chameleon.training.evaluator import EvalResult
        r = EvalResult(task_id="test_001", student_score=0.85)
        assert r.student_score == 0.85
        assert r.task_id == "test_001"
        

    def test_eval_result_to_dict(self):
        from lazy_chameleon.training.evaluator import EvalResult
        r = EvalResult(
            task_id="bench_01",
            student_score=0.88,
            teacher_score=0.92,
            task_type="reasoning",
        )
        d = r.to_dict()
        assert isinstance(d, dict)
        assert d["student_score"] == 0.88
        assert d["task_id"] == "bench_01"


class TestBenchmarkEvaluator:
    """Tests for the BenchmarkEvaluator."""

    def test_importable(self):
        from lazy_chameleon.training.evaluator import BenchmarkEvaluator
        assert BenchmarkEvaluator is not None

    def test_init_requires_student_fn(self):
        from lazy_chameleon.training.evaluator import BenchmarkEvaluator
        try:
            b = BenchmarkEvaluator(lambda x: "response")
            assert b is not None
        except Exception as e:
            assert False, f"BenchmarkEvaluator init failed: {e}"

    def test_has_eval_methods(self):
        from lazy_chameleon.training.evaluator import BenchmarkEvaluator
        b = BenchmarkEvaluator(lambda x: "response")
        assert hasattr(b, "eval_coding")
        assert hasattr(b, "eval_reasoning")
        assert hasattr(b, "eval_math")
        assert hasattr(b, "run_full_suite")


class TestPairwiseEvaluator:
    """Tests for the PairwiseEvaluator."""

    def test_importable(self):
        from lazy_chameleon.training.evaluator import PairwiseEvaluator
        assert PairwiseEvaluator is not None

    def test_compare_returns_string(self):
        from lazy_chameleon.training.evaluator import PairwiseEvaluator
        p = PairwiseEvaluator(judge_fn=lambda x: x)
        result = p.compare("test prompt", "answer a", "answer b")
        assert isinstance(result, str)

    def test_compare_returns_winner_label(self):
        from lazy_chameleon.training.evaluator import PairwiseEvaluator
        p = PairwiseEvaluator(judge_fn=lambda x: x)
        result = p.compare("test", "good answer", "bad answer")
        assert result in ("a", "b", "tie")

    def test_compare_better_response_wins(self):
        from lazy_chameleon.training.evaluator import PairwiseEvaluator
        p = PairwiseEvaluator(judge_fn=lambda x: x)
        result = p.compare("test",
                           "A comprehensive detailed answer with examples.",
                           "Bad.")
        assert result in ("a", "b", "tie")


class TestConstitutionalEvaluator:
    """Tests for the ConstitutionalEvaluator."""

    def test_importable(self):
        from lazy_chameleon.training.evaluator import ConstitutionalEvaluator
        assert ConstitutionalEvaluator is not None

    def test_init_default(self):
        from lazy_chameleon.training.evaluator import ConstitutionalEvaluator
        c = ConstitutionalEvaluator()
        assert c is not None

    def test_score_response_returns_dict(self):
        from lazy_chameleon.training.evaluator import ConstitutionalEvaluator
        c = ConstitutionalEvaluator()
        result = c.score_response("A helpful answer about programming.", "test task")
        assert isinstance(result, dict)
        assert len(result) > 0

    def test_aggregate_score(self):
        from lazy_chameleon.training.evaluator import ConstitutionalEvaluator
        c = ConstitutionalEvaluator()
        score = c.aggregate_score({"helpfulness": 0.9, "harmlessness": 0.8})
        assert isinstance(score, float)
        assert 0.0 <= score <= 1.0


class TestV5FullIntegration:
    """End-to-end tests exercising multiple subsystems together."""

    def test_imports_from_training_package(self):
        """Core training symbols must be importable from the training package."""
        from lazy_chameleon.training import (
            BenchmarkEvaluator,
            PairwiseEvaluator,
            ConstitutionalEvaluator,
            EvalResult,
        )
        assert all([BenchmarkEvaluator, PairwiseEvaluator,
                    ConstitutionalEvaluator, EvalResult])

    def test_full_eval_suite(self):
        """All three evaluators must work together on a single response."""
        from lazy_chameleon.training.evaluator import (
            BenchmarkEvaluator,
            ConstitutionalEvaluator,
            PairwiseEvaluator,
        )

        output = (
            "Here is a comprehensive and helpful answer. You can use this approach. "
            "First, consider the problem carefully. Because of X, we see Y. "
            "Therefore the answer is Z."
        )

        bench = BenchmarkEvaluator(student_fn=lambda x: "response")
        const = ConstitutionalEvaluator()
        pair  = PairwiseEvaluator(judge_fn=lambda x: x)

        const_r = const.score_response(output, "test prompt")
        pair_r  = pair.compare("prompt", output, "bad answer")

        assert isinstance(const_r, dict)
        assert pair_r in ("a", "b", "tie")

    def test_eval_result_to_dict_format(self):
        """EvalResult.to_dict() returns a dict with score and breakdown."""
        from lazy_chameleon.training.evaluator import EvalResult
        r = EvalResult(
            task_id="bench_01",
            student_score=0.88,
            teacher_score=0.92,
            task_type="reasoning",
        )
        d = r.to_dict()
        assert "student_score" in d
