"""Vector store with FAISS-like capabilities: Flat, IVF, HNSW indexes,
collection management, metadata filtering, embedding management."""
from __future__ import annotations

import json
import math
import pickle
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

import numpy as np


@dataclass
class IndexedPoint:
    """A single point in the vector index."""
    vector: np.ndarray
    id: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.id:
            self.id = str(uuid.uuid4())


@dataclass
class SearchResult:
    """Result from a vector search."""
    ids: List[str]
    distances: np.ndarray
    vectors: List[np.ndarray]
    metadata: List[Dict[str, Any]]

    def top_k(self, k: int) -> SearchResult:
        k = min(k, len(self.ids))
        return SearchResult(
            ids=self.ids[:k],
            distances=self.distances[:k],
            vectors=self.vectors[:k],
            metadata=self.metadata[:k],
        )

    def filter_by_metadata(self, key: str, value: Any) -> SearchResult:
        filtered_indices = [
            i for i, m in enumerate(self.metadata)
            if m.get(key) == value
        ]
        return SearchResult(
            ids=[self.ids[i] for i in filtered_indices],
            distances=self.distances[filtered_indices],
            vectors=[self.vectors[i] for i in filtered_indices],
            metadata=[self.metadata[i] for i in filtered_indices],
        )


class VectorIndex:
    """Base class for vector indexes."""

    def __init__(self, dimension: int, metric: str = "cosine"):
        self.dimension = dimension
        self.metric = metric
        self.points: List[IndexedPoint] = []
        self._is_trained = False

    def add(self, vector: np.ndarray, id: str = "", metadata: Dict[str, Any] = None) -> str:
        """Add a vector to the index."""
        if vector.shape[0] != self.dimension:
            raise ValueError(f"Vector dimension {vector.shape[0]} != {self.dimension}")
        point = IndexedPoint(vector=vector.astype(np.float32), id=id, metadata=metadata or {})
        self.points.append(point)
        return point.id

    def add_batch(self, vectors: np.ndarray, ids: Optional[List[str]] = None,
                  metadata_list: Optional[List[Dict[str, Any]]] = None) -> List[str]:
        """Add multiple vectors."""
        if ids is None:
            ids = [""] * len(vectors)
        if metadata_list is None:
            metadata_list = [{}] * len(vectors)
        return [
            self.add(v, i, m)
            for v, i, m in zip(vectors, ids, metadata_list)
        ]

    def _compute_distance(self, a: np.ndarray, b: np.ndarray) -> float:
        """Compute distance between two vectors based on metric."""
        if self.metric == "cosine":
            dot = np.dot(a, b)
            norm = np.linalg.norm(a) * np.linalg.norm(b) + 1e-12
            return 1.0 - float(dot / norm)  # cosine distance
        elif self.metric == "l2":
            return float(np.linalg.norm(a - b))
        elif self.metric == "ip":
            return -float(np.dot(a, b))
        else:
            return float(np.linalg.norm(a - b))

    def search(self, query: np.ndarray, k: int = 10) -> SearchResult:
        """Search for nearest neighbors."""
        if not self.points:
            return SearchResult(ids=[], distances=np.array([]), vectors=[], metadata=[])

        distances = np.array([
            self._compute_distance(query, p.vector) for p in self.points
        ])
        indices = np.argsort(distances)[:k]

        return SearchResult(
            ids=[self.points[i].id for i in indices],
            distances=distances[indices],
            vectors=[self.points[i].vector for i in indices],
            metadata=[self.points[i].metadata for i in indices],
        )

    def remove(self, id: str) -> bool:
        """Remove a point by ID."""
        for i, p in enumerate(self.points):
            if p.id == id:
                self.points.pop(i)
                return True
        return False

    def size(self) -> int:
        return len(self.points)

    def save(self, path: str) -> None:
        data = {
            "dimension": self.dimension,
            "metric": self.metric,
            "points": [(p.id, p.vector.tolist(), p.metadata) for p in self.points],
        }
        with open(path, "wb") as f:
            pickle.dump(data, f)

    def load(self, path: str) -> None:
        with open(path, "rb") as f:
            data = pickle.load(f)
        self.dimension = data["dimension"]
        self.metric = data["metric"]
        self.points = [
            IndexedPoint(vector=np.array(v), id=i, metadata=m)
            for i, v, m in data["points"]
        ]


class FlatIndex(VectorIndex):
    """Flat (brute-force) index - exact search."""

    def __init__(self, dimension: int, metric: str = "cosine"):
        super().__init__(dimension, metric)
        self._is_trained = True

    def search(self, query: np.ndarray, k: int = 10) -> SearchResult:
        return super().search(query, k)


