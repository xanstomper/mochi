"""SkillLibrary — Living library of reusable problem-solving procedures."""
from __future__ import annotations
import os, re, sqlite3, uuid
from dataclasses import dataclass, field
from datetime import datetime

_SEED_SKILLS = [
    ("debug_python",       "Debugging Python code",        "procedure", "coding",
     ["read traceback", "identify error type", "add print/logging", "isolate minimal case", "fix and test"],
     ["debugging", "python", "error"]),
    ("sql_optimization",   "Optimise slow SQL queries",     "heuristic",  "database",
     ["EXPLAIN the query", "add indexes on WHERE cols", "avoid SELECT *", "use JOINs not subqueries", "profile"],
     ["sql", "database", "performance"]),
    ("api_design",         "Design clean REST APIs",        "pattern",    "backend",
     ["define resources as nouns", "use HTTP verbs correctly", "version the API", "document errors", "add pagination"],
     ["api", "rest", "design"]),
    ("code_review",        "Review code for quality",       "workflow",   "coding",
     ["check correctness", "check readability", "check edge cases", "check tests", "check security"],
     ["review", "quality", "code"]),
    ("research_topic",     "Research an unfamiliar topic",  "workflow",   "research",
     ["define scope", "find primary sources", "identify key concepts", "synthesise", "verify claims"],
     ["research", "learning", "analysis"]),
    ("write_tests",        "Write effective unit tests",    "procedure",  "testing",
     ["test happy path", "test edge cases", "test error conditions", "mock dependencies", "check coverage"],
     ["testing", "quality", "tdd"]),
    ("system_design",      "Design a distributed system",   "pattern",    "architecture",
     ["clarify requirements", "estimate scale", "design data model", "choose components", "handle failures"],
     ["architecture", "design", "scalability"]),
    ("root_cause_analysis","Find root cause of problems",   "procedure",  "analysis",
     ["gather symptoms", "reproduce issue", "bisect timeline", "form hypotheses", "test each hypothesis"],
     ["debugging", "analysis", "problem-solving"]),
    ("refactor_code",      "Refactor code safely",          "procedure",  "coding",
     ["write tests first", "make one change at a time", "run tests after each", "commit working states", "document"],
     ["refactoring", "code", "quality"]),
    ("prompt_engineering", "Write effective LLM prompts",   "heuristic",  "ai",
     ["be specific", "provide examples", "set the role", "specify output format", "add constraints"],
     ["prompts", "llm", "ai"]),
    ("perf_profiling",     "Profile Python performance",    "procedure",  "performance",
     ["measure baseline", "use cProfile", "identify hotspot", "optimise hotspot", "measure again"],
     ["performance", "profiling", "python"]),
    ("data_pipeline",      "Build a data pipeline",         "workflow",   "data",
     ["ingest", "validate", "transform", "store", "monitor"],
     ["data", "pipeline", "etl"]),
    ("security_audit",     "Audit code for security issues","procedure",  "security",
     ["check input validation", "check auth/authz", "check SQL injection", "check secrets", "check deps"],
     ["security", "audit", "vulnerability"]),
    ("deploy_service",     "Deploy a service",              "workflow",   "devops",
     ["build & test", "containerise", "configure env", "deploy to staging", "smoke test", "promote to prod"],
     ["deployment", "devops", "production"]),
    ("explain_concept",    "Explain a technical concept",   "pattern",    "communication",
     ["start with analogy", "show simplest example", "build complexity", "show real use case", "summarise"],
     ["communication", "teaching", "explanation"]),
]


@dataclass
class Skill:
    id: str
    name: str
    description: str
    skill_type: str        # procedure / heuristic / pattern / workflow
    domain: str
    steps: list[str] = field(default_factory=list)
    success_rate: float = 1.0
    use_count: int = 0
    avg_quality: float = 0.8
    tags: list[str] = field(default_factory=list)
    created_at: str = ""
    examples: list[str] = field(default_factory=list)


