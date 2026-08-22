"""Frameworks — Training, evaluation, and testing frameworks."""
from .eval_framework import EvaluationFramework, EvalSuite, EvalResult
from .test_framework import TestFramework, TestCase, TestSuite
__all__ = ["EvaluationFramework", "EvalSuite", "EvalResult", "TestFramework", "TestCase", "TestSuite"]
