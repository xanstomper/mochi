"""RAG system: retrieval, augmentation, Graph RAG, LightRAG."""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

import numpy as np

from .vector_store import VectorStore, SearchResult


@dataclass
class RetrievedContext:
    """A retrieved context document."""
    text: str
    score: float
    source: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class AugmentedPrompt:
    """An augmented prompt with context."""
    original_query: str
    context: List[RetrievedContext]
    augmented_text: str
    strategy: str = "concatenate"

    def to_prompt(self) -> str:
        return self.augmented_text


@dataclass
class GraphNode:
    """A node in the knowledge graph."""
    id: str
    label: str
    properties: Dict[str, Any] = field(default_factory=dict)
    embedding: Optional[np.ndarray] = None


@dataclass
class GraphEdge:
    """An edge in the knowledge graph."""
    source_id: str
    target_id: str
    relation: str
    weight: float = 1.0
    properties: Dict[str, Any] = field(default_factory=dict)


class RAGSystem:
    """Retrieval-Augmented Generation system."""

    def __init__(
        self,
        vector_store: Optional[VectorStore] = None,
        llm_call: Optional[Callable[[str], str]] = None,
    ):
        self.vector_store = vector_store or VectorStore()
        self.llm_call = llm_call or self._default_llm_call

    @staticmethod
    def _default_llm_call(prompt: str) -> str:
        return f"Generated response based on context. Query: {prompt[:100]}..."

    def ingest(self, text: str, source: str = "",
               collection: str = "documents",
               chunk_size: int = 512, chunk_overlap: int = 64) -> List[str]:
        """Ingest text into the vector store with chunking."""
        # Simple chunking by paragraphs and fixed size
        paragraphs = text.split("\n\n")
        chunks: List[str] = []
        current_chunk = ""

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue
            if len(current_chunk) + len(para) < chunk_size:
                current_chunk += "\n\n" + para if current_chunk else para
            else:
                if current_chunk:
                    chunks.append(current_chunk)
                # If a single paragraph is too long, split it
                while len(para) > chunk_size:
                    chunks.append(para[:chunk_size])
                    para = para[chunk_size - chunk_overlap:]
                current_chunk = para

        if current_chunk:
            chunks.append(current_chunk)

        ids: List[str] = []
        for chunk in chunks:
            metadata = {"source": source, "chunk_size": len(chunk)}
            doc_id = self.vector_store.add_text(chunk, collection, metadata)
            ids.append(doc_id)

        return ids

    def retrieve(
        self,
        query: str,
        collection: str = "documents",
        k: int = 5,
        score_threshold: float = 0.0,
    ) -> List[RetrievedContext]:
        """Retrieve relevant context for a query."""
        results = self.vector_store.search(query, collection, k)

        contexts: List[RetrievedContext] = []
        for i in range(len(results.ids)):
            score = 1.0 - results.distances[i] if hasattr(results.distances, '__getitem__') else 0.0
            if score < score_threshold:
                continue

            metadata = results.metadata[i] if i < len(results.metadata) else {}
            text = metadata.get("text", "") if isinstance(metadata, dict) else ""

            contexts.append(RetrievedContext(
                text=text,
                score=float(score),
                source=metadata.get("source", "") if isinstance(metadata, dict) else "",
                metadata=metadata if isinstance(metadata, dict) else {},
            ))

        return contexts

    def augment(
        self,
        query: str,
        contexts: List[RetrievedContext],
        strategy: str = "concatenate",
        max_context_length: int = 2048,
    ) -> AugmentedPrompt:
        """Augment a query with retrieved context."""
        if strategy == "concatenate":
            # Simple concatenation
            context_texts = []
            total_len = 0
            for ctx in contexts:
                if total_len + len(ctx.text) > max_context_length:
                    remaining = max_context_length - total_len
                    if remaining > 100:
                        context_texts.append(ctx.text[:remaining])
                    break
                context_texts.append(ctx.text)
                total_len += len(ctx.text)

            context_block = "\n\n---\n\n".join(context_texts)
            augmented = (
                f"Context information:\n{context_block}\n\n"
                f"Based on the above context, answer the following:\n"
                f"Query: {query}\n\n"
                f"Answer:"
            )

        elif strategy == "summarize":
            # Summarize context first
            context_combined = " ".join(ctx.text[:500] for ctx in contexts[:3])
            augmented = (
                f"Summarized context: {context_combined[:max_context_length]}\n\n"
                f"Query: {query}\n\n"
                f"Answer based on the context:"
            )

        elif strategy == "rerank":
            # Re-rank and use top
            contexts.sort(key=lambda x: x.score, reverse=True)
            best_ctx = contexts[0].text[:max_context_length] if contexts else ""
            augmented = (
                f"Most relevant information: {best_ctx}\n\n"
                f"Query: {query}\n\n"
                f"Answer:"
            )
        else:
            augmented = f"Query: {query}"

        return AugmentedPrompt(
            original_query=query,
            context=contexts,
            augmented_text=augmented,
            strategy=strategy,
        )

    def query(
        self,
        query: str,
        collection: str = "documents",
        k: int = 5,
        strategy: str = "concatenate",
    ) -> str:
        """Complete RAG query: retrieve + augment + generate."""
        contexts = self.retrieve(query, collection, k)
        augmented = self.augment(query, contexts, strategy)
        response = self.llm_call(augmented.to_prompt())
        return response


