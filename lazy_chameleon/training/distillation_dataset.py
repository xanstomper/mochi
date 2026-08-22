"""Distillation Dataset — TrajectoryRecord, DistillationDataset, filtering."""
from __future__ import annotations

import json
import math
import re
import sqlite3
import uuid
from collections import Counter
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple


# ─── Core record ────────────────────────────────────────────────────────────

@dataclass
class TrajectoryRecord:
    """One teacher-generated reasoning trajectory."""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    source_task: str = ""
    teacher_model: str = ""
    teacher_provider: str = ""
    prompt: str = ""
    reasoning_trace: str = ""        # full chain-of-thought
    final_answer: str = ""
    quality_score: float = 0.0       # 0-1
    difficulty_score: float = 0.5    # 0-1
    diversity_score: float = 0.5     # 0-1
    consistency_score: float = 0.5   # 0-1 (self-consistency across samples)
    token_count: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: float = 0.0
    domain: str = "general"          # math, code, reasoning, science, etc.
    difficulty_bucket: str = "medium" # easy/medium/hard/extreme
    source_name: str = ""            # AIME, HumanEval, GSM8K, etc.
    timestamp: datetime = field(default_factory=datetime.now)
    metadata: Dict[str, Any] = field(default_factory=dict)

    @property
    def full_text(self) -> str:
        """Combined reasoning + answer text."""
        return f"{self.reasoning_trace}\n\n{self.final_answer}"

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens

    def to_dict(self) -> dict:
        d = asdict(self)
        d["timestamp"] = self.timestamp.isoformat()
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "TrajectoryRecord":
        d = dict(d)
        if isinstance(d.get("timestamp"), str):
            try:
                d["timestamp"] = datetime.fromisoformat(d["timestamp"])
            except ValueError:
                d["timestamp"] = datetime.now()
        if "metadata" in d and isinstance(d["metadata"], str):
            try:
                d["metadata"] = json.loads(d["metadata"])
            except Exception:
                d["metadata"] = {}
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})

    def to_sft_pair(self, format: str = "alpaca") -> dict:
        """Convert to SFT training pair."""
        if format == "alpaca":
            return {
                "instruction": self.source_task,
                "input": "",
                "output": self.full_text,
            }
        elif format == "sharegpt":
            return {
                "conversations": [
                    {"from": "human", "value": self.prompt},
                    {"from": "gpt", "value": self.full_text},
                ]
            }
        elif format == "openai":
            return {
                "messages": [
                    {"role": "user", "content": self.prompt},
                    {"role": "assistant", "content": self.full_text},
                ]
            }
        elif format == "axolotl":
            return {
                "input": self.prompt,
                "output": self.full_text,
            }
        else:
            raise ValueError(f"Unknown format: {format}")

    def to_distillation_pair(self, include_reasoning: bool = True) -> dict:
        """Convert to knowledge distillation training pair."""
        pair = {
            "id": self.id,
            "prompt": self.prompt,
            "target": self.final_answer,
            "quality": self.quality_score,
            "difficulty": self.difficulty_score,
            "token_count": self.token_count,
            "domain": self.domain,
        }
        if include_reasoning:
            pair["reasoning_trace"] = self.reasoning_trace
            pair["full_response"] = self.full_text
        return pair


# ─── SQLite-backed dataset ───────────────────────────────────────────────────

