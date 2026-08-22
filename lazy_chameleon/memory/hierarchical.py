"""HierarchicalMemory — Four-layer memory: Immediate → Working → LongTerm → Archive."""
from __future__ import annotations
import os, sqlite3, re
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional


class MemoryLayer(Enum):
    IMMEDIATE = "immediate"
    WORKING   = "working"
    LONG_TERM = "long_term"
    ARCHIVE   = "archive"


@dataclass
class HierarchicalMemoryItem:
    key: str
    content: str
    layer: MemoryLayer
    importance: float = 0.5
    access_count: int = 0
    last_accessed: str = ""
    created_at: str = ""
    tags: list[str] = field(default_factory=list)
    source_agent: str = ""

    def __post_init__(self):
        now = datetime.now().isoformat()
        if not self.created_at:
            self.created_at = now
        if not self.last_accessed:
            self.last_accessed = now


class HierarchicalMemory:
    IMMEDIATE_CAP = 10
    WORKING_CAP   = 50

    def __init__(self, db_path: str = "~/.lazy_chameleon/hierarchical_memory.db"):
        self._db  = os.path.expanduser(db_path)
        self._imm: dict[str, HierarchicalMemoryItem] = {}
        os.makedirs(os.path.dirname(self._db), exist_ok=True)
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self._db) as c:
            c.execute("""CREATE TABLE IF NOT EXISTS memory (
                key TEXT PRIMARY KEY, content TEXT, layer TEXT,
                importance REAL, access_count INTEGER, last_accessed TEXT,
                created_at TEXT, tags TEXT, source_agent TEXT)""")
            c.commit()

    # ---- store ---------------------------------------------------------
    def store(self, key: str, content: str, layer: MemoryLayer,
              importance: float = 0.5, tags: list[str] | None = None,
              source_agent: str = "") -> bool:
        tags = tags or []
        now  = datetime.now().isoformat()
        item = HierarchicalMemoryItem(key, content, layer, importance,
                                      0, now, now, tags, source_agent)
        if layer == MemoryLayer.IMMEDIATE:
            if len(self._imm) >= self.IMMEDIATE_CAP:
                oldest = min(self._imm, key=lambda k: self._imm[k].last_accessed)
                del self._imm[oldest]
            self._imm[key] = item
            return True
        with sqlite3.connect(self._db) as c:
            c.execute("""INSERT OR REPLACE INTO memory
                VALUES (?,?,?,?,?,?,?,?,?)""",
                (key, content, layer.value, importance, 0, now, now,
                 ",".join(tags), source_agent))
            c.commit()
        return True

    # ---- retrieve -------------------------------------------------------
    def retrieve(self, query: str, layer: MemoryLayer | None = None,
                 top_k: int = 5) -> list[HierarchicalMemoryItem]:
        q_tokens = set(re.sub(r"[^\w]", " ", query.lower()).split())
        results: list[tuple[float, HierarchicalMemoryItem]] = []

        # Search immediate
        if layer in (None, MemoryLayer.IMMEDIATE):
            for item in self._imm.values():
                sc = self._score(item.content, q_tokens)
                if sc > 0:
                    results.append((sc, item))

        # Search DB layers
        target_layers = [layer.value] if layer and layer != MemoryLayer.IMMEDIATE else \
                        [MemoryLayer.WORKING.value, MemoryLayer.LONG_TERM.value, MemoryLayer.ARCHIVE.value]
        with sqlite3.connect(self._db) as c:
            rows = c.execute("SELECT * FROM memory WHERE layer IN (%s)"
                             % ",".join("?" * len(target_layers)),
                             target_layers).fetchall()
        for row in rows:
            item = self._row_to_item(row)
            sc   = self._score(item.content, q_tokens) + item.importance * 0.2
            if sc > 0:
                results.append((sc, item))

        results.sort(key=lambda x: x[0], reverse=True)
        top = [item for _, item in results[:top_k]]
        # update access counts
        for item in top:
            item.access_count += 1
            item.last_accessed = datetime.now().isoformat()
            if item.layer != MemoryLayer.IMMEDIATE:
                with sqlite3.connect(self._db) as c:
                    c.execute("UPDATE memory SET access_count=?, last_accessed=? WHERE key=?",
                              (item.access_count, item.last_accessed, item.key))
                    c.commit()
        return top

    def _score(self, content: str, q_tokens: set) -> float:
        c_tokens = set(re.sub(r"[^\w]", " ", content.lower()).split())
        overlap  = len(q_tokens & c_tokens)
        return overlap / max(len(q_tokens), 1)

    def _row_to_item(self, row) -> HierarchicalMemoryItem:
        key, content, layer_str, imp, acc, last_acc, created, tags_str, src = row
        return HierarchicalMemoryItem(
            key=key, content=content,
            layer=MemoryLayer(layer_str),
            importance=imp, access_count=acc,
            last_accessed=last_acc, created_at=created,
            tags=tags_str.split(",") if tags_str else [],
            source_agent=src,
        )

    # ---- promote / demote ----------------------------------------------
    def promote(self, key: str):
        order = [MemoryLayer.ARCHIVE, MemoryLayer.LONG_TERM, MemoryLayer.WORKING, MemoryLayer.IMMEDIATE]
        self._move_layer(key, direction=1)

    def demote(self, key: str):
        self._move_layer(key, direction=-1)

    def _move_layer(self, key: str, direction: int):
        order = [MemoryLayer.IMMEDIATE, MemoryLayer.WORKING, MemoryLayer.LONG_TERM, MemoryLayer.ARCHIVE]
        item  = self._get_item(key)
        if not item:
            return
        idx = next((i for i, l in enumerate(order) if l == item.layer), None)
        if idx is None:
            return
        new_idx = max(0, min(len(order) - 1, idx + direction))
        if new_idx != idx:
            self.store(item.key, item.content, order[new_idx],
                       item.importance, item.tags, item.source_agent)

    def _get_item(self, key: str) -> Optional[HierarchicalMemoryItem]:
        if key in self._imm:
            return self._imm[key]
        with sqlite3.connect(self._db) as c:
            row = c.execute("SELECT * FROM memory WHERE key=?", (key,)).fetchone()
        return self._row_to_item(row) if row else None

    # ---- auto-consolidate ----------------------------------------------
    def auto_consolidate(self):
        with sqlite3.connect(self._db) as c:
            # Promote frequently-accessed working items to long-term
            rows = c.execute(
                "SELECT * FROM memory WHERE layer=? AND access_count>=3",
                (MemoryLayer.WORKING.value,)
            ).fetchall()
            for row in rows:
                item = self._row_to_item(row)
                self.store(item.key, item.content, MemoryLayer.LONG_TERM,
                           item.importance + 0.1, item.tags, item.source_agent)
            # Archive low-importance long-term items
            c.execute(
                "UPDATE memory SET layer=? WHERE layer=? AND importance<0.2",
                (MemoryLayer.ARCHIVE.value, MemoryLayer.LONG_TERM.value)
            )
            c.commit()

    def get_context_for_task(self, task: str, max_tokens: int = 2000) -> str:
        items = self.retrieve(task, top_k=10)
        lines, budget = [], max_tokens * 4  # rough chars
        for item in items:
            line = f"[{item.layer.value}|{item.source_agent}] {item.content}"
            if len("\n".join(lines)) + len(line) > budget:
                break
            lines.append(line)
        return "\n".join(lines)

    def clear_immediate(self):
        self._imm.clear()

    def stats(self) -> dict:
        with sqlite3.connect(self._db) as c:
            counts = {row[0]: row[1] for row in
                      c.execute("SELECT layer, COUNT(*) FROM memory GROUP BY layer")}
        return {"immediate": len(self._imm), **counts}