class GraphRAG:
    """Graph-based RAG: constructs and queries a knowledge graph."""

    def __init__(self, vector_store: Optional[VectorStore] = None):
        self.vector_store = vector_store or VectorStore()
        self.nodes: Dict[str, GraphNode] = {}
        self.edges: List[GraphEdge] = []
        self._adjacency: Dict[str, List[Tuple[str, str, float]]] = {}

    def add_node(self, node_id: str, label: str,
                 properties: Optional[Dict[str, Any]] = None) -> GraphNode:
        """Add a node to the graph."""
        node = GraphNode(id=node_id, label=label, properties=properties or {})
        self.nodes[node_id] = node
        if node_id not in self._adjacency:
            self._adjacency[node_id] = []
        return node

    def add_edge(self, source_id: str, target_id: str, relation: str,
                 weight: float = 1.0) -> GraphEdge:
        """Add an edge between two nodes."""
        if source_id not in self.nodes or target_id not in self.nodes:
            raise ValueError(f"Source or target node not found")

        edge = GraphEdge(
            source_id=source_id, target_id=target_id,
            relation=relation, weight=weight,
        )
        self.edges.append(edge)

        # Build adjacency
        if source_id not in self._adjacency:
            self._adjacency[source_id] = []
        if target_id not in self._adjacency:
            self._adjacency[target_id] = []
        self._adjacency[source_id].append((target_id, relation, weight))
        self._adjacency[target_id].append((source_id, relation, weight))

        return edge

    def build_from_text(self, text: str, source: str = "") -> None:
        """Build a graph from text by extracting entities and relations."""
        sentences = re.split(r'[.!?]+', text)
        for i, sentence in enumerate(sentences):
            if not sentence.strip():
                continue
            # Extract noun phrases as nodes (simple heuristic)
            words = sentence.split()
            entities = [w for w in words if w[0].isupper() and len(w) > 2]

            if not entities:
                # Use content words as nodes
                content_words = [w.lower() for w in words
                                 if len(w) > 3 and w.isalpha()]
                entities = content_words[:3]

            prev_id = None
            for entity in entities:
                node_id = f"{source}_{entity}_{i}"
                self.add_node(node_id, entity, {"source": source, "sentence": i})
                if prev_id:
                    self.add_edge(prev_id, node_id, "follows", weight=1.0 / (i + 1))
                prev_id = node_id

    def retrieve(
        self,
        query: str,
        max_nodes: int = 10,
        max_hops: int = 2,
    ) -> Tuple[List[GraphNode], List[GraphEdge]]:
        """Retrieve subgraph relevant to query using BFS."""
        # Find seed nodes matching query
        query_lower = query.lower()
        seed_nodes: List[str] = []

        for nid, node in self.nodes.items():
            if query_lower in node.label.lower():
                seed_nodes.append(nid)
            for prop_val in node.properties.values():
                if isinstance(prop_val, str) and query_lower in prop_val.lower():
                    if nid not in seed_nodes:
                        seed_nodes.append(nid)

        if not seed_nodes:
            # Fallback: use any node
            seed_nodes = list(self.nodes.keys())[:min(3, len(self.nodes))]

        # BFS to get subgraph
        visited_nodes: Set[str] = set(seed_nodes)
        frontier: List[str] = list(seed_nodes)
        collected_edges: List[GraphEdge] = []

        for _ in range(max_hops):
            next_frontier: List[str] = []
            for nid in frontier:
                for neighbor, rel, w in self._adjacency.get(nid, []):
                    if neighbor not in visited_nodes:
                        visited_nodes.add(neighbor)
                        next_frontier.append(neighbor)
                    # Collect connecting edge
                    for edge in self.edges:
                        if (edge.source_id == nid and edge.target_id == neighbor) or \
                           (edge.source_id == neighbor and edge.target_id == nid):
                            if edge not in collected_edges:
                                collected_edges.append(edge)
                    if len(visited_nodes) >= max_nodes:
                        break
                if len(visited_nodes) >= max_nodes:
                    break
            frontier = next_frontier
            if not frontier:
                break

        retrieved = [self.nodes[nid] for nid in visited_nodes]
        return retrieved, collected_edges

    def query(self, query: str) -> str:
        """Query the graph and return formatted context."""
        nodes, edges = self.retrieve(query)

        node_info = "\n".join(
            f"- {n.label} (id={n.id[:12]}...)" for n in nodes[:20]
        )
        edge_info = "\n".join(
            f"  {e.source_id[:8]}... --[{e.relation}]--> {e.target_id[:8]}..."
            for e in edges[:20]
        )

        context = (
            f"Knowledge Graph Context:\n"
            f"Nodes ({len(nodes)}):\n{node_info}\n\n"
            f"Relations ({len(edges)}):\n{edge_info}\n\n"
            f"Query: {query}"
        )
        return context


