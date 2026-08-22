"""ReflectionMemory — Learn from failures, corrections, and successes."""
from __future__ import annotations
import os, re, sqlite3, uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class ReflectionType(Enum):
    FAILURE     = "failure"
    CORRECTION  = "correction"
    SUCCESS     = "success"
    ANTI_PATTERN = "anti_pattern"
    INSIGHT     = "insight"


@dataclass
class Reflection:
    id: str
    type: ReflectionType
    task_pattern: str
    what_happened: str
    lesson: str
    confidence: float = 0.7
    occurrence_count: int = 1
    tags: list[str] = field(default_factory=list)


class ReflectionMemory:
    def __init__(self, db_path: str = "~/.lazy_chameleon/reflections.db"):
        self._db = os.path.expanduser(db_path)
        os.makedirs(os.path.dirname(self._db), exist_ok=True)
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self._db) as c:
            c.execute("""CREATE TABLE IF NOT EXISTS reflections (
                id TEXT PRIMARY KEY, type TEXT, task_pattern TEXT,
                what_happened TEXT, lesson TEXT, confidence REAL,
                occurrence_count INTEGER, tags TEXT, created_at TEXT)""")
            c.commit()

    def _store(self, r: Reflection):
        with sqlite3.connect(self._db) as c:
            c.execute("""INSERT OR REPLACE INTO reflections VALUES (?,?,?,?,?,?,?,?,?)""",
                (r.id, r.type.value, r.task_pattern, r.what_happened, r.lesson,
                 r.confidence, r.occurrence_count, ",".join(r.tags),
                 datetime.now().isoformat()))
            c.commit()

    def record_failure(self, task: str, what_went_wrong: str, context: str = "") -> str:
        rid = str(uuid.uuid4())[:8]
        r   = Reflection(rid, ReflectionType.FAILURE,
                         task[:120], what_went_wrong,
                         f"Avoid: {what_went_wrong[:200]}", 0.8,
                         tags=["failure"])
        self._store(r)
        return rid

    def record_correction(self, task: str, original_mistake: str, correction: str) -> str:
        rid = str(uuid.uuid4())[:8]
        r   = Reflection(rid, ReflectionType.CORRECTION, task[:120],
                         f"Was wrong: {original_mistake}",
                         f"Correct approach: {correction}", 0.85,
                         tags=["correction"])
        self._store(r)
        return rid

    def record_success(self, task: str, what_worked: str, pattern: str = "") -> str:
        rid = str(uuid.uuid4())[:8]
        r   = Reflection(rid, ReflectionType.SUCCESS, task[:120],
                         what_worked, f"Reuse pattern: {pattern or what_worked}", 0.9,
                         tags=["success"])
        self._store(r)
        return rid

    def record_anti_pattern(self, pattern: str, why_bad: str, what_to_do_instead: str) -> str:
        rid = str(uuid.uuid4())[:8]
        r   = Reflection(rid, ReflectionType.ANTI_PATTERN, pattern[:120],
                         f"Bad because: {why_bad}",
                         f"Do instead: {what_to_do_instead}", 0.9,
                         tags=["anti_pattern"])
        self._store(r)
        return rid

    def get_relevant_reflections(self, task: str, top_k: int = 5) -> list[Reflection]:
        q_tokens = set(re.sub(r"[^\w]", " ", task.lower()).split())
        with sqlite3.connect(self._db) as c:
            rows = c.execute("SELECT * FROM reflections ORDER BY occurrence_count DESC").fetchall()
        scored: list[tuple[float, Reflection]] = []
        for row in rows:
            r = self._row(row)
            overlap = len(q_tokens & set(re.sub(r"[^\w]", " ", r.task_pattern.lower()).split()))
            sc = overlap / max(len(q_tokens), 1) + r.confidence * 0.2 + r.occurrence_count * 0.05
            if sc > 0:
                scored.append((sc, r))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [r for _, r in scored[:top_k]]

    def format_as_context(self, reflections: list[Reflection]) -> str:
        if not reflections:
            return ""
        lines = ["=== REFLECTION MEMORY ==="]
        for r in reflections:
            icon = {"failure": "⚠", "correction": "✓", "success": "★",
                    "anti_pattern": "✗", "insight": "💡"}.get(r.type.value, "•")
            lines.append(f"{icon} [{r.type.value.upper()}] {r.lesson}")
        return "\n".join(lines)

    def merge_duplicates(self):
        with sqlite3.connect(self._db) as c:
            rows = c.execute("SELECT * FROM reflections").fetchall()
        seen: dict[str, Reflection] = {}
        for row in rows:
            r   = self._row(row)
            key = r.task_pattern[:50] + r.type.value
            if key in seen:
                seen[key].occurrence_count += 1
                self._store(seen[key])
                with sqlite3.connect(self._db) as c:
                    c.execute("DELETE FROM reflections WHERE id=?", (r.id,))
                    c.commit()
            else:
                seen[key] = r

    def _row(self, row) -> Reflection:
        id_, type_s, tp, wh, lesson, conf, occ, tags_s, _ = row
        return Reflection(id_, ReflectionType(type_s), tp, wh, lesson,
                          conf, occ, tags_s.split(",") if tags_s else [])

    def stats(self) -> dict:
        with sqlite3.connect(self._db) as c:
            total = c.execute("SELECT COUNT(*) FROM reflections").fetchone()[0]
            by_type = {row[0]: row[1] for row in
                       c.execute("SELECT type, COUNT(*) FROM reflections GROUP BY type")}
        return {"total": total, "by_type": by_type}
