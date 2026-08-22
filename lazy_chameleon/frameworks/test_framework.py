"""TestFramework — Unit and integration testing for models."""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

@dataclass
class TestCase:
    name: str
    input: str
    expected: Any
    assertion: str = "exact_match"
    domain: str = "general"

@dataclass
class TestSuite:
    name: str
    cases: List[TestCase]

class TestFramework:
    def __init__(self):
        self._suites: Dict[str, TestSuite] = {}

    def add_suite(self, suite: TestSuite):
        self._suites[suite.name] = suite

    def run_suite(self, name: str, test_fn: Callable) -> Dict:
        suite = self._suites.get(name)
        if not suite:
            return {"error": f"Suite '{name}' not found"}
        passed = 0
        failed = 0
        details = []
        for case in suite.cases:
            try:
                result = test_fn(case.input)
                if case.assertion == "exact_match" and result == case.expected:
                    passed += 1
                    details.append({"case": case.name, "status": "pass"})
                else:
                    failed += 1
                    details.append({"case": case.name, "status": "fail", "got": result, "expected": case.expected})
            except Exception as e:
                failed += 1
                details.append({"case": case.name, "status": "error", "error": str(e)})
        return {"suite": name, "passed": passed, "failed": failed, "total": len(suite.cases),
                "pass_rate": round(passed / max(len(suite.cases), 1) * 100, 1), "details": details}

    def run_all(self, test_fn: Callable) -> Dict:
        results = {}
        for name in self._suites:
            results[name] = self.run_suite(name, test_fn)
        return results
