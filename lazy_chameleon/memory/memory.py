"""Three-tier memory: Hot (working), Warm (project), Cold (experience)."""
import sqlite3
import os
from datetime import datetime
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class MemoryItem:
    key: str
    content: str
    category: str
    importance: float = 0.5
    timestamp: str = ""


class HotMemory:
    """Working memory — always active, accumulates synthetic params."""

    def __init__(self):
        self.task = ""
        self.current_goal = ""
        self.constraints = []
        self.decisions = []
        self.accumulated_context = []

    def add_synthetic_context(self, agent: str, content: str, params: int):
        self.accumulated_context.append({
            "agent": agent, "content": content,
            "params": params, "time": datetime.now().isoformat(),
        })

    def total_synthetic_params(self) -> int:
        return sum(i["params"] for i in self.accumulated_context)

    def get_compiled_context(self) -> str:
        parts = [f"Task: {self.task}", f"Goal: {self.current_goal}"]
        if self.constraints:
            parts.append(f"Constraints: {', '.join(self.constraints)}")
        if self.accumulated_context:
            parts.append("\n=== SYNTHETIC PARAMETER CONTEXT (Lazy Agent Output) ===")
            for item in self.accumulated_context:
                parts.append(f"[{item['agent']}](+{item['params']}p): {item['content']}")
        return "\n".join(parts)

    def clear(self):
        self.__init__()


class WarmMemory:
    """Project memory — persists across sessions."""

    def __init__(self, db_path: str):
        self.db_path = os.path.expanduser(db_path)
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.execute("""CREATE TABLE IF NOT EXISTS project_memory (
            id INTEGER PRIMARY KEY, key TEXT, content TEXT,
            category TEXT, importance REAL, timestamp TEXT)""")
        conn.execute("""CREATE TABLE IF NOT EXISTS results (
            id INTEGER PRIMARY KEY, task TEXT, result TEXT,
            confidence REAL, timestamp TEXT)""")
        conn.commit()
        conn.close()

    def store(self, item: MemoryItem) -> bool:
        """Store a memory item.  Deduplicates by key (upserts).
        Returns True if inserted, False if updated an existing key."""
        conn = sqlite3.connect(self.db_path)
        existing = conn.execute(
            "SELECT id FROM project_memory WHERE key=?", (item.key,)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE project_memory SET content=?, category=?, importance=?, timestamp=? WHERE key=?",
                (item.content, item.category, item.importance,
                 datetime.now().isoformat(), item.key),
            )
            conn.commit()
            conn.close()
            return False
        conn.execute(
            "INSERT INTO project_memory VALUES (?,?,?,?,?,?)",
            (None, item.key, item.content, item.category,
             item.importance, datetime.now().isoformat()),
        )
        conn.commit()
        conn.close()
        return True

    def store_result(self, task: str, result: str, confidence: float):
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "INSERT INTO results VALUES (?,?,?,?,?)",
            (None, task, result, confidence, datetime.now().isoformat()),
        )
        conn.commit()
        conn.close()

    def retrieve(self, category: str = None, limit: int = 10) -> list:
        conn = sqlite3.connect(self.db_path)
        if category:
            rows = conn.execute(
                "SELECT * FROM project_memory WHERE category=? ORDER BY importance DESC LIMIT ?",
                (category, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM project_memory ORDER BY importance DESC LIMIT ?",
                (limit,),
            ).fetchall()
        conn.close()
        return [
            MemoryItem(key=r[1], content=r[2], category=r[3],
                       importance=r[4], timestamp=r[5])
            for r in rows
        ]


class ColdMemory:
    """Experience memory — failures and successful patterns."""

    def __init__(self, db_path: str):
        self.db_path = os.path.expanduser(db_path).replace(".db", "_cold.db")
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        conn = sqlite3.connect(self.db_path)
        conn.execute("""CREATE TABLE IF NOT EXISTS experiences (
            id INTEGER PRIMARY KEY, key TEXT, content TEXT,
            pattern_type TEXT, success_rate REAL, timestamp TEXT)""")
        conn.commit()
        conn.close()
        self._write_count: int = 0  # tracks writes for auto-vacuum

    # ------------------------------------------------------------------
    def _maybe_vacuum(self) -> None:
        """VACUUM the database every 100 writes to reclaim freed pages.

        SQLite does not reclaim disk space automatically after DELETEs; running
        VACUUM periodically keeps the file size bounded as old experience rows
        are overwritten or deleted externally.  We run it *outside* any open
        transaction (VACUUM requires autocommit mode) on a closed connection.
        """
        self._write_count += 1
        if self._write_count % 100 == 0:
            conn = sqlite3.connect(self.db_path)
            conn.execute("VACUUM")
            conn.close()

    def store_failure(self, task: str, analysis: str):
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "INSERT INTO experiences VALUES (?,?,?,?,?,?)",
            (None, f"fail_{task}", analysis, "failure", 0.0,
             datetime.now().isoformat()),
        )
        conn.commit()
        conn.close()
        self._maybe_vacuum()

    def store_success(self, task: str, strategy: str):
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            "INSERT INTO experiences VALUES (?,?,?,?,?,?)",
            (None, f"ok_{task}", strategy, "success", 1.0,
             datetime.now().isoformat()),
        )
        conn.commit()
        conn.close()
        self._maybe_vacuum()

    def search(self, query: str, limit: int = 5) -> list:
        conn = sqlite3.connect(self.db_path)
        rows = conn.execute(
            "SELECT * FROM experiences WHERE content LIKE ? ORDER BY success_rate DESC LIMIT ?",
            (f"%{query}%", limit),
        ).fetchall()
        conn.close()
        return [
            MemoryItem(key=r[1], content=r[2], category=r[3],
                       importance=r[4], timestamp=r[5])
            for r in rows
        ]
