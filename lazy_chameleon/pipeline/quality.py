"""Quality gating and scoring for pipeline data.
Provides multi-signal quality checks, heuristic and model-based scoring,
pass/fail/retry threshold policies, and domain-based routing.
Classes
-------
QualityGate: Multi-signal quality check.
QualityScorer: Heuristic + model-based scoring.
ThresholdPolicy: Pass/fail/retry decisions.
DomainRouter: Route data by domain quality.
"""
from __future__ import annotations
import enum
import json
import logging
import math
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple, Union
from lazy_chameleon.pipeline.core import PipelineResult, StageStatus
logger = logging.getLogger(__name__)
class SignalType(enum.Enum):
    SCHEMA = "schema"; STATISTICAL = "statistical"; CONSISTENCY = "consistency"; DOMAIN = "domain"; MODEL = "model"; CUSTOM = "custom"

@dataclass
class SignalResult:
    name: str; signal_type: str = "custom"; passed: bool = True; score: float = 1.0; details: str = ""
    def to_dict(self): return {"name": self.name, "type": self.signal_type, "passed": self.passed, "score": self.score, "details": self.details}

class QualityGate:
    """Multi-signal quality check that runs multiple validators."""
    def __init__(self, name="gate"):
        self.name = name; self._signals = []; self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.QualityGate"); self._results = []
    def add_signal(self, name, fn, signal_type="custom", weight=1.0):
        self._signals.append({"name": name, "fn": fn, "type": signal_type, "weight": weight})
    def evaluate(self, data, context=None):
        results = []
        for sig in self._signals:
            try:
                passed, score, details = sig["fn"](data, context), 1.0, ""
                if isinstance(passed, tuple): score, details = passed[1], passed[2] if len(passed) > 2 else ""
                results.append(SignalResult(name=sig["name"], signal_type=sig["type"], passed=bool(passed) if not isinstance(passed, tuple) else bool(passed[0]), score=score, details=details))
            except Exception as exc:
                results.append(SignalResult(name=sig["name"], signal_type=sig["type"], passed=False, score=0.0, details=str(exc)))
        with self._lock: self._results = results
        return results
    @property
    def passed(self): return all(r.passed for r in self._results) if self._results else True
    @property
    def overall_score(self):
        if not self._results: return 1.0
        total_w = sum(s["weight"] for s in self._signals[:len(self._results)]) or 1.0
        return sum(r.score * s["weight"] for r, s in zip(self._results, self._signals[:len(self._results)])) / total_w
    def to_dict(self): return {"name": self.name, "passed": self.passed, "score": self.overall_score, "signals": [r.to_dict() for r in self._results]}

class QualityScorer:
    """Heuristic + model-based scoring for data quality."""
    def __init__(self, weights=None, model_fn=None):
        self.weights = weights or {"completeness": 0.3, "consistency": 0.3, "validity": 0.2, "uniqueness": 0.2}
        self.model_fn = model_fn; self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.QualityScorer"); self._history = []
    def score_completeness(self, data):
        if not data: return 0.0
        if isinstance(data, dict):
            if not data: return 0.0
            non_null = sum(1 for v in data.values() if v is not None)
            return non_null / len(data)
        if isinstance(data, (list, tuple)):
            if not data: return 0.0
            non_null = sum(1 for x in data if x is not None)
            return non_null / len(data)
        return 1.0 if data is not None else 0.0
    def score_consistency(self, data):
        if not data: return 0.0
        if isinstance(data, dict):
            types = set(type(v).__name__ for v in data.values() if v is not None)
            return 1.0 if len(types) <= 3 else max(0.0, 1.0 - (len(types) - 3) * 0.2)
        return 1.0
    def score_validity(self, data, schema=None):
        if schema is None: return 0.8
        if isinstance(data, dict):
            expected = set(schema.keys()) if isinstance(schema, dict) else set(schema)
            actual = set(data.keys())
            if not expected: return 1.0
            return len(expected & actual) / len(expected)
        return 0.5
    def score_uniqueness(self, data):
        if isinstance(data, (list, tuple)):
            if not data: return 1.0
            return len(set(str(x) for x in data)) / len(data)
        return 1.0
    def score(self, data, schema=None, model_input=None):
        scores = {}
        scores["completeness"] = self.score_completeness(data)
        scores["consistency"] = self.score_consistency(data)
        scores["validity"] = self.score_validity(data, schema)
        scores["uniqueness"] = self.score_uniqueness(data)
        if self.model_fn and model_input is not None:
            try: scores["model_score"] = self.model_fn(model_input)
            except Exception as exc: self._logger.warning("Model scoring failed: %s", exc)
        total = sum(scores.get(k, 0) * self.weights.get(k, 0) for k in self.weights)
        result = {"total": total, "components": scores}
        with self._lock: self._history.append(result)
        return result
    def get_history(self, n=10): return self._history[-n:]

