---
name: eval-design
description: Design document for agentic evaluations
---

# LAZY CHAMELEON - Evaluation & Self-Improvement

## Eval-Harness Design Document

### ConfidenceScorer (L10)
class ConfidenceScorer:
    def score(self, solution, plan):
        signals = {
            "req_coverage": self._check_requirements(solution, plan),
            "verification": self._check_verification(solution),
            "risk": self._assess_risks(solution),
            "specificity": self._check_specificity(solution),
            "consistency": self._check_consistency(solution),
        }
        overall = (
            signals["req_coverage"] * 0.35 +
            signals["verification"] * 0.25 +
            (1 - signals["risk"]) * 0.20 +
            signals["specificity"] * 0.10 +
            signals["consistency"] * 0.10
        )
        return ConfidenceScore(overall, signals)

    def should_continue(self, score, budget):
        if score.overall < 0.3 and budget > 0:
            return True  # Very uncertain
        if score.overall < 0.6 and score.signals["risk"] > 0.5:
            return True  # High risk
        return False

### AdversarialCritic (L12)
class AdversarialCritic:
    async def critique(self, solution, task):
        prompt = f"""Ruthless review. Find EVERY flaw.
ISSUE: description | SEVERITY: CRITICAL/MAJOR/MINOR | CATEGORY: bug/halluc/security/missing"""
        resp = await self.model.generate(prompt)
        return Critique.parse(resp)

    def severity_score(self, critique):
        weights = {"CRITICAL": 0.5, "MAJOR": 0.3, "MINOR": 0.1}
        return min(sum(weights[i.severity] for i in critique.issues), 1.0)

### OutputGrader (L35)
class OutputGrader:
    def grade(self, solution, task):
        return Grade(
            correctness=self._rate_correctness(solution, task),
            completeness=self._rate_completeness(solution, task),
            efficiency=self._rate_efficiency(solution),
            style=self._rate_style(solution),
            safety=self._rate_safety(solution),
        )
    # Each rating 0-1, based on compile/test/lint results

### FailureModeDetector (L42)
class FailureModeDetector:
    MODES = {
        "hallucination": {
            "signals": ["doesn't exist", "wrong version", "made-up"],
            "fix": "add_verification_prompt"
        },
        "logic_error": {
            "signals": ["wrong condition", "off-by-one", "incorrect"],
            "fix": "decompose_more"
        },
        "missing_context": {
            "signals": ["wrong file", "wrong directory"],
            "fix": "search_first"
        },
        "tool_misuse": {
            "signals": ["wrong command", "wrong flag"],
            "fix": "add_tool_selection_prompt"
        },
        "overconfidence": {
            "signals": ["guaranteed", "always", "never", "absolutely"],
            "fix": "force_verification"
        },
    }

    def classify(self, result):
        for mode, spec in self.MODES.items():
            if any(s in result.lower() for s in spec["signals"]):
                return FailureMode(mode, spec["fix"])
        return FailureMode("unknown", "default")

### BenchmarkRunner (L40)
class BenchmarkRunner:
    BENCHMARKS = {
        "coding": ["HumanEval", "MBPP", "CodeContests"],
        "reasoning": ["GSM8K", "MATH", "LogiQA"],
        "agent": ["SWE-bench", "AgentBench", "GAIA"],
        "tool_use": ["ToolQA", "APIBench"],
        "debug": ["Defects4J", "QuixBugs"],
        "long_ctx": ["RepoBench", "NeedleInHaystack"],
    }

    async def run(self, category=None):
        results = {}
        cats = [category] if category else self.BENCHMARKS
        for cat, benches in cats.items():
            for b in benches:
                results[b] = await self._run(b)
        return results

    async def compare(self, harness):
        raw = await self._run_raw(harness.model)
        with_harness = await harness.run_benchmarks(self)
        return {k: with_harness[k] - raw[k] for k in raw}

### SelfTrainingLoop (L26)
class SelfTrainingLoop:
    def __init__(self):
        self.training_data = []

    def process(self, task, run, grade):
        example = {
            "task": task,
            "attempts": run.attempts,
            "final": run.final,
            "grade": grade,
            "success": grade.overall > 0.7,
            "config": run.config,
        }
        self.training_data.append(example)

        if not example["success"]:
            mode = FailureModeDetector().classify(str(run.final))
            FailureBank().record(task, run.final, mode)

        if len(self.training_data) % 100 == 0:
            self._optimize()

    def _optimize(self):
        from collections import Counter
        modes = Counter(f["mode"] for f in FailureBank().get_recent(1000))
        worst = modes.most_common(3)
        for mode, count in worst:
            self._apply_fix(mode)
