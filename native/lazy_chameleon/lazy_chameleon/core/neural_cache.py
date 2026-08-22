"""NeuralCache — Cache reasoning PATTERNS, not just facts."""
from __future__ import annotations
import hashlib, os, re, sqlite3
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

_SEED_PATTERNS = [
    ("sql_optimization",    "approach",    "For SQL performance: EXPLAIN first, add indexes on WHERE/JOIN cols, avoid SELECT *, use CTEs not nested subqueries."),
    ("debug_async_python",  "template",    "Async debugging: check event loop, add asyncio.run() wrappers, use anyio for testing, look for missing awaits."),
    ("system_design_q",     "heuristic",   "For system design: clarify scale, then: data model → API → components → scale → failure modes."),
    ("python_perf",         "heuristic",   "Python perf: profile first (cProfile), then: list comps > loops, use numpy for maths, cache repeated calls."),
    ("security_review",     "template",    "Security checklist: input validation, auth/authz, SQL injection, XSS, secrets management, dependency CVEs."),
    ("api_design",          "pattern",     "REST API: plural nouns for resources, HTTP verbs for actions, return 200/201/400/401/404/500, version in URL."),
    ("refactoring",         "heuristic",   "Safe refactoring: write tests → make small change → run tests → commit → repeat. Never refactor and add features."),
    ("reasoning_math",      "approach",    "Maths problems: identify type (algebra/combinatorics/etc), apply known formula, verify with concrete numbers."),
    ("code_explanation",    "template",    "Explaining code: state purpose → show simplest usage → explain key parts → note gotchas → give full example."),
    ("debugging_general",   "approach",    "Debugging: reproduce → isolate → bisect (binary search in code) → hypothesise → test each hypothesis → fix."),
    ("writing_prompts",     "heuristic",   "Good prompts: role + context + specific task + output format + constraints + examples = better results."),
    ("data_pipeline",       "pattern",     "Data pipeline: ingest → validate schema → transform → deduplicate → store → monitor for drift."),
    ("test_strategy",       "heuristic",   "Testing: unit (logic) + integration (interactions) + e2e (user flows). Mock external deps. Test edge cases first."),
    ("architecture_review", "template",    "Architecture review: correctness → scalability → maintainability → security → cost → operational complexity."),
    ("planning_tasks",      "approach",    "Task planning: decompose → identify dependencies → critical path → allocate time with buffer → track milestones."),
]


@dataclass
class CachedPattern:
    key: str              # SHA-256 of original query
    original_query: str
    pattern_type: str     # approach / template / heuristic / anti-pattern / example
    content: str
    hit_count: int = 0
    miss_count: int = 0
    avg_quality: float = 0.8
    created_at: str = ""
    last_used: str = ""
    tags: list[str] = field(default_factory=list)
    source_task: str = ""