class Decision(enum.Enum): PASS = "pass"; FAIL = "fail"; RETRY = "retry"; REVIEW = "review"

@dataclass
class ThresholdPolicy:
    """Pass/fail/retry decisions based on quality scores and thresholds."""
    pass_threshold: float = 0.8
    retry_threshold: float = 0.5
    max_retries: int = 3
    min_signal_score: float = 0.3
    require_all_signals: bool = False
    _retry_counts: Dict[str, int] = field(default_factory=dict)
    _lock: Any = field(default_factory=threading.RLock)

    def evaluate(self, item_id, quality_score, signal_results=None):
        """Evaluate quality and return a decision.
        Parameters
        ----------
        item_id: Identifier for the item being evaluated.
        quality_score: Overall quality score (0.0 to 1.0).
        signal_results: Optional list of SignalResult objects.
        Returns
        -------
        Tuple[Decision, str]: Decision and reason message.
        """
        if signal_results and self.require_all_signals:
            if not all(r.passed for r in signal_results):
                failed = [r.name for r in signal_results if not r.passed]
                return (Decision.FAIL, f"Required signals failed: {failed}")
        if signal_results:
            low = [r for r in signal_results if r.score < self.min_signal_score]
            if low:
                names = [r.name for r in low]
                with self._lock:
                    cnt = self._retry_counts.get(item_id, 0) + 1
                    self._retry_counts[item_id] = cnt
                if cnt <= self.max_retries:
                    return (Decision.RETRY, f"Low signals {names} (score < {self.min_signal_score}), retry {cnt}/{self.max_retries}")
                return (Decision.FAIL, f"Low signals {names}, max retries reached")
        if quality_score >= self.pass_threshold:
            return (Decision.PASS, f"Score {quality_score:.3f} >= {self.pass_threshold}")
        if quality_score >= self.retry_threshold:
            with self._lock:
                cnt = self._retry_counts.get(item_id, 0) + 1
                self._retry_counts[item_id] = cnt
            if cnt <= self.max_retries:
                return (Decision.RETRY, f"Score {quality_score:.3f} >= {self.retry_threshold}, retry {cnt}/{self.max_retries}")
            return (Decision.FAIL, f"Score {quality_score:.3f}, max retries reached")
        return (Decision.FAIL, f"Score {quality_score:.3f} < {self.retry_threshold}")

    def reset_counts(self, item_id=None):
        with self._lock:
            if item_id: self._retry_counts.pop(item_id, None)
            else: self._retry_counts.clear()


class DomainRouter:
    """Route data items to different processing paths based on domain quality.
    Maintains domain-specific quality thresholds and routes items to
    appropriate downstream processors.
    Parameters
    ----------
    domains: Dict mapping domain name -> quality threshold.
    default_domain: Fallback domain for unrecognized items.
    """
    def __init__(self, domains=None, default_domain="general"):
        self.domains = domains or {"high": 0.9, "standard": 0.7, "low": 0.4}
        self.default_domain = default_domain
        self._routing_log: List[Dict] = []
        self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.DomainRouter")

    def add_domain(self, name, threshold, processors=None):
        """Register a domain with quality threshold.
        Parameters
        ----------
        name: Domain name.
        threshold: Min quality score for this domain.
        processors: Optional list of processor names for this domain.
        """
        self.domains[name] = {"threshold": threshold, "processors": processors or []}

    def route(self, item_id, quality_score, features=None):
        """Route an item to the appropriate domain based on quality.
        Parameters
        ----------
        item_id: Item identifier.
        quality_score: Quality score (0.0 to 1.0).
        features: Optional feature dict for domain classification.
        Returns
        -------
        str: Selected domain name.
        """
        selected = self.default_domain
        if isinstance(self.domains, dict) and self.domains:
            entry = next(iter(self.domains.items()))
            if isinstance(entry[1], dict) and "threshold" in entry[1]:
                for name, cfg in sorted(self.domains.items(), key=lambda x: x[1].get("threshold", 0), reverse=True):
                    if quality_score >= cfg.get("threshold", 0):
                        selected = name; break
            else:
                for name, threshold in sorted(self.domains.items(), key=lambda x: x[1] if isinstance(x[1], (int, float)) else 0, reverse=True):
                    th = threshold if isinstance(threshold, (int, float)) else threshold.get("threshold", 0)
                    if quality_score >= th: selected = name; break
        log_entry = {"item_id": item_id, "score": quality_score, "routed_to": selected, "timestamp": time.time()}
        with self._lock: self._routing_log.append(log_entry)
        self._logger.debug("Routed %s (score=%.3f) -> %s", item_id, quality_score, selected)
        return selected

    def get_processors(self, domain):
        cfg = self.domains.get(domain)
        if isinstance(cfg, dict): return cfg.get("processors", [])
        return []

    def get_routing_stats(self):
        with self._lock:
            counts = defaultdict(int)
            for entry in self._routing_log: counts[entry["routed_to"]] += 1
            return dict(counts)

    def get_recent_routes(self, n=20):
        with self._lock: return list(self._routing_log[-n:])