class DistillationDataset:
    """
    SQLite-backed dataset for distillation trajectories.

    Supports:
    - Append, bulk-insert, deduplication
    - Quality / diversity / difficulty filtering
    - Export to JSONL, Parquet, HuggingFace datasets
    - Statistics and analysis
    """

    def __init__(self, db_path: str = "~/.lazy_chameleon/distillation.db"):
        self.db_path = Path(db_path).expanduser()
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self.db_path))
        self._init_db()

    def _init_db(self):
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS trajectories (
                id TEXT PRIMARY KEY,
                source_task TEXT,
                teacher_model TEXT,
                teacher_provider TEXT,
                prompt TEXT,
                reasoning_trace TEXT,
                final_answer TEXT,
                quality_score REAL DEFAULT 0,
                difficulty_score REAL DEFAULT 0.5,
                diversity_score REAL DEFAULT 0.5,
                consistency_score REAL DEFAULT 0.5,
                token_count INTEGER DEFAULT 0,
                prompt_tokens INTEGER DEFAULT 0,
                completion_tokens INTEGER DEFAULT 0,
                cost_usd REAL DEFAULT 0,
                latency_ms REAL DEFAULT 0,
                domain TEXT DEFAULT 'general',
                difficulty_bucket TEXT DEFAULT 'medium',
                source_name TEXT DEFAULT '',
                timestamp TEXT,
                metadata TEXT DEFAULT '{}'
            );
            CREATE INDEX IF NOT EXISTS idx_quality ON trajectories(quality_score);
            CREATE INDEX IF NOT EXISTS idx_domain ON trajectories(domain);
            CREATE INDEX IF NOT EXISTS idx_difficulty ON trajectories(difficulty_bucket);
            CREATE INDEX IF NOT EXISTS idx_teacher ON trajectories(teacher_model);
        """)
        self._conn.commit()

    def add(self, record: TrajectoryRecord) -> bool:
        """Add a single record. Returns False if duplicate."""
        try:
            d = record.to_dict()
            d["metadata"] = json.dumps(d.get("metadata", {}))
            d["timestamp"] = record.timestamp.isoformat()
            cols = list(d.keys())
            placeholders = ",".join("?" * len(cols))
            self._conn.execute(
                f"INSERT OR IGNORE INTO trajectories ({','.join(cols)}) VALUES ({placeholders})",
                [d[c] for c in cols]
            )
            self._conn.commit()
            return self._conn.total_changes > 0
        except Exception:
            return False

    def add_bulk(self, records: List[TrajectoryRecord]) -> int:
        """Bulk insert. Returns count inserted."""
        inserted = 0
        for r in records:
            if self.add(r):
                inserted += 1
        return inserted

    def filter(
        self,
        min_quality: float = 0.0,
        max_quality: float = 1.0,
        domains: Optional[List[str]] = None,
        difficulty_buckets: Optional[List[str]] = None,
        teacher_models: Optional[List[str]] = None,
        min_tokens: int = 0,
        max_tokens: int = 999_999,
        limit: Optional[int] = None,
        order_by: str = "quality_score DESC",
    ) -> List[TrajectoryRecord]:
        """Filter dataset by various criteria."""
        where_clauses = [
            f"quality_score >= {min_quality}",
            f"quality_score <= {max_quality}",
            f"token_count >= {min_tokens}",
            f"token_count <= {max_tokens}",
        ]
        params: list = []

        if domains:
            placeholders = ",".join("?" * len(domains))
            where_clauses.append(f"domain IN ({placeholders})")
            params.extend(domains)

        if difficulty_buckets:
            placeholders = ",".join("?" * len(difficulty_buckets))
            where_clauses.append(f"difficulty_bucket IN ({placeholders})")
            params.extend(difficulty_buckets)

        if teacher_models:
            placeholders = ",".join("?" * len(teacher_models))
            where_clauses.append(f"teacher_model IN ({placeholders})")
            params.extend(teacher_models)

        sql = f"SELECT * FROM trajectories WHERE {' AND '.join(where_clauses)} ORDER BY {order_by}"
        if limit:
            sql += f" LIMIT {limit}"

        rows = self._conn.execute(sql, params).fetchall()
        cols = [d[0] for d in self._conn.execute("SELECT * FROM trajectories LIMIT 0").description]
        return [TrajectoryRecord.from_dict(dict(zip(cols, row))) for row in rows]

    def deduplicate(self, similarity_threshold: float = 0.85) -> int:
        """Remove near-duplicate records using token overlap. Returns removed count."""
        records = self.filter()
        seen: List[set] = []
        to_delete: List[str] = []

        for rec in records:
            tokens = set(rec.prompt.lower().split())
            is_dup = False
            for seen_tokens in seen:
                if not tokens or not seen_tokens:
                    continue
                overlap = len(tokens & seen_tokens) / max(len(tokens | seen_tokens), 1)
                if overlap >= similarity_threshold:
                    is_dup = True
                    break
            if is_dup:
                to_delete.append(rec.id)
            else:
                seen.append(tokens)

        if to_delete:
            placeholders = ",".join("?" * len(to_delete))
            self._conn.execute(f"DELETE FROM trajectories WHERE id IN ({placeholders})", to_delete)
            self._conn.commit()

        return len(to_delete)

    def get_stats(self) -> dict:
        """Return dataset statistics."""
        row = self._conn.execute("""
            SELECT
                COUNT(*) as total,
                AVG(quality_score) as avg_quality,
                MIN(quality_score) as min_quality,
                MAX(quality_score) as max_quality,
                AVG(token_count) as avg_tokens,
                SUM(token_count) as total_tokens,
                SUM(cost_usd) as total_cost,
                COUNT(DISTINCT teacher_model) as n_teachers,
                COUNT(DISTINCT domain) as n_domains,
                COUNT(DISTINCT source_name) as n_sources
            FROM trajectories
        """).fetchone()

        domain_counts = dict(self._conn.execute(
            "SELECT domain, COUNT(*) FROM trajectories GROUP BY domain ORDER BY COUNT(*) DESC"
        ).fetchall())

        difficulty_counts = dict(self._conn.execute(
            "SELECT difficulty_bucket, COUNT(*) FROM trajectories GROUP BY difficulty_bucket"
        ).fetchall())

        teacher_counts = dict(self._conn.execute(
            "SELECT teacher_model, COUNT(*) FROM trajectories GROUP BY teacher_model ORDER BY COUNT(*) DESC"
        ).fetchall())

        return {
            "total": row[0] or 0,
            "avg_quality": round(row[1] or 0, 4),
            "min_quality": round(row[2] or 0, 4),
            "max_quality": round(row[3] or 0, 4),
            "avg_tokens": round(row[4] or 0, 1),
            "total_tokens": row[5] or 0,
            "total_cost_usd": round(row[6] or 0, 4),
            "n_teachers": row[7] or 0,
            "n_domains": row[8] or 0,
            "n_sources": row[9] or 0,
            "domain_distribution": domain_counts,
            "difficulty_distribution": difficulty_counts,
            "teacher_distribution": teacher_counts,
        }

    def export_jsonl(
        self,
        path: str,
        format: str = "sft",          # sft | distillation | raw
        sft_format: str = "alpaca",
        min_quality: float = 0.5,
        **filter_kwargs,
    ) -> int:
        """Export to JSONL file. Returns count exported."""
        records = self.filter(min_quality=min_quality, **filter_kwargs)
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, "w") as f:
            for rec in records:
                if format == "sft":
                    row = rec.to_sft_pair(sft_format)
                elif format == "distillation":
                    row = rec.to_distillation_pair()
                else:
                    row = rec.to_dict()
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

        return len(records)

    def export_huggingface(self, name: str = "distillation_dataset", **filter_kwargs):
        """Export as HuggingFace datasets.Dataset (if available)."""
        try:
            from datasets import Dataset as HFDataset
            records = self.filter(**filter_kwargs)
            data = [r.to_dict() for r in records]
            return HFDataset.from_list(data)
        except ImportError:
            raise ImportError("pip install datasets to use HuggingFace export")

    def close(self):
        self._conn.close()

    def __len__(self) -> int:
        row = self._conn.execute("SELECT COUNT(*) FROM trajectories").fetchone()
        return row[0] if row else 0

    def __repr__(self) -> str:
        return f"DistillationDataset(path={self.db_path}, records={len(self)})"


# ─── Quality scoring ─────────────────────────────────────────────────────────

class TrajectoryQualityScorer:
    """Scores trajectory quality on multiple dimensions."""

    # Signals of high-quality reasoning
    POSITIVE_SIGNALS = [
        r"step \d+", r"first,?\s+", r"therefore", r"because", r"since",
        r"let me", r"consider", r"approach", r"solution", r"answer",
        r"reasoning", r"analysis", r"\bthus\b", r"conclude",
        r"proof", r"derive", r"calculate", r"verify",
    ]

    NEGATIVE_SIGNALS = [
        r"i (don't|cannot|can't) ", r"i'm not sure", r"i don't know",
        r"unclear", r"impossible", r"sorry", r"apologize",
    ]

    STRUCTURE_SIGNALS = [
        r"```", r"def ", r"class ", r"import ", r"\d+\.", r"- ", r"\* ",
    ]

    def score(self, record: TrajectoryRecord) -> float:
        """Compute composite quality score 0-1."""
        text = record.full_text
        scores: Dict[str, float] = {}

        # 1. Length signal (longer = more thorough, up to a point)
        tokens = max(record.token_count, len(text.split()))
        scores["length"] = min(tokens / 800, 1.0) * 0.15

        # 2. Positive reasoning signals
        pos_hits = sum(1 for p in self.POSITIVE_SIGNALS if re.search(p, text, re.I))
        scores["reasoning"] = min(pos_hits / len(self.POSITIVE_SIGNALS), 1.0) * 0.25

        # 3. Negative signals (penalty)
        neg_hits = sum(1 for p in self.NEGATIVE_SIGNALS if re.search(p, text, re.I))
        scores["no_hedging"] = max(0, 1 - neg_hits / 3) * 0.15

        # 4. Structure signals (code, lists, numbered steps)
        struct_hits = sum(1 for p in self.STRUCTURE_SIGNALS if re.search(p, text))
        scores["structure"] = min(struct_hits / 3, 1.0) * 0.15

        # 5. Has explicit final answer
        has_answer = bool(record.final_answer and len(record.final_answer) > 10)
        scores["has_answer"] = 0.15 if has_answer else 0.0

        # 6. Has reasoning trace separate from answer
        has_trace = bool(record.reasoning_trace and len(record.reasoning_trace) > 50)
        scores["has_trace"] = 0.15 if has_trace else 0.0

        total = sum(scores.values())
        return min(round(total, 4), 1.0)

    def score_difficulty(self, record: TrajectoryRecord) -> float:
        """Estimate difficulty 0-1 from content."""
        task = record.source_task.lower()
        difficult_keywords = [
            "prove", "derive", "optimize", "implement", "design", "architect",
            "analyze", "evaluate", "compare", "theorem", "algorithm",
            "concurrent", "distributed", "security", "vulnerability",
        ]
        easy_keywords = ["what is", "define", "list", "name", "when was", "who is"]

        diff_hits = sum(1 for k in difficult_keywords if k in task)
        easy_hits = sum(1 for k in easy_keywords if k in task)

        base = 0.5 + (diff_hits * 0.08) - (easy_hits * 0.15)
        return max(0.1, min(base, 1.0))

    def bucket_difficulty(self, score: float) -> str:
        if score < 0.3:
            return "easy"
        elif score < 0.55:
            return "medium"
        elif score < 0.8:
            return "hard"
        else:
            return "extreme"

    def score_diversity(
        self,
        record: TrajectoryRecord,
        existing_records: List[TrajectoryRecord],
    ) -> float:
        """Score diversity vs existing records (1 = very different)."""
        if not existing_records:
            return 1.0

        my_tokens = set(record.prompt.lower().split())
        overlaps = []
        for other in existing_records[-50:]:  # compare to last 50
            other_tokens = set(other.prompt.lower().split())
            if not my_tokens or not other_tokens:
                continue
            overlap = len(my_tokens & other_tokens) / max(len(my_tokens | other_tokens), 1)
            overlaps.append(overlap)

        if not overlaps:
            return 1.0

        avg_overlap = sum(overlaps) / len(overlaps)
        return round(1.0 - avg_overlap, 4)