class LightRAG:
    """Lightweight RAG: minimal dependencies, fast retrieval."""

    def __init__(self, embedding_dim: int = 128):
        self.documents: List[Dict[str, Any]] = []
        self.embeddings: List[np.ndarray] = []
        self.dim = embedding_dim
        self.rng = np.random.default_rng(42)

    def _embed(self, text: str) -> np.ndarray:
        """Fast embedding using character-level hashing."""
        vec = np.zeros(self.dim, dtype=np.float32)
        for i, ch in enumerate(text):
            idx = (i * 31 + ord(ch) * 17) % self.dim
            vec[idx] += 1.0
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec /= norm
        return vec

    def add_document(self, text: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        """Add a document to the index."""
        self.documents.append({"text": text, "metadata": metadata or {}})
        self.embeddings.append(self._embed(text))

    def retrieve(self, query: str, k: int = 5) -> List[RetrievedContext]:
        """Retrieve top-k documents."""
        if not self.documents:
            return []

        q_vec = self._embed(query)
        scores = np.array([
            float(np.dot(q_vec, e)) for e in self.embeddings
        ])
        indices = np.argsort(scores)[::-1][:k]

        return [
            RetrievedContext(
                text=self.documents[i]["text"],
                score=float(scores[i]),
                metadata=self.documents[i]["metadata"],
            )
            for i in indices
        ]

    def query(self, query: str, k: int = 5) -> str:
        """Quick query with context."""
        contexts = self.retrieve(query, k)
        if not contexts:
            return f"No context found for: {query}"

        context_block = "\n\n".join(ctx.text[:500] for ctx in contexts)
        return (
            f"Context:\n{context_block}\n\n"
            f"Query: {query}\n\n"
            f"Based on the above context, here is the answer."
        )


# Convenience functions

def retrieve(
    query: str,
    vector_store: VectorStore,
    collection: str = "documents",
    k: int = 5,
) -> List[RetrievedContext]:
    rag = RAGSystem(vector_store)
    return rag.retrieve(query, collection, k)


def augment(
    query: str,
    contexts: List[RetrievedContext],
    strategy: str = "concatenate",
) -> AugmentedPrompt:
    rag = RAGSystem()
    return rag.augment(query, contexts, strategy)


def graph_rag(
    query: str,
    graph: GraphRAG,
) -> str:
    return graph.query(query)


def lightrag(
    query: str,
    lrag: LightRAG,
    k: int = 5,
) -> str:
    return lrag.query(query, k)
