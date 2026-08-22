"""LatentWorkspace — Shared scratchpad bus for all experts."""
from __future__ import annotations
import re, threading, uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass
class WorkspaceEntry:
    id: str
    author_agent: str
    entry_type: str     # finding/hypothesis/question/answer/code/data/warning
    content: str
    confidence: float = 0.8
    timestamp: str = ""
    tags: list[str] = field(default_factory=list)
    referenced_by: list[str] = field(default_factory=list)
    answered_by: Optional[str] = None   # for questions

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = datetime.now().isoformat()


class LatentWorkspace:
    """Thread-safe shared working memory."""

    def __init__(self, max_entries: int = 200):
        self._max    = max_entries
        self._entries: dict[str, WorkspaceEntry] = {}
        self._lock   = threading.Lock()

    # ---- write ----------------------------------------------------------
    def write(self, author: str, content: str, entry_type: str = "finding",
              confidence: float = 0.8, tags: list[str] | None = None) -> str:
        eid = str(uuid.uuid4())[:8]
        entry = WorkspaceEntry(eid, author, entry_type, content, confidence,
                               tags=tags or [])
        with self._lock:
            if len(self._entries) >= self._max:
                # evict oldest
                oldest = min(self._entries, key=lambda k: self._entries[k].timestamp)
                del self._entries[oldest]
            self._entries[eid] = entry
        return eid

    # ---- read -----------------------------------------------------------
    def read(self, query: str | None = None, author: str | None = None,
             entry_type: str | None = None, top_k: int = 10) -> list[WorkspaceEntry]:
        with self._lock:
            entries = list(self._entries.values())
        if author:
            entries = [e for e in entries if e.author_agent == author]
        if entry_type:
            entries = [e for e in entries if e.entry_type == entry_type]
        if query:
            q_tok = set(re.sub(r"[^\w]", " ", query.lower()).split())
            scored: list[tuple[float, WorkspaceEntry]] = []
            for e in entries:
                c_tok = set(re.sub(r"[^\w]", " ", e.content.lower()).split())
                sc    = len(q_tok & c_tok) / max(len(q_tok), 1) + e.confidence * 0.1
                scored.append((sc, e))
            scored.sort(key=lambda x: x[0], reverse=True)
            return [e for _, e in scored[:top_k]]
        return sorted(entries, key=lambda e: e.timestamp, reverse=True)[:top_k]

    def read_all(self) -> list[WorkspaceEntry]:
        with self._lock:
            return list(self._entries.values())

    # ---- meta -----------------------------------------------------------
    def reference(self, entry_id: str, by_agent: str):
        with self._lock:
            if entry_id in self._entries:
                self._entries[entry_id].referenced_by.append(by_agent)

    def mark_answered(self, question_id: str, answer_entry_id: str):
        with self._lock:
            if question_id in self._entries:
                self._entries[question_id].answered_by = answer_entry_id

    def get_unanswered_questions(self) -> list[WorkspaceEntry]:
        with self._lock:
            return [e for e in self._entries.values()
                    if e.entry_type == "question" and e.answered_by is None]

    def get_agent_contributions(self, agent: str) -> list[WorkspaceEntry]:
        with self._lock:
            return [e for e in self._entries.values() if e.author_agent == agent]

    def get_summary(self) -> str:
        with self._lock:
            entries = list(self._entries.values())
        if not entries:
            return "(workspace empty)"
        lines = [f"=== LATENT WORKSPACE ({len(entries)} entries) ==="]
        by_type: dict[str, list[WorkspaceEntry]] = {}
        for e in entries:
            by_type.setdefault(e.entry_type, []).append(e)
        for etype, group in by_type.items():
            lines.append(f"\n[{etype.upper()}s]")
            for e in group[-3:]:  # most recent 3 per type
                lines.append(f"  {e.author_agent}: {e.content[:120]}")
        return "\n".join(lines)

    def clear(self):
        with self._lock:
            self._entries.clear()

    def snapshot(self) -> dict:
        with self._lock:
            return {k: vars(v) for k, v in self._entries.items()}

    def restore(self, snap: dict):
        with self._lock:
            self._entries.clear()
            for k, v in snap.items():
                e = WorkspaceEntry(**v)
                self._entries[k] = e