class QualityEnsemble:
    """Combines multiple QualityGates into an ensemble evaluator.
    Runs each gate independently and aggregates results using
    configurable voting or averaging strategies.
    Parameters
    ----------
    gates: List of QualityGate instances.
    strategy: Aggregation strategy ("vote", "average", "min", "max").
    """
    def __init__(self, gates=None, strategy="average"):
        self.gates = list(gates or []); self.strategy = strategy
        self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.QualityEnsemble")

    def add_gate(self, gate): self.gates.append(gate)

    def evaluate(self, data, context=None):
        results = [g.evaluate(data, context) for g in self.gates]
        scores = [g.overall_score for g in self.gates]
        passed = [g.passed for g in self.gates]
        if self.strategy == "vote":
            final_pass = sum(passed) >= len(self.gates) / 2
            final_score = sum(scores) / len(scores) if scores else 0.0
        elif self.strategy == "min":
            final_pass = all(passed); final_score = min(scores) if scores else 0.0
        elif self.strategy == "max":
            final_pass = any(passed); final_score = max(scores) if scores else 0.0
        else:
            final_pass = all(passed); final_score = sum(scores) / len(scores) if scores else 0.0
        return {"passed": final_pass, "score": final_score, "gate_results": [r.to_dict() for r in results]}


class SignalRegistry:
    """Registry of reusable quality signal functions.
    Provides built-in signal factories and custom registration.
    """
    def __init__(self):
        self._signals = {}; self._lock = threading.RLock()
        self._register_builtins()
    def _register_builtins(self):
        self.register("not_null", lambda data, ctx=None: data is not None)
        self.register("min_length", lambda data, ctx=None, min_len=1: isinstance(data, (list, tuple, str)) and len(data) >= min_len)
        self.register("max_length", lambda data, ctx=None, max_len=10000: isinstance(data, (list, tuple, str)) and len(data) <= max_len)
        self.register("positive_values", lambda data, ctx=None: all(v > 0 for v in data) if isinstance(data, (list, tuple)) else True)
        self.register("valid_json", lambda data, ctx=None: isinstance(data, dict) or (isinstance(data, str) and json.loads(data) or True))
    def register(self, name, fn):
        with self._lock: self._signals[name] = fn
    def get(self, name): return self._signals.get(name)
    def list_signals(self): return list(self._signals.keys())


class DataProfiler:
    """Profiles data quality characteristics for analysis.
    Computes statistical summaries, detects anomalies, and generates
    quality reports.
    """
    def __init__(self):
        self._profiles = {}; self._lock = threading.RLock()
        self._logger = logging.getLogger(f"{__name__}.DataProfiler")

    def profile(self, data_id, data):
        profile = {}
        if isinstance(data, dict):
            profile["type"] = "dict"; profile["keys"] = list(data.keys())
            profile["num_keys"] = len(data)
            profile["null_values"] = sum(1 for v in data.values() if v is None)
            numeric = [v for v in data.values() if isinstance(v, (int, float))]
            if numeric: profile["mean"] = sum(numeric) / len(numeric); profile["min"] = min(numeric); profile["max"] = max(numeric)
        elif isinstance(data, (list, tuple)):
            profile["type"] = "list"; profile["length"] = len(data)
            profile["null_values"] = sum(1 for v in data if v is None)
            numeric = [v for v in data if isinstance(v, (int, float))]
            if numeric: profile["mean"] = sum(numeric) / len(numeric); profile["min"] = min(numeric); profile["max"] = max(numeric)
        else: profile["type"] = type(data).__name__
        profile["size_bytes"] = len(str(data))
        profile["timestamp"] = time.time()
        with self._lock: self._profiles[data_id] = profile
        return profile

    def get_profile(self, data_id):
        with self._lock: return self._profiles.get(data_id)

    def compare(self, data_id_1, data_id_2):
        p1 = self.get_profile(data_id_1); p2 = self.get_profile(data_id_2)
        if not p1 or not p2: return None
        score = 0.0; total = 0
        for key in set(list(p1.keys()) + list(p2.keys())):
            if key in ("timestamp", "size_bytes"): continue
            total += 1
            if key in p1 and key in p2 and p1[key] == p2[key]: score += 1.0
        return score / max(total, 1)