class IVFIndex(VectorIndex):
    """Inverted File Index - approximate search with clustering."""

    def __init__(self, dimension: int, nlist: int = 100, metric: str = "cosine",
                 nprobe: int = 10):
        super().__init__(dimension, metric)
        self.nlist = nlist
        self.nprobe = nprobe
        self.centroids: Optional[np.ndarray] = None
        self._inverted_lists: Dict[int, List[IndexedPoint]] = {}

    def train(self, vectors: np.ndarray) -> None:
        """Train the index on a sample of vectors."""
        n = len(vectors)
        k = min(self.nlist, n)
        if k < 1:
            return

        # K-means clustering
        indices = np.random.choice(n, k, replace=False)
        centroids = vectors[indices].copy()

        for _ in range(20):
            distances = np.linalg.norm(vectors[:, np.newaxis] - centroids[np.newaxis], axis=2)
            labels = np.argmin(distances, axis=1)
            new_centroids = np.array([
                vectors[labels == i].mean(axis=0) if np.any(labels == i) else centroids[i]
                for i in range(k)
            ])
            if np.allclose(centroids, new_centroids, atol=1e-4):
                break
            centroids = new_centroids

        self.centroids = centroids
        self._inverted_lists = {i: [] for i in range(k)}

        for i, label in enumerate(labels):
            self._inverted_lists[int(label)].append(
                IndexedPoint(vector=vectors[i], id=f"train_{i}")
            )

        self._is_trained = True

    def add(self, vector: np.ndarray, id: str = "",
            metadata: Dict[str, Any] = None) -> str:
        point_id = super().add(vector, id, metadata)
        point = self.points[-1]

        if self.centroids is not None:
            distances = np.linalg.norm(self.centroids - vector, axis=1)
            nearest = int(np.argmin(distances))
            if nearest not in self._inverted_lists:
                self._inverted_lists[nearest] = []
            self._inverted_lists[nearest].append(point)

        return point_id

    def search(self, query: np.ndarray, k: int = 10) -> SearchResult:
        if not self._is_trained or self.centroids is None:
            return super().search(query, k)

        # Find nearest nprobe centroids
        distances_to_centroids = np.linalg.norm(self.centroids - query, axis=1)
        probe_indices = np.argsort(distances_to_centroids)[:self.nprobe]

        # Search within those inverted lists
        candidates: List[Tuple[float, IndexedPoint]] = []
        for idx in probe_indices:
            for point in self._inverted_lists.get(int(idx), []):
                dist = self._compute_distance(query, point.vector)
                candidates.append((dist, point))

        candidates.sort(key=lambda x: x[0])
        top_k = candidates[:k]

        return SearchResult(
            ids=[p.id for _, p in top_k],
            distances=np.array([d for d, _ in top_k]),
            vectors=[p.vector for _, p in top_k],
            metadata=[p.metadata for _, p in top_k],
        )


class HNSWIndex(VectorIndex):
    """Hierarchical Navigable Small World index."""

    def __init__(self, dimension: int, M: int = 16, ef_construction: int = 200,
                 ef_search: int = 50, metric: str = "cosine"):
        super().__init__(dimension, metric)
        self.M = M
        self.ef_construction = ef_construction
        self.ef_search = ef_search
        self._levels: List[List[int]] = []  # levels[l][i] = index in points
        self._entry_point: Optional[int] = None
        self._max_level = 0
        self._is_trained = True

    def _random_level(self) -> int:
        """Random level for a new element (geometric distribution)."""
        ml = 1.0 / math.log(self.M)
        level = int(-math.log(np.random.random()) * ml)
        return min(level, 32)

    def add(self, vector: np.ndarray, id: str = "",
            metadata: Dict[str, Any] = None) -> str:
        point_id = super().add(vector, id, metadata)
        idx = len(self.points) - 1
        level = self._random_level()

        while len(self._levels) <= level:
            self._levels.append([])

        if self._entry_point is None:
            self._entry_point = idx
            self._levels[0].append(idx)
            self._max_level = level
            return point_id

        curr = self._entry_point
        curr_level = self._max_level

        # Greedy search from top level
        while curr_level > level:
            # Simple: just go down
            if curr_level < len(self._levels):
                neighbors = self._levels[curr_level]
                if neighbors:
                    curr = neighbors[np.random.randint(len(neighbors))]
            curr_level -= 1

        # Add to level 0 (and higher levels)
        for lvl in range(min(level + 1, len(self._levels))):
            self._levels[lvl].append(idx)

        return point_id

    def search(self, query: np.ndarray, k: int = 10) -> SearchResult:
        if not self.points:
            return SearchResult(ids=[], distances=np.array([]), vectors=[], metadata=[])

        # Brute-force for simplicity in this implementation
        distances = np.array([
            self._compute_distance(query, p.vector) for p in self.points
        ])
        indices = np.argsort(distances)[:k]

        return SearchResult(
            ids=[self.points[i].id for i in indices],
            distances=distances[indices],
            vectors=[self.points[i].vector for i in indices],
            metadata=[self.points[i].metadata for i in indices],
        )


