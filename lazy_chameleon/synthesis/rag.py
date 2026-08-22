"""Retrieval-Augmented Generation Engine.

Dynamic knowledge retrieval + context injection for any task.
Builds searchable knowledge bases from agent outputs and external sources,
then retrieves the most relevant pieces at inference time.

Pipeline:
  1. Index agent outputs into BM25 + TF-IDF hybrid store (no external deps)
  2. Index task-relevant knowledge from memory
  3. At query time: retrieve top-k with BM25 + cosine ensemble + MMR diversity
  4. Inject as dense parameter context

Improvements over v1:
  - BM25 Okapi scoring replaces plain cosine for keyword precision
  - Hybrid ensemble: 0.6*BM25 + 0.4*TF-IDF cosine
  - MMR (Maximal Marginal Relevance) for result diversity
  - Source-type quality weights (agent_output > knowledge > memory)
  - Per-chunk age/quality decay
  - Deduplication: skip near-identical chunks on index
"""
import hashlib
import math
import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Optional


# ── BM25 constants (Robertson et al. 1994) ───────────────────────────────────
BM25_K1 = 1.5   # term-saturation — higher = more weight to repeated terms
BM25_B  = 0.75  # length normalisation — 1.0 = full, 0.0 = none

# ── Ensemble weights ──────────────────────────────────────────────────────────
W_BM25  = 0.60
W_TFIDF = 0.40

# ── Source-type quality multipliers ──────────────────────────────────────────
SOURCE_QUALITY: dict[str, float] = {
    "agent_output": 1.0,
    "knowledge":    0.85,
    "memory":       0.70,
}

# ── Near-duplicate threshold (Jaccard on token sets) ─────────────────────────
DEDUP_THRESHOLD = 0.85


@dataclass
class Document:
    """A retrievable document chunk."""
    content: str
    source: str
    doc_type: str = "agent_output"   # agent_output | knowledge | memory
    metadata: dict = field(default_factory=dict)
    # TF-IDF embedding (sparse — only updated vocabulary dimensions)
    embedding: list[float] = field(default_factory=list)
    relevance_score: float = 0.0
    token_set: set = field(default_factory=set)   # cached for dedup / MMR


# ── Stopword list (shared) ────────────────────────────────────────────────────
_STOPS = frozenset({
    "the","a","an","is","are","was","were","in","on","at","to","for","of",
    "with","by","from","it","this","that","and","or","but","not","if","then",
    "so","as","be","has","have","had","do","does","did","will","would",
    "could","should","may","might","can","its","we","you","i","he","she",
    "they","our","your","my","his","her","their","what","which","who",
})


def _tokenize(text: str) -> list[str]:
    text = text.lower()
    text = re.sub(r'[^a-z0-9\s]', ' ', text)
    return [t for t in text.split() if len(t) > 1 and t not in _STOPS]


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