class AnomalyDetector:
    """Detects anomalous data points using statistical methods.
    Supports z-score, IQR, and percentile-based detection.
    Parameters
    ----------
    method: Detection method ("zscore", "iqr", "percentile").
    threshold: Threshold for anomaly classification.
    """
    def __init__(self, method="zscore", threshold=3.0):
        self.method = method; self.threshold = threshold
        self._stats = {}; self._lock = threading.RLock()

    def fit(self, values):
        import statistics
        with self._lock:
            n = len(values)
            if n == 0: return
            mean = sum(values) / n
            variance = sum((x - mean) ** 2 for x in values) / n
            std = variance ** 0.5
            sorted_vals = sorted(values)
            q1 = sorted_vals[n // 4]
            q3 = sorted_vals[(3 * n) // 4]
            iqr = q3 - q1
            self._stats = {"mean": mean, "std": std, "q1": q1, "q3": q3, "iqr": iqr, "n": n}

    def is_anomaly(self, value):
        stats = self._stats
        if not stats: return False
        if self.method == "zscore":
            if stats["std"] == 0: return False
            z = abs(value - stats["mean"]) / stats["std"]
            return z > self.threshold
        elif self.method == "iqr":
            lower = stats["q1"] - 1.5 * stats["iqr"]
            upper = stats["q3"] + 1.5 * stats["iqr"]
            return value < lower or value > upper
        return False

    def score_anomaly(self, value):
        stats = self._stats
        if not stats or stats["std"] == 0: return 0.0
        z = abs(value - stats["mean"]) / stats["std"]
        return min(1.0, z / max(self.threshold, 0.1))


class QualityReport:
    """Generates comprehensive quality reports for pipeline data.
    Aggregates gate results, scores, profiles, and anomalies.
    """
    def __init__(self):
        self._entries = []; self._lock = threading.RLock()

    def add_entry(self, data_id, gate_results, score, decision, domain, details=None):
        with self._lock:
            self._entries.append({
                "data_id": data_id, "gate_results": gate_results,
                "score": score, "decision": decision.value if isinstance(decision, enum.Enum) else decision,
                "domain": domain, "details": details or {},
                "timestamp": time.time()
            })

    def get_summary(self):
        with self._lock:
            if not self._entries: return {"total": 0, "avg_score": 0, "pass_rate": 0}
            scores = [e["score"] for e in self._entries]
            passed = sum(1 for e in self._entries if e["decision"] == "pass")
            failed = sum(1 for e in self._entries if e["decision"] == "fail")
            return {
                "total": len(self._entries),
                "avg_score": sum(scores) / len(scores),
                "pass_rate": passed / len(self._entries),
                "fail_count": failed,
                "by_domain": defaultdict(int, {e["domain"]: 1 for e in self._entries}),
            }

    def get_entries(self, n=100):
        with self._lock: return list(self._entries[-n:])

    def clear(self):
        with self._lock: self._entries.clear()


class ConsistencyChecker:
    """Checks data consistency across multiple signals or sources.
    Verifies that related data fields are consistent with each other.
    """
    def __init__(self):
        self._rules = []; self._lock = threading.RLock()

    def add_rule(self, name, check_fn, description=""):
        self._rules.append({"name": name, "fn": check_fn, "desc": description})

    def check(self, data):
        results = []
        for rule in self._rules:
            try:
                passed = rule["fn"](data)
                results.append({"rule": rule["name"], "passed": bool(passed), "description": rule["desc"]})
            except Exception as exc:
                results.append({"rule": rule["name"], "passed": False, "description": rule["desc"], "error": str(exc)})
        return results

    def consistency_score(self, data):
        results = self.check(data)
        if not results: return 1.0
        return sum(1 for r in results if r["passed"]) / len(results)
