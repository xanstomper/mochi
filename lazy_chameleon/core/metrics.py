"""
Metrics — lightweight strategy performance tracker.

Persists per-strategy win/loss records across sessions so the classifier
and staller can auto-tune toward whatever is actually working.

Storage: SQLite via WarmMemory's db path (same file, separate table).
Fallback: in-memory only if no db path given.

Usage
─────
    tracker = MetricsTracker(db_path="~/.lazy_chameleon/memory.db")
    tracker.record("constitutional", task_type="coding",
                   quality=0.88, tokens_used=1200, time_taken=2.1)
    best = tracker.best_strategy_for("coding")   # "constitutional"
    tracker.report()                              # pretty-print table
"""
from __future__ import annotations

import json
import logging
import math
import os
import sqlite3
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

log = logging.getLogger(__name__)

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS strategy_metrics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy    TEXT    NOT NULL,
    task_type   TEXT    NOT NULL DEFAULT 'general',
    quality     REAL    NOT NULL,
    tokens_used INTEGER NOT NULL DEFAULT 0,
    time_taken  REAL    NOT NULL DEFAULT 0,
    mode        TEXT    NOT NULL DEFAULT 'hard',
    timestamp   REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sm_strategy  ON strategy_metrics(strategy);
CREATE INDEX IF NOT EXISTS idx_sm_task_type ON strategy_metrics(task_type);
"""


@dataclass
class StrategyStats:
    """Aggregate stats for one strategy (optionally scoped to a task_type)."""
    strategy: str
    task_type: str
    n: int = 0
    avg_quality: float = 0.0
    p50_quality: float = 0.0
    p90_quality: float = 0.0
    avg_tokens: float = 0.0
    avg_time_s: float = 0.0
    win_rate: float = 0.0      # fraction of runs >= 0.75 quality
    score: float = 0.0         # composite score used for ranking

    def summary(self) -> str:
        return (
            f"{self.strategy:<20} n={self.n:<4} "
            f"avg_q={self.avg_quality:.3f}  "
            f"p90={self.p90_quality:.3f}  "
            f"win={self.win_rate:.0%}  "
            f"tok={self.avg_tokens:.0f}  "
            f"score={self.score:.3f}"
        )


class MetricsTracker:
    """
    Thread-safe strategy performance tracker backed by SQLite.

    Falls back to pure in-memory storage when db_path is empty.
    """

    WIN_THRESHOLD = 0.75        # quality >= this counts as a "win"
    MIN_SAMPLES   = 3           # need at least N samples to trust a strategy

    def __init__(self, db_path: str = ""):
        self._db_path = os.path.expanduser(db_path) if db_path else ""
        self._lock = threading.Lock()
        self._memory: list[dict] = []   # fallback when no db

        if self._db_path:
            try:
                self._init_db()
            except Exception as exc:
                log.warning("MetricsTracker: db init failed (%s) — using memory", exc)
                self._db_path = ""

    # ── Write ────────────────────────────────────────────────────────────────

    def record(
        self,
        strategy: str,
        quality: float,
        task_type: str = "general",
        tokens_used: int = 0,
        time_taken: float = 0.0,
        mode: str = "hard",
    ):
        """Record a single strategy run result."""
        row = {
            "strategy":   strategy,
            "task_type":  task_type,
            "quality":    float(quality),
            "tokens_used": int(tokens_used),
            "time_taken": float(time_taken),
            "mode":       mode,
            "timestamp":  time.time(),
        }
        with self._lock:
            if self._db_path:
                self._insert_db(row)
            else:
                self._memory.append(row)

    # ── Read ─────────────────────────────────────────────────────────────────

    def best_strategy_for(
        self,
        task_type: str = "general",
        mode: str = "",
        fallback: str = "hybrid",
    ) -> str:
        """
        Return the highest-scoring strategy for a given task_type.
        Falls back to `fallback` if too few samples exist.
        """
        rows = self._load(task_type=task_type, mode=mode)
        if not rows:
            return fallback

        by_strategy: dict[str, list[float]] = defaultdict(list)
        for r in rows:
            by_strategy[r["strategy"]].append(r["quality"])

        best_strategy = fallback
        best_score = -1.0
        for strategy, qualities in by_strategy.items():
            if len(qualities) < self.MIN_SAMPLES:
                continue
            score = self._compute_score(qualities)
            if score > best_score:
                best_score = score
                best_strategy = strategy

        return best_strategy

    def stats_for(
        self,
        task_type: str = "",
        strategy: str = "",
        limit: int = 200,
    ) -> list[StrategyStats]:
        """Return aggregate StrategyStats, sorted by composite score desc."""
        rows = self._load(task_type=task_type, strategy=strategy, limit=limit)
        if not rows:
            return []

        # Group by (strategy, task_type)
        groups: dict[tuple, list[dict]] = defaultdict(list)
        for r in rows:
            key = (r["strategy"], r.get("task_type", "general"))
            groups[key].append(r)

        results: list[StrategyStats] = []
        for (strat, ttype), rlist in groups.items():
            qualities = [r["quality"] for r in rlist]
            tokens    = [r["tokens_used"] for r in rlist]
            times     = [r["time_taken"] for r in rlist]

            qs_sorted = sorted(qualities)
            n = len(qs_sorted)
            p50 = qs_sorted[n // 2]
            p90 = qs_sorted[min(int(n * 0.9), n - 1)]
            avg_q = sum(qualities) / n
            wins  = sum(1 for q in qualities if q >= self.WIN_THRESHOLD)

            stats = StrategyStats(
                strategy=strat,
                task_type=ttype,
                n=n,
                avg_quality=round(avg_q, 4),
                p50_quality=round(p50, 4),
                p90_quality=round(p90, 4),
                avg_tokens=round(sum(tokens) / n, 1),
                avg_time_s=round(sum(times) / n, 2),
                win_rate=round(wins / n, 3),
                score=round(self._compute_score(qualities), 4),
            )
            results.append(stats)

        return sorted(results, key=lambda s: -s.score)

    def report(self, task_type: str = "") -> str:
        """Return a formatted leaderboard string."""
        stats = self.stats_for(task_type=task_type)
        if not stats:
            return "MetricsTracker: no data recorded yet."
        lines = [
            f"{'Strategy':<20} {'N':>4}  {'AvgQ':>6}  "
            f"{'P90':>6}  {'Win%':>5}  {'Tok':>6}  {'Score':>6}",
            "-" * 68,
        ]
        for s in stats:
            lines.append(s.summary())
        return "\n".join(lines)

    # ── Internal ─────────────────────────────────────────────────────────────

    def _compute_score(self, qualities: list[float]) -> float:
        """
        Composite score = weighted combination of:
          - mean quality     (0.5 weight)
          - p75 quality      (0.3 weight)  — rewards consistency
          - win rate         (0.2 weight)
        Applies a Wilson-like credibility discount for small N.
        """
        n = len(qualities)
        if n == 0:
            return 0.0
        qs_sorted = sorted(qualities)
        mean_q = sum(qualities) / n
        p75    = qs_sorted[min(int(n * 0.75), n - 1)]
        wins   = sum(1 for q in qualities if q >= self.WIN_THRESHOLD)
        win_r  = wins / n
        raw    = 0.5 * mean_q + 0.3 * p75 + 0.2 * win_r
        # discount: credibility rises from 0 → 1 as n goes 0 → MIN_SAMPLES*2
        cred   = 1.0 - math.exp(-n / max(self.MIN_SAMPLES, 1))
        return raw * cred

    def _init_db(self):
        os.makedirs(os.path.dirname(self._db_path), exist_ok=True)
        with sqlite3.connect(self._db_path) as conn:
            conn.executescript(_CREATE_SQL)
            conn.commit()

    def _insert_db(self, row: dict):
        sql = """
        INSERT INTO strategy_metrics
            (strategy, task_type, quality, tokens_used, time_taken, mode, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """
        with sqlite3.connect(self._db_path) as conn:
            conn.execute(sql, (
                row["strategy"], row["task_type"], row["quality"],
                row["tokens_used"], row["time_taken"], row["mode"],
                row["timestamp"],
            ))
            conn.commit()

    def _load(
        self,
        task_type: str = "",
        strategy: str = "",
        mode: str = "",
        limit: int = 500,
    ) -> list[dict]:
        cols = ["strategy", "task_type", "quality", "tokens_used", "time_taken", "mode"]
        if self._db_path and os.path.exists(self._db_path):
            return self._load_db(task_type, strategy, mode, limit, cols)
        return self._load_memory(task_type, strategy, mode, limit)

    def _load_db(self, task_type, strategy, mode, limit, cols) -> list[dict]:
        filters, params = [], []
        if task_type:
            filters.append("task_type = ?"); params.append(task_type)
        if strategy:
            filters.append("strategy = ?"); params.append(strategy)
        if mode:
            filters.append("mode = ?"); params.append(mode)
        where = ("WHERE " + " AND ".join(filters)) if filters else ""
        sql = f"""
        SELECT {', '.join(cols)} FROM strategy_metrics
        {where}
        ORDER BY timestamp DESC LIMIT {limit}
        """
        try:
            with sqlite3.connect(self._db_path) as conn:
                rows = conn.execute(sql, params).fetchall()
            return [dict(zip(cols, r)) for r in rows]
        except Exception as exc:
            log.warning("MetricsTracker: db read failed (%s)", exc)
            return []

    def _load_memory(self, task_type, strategy, mode, limit) -> list[dict]:
        rows = self._memory
        if task_type:
            rows = [r for r in rows if r.get("task_type") == task_type]
        if strategy:
            rows = [r for r in rows if r.get("strategy") == strategy]
        if mode:
            rows = [r for r in rows if r.get("mode") == mode]
        return rows[-limit:]


# ── MetricsCollector ──────────────────────────────────────────────────────────

class MetricsCollector:
    """Lightweight in-memory metrics store for latency, counters, etc."""

    def __init__(self) -> None:
        self._values: dict[str, list[float]] = {}
        self._counters: dict[str, int] = {}

    # ── continuous metrics ────────────────────────────────────────────────────

    def record(self, name: str, value: float) -> None:
        self._values.setdefault(name, []).append(float(value))

    def summary(self, name: str) -> dict:
        vals = self._values.get(name, [])
        if not vals:
            return {}
        sorted_vals = sorted(vals)
        n = len(sorted_vals)
        mean = sum(sorted_vals) / n
        p95_idx = max(0, int(math.ceil(0.95 * n)) - 1)
        return {
            "count": n,
            "mean": round(mean, 6),
            "min": sorted_vals[0],
            "max": sorted_vals[-1],
            "p95": sorted_vals[p95_idx],
        }

    def reset(self, name: str) -> None:
        self._values.pop(name, None)

    # ── counters ─────────────────────────────────────────────────────────────

    def increment(self, name: str, amount: int = 1) -> None:
        self._counters[name] = self._counters.get(name, 0) + amount

    def get_counter(self, name: str) -> int:
        return self._counters.get(name, 0)

    def reset_counter(self, name: str) -> None:
        self._counters.pop(name, None)

    # ── introspection ─────────────────────────────────────────────────────────

    def all_metric_names(self) -> list[str]:
        return list(self._values) + list(self._counters)

    def export(self) -> dict:
        out: dict = {}
        for k, vals in self._values.items():
            out[k] = self.summary(k)
        for k, v in self._counters.items():
            out.setdefault(k, {})["counter"] = v
        return out