class SkillLibrary:
    def __init__(self, db_path: str = "~/.lazy_chameleon/skills.db"):
        self._db = os.path.expanduser(db_path)
        os.makedirs(os.path.dirname(self._db), exist_ok=True)
        self._init_db()
        self._seed()

    def _init_db(self):
        with sqlite3.connect(self._db) as c:
            c.execute("""CREATE TABLE IF NOT EXISTS skills (
                id TEXT PRIMARY KEY, name TEXT, description TEXT,
                skill_type TEXT, domain TEXT, steps TEXT,
                success_rate REAL, use_count INTEGER, avg_quality REAL,
                tags TEXT, created_at TEXT, examples TEXT)""")
            c.commit()

    def _seed(self):
        with sqlite3.connect(self._db) as c:
            count = c.execute("SELECT COUNT(*) FROM skills").fetchone()[0]
        if count > 0:
            return
        for name, desc, st, domain, steps, tags in _SEED_SKILLS:
            self.add_skill(name, desc, steps, domain, tags)

    def add_skill(self, name: str, description: str, steps: list[str],
                  domain: str, tags: list[str] | None = None,
                  example: str = "") -> str:
        sid = str(uuid.uuid4())[:8]
        with sqlite3.connect(self._db) as c:
            c.execute("INSERT OR IGNORE INTO skills VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (sid, name, description, "procedure", domain,
                 "||".join(steps), 1.0, 0, 0.8,
                 ",".join(tags or []), datetime.now().isoformat(),
                 example))
            c.commit()
        return sid

    def find_skills(self, query: str, domain: str | None = None,
                    top_k: int = 3) -> list[Skill]:
        q_tokens = set(re.sub(r"[^\w]", " ", query.lower()).split())
        with sqlite3.connect(self._db) as c:
            if domain:
                rows = c.execute("SELECT * FROM skills WHERE domain=?", (domain,)).fetchall()
            else:
                rows = c.execute("SELECT * FROM skills").fetchall()
        scored: list[tuple[float, Skill]] = []
        for row in rows:
            sk = self._row(row)
            tokens = set(re.sub(r"[^\w]", " ",
                                f"{sk.name} {sk.description} {' '.join(sk.tags)}".lower()).split())
            sc = len(q_tokens & tokens) / max(len(q_tokens), 1) + sk.success_rate * 0.2
            if sc > 0:
                scored.append((sc, sk))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [s for _, s in scored[:top_k]]

    def use_skill(self, skill_id: str, quality: float):
        with sqlite3.connect(self._db) as c:
            row = c.execute("SELECT use_count, avg_quality, success_rate FROM skills WHERE id=?",
                            (skill_id,)).fetchone()
            if not row:
                return
            uc, aq, sr = row
            new_aq = (aq * uc + quality) / (uc + 1)
            new_sr = (sr * uc + (1 if quality > 0.5 else 0)) / (uc + 1)
            c.execute("UPDATE skills SET use_count=?, avg_quality=?, success_rate=? WHERE id=?",
                      (uc + 1, new_aq, new_sr, skill_id))
            c.commit()

    def extract_skill_from_trace(self, task: str, reasoning_trace: str,
                                 quality: float) -> "Skill | None":
        if quality < 0.6:
            return None
        lines   = reasoning_trace.split("\n")
        steps   = [l.strip() for l in lines if re.match(r"^\d+[\.\)]|^step|^-\s", l.strip(), re.I)][:8]
        if len(steps) < 2:
            return None
        name = re.sub(r"[^\w\s]", "", task[:40]).strip()
        sid  = self.add_skill(name, f"Extracted from: {task[:80]}", steps, "auto",
                              tags=["extracted", "auto"])
        with sqlite3.connect(self._db) as c:
            row = c.execute("SELECT * FROM skills WHERE id=?", (sid,)).fetchone()
        return self._row(row) if row else None

    def format_skills_as_context(self, skills: list[Skill]) -> str:
        if not skills:
            return ""
        lines = ["=== RELEVANT SKILLS ==="]
        for sk in skills:
            lines.append(f"[{sk.skill_type.upper()}] {sk.name}: {sk.description}")
            for i, step in enumerate(sk.steps[:5], 1):
                lines.append(f"  {i}. {step}")
        return "\n".join(lines)

    def prune_poor_skills(self, min_success_rate: float = 0.3, min_uses: int = 3):
        with sqlite3.connect(self._db) as c:
            c.execute("DELETE FROM skills WHERE use_count>=? AND success_rate<?",
                      (min_uses, min_success_rate))
            c.commit()

    def _row(self, row) -> Skill:
        id_, name, desc, st, domain, steps_s, sr, uc, aq, tags_s, created, ex_s = row
        return Skill(id_, name, desc, st, domain,
                     steps_s.split("||") if steps_s else [],
                     sr, uc, aq, tags_s.split(",") if tags_s else [],
                     created, [ex_s] if ex_s else [])

    def stats(self) -> dict:
        with sqlite3.connect(self._db) as c:
            total = c.execute("SELECT COUNT(*) FROM skills").fetchone()[0]
            top   = c.execute("SELECT name, use_count FROM skills ORDER BY use_count DESC LIMIT 5").fetchall()
        return {"total_skills": total, "top_used": top}
