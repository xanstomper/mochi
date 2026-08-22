---
name: memory-design
description: Design document for agentic memory handling
---

# LAZY CHAMELEON - Memory Architecture

## Memory-Engineer Design Document

### Four-Tier Memory System

### 1. Short-Term Memory
Rolling window of recent interactions. Managed via smart context.

class ShortTermMemory:
    def __init__(self, max_tokens=4096):
        self.buffer = deque()
        self.max_tokens = max_tokens

    def add(self, turn):
        self.buffer.append(turn)
        self._evict_if_needed()

    def get_context(self):
        priority = [system_prompt, task, plan, recent_turns, tool_outputs]
        return self._render_by_priority(priority)

### 2. Working Memory
class WorkingMemory:
    def __init__(self):
        self.plan = None
        self.progress = {}
        self.decisions = []
        self.repo_context = None

    def get_status(self):
        return f"Plan: {self.plan.goal} | {self.progress}"

### 3. Long-Term Memory (Vector DB)
class LongTermMemory:
    def __init__(self, db_path):
        self.vector_db = ChromaDB(persist_directory=db_path)
        self.sqlite = sqlite3.connect(f"{db_path}/meta.db")

    def store(self, item):
        emb = self._embed(item.content)
        self.vector_db.add(embeddings=[emb], metadatas=[item.meta])

    def retrieve(self, query, k=5):
        emb = self._embed(query)
        return self.vector_db.query(query_embeddings=[emb], n_results=k)

### 4. Cross-Session Memory
class CrossSessionMemory:
    TABLES = {
        "users": "id TEXT, prefs TEXT",
        "projects": "path TEXT, state TEXT, last_access TIMESTAMP",
        "failures": "task TEXT, error_type TEXT, analysis TEXT"
    }

    def get_user_prefs(self, user_id):
        row = self.db.execute("SELECT prefs FROM users WHERE id=?", (user_id,))
        return json.loads(row.fetchone()[0]) if row.fetchone() else {}

### Failure Bank (L16)
class FailureBank:
    def record(self, task, output, error_type, analysis):
        self.db.execute("INSERT INTO failures VALUES (?,?,?,?,datetime('now'))",
                       (task, output, error_type, analysis))

    def check_similar(self, task):
        # Embed task, search similar failures, return warnings
        pass

### Context Optimizer (L28)
class ContextOptimizer:
    def optimize(self, context, budget_tokens):
        priorities = [
            ("critical", context.system_prompt),
            ("critical", context.task),
            ("critical", context.plan),
            ("high", context.recent),
            ("medium", context.memories),
            ("low", context.old_turns),
        ]
        result = []
        for priority, section in priorities:
            if priority == "critical":
                result.append(section)
            elif self._count_tokens(result) < budget_tokens:
                result.append(self._summarize(section))
        return "\n".join(result)

### DB Choice: SQLite + ChromaDB
- SQLite: reliable, zero-config metadata store
- ChromaDB: lightweight vector DB for embedding search