@dataclass
class Collection:
    """A named collection of indexed vectors."""
    name: str
    index: VectorIndex
    metadata_schema: Dict[str, type] = field(default_factory=dict)


class CollectionManager:
    """Manages multiple named collections."""

    def __init__(self):
        self.collections: Dict[str, Collection] = {}

    def create_collection(self, name: str, dimension: int,
                          index_type: str = "flat", **kwargs) -> Collection:
        """Create a new collection."""
        if name in self.collections:
            raise ValueError(f"Collection '{name}' already exists")

        if index_type == "flat":
            index = FlatIndex(dimension, **kwargs)
        elif index_type == "ivf":
            index = IVFIndex(dimension, **kwargs)
        elif index_type == "hnsw":
            index = HNSWIndex(dimension, **kwargs)
        else:
            raise ValueError(f"Unknown index type: {index_type}")

        collection = Collection(name=name, index=index)
        self.collections[name] = collection
        return collection

    def get_collection(self, name: str) -> Optional[Collection]:
        return self.collections.get(name)

    def list_collections(self) -> List[str]:
        return list(self.collections.keys())

    def delete_collection(self, name: str) -> bool:
        if name in self.collections:
            del self.collections[name]
            return True
        return False


class EmbeddingManager:
    """Manages embedding generation and normalization."""

    def __init__(self, embedding_dim: int = 768):
        self.dim = embedding_dim
        self.rng = np.random.default_rng(42)

    def embed(self, text: str) -> np.ndarray:
        """Generate an embedding for text (mock with random projection of char n-grams)."""
        # Simple character-level embedding for demo
        vec = np.zeros(self.dim, dtype=np.float32)
        text_bytes = text.encode("utf-8")
        for i, byte in enumerate(text_bytes):
            idx = (i * 256 + byte) % self.dim
            vec[idx] += 1.0
        # Normalize
        norm = np.linalg.norm(vec)
        if norm > 0:
            vec /= norm
        return vec

    def embed_batch(self, texts: List[str]) -> np.ndarray:
        """Generate embeddings for a batch of texts."""
        return np.array([self.embed(t) for t in texts], dtype=np.float32)

    def normalize(self, vectors: np.ndarray) -> np.ndarray:
        """L2-normalize vectors."""
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        norms = np.maximum(norms, 1e-12)
        return vectors / norms


class VectorStore:
    """Complete vector store with multiple collections and embedding support."""

    def __init__(self, default_dim: int = 768):
        self.collections = CollectionManager()
        self.embeddings = EmbeddingManager(default_dim)
        self.default_dim = default_dim

    def add_text(self, text: str, collection: str = "default",
                 metadata: Optional[Dict[str, Any]] = None,
                 index_type: str = "flat") -> str:
        """Add a text document to the vector store."""
        if collection not in self.collections.collections:
            self.collections.create_collection(collection, self.default_dim, index_type)

        vector = self.embeddings.embed(text)
        col = self.collections.get_collection(collection)
        return col.index.add(vector, metadata=metadata or {"text": text})

    def search(self, query: str, collection: str = "default", k: int = 10) -> SearchResult:
        """Search for similar texts."""
        col = self.collections.get_collection(collection)
        if col is None:
            return SearchResult(ids=[], distances=np.array([]), vectors=[], metadata=[])

        query_vec = self.embeddings.embed(query)
        return col.index.search(query_vec, k)

    def save(self, path: str) -> None:
        data = {
            "default_dim": self.default_dim,
            "collections": {},
        }
        for name, col in self.collections.collections.items():
            index_data = {
                "dimension": col.index.dimension,
                "metric": col.index.metric,
                "points": [(p.id, p.vector.tolist(), p.metadata) for p in col.index.points],
                "type": type(col.index).__name__,
            }
            data["collections"][name] = index_data

        with open(path, "wb") as f:
            pickle.dump(data, f)

    def load(self, path: str) -> None:
        with open(path, "rb") as f:
            data = pickle.load(f)
        self.default_dim = data["default_dim"]
        for name, index_data in data["collections"].items():
            dim = index_data["dimension"]
            index = FlatIndex(dim, index_data["metric"])
            for pid, pv, pm in index_data["points"]:
                index.add(np.array(pv), pid, pm)
            self.collections.collections[name] = Collection(name=name, index=index)
