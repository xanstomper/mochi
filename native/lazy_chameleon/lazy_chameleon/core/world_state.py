"""WorldStateGraph — Structured knowledge graph for the current task."""
from __future__ import annotations
import re, uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class NodeType(Enum):
    FACT       = "fact"
    GOAL       = "goal"
    CONSTRAINT = "constraint"
    ASSUMPTION = "assumption"
    DEPENDENCY = "dependency"
    UNKNOWN    = "unknown"


class EdgeRelation(Enum):
    REQUIRES    = "requires"
    CONTRADICTS = "contradicts"
    SUPPORTS    = "supports"
    ENABLES     = "enables"
    BLOCKS      = "blocks"
    DERIVES_FROM = "derives_from"


@dataclass
class StateNode:
    id: str
    node_type: NodeType
    content: str
    confidence: float = 1.0
    source: str = ""
    timestamp: str = ""
    tags: list[str] = field(default_factory=list)
    verified: bool = False

    def __post_init__(self):
        if not self.timestamp:
            self.timestamp = datetime.now().isoformat()


@dataclass
class StateEdge:
    from_id: str
    to_id: str
    relation: EdgeRelation


class WorldStateGraph:
    def __init__(self):
        self._nodes: dict[str, StateNode] = {}
        self._edges: list[StateEdge] = []

    def _add(self, node_type: NodeType, content: str,
             confidence: float = 1.0, source: str = "",
             tags: list[str] | None = None) -> str:
        nid  = str(uuid.uuid4())[:8]
        node = StateNode(nid, node_type, content, confidence, source,
                         tags=tags or [])
        self._nodes[nid] = node
        return nid

    def add_fact(self, content: str, confidence: float = 1.0, source: str = "") -> str:
        return self._add(NodeType.FACT, content, confidence, source)

    def add_goal(self, content: str, priority: float = 0.5) -> str:
        return self._add(NodeType.GOAL, content, priority)

    def add_constraint(self, content: str, hard: bool = True) -> str:
        tags = ["hard"] if hard else ["soft"]
        return self._add(NodeType.CONSTRAINT, content, 1.0 if hard else 0.7, tags=tags)

    def add_assumption(self, content: str, confidence: float = 0.7) -> str:
        return self._add(NodeType.ASSUMPTION, content, confidence)

    def add_dependency(self, from_id: str, to_id: str, relation: str) -> str:
        try:
            rel = EdgeRelation(relation)
        except ValueError:
            rel = EdgeRelation.REQUIRES
        self._edges.append(StateEdge(from_id, to_id, rel))
        return f"{from_id}->{to_id}"

    # ---- query ----------------------------------------------------------
    def get_facts(self)       -> list[StateNode]: return self._by_type(NodeType.FACT)
    def get_goals(self)       -> list[StateNode]: return self._by_type(NodeType.GOAL)
    def get_constraints(self) -> list[StateNode]: return self._by_type(NodeType.CONSTRAINT)
    def get_assumptions(self) -> list[StateNode]: return self._by_type(NodeType.ASSUMPTION)

    def _by_type(self, nt: NodeType) -> list[StateNode]:
        return [n for n in self._nodes.values() if n.node_type == nt]

    def detect_contradictions(self) -> list[tuple[StateNode, StateNode]]:
        pairs = []
        facts = self.get_facts()
        for i, a in enumerate(facts):
            for b in facts[i + 1:]:
                if self._may_contradict(a.content, b.content):
                    pairs.append((a, b))
        return pairs

    def _may_contradict(self, a: str, b: str) -> bool:
        neg = re.compile(r"\b(not|no|never|cannot|can't|isn't|doesn't|don't|without)\b", re.I)
        a_has_neg = bool(neg.search(a))
        b_has_neg = bool(neg.search(b))
        a_clean   = re.sub(r"[^\w\s]", "", a.lower())
        b_clean   = re.sub(r"[^\w\s]", "", b.lower())
        a_tok = set(a_clean.split())
        b_tok = set(b_clean.split())
        overlap = len(a_tok & b_tok) / max(len(a_tok | b_tok), 1)
        return overlap > 0.4 and a_has_neg != b_has_neg

    def get_relevant_nodes(self, query: str, top_k: int = 10) -> list[StateNode]:
        q_tok = set(re.sub(r"[^\w]", " ", query.lower()).split())
        scored: list[tuple[float, StateNode]] = []
        for n in self._nodes.values():
            c_tok = set(re.sub(r"[^\w]", " ", n.content.lower()).split())
            sc = len(q_tok & c_tok) / max(len(q_tok), 1) + n.confidence * 0.1
            scored.append((sc, n))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [n for _, n in scored[:top_k]]

    def to_context_string(self, max_items: int = 20) -> str:
        sections = []
        for nt, label in [(NodeType.GOAL, "GOALS"), (NodeType.FACT, "FACTS"),
                          (NodeType.CONSTRAINT, "CONSTRAINTS"),
                          (NodeType.ASSUMPTION, "ASSUMPTIONS")]:
            items = self._by_type(nt)[:max_items // 4]
            if items:
                sections.append(f"=== {label} ===")
                for n in items:
                    ver = " ✓" if n.verified else ""
                    sections.append(f"  [{n.confidence:.0%}]{ver} {n.content}")
        contradictions = self.detect_contradictions()
        if contradictions:
            sections.append("=== ⚠ CONTRADICTIONS DETECTED ===")
            for a, b in contradictions[:3]:
                sections.append(f"  CONFLICT: '{a.content[:60]}' vs '{b.content[:60]}'")
        return "\n".join(sections)

    def update_from_text(self, text: str, source: str = ""):
        for line in text.split("\n"):
            line = line.strip()
            if not line:
                continue
            low = line.lower()
            if any(low.startswith(p) for p in ("fact:", "known:", "given:")):
                self.add_fact(line.split(":", 1)[-1].strip(), source=source)
            elif any(low.startswith(p) for p in ("goal:", "objective:", "target:")):
                self.add_goal(line.split(":", 1)[-1].strip())
            elif any(low.startswith(p) for p in ("constraint:", "must not:", "cannot:")):
                self.add_constraint(line.split(":", 1)[-1].strip())
            elif any(low.startswith(p) for p in ("assume:", "assumption:")):
                self.add_assumption(line.split(":", 1)[-1].strip())

    def merge(self, other: "WorldStateGraph"):
        for n in other._nodes.values():
            self._nodes[n.id] = n
        self._edges.extend(other._edges)

    def clear(self):
        self._nodes.clear()
        self._edges.clear()

    def stats(self) -> dict:
        return {t.value: len(self._by_type(t)) for t in NodeType} | {"edges": len(self._edges)}