class NeuralCache:
    def __init__(self, max_entries: int = 500,
                 db_path: str = "~/.lazy_chameleon/neural_cache.db"):
        self._max  = max_entries
        self._db   = os.path.expanduser(db_path)
        os.makedirs(os.path.dirname(self._db), exist_ok=True)
        self._init_db()
        self._seed()

    def _init_db(self):
        with sqlite3.connect(self._db) as c:
            c.execute("""CREATE TABLE IF NOT EXISTS patterns (
                key TEXT PRIMARY KEY, original_query TEXT, pattern_type TEXT,
                content TEXT, hit_count INTEGER, miss_count INTEGER,
                avg_quality REAL, created_at TEXT, last_used TEXT,
                tags TEXT, source_task TEXT)""")
            c.commit()

    def _seed(self):
        with sqlite3.connect(self._db) as c:
            count = c.execute("SELECT COUNT(*) FROM patterns").fetchone()[0]
        if count > 0:
            return
        for name, pt, content in _SEED_PATTERNS:
            self.put(name, content, pt, 0.9, tags=[pt, "seed"])

    # ---- public ---------------------------------------------------------
    def get(self, query: str, threshold: float = 0.25) -> Optional[CachedPattern]:
        q_tokens = set(re.sub(r"[^\w]", " ", query.lower()).split())
        with sqlite3.connect(self._db) as c:
            rows = c.execute("SELECT * FROM patterns ORDER BY hit_count DESC LIMIT 100").fetchall()
        best: Optional[tuple[float, CachedPattern]] = None
        for row in rows:
            p  = self._row(row)
            sc = self._similarity(query, p.original_query, q_tokens)
            if sc >= threshold:
                if best is None or sc > best[0]:
                    best = (sc, p)
        if best:
            self.record_hit(best[1].key, best[1].avg_quality)
            return best[1]
        return None

    def put(self, query: str, pattern: str, pattern_type: str,
            quality: float = 0.8, tags: list[str] | None = None,
            source_task: str = "") -> str:
        key  = hashlib.sha256(query.encode()).hexdigest()[:16]
        now  = datetime.now().isoformat()
        tags = tags or []
        with sqlite3.connect(self._db) as c:
            existing = c.execute("SELECT hit_count, avg_quality FROM patterns WHERE key=?",
                                 (key,)).fetchone()
            if existing:
                uc, aq = existing
                c.execute("UPDATE patterns SET avg_quality=?, last_used=? WHERE key=?",
                          ((aq * uc + quality) / (uc + 1), now, key))
            else:
                c.execute("INSERT INTO patterns VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                          (key, query, pattern_type, pattern, 0, 0, quality, now, now,
                           ",".join(tags), source_task))
            c.commit()
        self.evict_lru()
        return key

    def record_hit(self, key: str, quality: float):
        now = datetime.now().isoformat()
        with sqlite3.connect(self._db) as c:
            c.execute("UPDATE patterns SET hit_count=hit_count+1, last_used=? WHERE key=?",
                      (now, key))
            c.commit()

    def record_miss(self, key: str):
        with sqlite3.connect(self._db) as c:
            c.execute("UPDATE patterns SET miss_count=miss_count+1 WHERE key=?", (key,))
            c.commit()

    def _similarity(self, q1: str, q2: str, q1_tokens: set | None = None) -> float:
        if q1_tokens is None:
            q1_tokens = set(re.sub(r"[^\w]", " ", q1.lower()).split())
        q2_tokens = set(re.sub(r"[^\w]", " ", q2.lower()).split())
        union     = q1_tokens | q2_tokens
        if not union:
            return 0.0
        return len(q1_tokens & q2_tokens) / len(union)

    def evict_lru(self):
        with sqlite3.connect(self._db) as c:
            count = c.execute("SELECT COUNT(*) FROM patterns").fetchone()[0]
            if count > self._max:
                c.execute("""DELETE FROM patterns WHERE key IN (
                    SELECT key FROM patterns ORDER BY last_used ASC
                    LIMIT ?)""", (count - self._max,))
                c.commit()

    def get_cache_stats(self) -> dict:
        with sqlite3.connect(self._db) as c:
            total = c.execute("SELECT COUNT(*) FROM patterns").fetchone()[0]
            hits  = c.execute("SELECT SUM(hit_count) FROM patterns").fetchone()[0] or 0
            misses= c.execute("SELECT SUM(miss_count) FROM patterns").fetchone()[0] or 0
            top   = c.execute("SELECT original_query, hit_count FROM patterns ORDER BY hit_count DESC LIMIT 5").fetchall()
        rate = hits / max(hits + misses, 1)
        return {"total": total, "hits": hits, "misses": misses, "hit_rate": round(rate, 3), "top": top}

    def _row(self, row) -> CachedPattern:
        key, oq, pt, content, hc, mc, aq, created, last, tags_s, src = row
        return CachedPattern(key, oq, pt, content, hc, mc, aq, created, last,
                             tags_s.split(",") if tags_s else [], src)