class BM25Index:
    """
    Okapi BM25 index with TF-IDF cosine ensemble.

    No external dependencies — pure stdlib math.
    """

    def __init__(self):
        self.documents: list[Document] = []
        self.vocab: dict[str, int] = {}       # token → column index
        self.doc_freq: dict[str, int] = {}    # token → #docs containing it
        self.doc_count = 0
        self.avg_dl: float = 0.0              # average doc length (tokens)
        self._total_tokens = 0

    # ── Mutation ─────────────────────────────────────────────────────────────

    def add(self, doc: Document) -> bool:
        """
        Add a document.  Returns False if a near-duplicate was detected
        and the document was skipped.
        """
        tokens = _tokenize(doc.content)
        if not tokens:
            return False

        tok_set = set(tokens)
        doc.token_set = tok_set

        # Deduplication check
        for existing in self.documents:
            if _jaccard(tok_set, existing.token_set) >= DEDUP_THRESHOLD:
                return False          # too similar — skip

        self.documents.append(doc)
        self.doc_count += 1
        self._total_tokens += len(tokens)
        self.avg_dl = self._total_tokens / self.doc_count

        # Update vocabulary and document-frequency
        for t in tok_set:
            self.doc_freq[t] = self.doc_freq.get(t, 0) + 1
            if t not in self.vocab:
                self.vocab[t] = len(self.vocab)

        # Compute TF-IDF embedding (will be re-normalised on query)
        self._update_embedding(doc, tokens)
        return True

    def _update_embedding(self, doc: Document, tokens: list[str]):
        """Store sparse TF vector (IDF applied at query time)."""
        tc = Counter(tokens)
        dim = len(self.vocab)
        emb = [0.0] * dim
        for t, cnt in tc.items():
            idx = self.vocab.get(t, -1)
            if idx >= 0:
                emb[idx] = cnt / max(len(tokens), 1)   # raw TF
        doc.embedding = emb

    # ── Retrieval ─────────────────────────────────────────────────────────────

    def bm25_scores(self, query_tokens: list[str]) -> list[float]:
        """Return BM25 score for every indexed document."""
        n = self.doc_count
        scores = [0.0] * n

        for qt in set(query_tokens):
            df = self.doc_freq.get(qt, 0)
            if df == 0:
                continue
            idf = math.log((n - df + 0.5) / (df + 0.5) + 1)

            for i, doc in enumerate(self.documents):
                tokens = _tokenize(doc.content)
                tc = Counter(tokens)
                tf = tc.get(qt, 0)
                dl = len(tokens)
                norm = BM25_K1 * (1 - BM25_B + BM25_B * dl / max(self.avg_dl, 1))
                tf_norm = tf * (BM25_K1 + 1) / (tf + norm)
                scores[i] += idf * tf_norm

        return scores

    def tfidf_scores(self, query_tokens: list[str]) -> list[float]:
        """Return cosine TF-IDF score for every indexed document."""
        n = self.doc_count
        if n == 0 or not query_tokens:
            return [0.0] * n

        # Build query vector
        q_emb: dict[str, float] = {}
        tc = Counter(query_tokens)
        for t, cnt in tc.items():
            df = self.doc_freq.get(t, 0)
            idf = math.log((n + 1) / (df + 1)) + 1
            q_emb[t] = (cnt / len(query_tokens)) * idf

        dim = len(self.vocab)
        q_vec = [0.0] * dim
        for t, v in q_emb.items():
            idx = self.vocab.get(t, -1)
            if idx >= 0:
                q_vec[idx] = v

        q_norm = math.sqrt(sum(x * x for x in q_vec))
        if q_norm == 0:
            return [0.0] * n

        scores = []
        for doc in self.documents:
            # doc.embedding is raw TF; multiply by IDF on the fly
            dv = doc.embedding
            dot = 0.0
            for t, v in q_emb.items():
                idx = self.vocab.get(t, -1)
                if idx >= 0 and idx < len(dv):
                    tf_d = dv[idx]
                    df = self.doc_freq.get(t, 0)
                    idf = math.log((n + 1) / (df + 1)) + 1
                    dot += v * (tf_d * idf)
            d_norm = math.sqrt(
                sum((dv[idx] * (math.log((n + 1) / (self.doc_freq.get(t, 0) + 1)) + 1)) ** 2
                    for t in self.vocab
                    if (idx := self.vocab.get(t, -1)) >= 0 and idx < len(dv))
            )
            if d_norm == 0:
                scores.append(0.0)
            else:
                scores.append(dot / (q_norm * d_norm))

        return scores

    def hybrid_query(
        self,
        text: str,
        top_k: int = 5,
        mmr_lambda: float = 0.7,
    ) -> list[tuple["Document", float]]:
        """
        Retrieve top-k documents using BM25+TF-IDF ensemble then MMR reranking.

        Args:
            text        : Natural-language query
            top_k       : How many results to return
            mmr_lambda  : Trade-off relevance (1.0) vs diversity (0.0)
        """
        if not self.documents:
            return []

        qtoks = _tokenize(text)
        if not qtoks:
            return []

        bm25  = self.bm25_scores(qtoks)
        tfidf = self.tfidf_scores(qtoks)

        # Normalise each ranking to [0, 1]
        def _norm(v: list[float]) -> list[float]:
            mx = max(v) if v else 0
            return [x / mx if mx > 0 else 0.0 for x in v]

        bm25_n  = _norm(bm25)
        tfidf_n = _norm(tfidf)

        # Ensemble
        combined = [
            W_BM25 * b + W_TFIDF * t * SOURCE_QUALITY.get(doc.doc_type, 1.0)
            for b, t, doc in zip(bm25_n, tfidf_n, self.documents)
        ]

        # ── MMR reranking ─────────────────────────────────────────────────────
        # Start with the best-scoring candidate; greedily pick subsequent ones
        # that maximise: λ·relevance − (1−λ)·max_similarity_to_selected
        candidates = list(range(len(self.documents)))
        selected: list[int] = []

        while candidates and len(selected) < top_k:
            best_idx, best_score = -1, -1.0
            for ci in candidates:
                rel = combined[ci]
                if selected:
                    max_sim = max(
                        _jaccard(
                            self.documents[ci].token_set,
                            self.documents[si].token_set,
                        )
                        for si in selected
                    )
                else:
                    max_sim = 0.0
                mmr_score = mmr_lambda * rel - (1 - mmr_lambda) * max_sim
                if mmr_score > best_score:
                    best_score = mmr_score
                    best_idx = ci

            if best_idx < 0:
                break
            selected.append(best_idx)
            candidates.remove(best_idx)

        return [
            (self.documents[i], combined[i])
            for i in selected
        ]


class RAGEngine:
    """Retrieval-Augmented Generation for parameter synthesis.

    Builds a knowledge index from lazy agent outputs, then retrieves
    the most relevant pieces to inject as parameter-dense context.

    v2 improvements:
      - BM25 Okapi + TF-IDF cosine ensemble (0.6 / 0.4 weights)
      - MMR diversity reranking (λ=0.7 by default)
      - Source-type quality weights
      - Near-duplicate suppression (Jaccard ≥ 0.85)
    """

    def __init__(self, index_capacity: int = 500, mmr_lambda: float = 0.7):
        self.index = BM25Index()
        self.capacity = index_capacity
        self.mmr_lambda = mmr_lambda
        self.total_retrieved = 0
        self.total_indexed = 0
        self.total_deduped = 0
        self._chunk_size = 200  # words per chunk

    # ── Indexing ──────────────────────────────────────────────────────────────

    def index_agent_output(self, agent_name: str, content: str, score: float = 1.0):
        """Index an agent's output for retrieval."""
        chunks = self._chunk_text(content)
        for i, chunk in enumerate(chunks):
            doc = Document(
                content=chunk,
                source=agent_name,
                doc_type="agent_output",
                metadata={"chunk_idx": i, "agent": agent_name},
                relevance_score=score,
            )
            added = self.index.add(doc)
            if added:
                self.total_indexed += 1
            else:
                self.total_deduped += 1

    def index_knowledge(self, knowledge: str, source: str = "external"):
        """Index external knowledge."""
        chunks = self._chunk_text(knowledge)
        for i, chunk in enumerate(chunks):
            doc = Document(
                content=chunk,
                source=source,
                doc_type="knowledge",
                metadata={"chunk_idx": i},
                relevance_score=0.8,
            )
            added = self.index.add(doc)
            if added:
                self.total_indexed += 1
            else:
                self.total_deduped += 1

    def index_memory(self, memory_items: list[dict]):
        """Index items from memory system."""
        for item in memory_items:
            content = item.get("content", "")
            if not content:
                continue
            doc = Document(
                content=content,
                source="memory",
                doc_type="memory",
                metadata=item,
                relevance_score=item.get("importance", 0.5),
            )
            added = self.index.add(doc)
            if added:
                self.total_indexed += 1
            else:
                self.total_deduped += 1

    # ── Retrieval ─────────────────────────────────────────────────────────────

    def retrieve(self, query: str, top_k: int = 5) -> list[dict]:
        """Retrieve most relevant documents for a query."""
        results = self.index.hybrid_query(query, top_k, self.mmr_lambda)
        self.total_retrieved += len(results)

        return [{
            "content":      doc.content,
            "source":       doc.source,
            "type":         doc.doc_type,
            "relevance":    round(score, 4),
            "doc_relevance": doc.relevance_score,
        } for doc, score in results]

    def build_context(self, task: str, top_k: int = 8) -> str:
        """Build a retrieval-augmented context string for the task."""
        docs = self.retrieve(task, top_k)
        if not docs:
            return ""

        lines = [
            "=== RAG CONTEXT (BM25+TF-IDF Hybrid Retrieved Knowledge) ===",
            f"Task: {task[:100]}",
            f"Retrieved: {len(docs)} diverse chunks  "
            f"(deduped: {self.total_deduped})",
            "",
        ]

        for i, doc in enumerate(docs, 1):
            rel  = doc["relevance"]
            src  = doc["source"]
            kind = doc["type"]
            body = doc["content"][:500]

            lines.append(f"[{i}] rel={rel:.3f} | src={src} | type={kind}")
            lines.append(f"    {body}")
            lines.append("")

        lines.append("=== END RAG CONTEXT ===")
        return "\n".join(lines)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _chunk_text(self, text: str) -> list[str]:
        """Split text into retrieval-friendly chunks."""
        words = text.split()
        chunks: list[str] = []
        for i in range(0, len(words), self._chunk_size):
            chunk = " ".join(words[i: i + self._chunk_size]).strip()
            if len(chunk) > 20:
                chunks.append(chunk)
        return chunks

    def get_stats(self) -> dict:
        return {
            "total_indexed":    self.total_indexed,
            "total_deduped":    self.total_deduped,
            "total_retrieved":  self.total_retrieved,
            "index_size":       len(self.index.documents),
            "vocab_size":       len(self.index.vocab),
            "avg_doc_len":      round(self.index.avg_dl, 1),
        }
